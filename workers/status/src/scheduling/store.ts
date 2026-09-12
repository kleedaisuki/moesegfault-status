import { nextRunAt } from "./schedule.js";
import type {
  ClaimedMonitor,
  EvaluationPolicy,
  MonitorCheckpoint,
  ProbeSpec,
  StatusTarget,
} from "./types.js";

/** D1 结果的最小子集。 / Minimal D1 result surface. */
export interface D1ResultLike<T = Record<string, unknown>> {
  readonly results?: readonly T[];
  readonly meta?: { readonly changes?: number };
  readonly success?: boolean;
}

/** D1 prepared statement 的最小可测试子集。 / Minimal testable D1 prepared-statement surface. */
export interface D1StatementLike {
  /** 绑定参数。 / Bind query parameters. */
  bind(...values: unknown[]): D1StatementLike;
  /** 返回全部结果。 / Return all rows. */
  all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
  /** 返回第一行。 / Return the first row. */
  first<T = Record<string, unknown>>(): Promise<T | null>;
  /** 执行写入。 / Execute a write. */
  run<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
}

/** D1 binding 的最小可测试子集。 / Minimal testable D1 binding surface. */
export interface D1DatabaseLike {
  /** 准备 SQL。 / Prepare SQL. */
  prepare(sql: string): D1StatementLike;
  /** 以单事务执行 batch。 / Execute a batch in one transaction. */
  batch<T = Record<string, unknown>>(
    statements: D1StatementLike[],
  ): Promise<D1ResultLike<T>[]>;
}

/** Monitor lease 存储。 / Storage boundary for monitor leases and checkpoints. */
export interface MonitorStore {
  /** 原子领取到期 monitors；重叠 cron 不得领取同一行。 / Atomically lease due monitors so overlapping cron runs cannot claim the same row. */
  claimDue(
    now: Date,
    owner: string,
    leaseMs: number,
    limit: number,
  ): Promise<readonly ClaimedMonitor[]>;
  /** 读取单个聚合检查点。 / Read one aggregate checkpoint. */
  readCheckpoint(
    monitorId: string,
    location: string,
  ): Promise<MonitorCheckpoint | null>;
  /** 读取该 monitor 的全部真实位置聚合。 / Read aggregates for every actual location of this monitor. */
  readCheckpoints(monitorId: string): Promise<readonly MonitorCheckpoint[]>;
  /** 在产生跨事务副作用前确认租约仍归本轮所有。 / Confirm lease ownership before producing cross-transaction side effects. */
  ownsLease(
    monitor: ClaimedMonitor,
    owner: string,
    now: Date,
  ): Promise<boolean>;
  /** 保存聚合检查点，不写原始 history。 / Persist an aggregate checkpoint without raw history. */
  writeCheckpoint(checkpoint: MonitorCheckpoint): Promise<void>;
  /** 原子提交检查点并推进 schedule，防止 lease 崩溃导致重复窗口样本。 / Atomically commit the checkpoint and advance the schedule, preventing duplicate window samples after lease crashes. */
  commitEvaluation(
    monitor: ClaimedMonitor,
    checkpoint: MonitorCheckpoint | readonly MonitorCheckpoint[],
    owner: string,
    now: Date,
  ): Promise<void>;
  /** 成功结束本轮并推进 schedule。 / Complete the run and advance its schedule. */
  complete(monitor: ClaimedMonitor, owner: string, now: Date): Promise<void>;
  /** 仅由 lease owner 释放。 / Release only when owned by the caller. */
  release(monitorId: string, owner: string, now: Date): Promise<void>;
}

/** Outbox 中待投递的不可变事件。 / Immutable event leased from the outbox. */
export interface OutboxEvent {
  readonly outboxId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly schemaVersion: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly attempt: number;
}

/** Outbox lease 与状态写入。 / Outbox lease and state transitions. */
export interface OutboxStore {
  /** 领取 pending 或租约过期的 processing 事件。 / Claim pending or lease-expired processing events. */
  claimOutbox(
    now: Date,
    owner: string,
    leaseMs: number,
    limit: number,
  ): Promise<readonly OutboxEvent[]>;
  /** 以 owner guard 标记成功。 / Mark delivery successful with an owner guard. */
  markOutboxDelivered(
    outboxId: string,
    owner: string,
    now: Date,
  ): Promise<void>;
  /** 记录有界错误并进入重试或 dead。 / Record a bounded error and transition to retry or dead. */
  markOutboxFailed(
    outboxId: string,
    owner: string,
    nextAttempt: Date,
    errorType: string,
    dead: boolean,
  ): Promise<void>;
}

/** Revisioned retention candidate。 / Candidate selected under an immutable retention-policy revision. */
export interface RetentionCandidate {
  readonly occurrenceId: string;
  readonly policyId: string;
  readonly policyRevision: number;
  readonly purgeAfter: string;
}

/** Retention 清理边界。 / Retention cleanup boundary. */
export interface RetentionStore {
  /** 按写入时固定 revision 选择候选，并排除 Incident pins。 / Select candidates by their pinned policy revision, excluding Incident pins. */
  selectRetentionCandidates(
    now: Date,
    limit: number,
  ): Promise<readonly RetentionCandidate[]>;
  /** 带 revision、cutoff 与 pin 二次检查删除候选。 / Delete candidates with revision, cutoff, and pin checks repeated at deletion. */
  purgeRetentionCandidates(
    candidates: readonly RetentionCandidate[],
    now: Date,
  ): Promise<number>;
}

/** 需要在抑制/维护到期后重新计算的目标。 / Target requiring re-evaluation after suppression or maintenance expiry. */
export interface ExpiredTarget {
  readonly sourceType: "maintenance" | "override" | "suppression";
  readonly sourceId: string;
  readonly target: StatusTarget;
}

/** 到期状态扫描边界。 / Expiry scan boundary. */
export interface ExpiryStore {
  /** 原子创建稳定 outbox 工作项；重复扫描无副作用。 / Atomically create stable outbox work items; repeated scans are harmless. */
  enqueueExpiredReevaluations(
    now: Date,
    limit: number,
    id: (timeMs: number, seed: string) => Promise<string>,
  ): Promise<number>;
}

/** D1-backed scheduler store。 / D1-backed scheduler store. */
export class D1SchedulerStore
  implements MonitorStore, OutboxStore, RetentionStore, ExpiryStore
{
  readonly #db: D1DatabaseLike;

  constructor(db: D1DatabaseLike) {
    this.#db = db;
  }

  async claimDue(
    now: Date,
    owner: string,
    leaseMs: number,
    limit: number,
  ): Promise<readonly ClaimedMonitor[]> {
    const nowIso = now.toISOString();
    const candidates = await this.#db
      .prepare(DUE_MONITORS_SQL)
      .bind(nowIso, nowIso, clampLimit(limit))
      .all<MonitorRow>();
    const rows = candidates.results ?? [];
    if (rows.length === 0) return [];
    const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
    const statements: D1StatementLike[] = [];
    const validRows: {
      readonly row: MonitorRow;
      readonly nextRunAt: string;
      readonly intervalMs: number;
    }[] = [];
    for (const row of rows) {
      try {
        const intervalMs =
          row.interval_seconds === null ? null : row.interval_seconds * 1_000;
        const priorDueMs = Date.parse(row.next_run_at);
        const futureNextMs =
          row.schedule_kind === "interval"
            ? priorDueMs +
              (Math.floor(
                Math.max(0, now.getTime() - priorDueMs) / intervalMs!,
              ) +
                1) *
                intervalMs!
            : nextRunAt(
                {
                  kind: "cron",
                  intervalMs: null,
                  expression: row.schedule_expression,
                },
                now.getTime(),
              );
        statements.push(
          this.#db
            .prepare(CLAIM_MONITOR_SQL)
            .bind(owner, leaseUntil, nowIso, row.monitor_id, nowIso, nowIso),
        );
        const cadenceMs =
          intervalMs ??
          nextRunAt(
            {
              kind: row.schedule_kind,
              intervalMs,
              expression: row.schedule_expression,
            },
            futureNextMs,
          ) - futureNextMs;
        validRows.push({
          row,
          nextRunAt: new Date(futureNextMs).toISOString(),
          intervalMs: cadenceMs,
        });
      } catch {
        // An invalid schedule is configuration debt, not permission to invent a cadence.
      }
    }
    if (statements.length === 0) return [];
    const results = await this.#db.batch<{ monitor_id: string }>(statements);
    const claimed: ClaimedMonitor[] = [];
    for (let index = 0; index < results.length; index += 1) {
      if ((results[index]?.results?.length ?? 0) === 0) continue;
      const row = validRows[index]!;
      const locations = await this.#db
        .prepare(
          "SELECT location FROM monitor_locations WHERE monitor_id=? AND enabled=1 ORDER BY location",
        )
        .bind(row.row.monitor_id)
        .all<{ location: string }>();
      claimed.push({
        ...toClaimedMonitor(row.row, row.nextRunAt, row.intervalMs),
        locations: (locations.results ?? []).map((value) => value.location),
      });
    }
    return claimed;
  }

  async readCheckpoint(
    monitorId: string,
    location: string,
  ): Promise<MonitorCheckpoint | null> {
    const row = await this.#db
      .prepare(READ_CHECKPOINT_SQL)
      .bind(monitorId, location)
      .first<CheckpointRow>();
    return row === null ? null : toCheckpoint(row);
  }

  async readCheckpoints(
    monitorId: string,
  ): Promise<readonly MonitorCheckpoint[]> {
    const result = await this.#db
      .prepare(READ_CHECKPOINTS_SQL)
      .bind(monitorId)
      .all<CheckpointRow>();
    return (result.results ?? []).map(toCheckpoint);
  }

  async ownsLease(
    monitor: ClaimedMonitor,
    owner: string,
    now: Date,
  ): Promise<boolean> {
    const row = await this.#db
      .prepare(OWNS_MONITOR_LEASE_SQL)
      .bind(monitor.monitorId, owner, monitor.scheduledFor, now.toISOString())
      .first<{ owned: number }>();
    return row?.owned === 1;
  }

  async writeCheckpoint(checkpoint: MonitorCheckpoint): Promise<void> {
    const statements = checkpointStatements(this.#db, checkpoint);
    await this.#db.batch(statements);
  }

  async commitEvaluation(
    monitor: ClaimedMonitor,
    checkpoint: MonitorCheckpoint | readonly MonitorCheckpoint[],
    owner: string,
    now: Date,
  ): Promise<void> {
    await this.#db.batch([
      this.#db
        .prepare(ASSERT_MONITOR_LEASE_SQL)
        .bind(
          `monitor:${monitor.monitorId}:${owner}`,
          monitor.monitorId,
          owner,
          monitor.scheduledFor,
          now.toISOString(),
          monitor.policy.policyId,
          monitor.policy.revision,
          monitor.claimRevision ?? -1,
          monitor.monitorId,
          JSON.stringify([...monitor.locations].sort()),
        ),
      ...(Array.isArray(checkpoint) ? checkpoint : [checkpoint]).flatMap(
        (value) => checkpointStatements(this.#db, value),
      ),
      this.#db
        .prepare(COMPLETE_MONITOR_SQL)
        .bind(
          monitor.scheduledFor,
          monitor.nextRunAt,
          now.toISOString(),
          monitor.monitorId,
          owner,
        ),
    ]);
  }

  async release(monitorId: string, owner: string, now: Date): Promise<void> {
    await this.#db
      .prepare(RELEASE_MONITOR_SQL)
      .bind(now.toISOString(), monitorId, owner)
      .run();
  }

  async complete(
    monitor: ClaimedMonitor,
    owner: string,
    now: Date,
  ): Promise<void> {
    await this.#db
      .prepare(COMPLETE_MONITOR_SQL)
      .bind(
        monitor.scheduledFor,
        monitor.nextRunAt,
        now.toISOString(),
        monitor.monitorId,
        owner,
      )
      .run();
  }

  async claimOutbox(
    now: Date,
    owner: string,
    leaseMs: number,
    limit: number,
  ): Promise<readonly OutboxEvent[]> {
    const nowIso = now.toISOString();
    const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
    const result = await this.#db
      .prepare(CLAIM_OUTBOX_SQL)
      .bind(owner, leaseUntil, nowIso, nowIso, clampLimit(limit))
      .all<OutboxRow>();
    return (result.results ?? []).map((row) => ({
      outboxId: row.outbox_id,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      eventType: row.event_type,
      schemaVersion: row.schema_version,
      payload: parseObject(row.payload_json),
      attempt: row.attempt_count,
    }));
  }

  async markOutboxDelivered(
    outboxId: string,
    owner: string,
    now: Date,
  ): Promise<void> {
    await this.#db
      .prepare(MARK_OUTBOX_DELIVERED_SQL)
      .bind(now.toISOString(), outboxId, owner)
      .run();
  }

  async markOutboxFailed(
    outboxId: string,
    owner: string,
    nextAttempt: Date,
    errorType: string,
    dead: boolean,
  ): Promise<void> {
    await this.#db
      .prepare(MARK_OUTBOX_FAILED_SQL)
      .bind(
        dead ? "dead" : "pending",
        nextAttempt.toISOString(),
        errorType.slice(0, 128),
        outboxId,
        owner,
      )
      .run();
  }

  async selectRetentionCandidates(
    now: Date,
    limit: number,
  ): Promise<readonly RetentionCandidate[]> {
    const result = await this.#db
      .prepare(RETENTION_CANDIDATES_SQL)
      .bind(now.toISOString(), clampLimit(limit))
      .all<RetentionRow>();
    const perRevision = new Map<string, number>();
    return (result.results ?? []).flatMap((row) => {
      const revision = `${row.retention_policy_id}:${row.retention_policy_revision}`;
      const count = perRevision.get(revision) ?? 0;
      if (count >= row.cleanup_batch_size) return [];
      perRevision.set(revision, count + 1);
      return [
        {
          occurrenceId: row.occurrence_id,
          policyId: row.retention_policy_id,
          policyRevision: row.retention_policy_revision,
          purgeAfter: row.purge_after,
        },
      ];
    });
  }

  async purgeRetentionCandidates(
    candidates: readonly RetentionCandidate[],
    now: Date,
  ): Promise<number> {
    if (candidates.length === 0) return 0;
    const nowIso = now.toISOString();
    const results = await this.#db.batch(
      candidates.map((candidate) =>
        this.#db
          .prepare(PURGE_OCCURRENCE_SQL)
          .bind(
            candidate.occurrenceId,
            candidate.policyId,
            candidate.policyRevision,
            candidate.purgeAfter,
            nowIso,
          ),
      ),
    );
    return results.reduce(
      (sum, result) => sum + (result.meta?.changes ?? 0),
      0,
    );
  }

  async enqueueExpiredReevaluations(
    now: Date,
    limit: number,
    id: (timeMs: number, seed: string) => Promise<string>,
  ): Promise<number> {
    const nowIso = now.toISOString();
    const snapshot = await this.#db
      .prepare(
        "SELECT generation FROM evaluation_generation WHERE singleton_id=1",
      )
      .first<{ generation: number }>();
    if (!snapshot) throw new Error("evaluation_generation_missing");
    const result = await this.#db
      .prepare(EXPIRED_TARGETS_SQL)
      .bind(nowIso, nowIso, nowIso, nowIso, nowIso, clampLimit(limit))
      .all<ExpiredRow>();
    const rows = result.results ?? [];
    if (rows.length === 0) return 0;
    // 完整源对象为一批，且目录/维护并发编辑必须重试，不可丢失目标。 / Batch complete sources and reject concurrent catalog or maintenance edits.
    const statements: D1StatementLike[] = [
      this.#db
        .prepare(
          "INSERT INTO transaction_assertions(assertion_id,passed) SELECT ?, CASE WHEN generation=? THEN 1 ELSE 0 END FROM evaluation_generation WHERE singleton_id=1",
        )
        .bind(`expiry:${nowIso}`, snapshot.generation),
    ];
    const countsAsOutbox: boolean[] = [false];
    for (const maintenanceId of new Set(
      rows
        .filter((row) => row.event_type === "maintenance.expired")
        .map((row) => row.source_id),
    )) {
      statements.push(
        this.#db
          .prepare(COMPLETE_MAINTENANCE_SQL)
          .bind(nowIso, maintenanceId, nowIso),
      );
      countsAsOutbox.push(false);
    }
    for (const maintenanceId of new Set(
      rows
        .filter((row) => row.event_type === "maintenance.started")
        .map((row) => row.source_id),
    )) {
      statements.push(
        this.#db
          .prepare(ACTIVATE_MAINTENANCE_SQL)
          .bind(nowIso, maintenanceId, nowIso, nowIso),
      );
      countsAsOutbox.push(false);
    }
    for (const row of rows) {
      const outboxId = await id(
        now.getTime(),
        `temporal:${row.event_type}:${row.source_id}:${row.source_revision}:${row.target_type}:${row.target_id}`,
      );
      const payload = JSON.stringify({
        source_type: row.source_type,
        source_id: row.source_id,
        source_revision: row.source_revision,
        target_type: row.target_type,
        target_id: row.target_id,
      });
      statements.push(
        this.#db
          .prepare(INSERT_EXPIRY_OUTBOX_SQL)
          .bind(
            outboxId,
            row.target_id,
            row.event_type,
            payload,
            nowIso,
            nowIso,
            nowIso,
          ),
      );
      countsAsOutbox.push(true);
    }
    const inserted = await this.#db.batch(statements);
    return inserted.reduce(
      (sum, entry, index) =>
        sum + (countsAsOutbox[index] ? (entry.meta?.changes ?? 0) : 0),
      0,
    );
  }
}

interface MonitorRow {
  readonly monitor_revision: number;
  readonly monitor_id: string;
  readonly target_type: "service" | "component";
  readonly target_id: string;
  readonly service_name: string;
  readonly probe_kind: ProbeSpec["kind"];
  readonly probe_config_json: string;
  readonly environment: "development" | "test" | "staging" | "production";
  readonly timeout_ms: number;
  readonly schedule_kind: "interval" | "cron";
  readonly schedule_expression: string | null;
  readonly interval_seconds: number | null;
  readonly next_run_at: string;
  readonly critical: number;
  readonly deployment_id: string | null;
  readonly policy_id: string;
  readonly policy_revision: number;
  readonly observation_window_seconds: number;
  readonly minimum_samples: number;
  readonly failure_threshold: number;
  readonly recovery_threshold: number;
  readonly latency_threshold_ms: number | null;
  readonly stale_after_seconds: number;
  readonly location_quorum: number;
  readonly fingerprint_template_json: string;
  readonly status_mapping_json: string;
}

interface CheckpointRow {
  readonly monitor_id: string;
  readonly location: string;
  readonly executor_id: string | null;
  readonly actual_colo: string | null;
  readonly window_started_at: string;
  readonly last_observed_at: string;
  readonly consecutive_successes: number;
  readonly consecutive_failures: number;
  readonly window_samples: number;
  readonly window_unhealthy_samples: number;
  readonly window_latency_p95_ms: number | null;
  readonly evaluation_status: MonitorCheckpoint["evaluationStatus"];
  readonly evaluated_at: string;
  readonly fresh_until: string;
  readonly policy_id: string;
  readonly policy_revision: number;
  readonly revision: number;
}

interface OutboxRow {
  readonly outbox_id: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly event_type: string;
  readonly schema_version: string;
  readonly payload_json: string;
  readonly attempt_count: number;
}

interface RetentionRow {
  readonly occurrence_id: string;
  readonly retention_policy_id: string;
  readonly retention_policy_revision: number;
  readonly purge_after: string;
  readonly cleanup_batch_size: number;
}

interface ExpiredRow {
  readonly source_type: "maintenance" | "override" | "suppression";
  readonly source_id: string;
  readonly source_revision: number;
  readonly target_type: "service" | "component";
  readonly target_id: string;
  readonly event_type:
    | "maintenance.started"
    | "maintenance.expired"
    | "override.expired"
    | "suppression.expired";
}

function toClaimedMonitor(
  row: MonitorRow,
  nextRunAtValue: string,
  intervalMs: number,
): ClaimedMonitor {
  const policy: EvaluationPolicy = {
    policyId: row.policy_id,
    revision: row.policy_revision,
    observationWindowMs: row.observation_window_seconds * 1_000,
    minimumSamples: row.minimum_samples,
    failureThreshold: row.failure_threshold,
    recoveryThreshold: row.recovery_threshold,
    latencyThresholdMs: row.latency_threshold_ms,
    staleAfterMs: row.stale_after_seconds * 1_000,
    locationQuorum: row.location_quorum,
    fingerprintTemplate: parseObject(row.fingerprint_template_json),
    statusMapping: parseObject(row.status_mapping_json),
  };
  return {
    monitorId: row.monitor_id,
    locations: [],
    claimRevision: row.monitor_revision + 1,
    target: {
      type: row.target_type,
      id: row.target_id,
      serviceName: row.service_name,
    },
    probe: parseProbe(row.probe_kind, row.probe_config_json),
    timeoutMs: row.timeout_ms,
    intervalMs,
    scheduledFor: row.next_run_at,
    nextRunAt: nextRunAtValue,
    critical: row.critical === 1,
    policy,
    ...(row.deployment_id === null
      ? {}
      : { deploymentId: row.deployment_id, environment: row.environment }),
  };
}

function toCheckpoint(row: CheckpointRow): MonitorCheckpoint {
  return {
    monitorId: row.monitor_id,
    location: row.location,
    ...(row.executor_id ? { executorId: row.executor_id } : {}),
    ...(row.actual_colo ? { actualColo: row.actual_colo } : {}),
    windowStartedAt: row.window_started_at,
    lastObservedAt: row.last_observed_at,
    consecutiveSuccesses: row.consecutive_successes,
    consecutiveFailures: row.consecutive_failures,
    windowSamples: row.window_samples,
    windowUnhealthySamples: row.window_unhealthy_samples,
    windowLatencyP95Ms: row.window_latency_p95_ms,
    evaluationStatus: row.evaluation_status,
    evaluatedAt: row.evaluated_at,
    freshUntil: row.fresh_until,
    policyId: row.policy_id,
    policyRevision: row.policy_revision,
    revision: row.revision,
  };
}

function checkpointStatements(
  db: D1DatabaseLike,
  checkpoint: MonitorCheckpoint,
): D1StatementLike[] {
  return [
    db
      .prepare(
        "INSERT INTO transaction_assertions(assertion_id, passed) SELECT ?, CASE WHEN EXISTS(SELECT 1 FROM monitor_locations WHERE monitor_id=? AND location=? AND enabled=1) THEN 1 ELSE 0 END",
      )
      .bind(
        `location:${checkpoint.monitorId}:${checkpoint.location}`,
        checkpoint.monitorId,
        checkpoint.location,
      ),
    db
      .prepare(UPSERT_CHECKPOINT_SQL)
      .bind(
        checkpoint.monitorId,
        checkpoint.location,
        checkpoint.lastObservedAt,
        checkpoint.consecutiveSuccesses,
        checkpoint.consecutiveFailures,
        checkpoint.windowSamples,
        checkpoint.windowUnhealthySamples,
        checkpoint.windowStartedAt,
        checkpoint.windowLatencyP95Ms,
        checkpoint.evaluationStatus,
        checkpoint.evaluatedAt,
        checkpoint.freshUntil,
        checkpoint.policyId,
        checkpoint.policyRevision,
        checkpoint.executorId ?? null,
        checkpoint.actualColo ?? null,
      ),
  ];
}

function parseProbe(kind: ProbeSpec["kind"], json: string): ProbeSpec {
  const config = parseObject(json);
  switch (kind) {
    case "http":
      return {
        kind,
        url: stringValue(config.url),
        method: config.method === "GET" ? "GET" : "HEAD",
        expectedStatuses: numberList(config.expected_statuses),
        maxRedirects: numberValue(config.max_redirects, 0),
      };
    case "tcp":
      return {
        kind,
        hostname: stringValue(config.hostname),
        port: numberValue(config.port, 0),
      };
    case "dns":
      return {
        kind,
        hostname: stringValue(config.hostname),
        recordType: config.record_type === "AAAA" ? "AAAA" : "A",
      };
    case "rpc":
      return {
        kind,
        binding: stringValue(config.binding),
        operation: stringValue(config.operation),
      };
    case "synthetic":
      return {
        kind,
        binding: stringValue(config.binding),
        scenario: stringValue(config.scenario),
      };
  }
}

function parseObject(json: string): Readonly<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : {};
  } catch {
    return {};
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function numberList(value: unknown): readonly number[] {
  return Array.isArray(value)
    ? value
        .filter(
          (entry): entry is number =>
            Number.isInteger(entry) && entry >= 100 && entry <= 599,
        )
        .slice(0, 32)
    : [];
}

function clampLimit(limit: number): number {
  return Math.max(1, Math.min(Math.floor(limit), 500));
}

const DUE_MONITORS_SQL = `
SELECT m.monitor_id, m.revision AS monitor_revision, m.target_type, m.target_id,
       COALESCE(st.service_name, c.service_name) AS service_name,
       m.probe_kind, m.probe_config_json, m.environment, m.timeout_ms,
       m.schedule_kind, m.schedule_expression, m.interval_seconds,
       m.next_run_at, m.critical, sed.deployment_id,
       p.policy_id, p.revision AS policy_revision,
       p.observation_window_seconds, p.minimum_samples, p.failure_threshold,
       p.recovery_threshold, p.latency_threshold_ms, p.stale_after_seconds,
       p.location_quorum, p.fingerprint_template_json, p.status_mapping_json
FROM monitors AS m
JOIN status_targets AS st ON st.target_type = m.target_type AND st.target_id = m.target_id
LEFT JOIN components AS c ON c.component_id = st.component_id
JOIN evaluation_policies AS p ON p.policy_id = m.policy_id AND p.revision = m.policy_revision
LEFT JOIN service_environment_deployments AS sed
  ON sed.service_name = COALESCE(st.service_name, c.service_name) AND sed.environment = m.environment
WHERE m.enabled = 1 AND m.next_run_at <= ?
  AND (m.lease_expires_at IS NULL OR m.lease_expires_at <= ?)
ORDER BY m.next_run_at, m.monitor_id LIMIT ?`;

const CLAIM_MONITOR_SQL = `
UPDATE monitors SET lease_owner = ?, lease_expires_at = ?, updated_at = ?, revision = revision + 1
WHERE monitor_id = ? AND enabled = 1 AND next_run_at <= ?
  AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
RETURNING monitor_id`;

const RELEASE_MONITOR_SQL = `UPDATE monitors SET lease_owner = NULL, lease_expires_at = NULL,
updated_at = ?, revision = revision + 1 WHERE monitor_id = ? AND lease_owner = ?`;

const ASSERT_MONITOR_LEASE_SQL = `INSERT INTO transaction_assertions(assertion_id, passed)
SELECT ?, CASE WHEN EXISTS(SELECT 1 FROM monitors WHERE monitor_id=? AND lease_owner=? AND next_run_at=? AND lease_expires_at>? AND policy_id=? AND policy_revision=? AND revision=? AND enabled=1) AND (SELECT json_group_array(location) FROM (SELECT location FROM monitor_locations WHERE monitor_id=? AND enabled=1 ORDER BY location))=? THEN 1 ELSE 0 END`;

const COMPLETE_MONITOR_SQL = `UPDATE monitors SET last_run_at = ?, next_run_at = ?,
lease_owner = NULL, lease_expires_at = NULL, updated_at = ?, revision = revision + 1
WHERE monitor_id = ? AND lease_owner = ?`;

const READ_CHECKPOINT_SQL = `SELECT * FROM monitor_checkpoints WHERE monitor_id = ? AND location = ?`;
const READ_CHECKPOINTS_SQL = `SELECT * FROM monitor_checkpoints WHERE monitor_id = ? ORDER BY location`;
const OWNS_MONITOR_LEASE_SQL = `SELECT 1 AS owned FROM monitors
WHERE monitor_id=? AND lease_owner=? AND next_run_at=? AND lease_expires_at>?`;

const UPSERT_CHECKPOINT_SQL = `
INSERT INTO monitor_checkpoints(
  monitor_id, location, last_observed_at, consecutive_successes, consecutive_failures,
  window_samples, window_unhealthy_samples, window_started_at, window_latency_p95_ms,
  evaluation_status, evaluated_at, fresh_until, policy_id, policy_revision, executor_id, actual_colo, revision
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
ON CONFLICT(monitor_id, location) DO UPDATE SET
  executor_id = excluded.executor_id,
  actual_colo = excluded.actual_colo,
  last_observed_at = excluded.last_observed_at,
  consecutive_successes = excluded.consecutive_successes,
  consecutive_failures = excluded.consecutive_failures,
  window_samples = excluded.window_samples,
  window_unhealthy_samples = excluded.window_unhealthy_samples,
  window_started_at = excluded.window_started_at,
  window_latency_p95_ms = excluded.window_latency_p95_ms,
  evaluation_status = excluded.evaluation_status,
  evaluated_at = excluded.evaluated_at,
  fresh_until = excluded.fresh_until,
  policy_id = excluded.policy_id,
  policy_revision = excluded.policy_revision,
  revision = monitor_checkpoints.revision + 1`;

const CLAIM_OUTBOX_SQL = `
UPDATE outbox SET state = 'processing', attempt_count = attempt_count + 1,
  lease_owner = ?, lease_expires_at = ?, last_error = NULL
WHERE outbox_id IN (
  SELECT outbox_id FROM outbox
  WHERE ((state = 'pending' AND next_attempt_at <= ?) OR (state = 'processing' AND lease_expires_at <= ?))
  ORDER BY next_attempt_at, created_at LIMIT ?
)
RETURNING outbox_id, aggregate_type, aggregate_id, event_type, schema_version, payload_json, attempt_count`;

const MARK_OUTBOX_DELIVERED_SQL = `UPDATE outbox SET state = 'delivered', delivered_at = ?,
lease_owner = NULL, lease_expires_at = NULL WHERE outbox_id = ? AND state = 'processing' AND lease_owner = ?`;

const MARK_OUTBOX_FAILED_SQL = `UPDATE outbox SET state = ?, next_attempt_at = ?, last_error = ?,
lease_owner = NULL, lease_expires_at = NULL WHERE outbox_id = ? AND state = 'processing' AND lease_owner = ?`;

const RETENTION_CANDIDATES_SQL = `
SELECT o.occurrence_id, o.retention_policy_id, o.retention_policy_revision, o.purge_after,
       p.cleanup_batch_size
FROM issue_occurrences AS o
JOIN data_retention_policies AS p
  ON p.policy_id = o.retention_policy_id AND p.revision = o.retention_policy_revision
WHERE o.purge_after <= ?
  AND NOT EXISTS (SELECT 1 FROM incident_occurrences AS pin WHERE pin.occurrence_id = o.occurrence_id)
ORDER BY o.purge_after, o.occurrence_id LIMIT ?`;

const PURGE_OCCURRENCE_SQL = `DELETE FROM issue_occurrences
WHERE occurrence_id = ? AND retention_policy_id = ? AND retention_policy_revision = ?
  AND purge_after = ? AND purge_after <= ?
  AND NOT EXISTS (SELECT 1 FROM incident_occurrences AS pin WHERE pin.occurrence_id = issue_occurrences.occurrence_id)`;

const EXPIRED_TARGETS_SQL = `
WITH maintenance_expanded AS (
  SELECT mw.maintenance_id,mw.revision,mw.state,mw.starts_at,mw.ends_at,mt.target_type,mt.target_id
  FROM maintenance_windows mw JOIN maintenance_targets mt USING(maintenance_id)
  UNION
  SELECT mw.maintenance_id,mw.revision,mw.state,mw.starts_at,mw.ends_at,'component',c.component_id
  FROM maintenance_windows mw JOIN maintenance_targets mt USING(maintenance_id)
  JOIN components c ON mt.target_type='service' AND c.service_name=mt.target_id
), temporal AS (
  SELECT 'maintenance' AS source_type, maintenance_id AS source_id, revision AS source_revision,target_type, target_id,
         'maintenance.started' AS event_type
  FROM maintenance_expanded WHERE state='scheduled' AND starts_at<=? AND ends_at>?
  UNION ALL
  SELECT 'maintenance', maintenance_id, revision,target_type, target_id, 'maintenance.expired'
  FROM maintenance_expanded WHERE state IN ('scheduled','active') AND ends_at<=?
  UNION ALL
  SELECT 'override', so.override_id, so.revision,so.target_type, so.target_id, 'override.expired'
  FROM status_overrides AS so
  WHERE so.revoked_at IS NULL AND so.expires_at <= ?
  UNION ALL
  SELECT 'suppression', i.issue_id, i.revision,'service', i.service_name, 'suppression.expired'
  FROM issues AS i WHERE i.state = 'suppressed' AND i.suppression_until <= ?
), pending AS (
SELECT source_type,source_id,source_revision,target_type,target_id,event_type FROM temporal
WHERE NOT EXISTS (
  SELECT 1 FROM outbox AS o
  WHERE o.aggregate_type = 'status_target' AND o.aggregate_id = temporal.target_id
    AND o.event_type = temporal.event_type
    AND json_extract(o.payload_json, '$.source_id') = temporal.source_id
    AND json_extract(o.payload_json, '$.source_revision') = temporal.source_revision
)), selected_sources AS (
  SELECT DISTINCT source_type,source_id,source_revision,event_type FROM pending
  ORDER BY source_type,source_id,event_type LIMIT ?
)
SELECT pending.* FROM pending JOIN selected_sources USING(source_type,source_id,source_revision,event_type)
ORDER BY source_type,source_id,target_type,target_id`;

const INSERT_EXPIRY_OUTBOX_SQL = `INSERT OR IGNORE INTO outbox(
outbox_id, aggregate_type, aggregate_id, event_type, schema_version, payload_json,
state, attempt_count, available_at, next_attempt_at, created_at
) VALUES (?, 'status_target', ?, ?, '1.0', ?, 'pending', 0, ?, ?, ?)`;

const COMPLETE_MAINTENANCE_SQL = `UPDATE maintenance_windows
SET state = 'completed', updated_at = ?, revision = revision + 1
WHERE maintenance_id = ? AND state IN ('scheduled', 'active') AND ends_at <= ?`;

const ACTIVATE_MAINTENANCE_SQL = `UPDATE maintenance_windows
SET state = 'active', updated_at = ?, revision = revision + 1
WHERE maintenance_id = ? AND state = 'scheduled' AND starts_at <= ? AND ends_at > ?`;

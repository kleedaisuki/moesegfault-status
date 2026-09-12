import { deterministicUuidV7 } from "./identity.js";
import type { TargetReevaluator } from "./jobs.js";
import type { D1DatabaseLike, D1StatementLike } from "./store.js";
import type {
  ClaimedMonitor,
  MonitorEvaluationResult,
  Observation,
  RustDispatcher,
  StatusTarget,
} from "./types.js";

export type DomainStatus =
  | "operational"
  | "degraded"
  | "partial_outage"
  | "major_outage"
  | "maintenance"
  | "unknown";

/** 单次全信号评估中的 Issue 状态覆盖。 / Issue-state overlay for one full-signal evaluation. */
export interface IssueStateOverlay {
  /** 被同一事务修改的 Issue。 / Issue mutated by the same transaction. */
  readonly issueId: string;
  /** 提交后的状态；非公开状态会从状态输入中移除。 / Post-commit state; non-public states are removed from status inputs. */
  readonly state:
    "observed" | "active" | "recovering" | "suppressed" | "resolved";
  /** 提交后的严重度。 / Post-commit severity. */
  readonly severity: "info" | "warning" | "error" | "critical";
  /** 规范 fingerprint，用于 component monitor 归属过滤。 / Canonical fingerprint used by component-monitor ownership filtering. */
  readonly fingerprintHash: string;
  /** 固定策略规则；新 Issue 尚未存在于快照时也可完整求值。 / Pinned policy rules, including for an Issue absent from the snapshot. */
  readonly diagnosticRulesJson: string;
}

/** 尚未提交的维护窗口快照。 / Uncommitted maintenance-window snapshot. */
export interface MaintenanceEvaluationOverlay {
  /** 稳定窗口身份。 / Stable window identity. */
  readonly maintenanceId: string;
  /** 提交后的生命周期状态。 / Post-commit lifecycle state. */
  readonly state: "scheduled" | "active" | "completed" | "cancelled";
  /** 生效起点。 / Inclusive activation instant. */
  readonly startsAt: string;
  /** 生效终点。 / Exclusive expiration instant. */
  readonly endsAt: string;
  /** 提交后的完整目标集合。 / Complete post-commit target set. */
  readonly targets: readonly {
    /** 目标种类。 / Target kind. */
    readonly type: "service" | "component";
    /** 目标身份。 / Target identity. */
    readonly id: string;
  }[];
}

/** 尚未提交的人工状态覆盖。 / Uncommitted operator-status override. */
export interface OverrideEvaluationOverlay {
  /** 稳定覆盖身份。 / Stable override identity. */
  readonly overrideId: string;
  /** 覆盖所属目标。 / Target owning the override. */
  readonly target: {
    /** 目标种类。 / Target kind. */
    readonly type: "service" | "component";
    /** 目标身份。 / Target identity. */
    readonly id: string;
  };
  /** 人工选择的直接状态。 / Operator-selected direct status. */
  readonly status: Exclude<DomainStatus, "maintenance">;
  /** 生效起点。 / Inclusive activation instant. */
  readonly startsAt: string;
  /** 生效终点。 / Exclusive expiration instant. */
  readonly expiresAt: string;
  /** 提交后是否已撤销。 / Whether the override is revoked after commit. */
  readonly revoked: boolean;
  /** aggregate_status 要求的审计身份。 / Audit identity required by aggregate_status. */
  readonly auditId: string;
}

/** 共享状态规划器的可选上下文。 / Optional context for the shared status planner. */
export interface StatusEvaluationOptions {
  /** 同一事务尚未提交的 Issue 状态。 / Issue state not yet committed in the same transaction. */
  readonly issue?: IssueStateOverlay;
  /** 同一事务尚未提交的维护窗口。 / Maintenance window not yet committed in the same transaction. */
  readonly maintenance?: MaintenanceEvaluationOverlay;
  /** 同一事务尚未提交的人工覆盖。 / Operator override not yet committed in the same transaction. */
  readonly override?: OverrideEvaluationOverlay;
  /** 触发本次评估的固定策略及证据 freshness。 / Pinned policy and evidence freshness causing this evaluation. */
  readonly policy?: {
    /** 不可变策略身份。 / Immutable policy identity. */
    readonly policyId: string;
    /** 不可变策略修订。 / Immutable policy revision. */
    readonly policyRevision: number;
    /** 本次证据可被视为新鲜的截止时间。 / Instant until which this evidence remains fresh. */
    readonly freshUntil: string;
  };
  /** 调用方固定的评估时间。 / Caller-pinned evaluation time. */
  readonly evaluatedAt?: string;
  /** 可选取消信号。 / Optional cancellation signal. */
  readonly signal?: AbortSignal;
  /** 可选 Diagnostic claim；使共享计划在重复投递时成为无操作。 / Optional Diagnostic claim making the shared plan a no-op on duplicate delivery. */
  readonly ownership?: {
    /** 不可变 Diagnostic 身份。 / Immutable Diagnostic identity. */
    readonly eventId: string;
    /** 本 consumer 尝试持有的 claim token。 / Claim token owned by this consumer attempt. */
    readonly processingToken: string;
  };
}

/** 状态规划器返回的可观测量，不代表提交成功。 / Status-planner measurements that do not imply commit success. */
export interface StatusEvaluationMetrics {
  /** 读取快照并运行纯领域聚合的耗时。 / Time spent reading the snapshot and running pure domain aggregation. */
  readonly durationMs: number;
  /** 若 batch 成功将追加的 transition 数。 / Number of transitions appended if the batch commits. */
  readonly transitionCount: 0 | 1;
  /** overlay 表示快照中不存在的新 Issue 时为一。 / One when the overlay represents an Issue absent from the snapshot. */
  readonly issueCreationCount: 0 | 1;
}

/** 可选、尽力而为的评估观测器；观测失败绝不回滚领域提交。 / Optional best-effort evaluation observer; observer failure never rolls back domain commits. */
export interface StatusEvaluationObserver {
  /** 记录无副作用规划，不得称为已提交。 / Record side-effect-free planning, never as a commit. */
  planned(
    target: { readonly type: "service" | "component"; readonly id: string },
    metrics: StatusEvaluationMetrics,
  ): void;
  /** 只在 standalone batch 成功后记录提交。 / Record a commit only after the standalone batch succeeds. */
  committed(
    target: { readonly type: "service" | "component"; readonly id: string },
    metrics: StatusEvaluationMetrics,
  ): void;
}

/** 已基于一致快照计算、可并入一个 D1 batch 的写计划。 / Write plan computed from one consistent snapshot and embeddable in one D1 batch. */
export interface D1StatusEvaluationPlan {
  /** 快照的全局输入代数。 / Global input generation of the snapshot. */
  readonly generation: number;
  /** 必须位于所有领域写入之前的乐观并发 guard。 / Optimistic-concurrency guard that must precede every domain write. */
  readonly guard: D1StatementLike;
  /** current status、transition、audit 与 outbox 写入。 / Current-status, transition, audit, and outbox writes. */
  readonly writes: D1StatementLike[];
  /** 规划得到的直接状态。 / Planned direct status. */
  readonly directStatus: DomainStatus;
  /** 无副作用的规划测量；提交计数只能由成功 batch 的调用方记录。 / Side-effect-free planning measurements; only a successful batch caller may record commit counts. */
  readonly metrics: StatusEvaluationMetrics;
}

/** 成功/失败 observation 后 probe-owned Issue 生命周期协调器。 / Lifecycle coordinator for probe-owned Issues after successful or failed observations. */
export interface ProbeIssueLifecycle {
  /** 成功证据推进 recovering/resolved；失败仍由共享 Diagnostic aggregator 处理。 / Success evidence advances recovering/resolved; failure remains owned by the shared Diagnostic aggregator. */
  apply(
    monitor: ClaimedMonitor,
    observation: Observation,
    evaluation: MonitorEvaluationResult,
  ): Promise<void>;
}

/** 使用 Rust issue_transition，并把因果 Issue 恢复与全信号状态计划原子写入 D1。 / Use Rust issue_transition and atomically persist causal Issue recovery with full-signal status plans. */
export class D1ProbeIssueLifecycle implements ProbeIssueLifecycle {
  readonly #db: D1DatabaseLike;
  readonly #core: RustDispatcher;

  constructor(db: D1DatabaseLike, core: RustDispatcher) {
    this.#db = db;
    this.#core = core;
  }

  async apply(
    monitor: ClaimedMonitor,
    observation: Observation,
    evaluation: MonitorEvaluationResult,
  ): Promise<void> {
    if (observation.outcome !== "success") return;
    const fingerprint = probeFingerprint(monitor);
    const canonical = parseObject(
      this.#core.dispatchJson(
        JSON.stringify({
          operation: "canonical_fingerprint",
          payload: {
            kind: "health.probe_failed",
            service_name: monitor.target.serviceName,
            fingerprint,
          },
        }),
      ),
    );
    if (typeof canonical.hash !== "string")
      throw new Error("invalid_fingerprint_result");
    const row = await this.#db
      .prepare(READ_PROBE_ISSUE_SQL)
      .bind(monitor.target.serviceName, canonical.hash)
      .first<IssueRow>();
    if (row === null) return;
    const observedAt = Date.parse(observation.observedAt);
    const faultAt = Date.parse(row.last_seen_at);
    if (
      row.last_fault_event_id === null ||
      !Number.isFinite(observedAt) ||
      !Number.isFinite(faultAt) ||
      observedAt <= faultAt
    )
      return;
    const command =
      row.state === "active"
        ? "begin_recovery"
        : row.state === "recovering" &&
            evaluation.checkpoint.evaluationStatus === "operational"
          ? "resolve"
          : null;
    if (command === null) return;
    const at = observation.observedAt;
    const transitioned = parseObject(
      this.#core.dispatchJson(
        JSON.stringify({
          operation: "issue_transition",
          payload: {
            issue: {
              issue_id: row.issue_id,
              fingerprint_hash: row.fingerprint_hash,
              service_name: row.service_name,
              kind: row.kind,
              impact: failureStatus(monitor.policy.statusMapping),
              state: row.state,
              first_seen_at: row.first_seen_at,
              last_seen_at: row.last_seen_at,
              occurrence_count: row.occurrence_count,
              policy_revision: `${row.policy_id}:${row.policy_revision}`,
              recurrence_of: row.recurrence_of_issue_id,
              suppressed_until: row.suppression_until,
              revision: row.revision,
            },
            expected_revision: row.revision,
            command,
            at,
          },
        }),
      ),
    );
    if (!isObject(transitioned.issue))
      throw new Error("invalid_issue_transition_result");
    const next = transitioned.issue;
    const nextState = next.state;
    const nextRevision = next.revision;
    if (
      (nextState !== "recovering" && nextState !== "resolved") ||
      typeof nextRevision !== "number"
    )
      throw new Error("invalid_issue_transition_result");
    const auditId = await deterministicUuidV7(
      Date.parse(at),
      `${row.issue_id}:${nextRevision}:recovery-audit`,
    );
    const outboxId = await deterministicUuidV7(
      Date.parse(at),
      `${row.issue_id}:${nextRevision}:recovery-outbox`,
    );
    const targetKeys = new Map<
      string,
      { readonly type: "service" | "component"; readonly id: string }
    >();
    targetKeys.set(`service:${row.service_name}`, {
      type: "service",
      id: row.service_name,
    });
    targetKeys.set(`${monitor.target.type}:${monitor.target.id}`, {
      type: monitor.target.type,
      id: monitor.target.id,
    });
    const reevaluator = new D1TargetReevaluator(this.#db, this.#core, () =>
      Date.parse(at),
    );
    const plans: D1StatusEvaluationPlan[] = [];
    for (const target of targetKeys.values())
      plans.push(
        await reevaluator.plan(
          target,
          { type: "observation", id: observation.observationId },
          {
            evaluatedAt: at,
            issue: {
              issueId: row.issue_id,
              state: nextState,
              severity: row.severity,
              fingerprintHash: row.fingerprint_hash,
              diagnosticRulesJson: row.diagnostic_rules_json,
            },
            policy: {
              policyId: monitor.policy.policyId,
              policyRevision: monitor.policy.revision,
              freshUntil: evaluation.checkpoint.freshUntil,
            },
          },
        ),
      );
    const guards = new Map<number, D1StatementLike>();
    for (const plan of plans)
      if (!guards.has(plan.generation)) guards.set(plan.generation, plan.guard);
    await this.#db.batch([
      ...guards.values(),
      this.#db
        .prepare(UPDATE_PROBE_ISSUE_SQL)
        .bind(
          nextState,
          nextState === "resolved" ? at : null,
          nextRevision,
          row.issue_id,
          row.revision,
        ),
      this.#db
        .prepare(ASSERT_ONE_CHANGE_SQL)
        .bind(`issue-recovery:${row.issue_id}:${nextRevision}`),
      this.#db
        .prepare(INSERT_RECOVERY_AUDIT_SQL)
        .bind(
          auditId,
          row.issue_id,
          row.revision,
          nextRevision,
          observation.correlationId,
          at,
          row.issue_id,
          nextRevision,
          nextState,
        ),
      this.#db.prepare(INSERT_RECOVERY_OUTBOX_SQL).bind(
        outboxId,
        row.issue_id,
        JSON.stringify({
          issue_id: row.issue_id,
          state: nextState,
          revision: nextRevision,
        }),
        at,
        at,
        at,
        row.issue_id,
        nextRevision,
        nextState,
      ),
      ...plans.flatMap((plan) => plan.writes),
    ]);
  }
}

/** 从 D1 当前 facts 调用 Rust aggregate_status 并写入状态快照/transition。 / Invoke Rust aggregate_status from current D1 facts and persist the snapshot/transition. */
export class D1TargetReevaluator implements TargetReevaluator {
  readonly #db: D1DatabaseLike;
  readonly #core: RustDispatcher;
  readonly #now: () => number;
  readonly #observer: StatusEvaluationObserver | undefined;

  constructor(
    db: D1DatabaseLike,
    core: RustDispatcher,
    now: () => number = Date.now,
    observer?: StatusEvaluationObserver,
  ) {
    this.#db = db;
    this.#core = core;
    this.#now = now;
    this.#observer = observer;
  }

  async reevaluate(
    target: { readonly type: "service" | "component"; readonly id: string },
    source: { readonly type: string; readonly id: string },
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) throw signal.reason;
    const now = new Date(this.#now()).toISOString();
    if (source.type === "suppression")
      await this.#expireSuppression(source.id, now);
    const plan = await this.plan(target, source, {
      evaluatedAt: now,
      signal,
    });
    if (signal.aborted) throw signal.reason;
    await this.#db.batch([plan.guard, ...plan.writes]);
    observeEvaluation(this.#observer, "committed", target, plan.metrics);
  }

  /**
   * 从一个完整 D1 快照规划状态写入，但不提交；调用方可把它与触发该状态的
   * Issue mutation 放进同一 batch。 / Plan status writes from one complete D1
   * snapshot without committing, allowing the caller to batch them with the
   * causal Issue mutation.
   */
  async plan(
    target: { readonly type: "service" | "component"; readonly id: string },
    source: { readonly type: string; readonly id: string },
    options: StatusEvaluationOptions = {},
  ): Promise<D1StatusEvaluationPlan> {
    const startedAt = performance.now();
    const signal = options.signal;
    throwIfAborted(signal);
    const now = options.evaluatedAt ?? new Date(this.#now()).toISOString();
    const results = await this.#db.batch([
      statement(this.#db, EVALUATION_GENERATION_SQL),
      statement(
        this.#db,
        ISSUE_SIGNALS_SQL,
        target.type,
        target.id,
        target.type,
        target.id,
        now,
        now,
        target.type,
        target.id,
        target.type,
        target.id,
      ),
      statement(
        this.#db,
        MAINTENANCE_SIGNALS_SQL,
        target.type,
        target.id,
        target.type,
        target.id,
        now,
        now,
      ),
      statement(this.#db, MONITOR_SIGNALS_SQL, target.type, target.id),
      statement(
        this.#db,
        OVERRIDE_SIGNAL_SQL,
        target.type,
        target.id,
        now,
        now,
      ),
      statement(this.#db, CURRENT_STATUS_SQL, target.type, target.id),
      statement(
        this.#db,
        SUPPORTING_SERVICE_STATUS_SQL,
        target.type,
        target.id,
      ),
      statement(
        this.#db,
        TARGET_CONTEXT_SQL,
        target.type,
        target.type,
        target.id,
      ),
      statement(this.#db, SERVICE_DIRECT_STATUSES_SQL),
      statement(this.#db, SERVICE_DEPENDENCIES_SQL),
      statement(
        this.#db,
        FANOUT_TARGETS_SQL,
        target.type,
        target.id,
        target.id,
        target.type,
        target.id,
      ),
    ]);
    throwIfAborted(signal);
    const generation = rows<{ generation: number }>(results[0])[0]?.generation;
    if (typeof generation !== "number" || !Number.isSafeInteger(generation))
      throw new Error("invalid_evaluation_generation");
    const targetContext = rows<{ service_name: string }>(results[7])[0];
    if (targetContext === undefined) throw new Error("unknown_status_target");
    const maintenanceRows = applyMaintenanceOverlay(
      rows<MaintenanceSignalRow>(results[2]),
      options.maintenance,
      target,
      targetContext.service_name,
      now,
    );
    const snapshotIssueRows = rows<IssueSignalRow>(results[1]);
    const overlayIssueId = options.issue?.issueId;
    const issueCreationCount =
      overlayIssueId !== undefined &&
      !snapshotIssueRows.some((row) => row.issue_id === overlayIssueId)
        ? 1
        : 0;
    const issueRows = applyIssueOverlay(
      snapshotIssueRows,
      options.issue,
      maintenanceRows.length > 0,
    );
    const monitorRows = rows<MonitorSignalRow>(results[3]);
    const override = applyOverrideOverlay(
      rows<OverrideRow>(results[4])[0],
      options.override,
      target,
      now,
    );
    const current = rows<CurrentStatusRow>(results[5])[0];
    const supportingServices = rows<SupportingServiceStatusRow>(results[6]);
    const serviceStatuses = rows<ServiceDirectStatusRow>(results[8]);
    const dependencies = rows<ServiceDependencyRow>(results[9]);
    const fanoutTargets = rows<FanoutTargetRow>(results[10]);
    const componentFingerprints =
      target.type === "component"
        ? new Set(
            monitorRows.map((row) => monitorFingerprintHash(this.#core, row)),
          )
        : null;
    const directIssues =
      componentFingerprints === null
        ? issueRows
        : issueRows.filter((row) =>
            componentFingerprints.has(row.fingerprint_hash),
          );
    const aggregateIssues = directIssues.map((row) => ({
      state: row.state,
      impact: issueImpact(row),
      covered_by_maintenance: row.covered_by_maintenance === 1,
    }));
    const direct = parseStatus(
      this.#core.dispatchJson(
        JSON.stringify({
          operation: "aggregate_status",
          payload: {
            issues: aggregateIssues,
            maintenance: maintenanceRows.map(() => ({ active: true })),
            monitors: aggregateMonitorSignals(monitorRows, now),
            operator_override:
              override === undefined
                ? null
                : {
                    status: override.status,
                    expires_at: override.expires_at,
                    audit_id: override.audit_id,
                  },
            evaluated_at: now,
          },
        }),
      ),
    );
    const freshness = [
      ...monitorRows.flatMap((row) =>
        row.fresh_until === null ? [] : [row.fresh_until],
      ),
      ...maintenanceRows.map((row) => row.fresh_until),
      ...(current?.fresh_until && current.fresh_until > now
        ? [current.fresh_until]
        : []),
      ...supportingServices.flatMap((row) =>
        row.fresh_until === null ? [] : [row.fresh_until],
      ),
      ...(options.policy === undefined ? [] : [options.policy.freshUntil]),
    ];
    const directFreshUntil = freshness.sort()[0] ?? now;
    const nextRevision = (current?.revision ?? 0) + 1;
    // Service graph risk is computed only from direct states; component support
    // consumes the already-persisted service effective plane. / 服务图只读取直接
    // 状态；component supporting 关系读取已持久化的 service effective 平面。
    const dependencyRisk =
      target.type === "component"
        ? supportingServiceRisk(supportingServices, now)
        : serviceDependencyRisk(
            this.#core,
            target.id,
            serviceStatuses,
            dependencies,
            direct,
            directFreshUntil,
            now,
          );
    const freshUntil =
      target.type === "service"
        ? dependencyFreshUntil(
            target.id,
            serviceStatuses,
            dependencies,
            directFreshUntil,
          )
        : directFreshUntil;
    const effective = effectiveImpact(direct, dependencyRisk);
    const transitioned = current?.effective_impact !== effective;
    const transitionId = await deterministicUuidV7(
      Date.parse(now),
      `${target.type}:${target.id}:${source.type}:${source.id}:${effective}`,
    );
    const auditId = await deterministicUuidV7(
      Date.parse(now),
      `${transitionId}:audit`,
    );
    const outboxId = await deterministicUuidV7(
      Date.parse(now),
      `${transitionId}:outbox`,
    );
    const ownership = options.ownership;
    const owned =
      ownership === undefined
        ? "1"
        : "EXISTS(SELECT 1 FROM diagnostic_event_dedup WHERE event_id=? AND processing_token=?)";
    const ownershipValues =
      ownership === undefined
        ? []
        : [ownership.eventId, ownership.processingToken];
    const writes: D1StatementLike[] = [
      statement(
        this.#db,
        UPSERT_CURRENT_STATUS_SQL.replaceAll("__OWNED__", owned),
        target.type,
        target.id,
        direct,
        dependencyRisk,
        effective,
        now,
        freshUntil,
        options.policy?.policyId ?? current?.policy_id ?? null,
        options.policy?.policyRevision ?? current?.policy_revision ?? null,
        ...ownershipValues,
        current?.revision ?? null,
        current?.revision ?? null,
      ),
      statement(
        this.#db,
        `INSERT INTO transaction_assertions(assertion_id,passed)
        VALUES (?,CASE WHEN NOT (${owned}) OR changes()=1 THEN 1 ELSE 0 END)`,
        `status-plan:${target.type}:${target.id}:${nextRevision}`,
        ...ownershipValues,
      ),
    ];
    if (transitioned) {
      writes.push(
        statement(
          this.#db,
          INSERT_STATUS_TRANSITION_SQL.replaceAll("__OWNED__", owned),
          transitionId,
          target.type,
          target.id,
          target.type,
          target.id,
          current?.effective_impact ?? null,
          effective,
          sourceType(source.type),
          source.id,
          options.policy?.policyId ?? current?.policy_id ?? null,
          options.policy?.policyRevision ?? current?.policy_revision ?? null,
          now,
          target.type,
          target.id,
          nextRevision,
          effective,
          ...ownershipValues,
        ),
      );
      writes.push(
        statement(
          this.#db,
          INSERT_STATUS_AUDIT_SQL.replaceAll("__OWNED__", owned),
          auditId,
          target.type,
          target.id,
          current?.revision ?? null,
          nextRevision,
          transitionId,
          now,
          target.type,
          target.id,
          nextRevision,
          effective,
          ...ownershipValues,
        ),
      );
      writes.push(
        statement(
          this.#db,
          INSERT_STATUS_OUTBOX_SQL.replaceAll("__OWNED__", owned),
          outboxId,
          target.type,
          target.id,
          JSON.stringify({
            target_type: target.type,
            target_id: target.id,
            status: effective,
            revision: nextRevision,
          }),
          now,
          now,
          now,
          target.type,
          target.id,
          nextRevision,
          effective,
          ...ownershipValues,
        ),
      );
      for (const fanout of fanoutTargets) {
        const fanoutId = await deterministicUuidV7(
          Date.parse(now),
          `${transitionId}:fanout:${fanout.target_type}:${fanout.target_id}`,
        );
        writes.push(
          statement(
            this.#db,
            INSERT_FANOUT_OUTBOX_SQL.replaceAll("__OWNED__", owned),
            fanoutId,
            fanout.target_type,
            fanout.target_id,
            JSON.stringify({
              target_type: fanout.target_type,
              target_id: fanout.target_id,
              source_type: "dependency",
              source_id: transitionId,
            }),
            now,
            now,
            now,
            target.type,
            target.id,
            nextRevision,
            effective,
            ...ownershipValues,
          ),
        );
      }
    }
    const metrics: StatusEvaluationMetrics = {
      durationMs: Math.max(0, performance.now() - startedAt),
      transitionCount: transitioned ? 1 : 0,
      issueCreationCount,
    };
    observeEvaluation(this.#observer, "planned", target, metrics);
    return {
      generation,
      guard: evaluationGenerationGuard(this.#db, generation),
      writes,
      directStatus: direct,
      metrics,
    };
  }

  async #expireSuppression(issueId: string, now: string): Promise<void> {
    const row = await this.#db
      .prepare(READ_SUPPRESSED_ISSUE_SQL)
      .bind(issueId, now)
      .first<SuppressedIssueRow>();
    if (row === null) return;
    const transitioned = parseObject(
      this.#core.dispatchJson(
        JSON.stringify({
          operation: "issue_transition",
          payload: {
            issue: {
              issue_id: row.issue_id,
              fingerprint_hash: row.fingerprint_hash,
              service_name: row.service_name,
              kind: row.kind,
              impact: issueImpact(row),
              state: row.state,
              first_seen_at: row.first_seen_at,
              last_seen_at: row.last_seen_at,
              occurrence_count: row.occurrence_count,
              policy_revision: `${row.policy_id}:${row.policy_revision}`,
              recurrence_of: row.recurrence_of_issue_id,
              suppressed_until: row.suppression_until,
              revision: row.revision,
            },
            expected_revision: row.revision,
            command: "suppression_expired",
            at: now,
          },
        }),
      ),
    );
    if (
      !isObject(transitioned.issue) ||
      transitioned.issue.state !== "active" ||
      typeof transitioned.issue.revision !== "number"
    ) {
      throw new Error("invalid_suppression_transition_result");
    }
    const nextRevision = transitioned.issue.revision;
    const auditId = await deterministicUuidV7(
      Date.parse(now),
      `${issueId}:${nextRevision}:suppression-expiry-audit`,
    );
    const outboxId = await deterministicUuidV7(
      Date.parse(now),
      `${issueId}:${nextRevision}:suppression-expiry-outbox`,
    );
    await this.#db.batch([
      this.#db
        .prepare(UPDATE_PROBE_ISSUE_SQL)
        .bind("active", null, nextRevision, issueId, row.revision),
      this.#db
        .prepare(ASSERT_ONE_CHANGE_SQL)
        .bind(`suppression-expiry:${issueId}:${nextRevision}`),
      this.#db
        .prepare(INSERT_RECOVERY_AUDIT_SQL)
        .bind(
          auditId,
          issueId,
          row.revision,
          nextRevision,
          `suppression:${issueId}`,
          now,
          issueId,
          nextRevision,
          "active",
        ),
      this.#db.prepare(INSERT_RECOVERY_OUTBOX_SQL).bind(
        outboxId,
        issueId,
        JSON.stringify({
          issue_id: issueId,
          state: "active",
          revision: nextRevision,
        }),
        now,
        now,
        now,
        issueId,
        nextRevision,
        "active",
      ),
    ]);
  }
}

interface IssueRow {
  readonly issue_id: string;
  readonly recurrence_of_issue_id: string | null;
  readonly fingerprint_hash: string;
  readonly service_name: string;
  readonly kind: string;
  readonly severity: "info" | "warning" | "error" | "critical";
  readonly state: "active" | "recovering";
  readonly first_seen_at: string;
  readonly last_seen_at: string;
  readonly occurrence_count: number;
  readonly policy_id: string;
  readonly policy_revision: number;
  readonly suppression_until: string | null;
  readonly last_fault_event_id: string | null;
  readonly diagnostic_rules_json: string;
  readonly revision: number;
}

interface ImpactPolicyRow {
  readonly severity: "info" | "warning" | "error" | "critical";
  readonly diagnostic_rules_json: string;
  readonly covered_by_maintenance: number;
}

interface IssueSignalRow extends ImpactPolicyRow {
  readonly issue_id: string;
  readonly state: "active" | "recovering";
  readonly fingerprint_hash: string;
}

interface SuppressedIssueRow extends ImpactPolicyRow {
  readonly issue_id: string;
  readonly recurrence_of_issue_id: string | null;
  readonly fingerprint_hash: string;
  readonly service_name: string;
  readonly kind: string;
  readonly state: "suppressed";
  readonly first_seen_at: string;
  readonly last_seen_at: string;
  readonly occurrence_count: number;
  readonly policy_id: string;
  readonly policy_revision: number;
  readonly suppression_until: string;
  readonly revision: number;
}

interface MonitorSignalRow {
  readonly monitor_id: string;
  readonly location: string | null;
  readonly target_type: "service" | "component";
  readonly target_id: string;
  readonly service_name: string;
  readonly probe_kind: ClaimedMonitor["probe"]["kind"];
  readonly critical: number;
  readonly evaluation_status: DomainStatus | null;
  readonly fresh_until: string | null;
  readonly executor_id: string | null;
  readonly actual_colo: string | null;
}

/** 一个匹配当前目标的生效维护输入。 / One active maintenance input matching the current target. */
interface MaintenanceSignalRow {
  readonly maintenance_id: string;
  readonly active: number;
  readonly fresh_until: string;
}

interface OverrideRow {
  readonly override_id: string;
  readonly status: Exclude<DomainStatus, "maintenance">;
  readonly expires_at: string;
  readonly audit_id: string;
}

interface CurrentStatusRow {
  readonly direct_status: DomainStatus;
  readonly dependency_risk:
    "none" | "degraded" | "partial_outage" | "major_outage" | "unknown";
  readonly policy_id: string | null;
  readonly policy_revision: number | null;
  readonly revision: number;
  readonly fresh_until: string;
  readonly effective_impact: DomainStatus;
}

/** Component 的额外支撑服务状态，不包含 owner。 / Status of an additional Component support service, excluding its owner. */
interface SupportingServiceStatusRow {
  readonly enabled: number;
  readonly effective_impact: DomainStatus | null;
  readonly fresh_until: string | null;
}

/** 服务依赖图只读取自身直接状态及其证明期限。 / Service dependency graph reads only each service's direct state and proof deadline. */
interface ServiceDirectStatusRow {
  readonly service_name: string;
  readonly direct_status: DomainStatus | null;
  readonly fresh_until: string;
}

/** Rust dependency graph 的一条已启用目录边。 / One enabled catalog edge for the Rust dependency graph. */
interface ServiceDependencyRow {
  readonly source_service: string;
  readonly target_service: string;
  readonly capability: string;
  readonly kind: "required" | "optional" | "degraded_fallback";
  readonly criticality: "low" | "medium" | "high" | "critical";
}

/** 状态变化后需要持久重评的反向依赖或支撑目标。 / Reverse-dependent or supporting target durably reevaluated after a status transition. */
interface FanoutTargetRow {
  readonly target_type: "service" | "component";
  readonly target_id: string;
}

function statement(
  db: D1DatabaseLike,
  sql: string,
  ...values: unknown[]
): D1StatementLike {
  return db.prepare(sql).bind(...values);
}

function rows<T>(
  result: { readonly results?: readonly unknown[] } | undefined,
): readonly T[] {
  return (result?.results ?? []) as readonly T[];
}

/** 调用尽力而为 observer，绝不让遥测改变领域结果。 / Invoke a best-effort observer without letting telemetry alter domain results. */
function observeEvaluation(
  observer: StatusEvaluationObserver | undefined,
  phase: "planned" | "committed",
  target: { readonly type: "service" | "component"; readonly id: string },
  metrics: StatusEvaluationMetrics,
): void {
  try {
    observer?.[phase](target, metrics);
  } catch {
    // Telemetry is non-authoritative. / 遥测不是权威状态。
  }
}

/**
 * 构造必须作为提交首语句运行的全局 generation guard。重复 Diagnostic
 * 可以跳过过时 guard，因为后续写入仍由其无法取得的 processing token 门控。
 * Build the global generation guard that must execute first at commit. A duplicate
 * Diagnostic may bypass a stale guard because every later write remains gated by
 * the processing token it cannot acquire.
 */
export function evaluationGenerationGuard(
  db: D1DatabaseLike,
  generation: number,
  duplicateEventId?: string,
): D1StatementLike {
  const duplicate =
    duplicateEventId === undefined
      ? "0"
      : "EXISTS(SELECT 1 FROM diagnostic_event_dedup WHERE event_id=?)";
  return statement(
    db,
    `INSERT INTO transaction_assertions(assertion_id,passed)
    VALUES (?,CASE WHEN COALESCE((SELECT generation FROM evaluation_generation WHERE singleton_id=1),-1)=?
      OR ${duplicate} THEN 1 ELSE 0 END)`,
    `evaluation-generation:${generation}`,
    generation,
    ...(duplicateEventId === undefined ? [] : [duplicateEventId]),
  );
}

/** 应用尚未提交的 Issue 状态，使特殊事务复用普通全信号规划路径。 / Apply an uncommitted Issue state so special transactions reuse the normal full-signal planner. */
function applyIssueOverlay(
  input: readonly IssueSignalRow[],
  overlay: IssueStateOverlay | undefined,
  coveredByMaintenance: boolean,
): readonly IssueSignalRow[] {
  const covered = coveredByMaintenance ? 1 : 0;
  const postMaintenance = input.map((row) => ({
    ...row,
    covered_by_maintenance: covered,
  }));
  if (overlay === undefined) return postMaintenance;
  const withoutCurrent = postMaintenance.filter(
    (row) => row.issue_id !== overlay.issueId,
  );
  if (overlay.state !== "active" && overlay.state !== "recovering")
    return withoutCurrent;
  return [
    ...withoutCurrent,
    {
      issue_id: overlay.issueId,
      state: overlay.state,
      severity: overlay.severity,
      fingerprint_hash: overlay.fingerprintHash,
      diagnostic_rules_json: overlay.diagnosticRulesJson,
      covered_by_maintenance: covered,
    },
  ];
}

/** 把维护 mutation 投影到当前目标的规划快照。 / Project a maintenance mutation into the current target's planning snapshot. */
function applyMaintenanceOverlay(
  input: readonly MaintenanceSignalRow[],
  overlay: MaintenanceEvaluationOverlay | undefined,
  target: { readonly type: "service" | "component"; readonly id: string },
  ownerService: string,
  now: string,
): readonly MaintenanceSignalRow[] {
  if (overlay === undefined) return input;
  const withoutCurrent = input.filter(
    (row) => row.maintenance_id !== overlay.maintenanceId,
  );
  const applies = overlay.targets.some(
    (candidate) =>
      (candidate.type === target.type && candidate.id === target.id) ||
      (target.type === "component" &&
        candidate.type === "service" &&
        candidate.id === ownerService),
  );
  if (
    !applies ||
    overlay.state !== "active" ||
    overlay.startsAt > now ||
    overlay.endsAt <= now
  )
    return withoutCurrent;
  return [
    ...withoutCurrent,
    {
      maintenance_id: overlay.maintenanceId,
      active: 1,
      fresh_until: overlay.endsAt,
    },
  ];
}

/** 把 override mutation 投影到当前目标的规划快照。 / Project an override mutation into the current target's planning snapshot. */
function applyOverrideOverlay(
  input: OverrideRow | undefined,
  overlay: OverrideEvaluationOverlay | undefined,
  target: { readonly type: "service" | "component"; readonly id: string },
  now: string,
): OverrideRow | undefined {
  if (
    overlay === undefined ||
    overlay.target.type !== target.type ||
    overlay.target.id !== target.id
  )
    return input;
  if (overlay.revoked || overlay.startsAt > now || overlay.expiresAt <= now)
    return undefined;
  return {
    override_id: overlay.overrideId,
    status: overlay.status,
    expires_at: overlay.expiresAt,
    audit_id: overlay.auditId,
  };
}

/** 在 await 边界两侧重新读取取消状态。 / Re-read cancellation state across await boundaries. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw signal.reason;
}

function aggregateMonitorSignals(
  rows: readonly MonitorSignalRow[],
  now: string,
): readonly { critical: boolean; state: "healthy" | "failing" | "unknown" }[] {
  const byMonitor = new Map<string, Map<string, MonitorSignalRow>>();
  for (const row of rows) {
    const current = byMonitor.get(row.monitor_id) ?? new Map();
    const voteKey =
      row.executor_id !== null && row.actual_colo !== null
        ? `colo:${row.actual_colo}`
        : `unproven:${row.location ?? "missing"}`;
    const previous = current.get(voteKey);
    current.set(
      voteKey,
      previous === undefined ? row : mergeMonitorVote(previous, row),
    );
    byMonitor.set(row.monitor_id, current);
  }
  return [...byMonitor.values()].map((byLocation) => {
    const locations = [...byLocation.values()];
    return {
      critical: locations.some((row) => row.critical === 1),
      state: locations.some(
        (row) =>
          row.fresh_until === null ||
          row.fresh_until <= now ||
          row.evaluation_status === null ||
          row.evaluation_status === "unknown",
      )
        ? "unknown"
        : locations.some((row) => row.evaluation_status !== "operational")
          ? "failing"
          : "healthy",
    };
  });
}

/** 合并同一真实 colo 的重复 checkpoint，冲突时保守选择不健康/未知。 / Merge duplicate checkpoints from one actual colo, conservatively preserving unhealthy or unknown conflicts. */
function mergeMonitorVote(
  left: MonitorSignalRow,
  right: MonitorSignalRow,
): MonitorSignalRow {
  const evaluationStatus =
    left.evaluation_status === null || right.evaluation_status === null
      ? null
      : left.evaluation_status === "operational"
        ? right.evaluation_status
        : left.evaluation_status;
  const freshUntil =
    left.fresh_until === null || right.fresh_until === null
      ? null
      : left.fresh_until < right.fresh_until
        ? left.fresh_until
        : right.fresh_until;
  return {
    ...left,
    evaluation_status: evaluationStatus,
    fresh_until: freshUntil,
  };
}

function issueImpact(row: ImpactPolicyRow): DomainStatus {
  const rules = parseObject(row.diagnostic_rules_json);
  const mapping = isObject(rules.status_by_severity)
    ? rules.status_by_severity
    : {};
  const contract = isObject(rules.contract) ? rules.contract : {};
  const status = mapping[row.severity] ?? contract.failure_status;
  if (
    status === "degraded" ||
    status === "partial_outage" ||
    status === "major_outage"
  )
    return status;
  throw new Error("invalid_issue_status_mapping");
}

function monitorFingerprintHash(
  core: RustDispatcher,
  row: MonitorSignalRow,
): string {
  const result = parseObject(
    core.dispatchJson(
      JSON.stringify({
        operation: "canonical_fingerprint",
        payload: {
          kind: "health.probe_failed",
          service_name: row.service_name,
          fingerprint: {
            operation: "active-health-probe",
            capability: row.target_id,
            ...(row.target_type === "component"
              ? { component: row.target_id }
              : {}),
            ...(row.probe_kind === "synthetic"
              ? {}
              : {
                  protocol: row.probe_kind === "rpc" ? "rpc" : row.probe_kind,
                }),
          },
        },
      }),
    ),
  );
  if (typeof result.hash !== "string")
    throw new Error("invalid_fingerprint_result");
  return result.hash;
}

function probeFingerprint(
  monitor: ClaimedMonitor,
): Readonly<Record<string, string>> {
  return {
    operation: "active-health-probe",
    capability: monitor.target.id,
    ...(monitor.target.type === "component"
      ? { component: monitor.target.id }
      : {}),
    ...(monitor.probe.kind === "synthetic"
      ? {}
      : {
          protocol: monitor.probe.kind === "rpc" ? "rpc" : monitor.probe.kind,
        }),
  };
}

function failureStatus(
  mapping: Readonly<Record<string, unknown>>,
): "degraded" | "partial_outage" | "major_outage" {
  const value = mapping.failure_status;
  if (
    value === "degraded" ||
    value === "partial_outage" ||
    value === "major_outage"
  )
    return value;
  throw new Error("missing_policy_failure_status");
}

function parseStatus(json: string): DomainStatus {
  const value: unknown = JSON.parse(json);
  if (
    value === "operational" ||
    value === "degraded" ||
    value === "partial_outage" ||
    value === "major_outage" ||
    value === "maintenance" ||
    value === "unknown"
  )
    return value;
  throw new Error("invalid_aggregate_status_result");
}

function effectiveImpact(
  direct: DomainStatus,
  dependency: CurrentStatusRow["dependency_risk"],
): DomainStatus {
  const risk = dependency === "none" ? "operational" : dependency;
  const rank: Readonly<Record<DomainStatus, number>> = {
    operational: 0,
    maintenance: 1,
    unknown: 2,
    degraded: 3,
    partial_outage: 4,
    major_outage: 5,
  };
  return rank[risk] > rank[direct] ? risk : direct;
}

/** 在同一快照的直接状态上调用 Rust 循环安全依赖算法。 / Invoke Rust's cycle-safe dependency algorithm over direct states from the same snapshot. */
function serviceDependencyRisk(
  core: RustDispatcher,
  serviceName: string,
  services: readonly ServiceDirectStatusRow[],
  dependencies: readonly ServiceDependencyRow[],
  ownDirect: DomainStatus,
  ownFreshUntil: string,
  now: string,
): CurrentStatusRow["dependency_risk"] {
  if (!dependencies.some((edge) => edge.source_service === serviceName))
    return "none";
  const directStatuses = Object.fromEntries(
    services.map((service) => [
      service.service_name,
      service.service_name === serviceName
        ? freshDirectStatus(ownDirect, ownFreshUntil, now)
        : freshDirectStatus(service.direct_status, service.fresh_until, now),
    ]),
  );
  const result = parseObject(
    core.dispatchJson(
      JSON.stringify({
        operation: "dependency_risk",
        payload: {
          graph: { dependencies },
          source_service: serviceName,
          direct_statuses: directStatuses,
        },
      }),
    ),
  );
  if (
    (result.source_service !== undefined &&
      result.source_service !== serviceName) ||
    !Array.isArray(result.contributors)
  )
    throw new Error("invalid_dependency_risk_result");
  if (result.status === "operational") return "none";
  if (
    result.status === "degraded" ||
    result.status === "partial_outage" ||
    result.status === "major_outage" ||
    result.status === "unknown"
  )
    return result.status;
  throw new Error("invalid_dependency_risk_result");
}

/** 过期的绿色/维护证明降为 unknown；已证实故障不会因时钟静默消失。 / Expired healthy or maintenance proof becomes unknown; demonstrated failure never disappears through clock silence. */
function freshDirectStatus(
  status: DomainStatus | null,
  freshUntil: string,
  now: string,
): DomainStatus {
  if (status === null) return "unknown";
  if (
    freshUntil < now &&
    status !== "degraded" &&
    status !== "partial_outage" &&
    status !== "major_outage"
  )
    return "unknown";
  return status;
}

/** 计算所有可达直接证明的最早期限；visited set 使循环有限。 / Compute the earliest reachable direct-proof deadline; a visited set bounds cycles. */
function dependencyFreshUntil(
  serviceName: string,
  services: readonly ServiceDirectStatusRow[],
  dependencies: readonly ServiceDependencyRow[],
  ownFreshUntil: string,
): string {
  const deadlines = new Map(
    services.map((service) => [service.service_name, service.fresh_until]),
  );
  deadlines.set(serviceName, ownFreshUntil);
  const adjacency = new Map<string, string[]>();
  for (const dependency of dependencies)
    adjacency.set(dependency.source_service, [
      ...(adjacency.get(dependency.source_service) ?? []),
      dependency.target_service,
    ]);
  const visited = new Set<string>();
  const pending = [serviceName];
  const reachable: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    reachable.push(deadlines.get(current) ?? ownFreshUntil);
    pending.push(...(adjacency.get(current) ?? []));
  }
  return reachable.sort()[0] ?? ownFreshUntil;
}

/**
 * 将额外支撑服务证据折叠为独立 dependency_risk；过期绿色证据不能冒充健康。
 * Fold additional support-service evidence into independent dependency_risk;
 * stale green evidence must not masquerade as health.
 */
function supportingServiceRisk(
  rows: readonly SupportingServiceStatusRow[],
  now: string,
): CurrentStatusRow["dependency_risk"] {
  if (rows.length === 0) return "none";
  const risks = rows.map((row) => {
    if (row.enabled !== 1 || row.effective_impact === null)
      return "unknown" as const;
    const status = row.effective_impact;
    if (
      row.fresh_until === null ||
      (row.fresh_until <= now &&
        status !== "degraded" &&
        status !== "partial_outage" &&
        status !== "major_outage")
    ) {
      return "unknown" as const;
    }
    if (status === "maintenance") return "degraded" as const;
    return status;
  });
  if (risks.includes("major_outage")) return "major_outage";
  if (risks.includes("partial_outage")) return "partial_outage";
  if (risks.includes("degraded")) return "degraded";
  if (risks.includes("unknown")) return "unknown";
  return "none";
}

function sourceType(
  type: string,
):
  | "observation"
  | "diagnostic_event"
  | "maintenance"
  | "operator_override"
  | "issue" {
  if (
    type === "observation" ||
    type === "diagnostic_event" ||
    type === "maintenance" ||
    type === "issue"
  )
    return type;
  return type === "override" ? "operator_override" : "issue";
}

function parseObject(json: string): Record<string, unknown> {
  const value: unknown = JSON.parse(json);
  if (!isObject(value)) throw new Error("invalid_core_result");
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const READ_PROBE_ISSUE_SQL = `SELECT i.*,p.diagnostic_rules_json FROM issues i
JOIN evaluation_policies p ON p.policy_id=i.policy_id AND p.revision=i.policy_revision
WHERE i.service_name=? AND i.kind='health.probe_failed' AND i.fingerprint_hash=?
  AND i.state IN ('active','recovering') LIMIT 1`;
const READ_SUPPRESSED_ISSUE_SQL = `SELECT i.*,p.diagnostic_rules_json,0 AS covered_by_maintenance
FROM issues i JOIN evaluation_policies p ON p.policy_id=i.policy_id AND p.revision=i.policy_revision
WHERE i.issue_id=? AND i.state='suppressed' AND i.suppression_until<=?`;
const UPDATE_PROBE_ISSUE_SQL = `UPDATE issues SET state = ?, suppression_until = NULL, suppression_reason = NULL,
resolved_at = ?, revision = ? WHERE issue_id = ? AND revision = ?`;
const ASSERT_ONE_CHANGE_SQL = `INSERT INTO transaction_assertions(assertion_id,passed)
VALUES (?, CASE WHEN changes()=1 THEN 1 ELSE 0 END)`;
const INSERT_RECOVERY_AUDIT_SQL = `INSERT INTO audit_log(audit_id,actor_type,actor_subject,actor_roles_json,action,target_type,target_id,before_revision,after_revision,correlation_id,occurred_at,details_json)
SELECT ?, 'system', 'status-scheduler', '[]', 'issue.recovery_evaluated', 'issue', ?, ?, ?, ?, ?, '{}'
WHERE EXISTS(SELECT 1 FROM issues WHERE issue_id = ? AND revision = ? AND state = ?)`;
const INSERT_RECOVERY_OUTBOX_SQL = `INSERT INTO outbox(outbox_id,aggregate_type,aggregate_id,event_type,schema_version,payload_json,state,attempt_count,available_at,next_attempt_at,created_at)
SELECT ?, 'issue', ?, 'issue.state_changed', '1.0', ?, 'pending', 0, ?, ?, ?
WHERE EXISTS(SELECT 1 FROM issues WHERE issue_id = ? AND revision = ? AND state = ?)`;

const EVALUATION_GENERATION_SQL = `SELECT generation FROM evaluation_generation WHERE singleton_id=1`;
const ISSUE_SIGNALS_SQL = `SELECT i.issue_id,i.state,i.severity,i.fingerprint_hash,p.diagnostic_rules_json,
CASE WHEN EXISTS(SELECT 1 FROM maintenance_windows mw JOIN maintenance_targets mt USING(maintenance_id)
  WHERE ((mt.target_type=? AND mt.target_id=?) OR
         (?='component' AND mt.target_type='service' AND mt.target_id=(SELECT service_name FROM components WHERE component_id=?)))
    AND mw.state='active' AND mw.starts_at<=? AND mw.ends_at>?) THEN 1 ELSE 0 END AS covered_by_maintenance
FROM issues i JOIN evaluation_policies p ON p.policy_id=i.policy_id AND p.revision=i.policy_revision
WHERE ((?='service' AND i.service_name=?) OR
       (?='component' AND i.service_name=(SELECT service_name FROM components WHERE component_id=?)))
  AND i.state IN ('active','recovering')`;
const MAINTENANCE_SIGNALS_SQL = `SELECT mw.maintenance_id,1 AS active,mw.ends_at AS fresh_until FROM maintenance_windows mw JOIN maintenance_targets mt USING(maintenance_id)
WHERE ((mt.target_type=? AND mt.target_id=?) OR
       (?='component' AND mt.target_type='service' AND mt.target_id=(SELECT service_name FROM components WHERE component_id=?)))
  AND mw.state='active' AND mw.starts_at<=? AND mw.ends_at>?`;
const MONITOR_SIGNALS_SQL = `SELECT m.monitor_id,ml.location,m.target_type,m.target_id,m.probe_kind,m.critical,
  COALESCE(st.service_name,component.service_name) AS service_name,
  CASE WHEN c.executor_id IS NOT NULL AND c.actual_colo IS NOT NULL THEN c.evaluation_status ELSE NULL END AS evaluation_status,
  CASE WHEN c.executor_id IS NOT NULL AND c.actual_colo IS NOT NULL THEN c.fresh_until ELSE NULL END AS fresh_until,
  c.executor_id,c.actual_colo
  FROM monitors m JOIN status_targets st ON st.target_type=m.target_type AND st.target_id=m.target_id
  LEFT JOIN components component ON component.component_id=st.component_id
  LEFT JOIN monitor_locations ml ON ml.monitor_id=m.monitor_id AND ml.enabled=1
  LEFT JOIN monitor_checkpoints c ON c.monitor_id=m.monitor_id AND c.location=ml.location
  WHERE m.target_type=? AND m.target_id=? AND m.enabled=1`;
const OVERRIDE_SIGNAL_SQL = `SELECT so.override_id,so.status,so.expires_at,COALESCE((SELECT audit_id FROM audit_log a WHERE a.correlation_id=so.correlation_id ORDER BY occurred_at DESC LIMIT 1),so.override_id) audit_id
FROM status_overrides so WHERE so.target_type=? AND so.target_id=? AND so.revoked_at IS NULL AND so.starts_at<=? AND so.expires_at>? LIMIT 1`;
const CURRENT_STATUS_SQL = `SELECT * FROM current_statuses WHERE target_type=? AND target_id=?`;
const SUPPORTING_SERVICE_STATUS_SQL = `SELECT service.enabled,cs.effective_impact,cs.fresh_until
FROM component_services relation
JOIN services service ON service.service_name=relation.service_name
LEFT JOIN current_statuses cs ON cs.target_type='service' AND cs.target_id=relation.service_name
WHERE ?='component' AND relation.component_id=? AND relation.role='supporting'
ORDER BY relation.service_name`;
const TARGET_CONTEXT_SQL = `SELECT CASE WHEN ?='service' THEN st.target_id ELSE component.service_name END AS service_name
FROM status_targets st LEFT JOIN components component ON component.component_id=st.component_id
WHERE st.target_type=? AND st.target_id=?`;
const SERVICE_DIRECT_STATUSES_SQL = `SELECT s.service_name,cs.direct_status,
COALESCE(cs.fresh_until,s.updated_at) AS fresh_until FROM services s
LEFT JOIN current_statuses cs ON cs.target_type='service' AND cs.target_id=s.service_name
WHERE s.enabled=1 ORDER BY s.service_name`;
const SERVICE_DEPENDENCIES_SQL = `SELECT d.source_service,d.target_service,d.capability,d.kind,d.criticality
FROM service_dependencies d
JOIN services source ON source.service_name=d.source_service AND source.enabled=1
JOIN services target ON target.service_name=d.target_service AND target.enabled=1
ORDER BY d.source_service,d.target_service,d.capability`;
const FANOUT_TARGETS_SQL = `SELECT 'service' AS target_type,d.source_service AS target_id
FROM service_dependencies d
JOIN services source ON source.service_name=d.source_service AND source.enabled=1
JOIN services changed ON changed.service_name=d.target_service AND changed.enabled=1
WHERE ?='service' AND d.target_service=? AND d.source_service<>?
UNION
SELECT 'component',relation.component_id FROM component_services relation
JOIN components component ON component.component_id=relation.component_id AND component.enabled=1
JOIN services support ON support.service_name=relation.service_name AND support.enabled=1
WHERE ?='service' AND relation.role='supporting' AND relation.service_name=?
ORDER BY target_type,target_id`;
const UPSERT_CURRENT_STATUS_SQL = `INSERT INTO current_statuses(target_type,target_id,direct_status,dependency_risk,effective_impact,evaluated_at,fresh_until,policy_id,policy_revision,revision)
  SELECT ?,?,?,?,?,?,?,?,?,1 WHERE __OWNED__ ON CONFLICT(target_type,target_id) DO UPDATE SET direct_status=excluded.direct_status,
  dependency_risk=excluded.dependency_risk,effective_impact=excluded.effective_impact,evaluated_at=excluded.evaluated_at,
  fresh_until=excluded.fresh_until,policy_id=excluded.policy_id,policy_revision=excluded.policy_revision,revision=current_statuses.revision+1
  WHERE ? IS NULL OR current_statuses.revision=?`;
const INSERT_STATUS_TRANSITION_SQL = `INSERT INTO status_transitions(transition_id,target_type,target_id,sequence,from_status,to_status,source_type,source_id,policy_id,policy_revision,occurred_at,details_json)
SELECT ?,?,?,COALESCE((SELECT MAX(sequence)+1 FROM status_transitions WHERE target_type=? AND target_id=?),1),?,?,?,?,?,?,?,'{}'
WHERE EXISTS(SELECT 1 FROM current_statuses WHERE target_type=? AND target_id=? AND revision=? AND effective_impact=?) AND __OWNED__`;
const INSERT_STATUS_AUDIT_SQL = `INSERT INTO audit_log(audit_id,actor_type,actor_subject,actor_roles_json,action,target_type,target_id,before_revision,after_revision,correlation_id,occurred_at,details_json)
SELECT ?,'system','status-scheduler','[]','status.reevaluated',?,?,?,?,?,?,'{}'
WHERE EXISTS(SELECT 1 FROM current_statuses WHERE target_type=? AND target_id=? AND revision=? AND effective_impact=?) AND __OWNED__`;
const INSERT_STATUS_OUTBOX_SQL = `INSERT INTO outbox(outbox_id,aggregate_type,aggregate_id,event_type,schema_version,payload_json,state,attempt_count,available_at,next_attempt_at,created_at)
SELECT ?,'status_target',?||':'||?,'status.changed','1.0',?,'pending',0,?,?,?
WHERE EXISTS(SELECT 1 FROM current_statuses WHERE target_type=? AND target_id=? AND revision=? AND effective_impact=?) AND __OWNED__`;
const INSERT_FANOUT_OUTBOX_SQL = `INSERT INTO outbox(outbox_id,aggregate_type,aggregate_id,event_type,schema_version,payload_json,state,attempt_count,available_at,next_attempt_at,created_at)
SELECT ?,'status_target',?||':'||?,'status.reevaluation_requested','1.0',?,'pending',0,?,?,?
WHERE EXISTS(SELECT 1 FROM current_statuses WHERE target_type=? AND target_id=? AND revision=? AND effective_impact=?) AND __OWNED__`;

import { measurement } from "../platform/instrumentation.js";
import {
  DiagnosticQueueEnvelopeSchema,
  type DiagnosticEvent,
  type DiagnosticQueueEnvelope,
} from "@moesegfault/contracts";
import {
  evaluateWithCore,
  fingerprintWithCore,
  validateWithCore,
  type CurrentIssue,
  type CurrentStatus,
} from "./domain.js";
import {
  D1TargetReevaluator,
  evaluationGenerationGuard,
  type D1StatusEvaluationPlan,
} from "../scheduling/reevaluate.js";
import type { D1DatabaseLike as SchedulingDatabase } from "../scheduling/store.js";
import type { RustDispatcher } from "../scheduling/types.js";
import type {
  D1ResultLike,
  D1StatementLike,
  DiagnosticConsumerEnv,
  DiagnosticDeadLetterEnvelope,
  DiagnosticFailureStage,
  QueueBatchLike,
  QueueMessageLike,
} from "./types.js";

/** 读取的不可变 policy 与保留策略。 / Immutable evaluation and retention policy snapshot. */
interface PolicyRow {
  readonly assignment_id: string;
  readonly policy_id: string;
  readonly policy_revision: number;
  readonly diagnostic_rules_json: string;
  readonly stale_after_seconds: number;
  readonly policy_binding_revision: number;
  readonly policy_from_issue: number;
  readonly retention_policy_id: string;
  readonly retention_policy_revision: number;
  readonly occurrence_retention_days: number;
  readonly retention_binding_revision: number;
}

/** 消费者阶段错误，不携带敏感输入。 / Stage-tagged consumer error without sensitive input. */
class ConsumerStageError extends Error {
  /** 构造稳定失败阶段。 / Construct a stable failure stage. */
  constructor(
    readonly stage: DiagnosticFailureStage,
    readonly problemType: string,
    cause?: unknown,
  ) {
    super(problemType, { cause });
  }
}

/** 创建 UUIDv7；数据库身份均为不透明值。 / Create a UUIDv7; database identities remain opaque. */
function uuidV7(date: Date): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let timestamp = date.getTime();
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp & 0xff;
    timestamp = Math.floor(timestamp / 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 计算不可变事件正文摘要。 / Compute the immutable event payload digest. */
async function payloadDigest(event: DiagnosticEvent): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(event));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** 从 D1 batch 结果中取唯一行。 / Read the sole row from a D1 batch result. */
function soleRow<T>(result: D1ResultLike | undefined): T | null {
  const rows = result?.results ?? [];
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new Error("expected at most one row");
  return rows[0] as T;
}

/** 为 SQL 语句绑定参数。 / Prepare and bind a SQL statement. */
function statement(
  env: DiagnosticConsumerEnv,
  sql: string,
  ...values: unknown[]
): D1StatementLike {
  return env.DB.prepare(sql).bind(...values);
}

/** 将 JSON rules 解析成 Rust 核心的显式 policy 输入。 / Decode JSON rules into the Rust core's explicit policy input. */
function decodeRules(row: PolicyRow): {
  policy_id: string;
  revision: number;
  minimum_occurrences: number;
  recovery_min_occurrences: number;
  status_by_severity: Record<DiagnosticEvent["severity"], string>;
} {
  const rules = JSON.parse(row.diagnostic_rules_json) as Record<
    string,
    unknown
  >;
  const contract =
    typeof rules.contract === "object" && rules.contract !== null
      ? (rules.contract as Record<string, unknown>)
      : {};
  const failureStatus = contract.failure_status as string | undefined;
  const explicitStatus = rules.status_by_severity as
    Record<DiagnosticEvent["severity"], string> | undefined;
  return {
    policy_id: row.policy_id,
    revision: row.policy_revision,
    minimum_occurrences: (rules.minimum_occurrences as number | undefined) ?? 1,
    recovery_min_occurrences:
      (rules.recovery_min_occurrences as number | undefined) ??
      (contract.recovery_min_occurrences as number | undefined) ??
      2,
    status_by_severity:
      explicitStatus ??
      ({
        info: failureStatus ?? "degraded",
        warning: failureStatus ?? "degraded",
        error: failureStatus ?? "degraded",
        critical: failureStatus ?? "major_outage",
      } satisfies Record<DiagnosticEvent["severity"], string>),
  };
}

/** 读取同一快照中的 policy、Issue 和 service status。 / Read policy, Issue, and service status in one snapshot batch. */
async function readEvaluationSnapshot(
  env: DiagnosticConsumerEnv,
  event: DiagnosticEvent,
  fingerprintHash: string,
  monitorId: string | null,
): Promise<{
  policy: PolicyRow;
  issue: CurrentIssue | null;
  status: CurrentStatus | null;
}> {
  const results = await env.DB.batch([
    statement(
      env,
      `SELECT sp.assignment_id,p.policy_id, p.revision AS policy_revision, p.diagnostic_rules_json,p.stale_after_seconds,
      sp.revision AS policy_binding_revision,CASE WHEN i.issue_id IS NULL THEN 0 ELSE 1 END AS policy_from_issue,
      rp.policy_id AS retention_policy_id,
      rp.revision AS retention_policy_revision, rp.occurrence_retention_days,
      sr.revision AS retention_binding_revision
      FROM service_diagnostic_policies sp
      LEFT JOIN issues i ON i.service_name=? AND i.kind=? AND i.fingerprint_hash=? AND i.state<>'resolved'
      JOIN evaluation_policies p ON p.policy_id=COALESCE(i.policy_id,sp.policy_id)
        AND p.revision=COALESCE(i.policy_revision,sp.policy_revision)
      JOIN service_retention_policies sr ON sr.service_name=?
      JOIN data_retention_policies rp ON rp.policy_id=sr.policy_id AND rp.revision=sr.policy_revision
      WHERE (sp.selector_kind='monitor' AND sp.monitor_id=?)
         OR (sp.selector_kind='service_kind' AND sp.service_name=? AND sp.diagnostic_kind=?)
         OR (sp.selector_kind='service_default' AND sp.service_name=?)
      ORDER BY CASE sp.selector_kind WHEN 'monitor' THEN 0 WHEN 'service_kind' THEN 1 ELSE 2 END
      LIMIT 1`,
      event.service_name,
      event.kind,
      fingerprintHash,
      event.service_name,
      monitorId,
      event.service_name,
      event.kind,
      event.service_name,
    ),
    statement(
      env,
      `SELECT issue_id,state,severity,occurrence_count,recovery_count,last_fault_event_id,last_recovery_at,
      first_seen_at,last_seen_at,revision,fingerprint_hash,policy_revision FROM issues
      WHERE service_name=? AND kind=? AND fingerprint_hash=? AND state<>'resolved' LIMIT 1`,
      event.service_name,
      event.kind,
      fingerprintHash,
    ),
    statement(
      env,
      `SELECT direct_status,dependency_risk,effective_impact,evaluated_at,fresh_until,revision
      FROM current_statuses WHERE target_type='service' AND target_id=?`,
      event.service_name,
    ),
  ]);
  const policy = soleRow<PolicyRow>(results[0]);
  if (policy === null)
    throw new Error("service has no diagnostic or retention policy");
  return {
    policy,
    issue: soleRow<CurrentIssue>(results[1]),
    status: soleRow<CurrentStatus>(results[2]),
  };
}

/** 为一次处理构建所有领域写入；每条语句都由 claim token 门控。 / Build all domain writes, each gated by the claim token. */
function buildDomainWrites(
  env: DiagnosticConsumerEnv,
  envelope: DiagnosticQueueEnvelope,
  snapshot: Awaited<ReturnType<typeof readEvaluationSnapshot>>,
  evaluation: ReturnType<typeof evaluateWithCore>,
  ids: {
    token: string;
    issue: string;
    occurrence: string;
    assertion: string;
    audit: string;
    outbox: string;
  },
  now: string,
  digest: string,
  statusPlan: D1StatusEvaluationPlan | null,
): D1StatementLike[] {
  const event = envelope.event;
  const owned = `EXISTS(SELECT 1 FROM diagnostic_event_dedup WHERE event_id=? AND processing_token=?)`;
  const createsIssue =
    snapshot.issue === null || evaluation.action === "create_recurrence";
  const issueId = createsIssue ? ids.issue : snapshot.issue!.issue_id;
  const expectedIssue =
    snapshot.issue === null
      ? `NOT EXISTS(SELECT 1 FROM issues WHERE service_name=? AND kind=? AND fingerprint_hash=? AND state<>'resolved')`
      : evaluation.action === "create_recurrence"
        ? `EXISTS(SELECT 1 FROM issues WHERE issue_id=? AND revision=? AND state='resolved') AND NOT EXISTS(
          SELECT 1 FROM issues WHERE service_name=? AND kind=? AND fingerprint_hash=? AND state<>'resolved')`
        : `EXISTS(SELECT 1 FROM issues WHERE issue_id=? AND revision=?)`;
  const expectedStatus =
    snapshot.status === null
      ? `NOT EXISTS(SELECT 1 FROM current_statuses WHERE target_type='service' AND target_id=?)`
      : `EXISTS(SELECT 1 FROM current_statuses WHERE target_type='service' AND target_id=? AND revision=?)`;
  const expectedPolicy =
    snapshot.policy.policy_from_issue === 1
      ? `EXISTS(SELECT 1 FROM evaluation_policies WHERE policy_id=? AND revision=?)`
      : `EXISTS(SELECT 1 FROM service_diagnostic_policies WHERE assignment_id=? AND policy_id=? AND policy_revision=? AND revision=?)`;

  const writes: D1StatementLike[] = [
    ...(statusPlan === null
      ? []
      : [
          evaluationGenerationGuard(
            env.DB as unknown as SchedulingDatabase,
            statusPlan.generation,
            event.event_id,
          ) as unknown as D1StatementLike,
        ]),
    statement(
      env,
      `INSERT INTO diagnostic_event_dedup(event_id,event_schema_version,service_name,deployment_id,kind,severity,
      occurred_at,received_at,processed_at,fingerprint_hash,payload_digest,envelope_schema_version,processing_token,
      producer_subject,correlation_id,trace_id,span_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(event_id) DO NOTHING`,
      event.event_id,
      event.schema_version,
      event.service_name,
      event.deployment_id,
      event.kind,
      event.severity,
      event.occurred_at,
      envelope.received_at,
      now,
      evaluation.fingerprint_hash,
      digest,
      envelope.schema_version,
      ids.token,
      envelope.producer.subject,
      event.correlation_id,
      event.trace_id ?? null,
      event.span_id ?? null,
    ),
  ];

  const issueExpectationValues =
    snapshot.issue === null
      ? [event.service_name, event.kind, evaluation.fingerprint_hash]
      : evaluation.action === "create_recurrence"
        ? [
            snapshot.issue.issue_id,
            snapshot.issue.revision,
            event.service_name,
            event.kind,
            evaluation.fingerprint_hash,
          ]
        : [snapshot.issue.issue_id, snapshot.issue.revision];
  const statusExpectationValues =
    snapshot.status === null
      ? [event.service_name]
      : [event.service_name, snapshot.status.revision];
  writes.push(
    statement(
      env,
      `INSERT INTO transaction_assertions(assertion_id,passed)
    SELECT ?, CASE WHEN
      ${expectedPolicy}
      AND EXISTS(SELECT 1 FROM service_retention_policies WHERE service_name=? AND policy_id=? AND policy_revision=? AND revision=?)
      AND ${expectedIssue} AND ${expectedStatus} THEN 1 ELSE 0 END
    WHERE ${owned}`,
      ids.assertion,
      ...(snapshot.policy.policy_from_issue === 1
        ? [snapshot.policy.policy_id, snapshot.policy.policy_revision]
        : [
            snapshot.policy.assignment_id,
            snapshot.policy.policy_id,
            snapshot.policy.policy_revision,
            snapshot.policy.policy_binding_revision,
          ]),
      event.service_name,
      snapshot.policy.retention_policy_id,
      snapshot.policy.retention_policy_revision,
      snapshot.policy.retention_binding_revision,
      ...issueExpectationValues,
      ...statusExpectationValues,
      event.event_id,
      ids.token,
    ),
  );

  writes.push(
    statement(
      env,
      `INSERT INTO issues(issue_id,recurrence_of_issue_id,fingerprint_hash,service_name,kind,severity,state,
    first_seen_at,last_seen_at,occurrence_count,affected_instance_count,policy_id,policy_revision,revision,
    last_fault_event_id,recovery_count,last_recovery_at)
    SELECT ?, (SELECT issue_id FROM issues WHERE service_name=? AND kind=? AND fingerprint_hash=? AND state='resolved'
      ORDER BY resolved_at DESC LIMIT 1), ?, ?, ?, ?, 'observed', ?, ?, 1, 0, ?, ?, 1,?,0,NULL WHERE ${owned}
      AND NOT EXISTS(SELECT 1 FROM issues WHERE service_name=? AND kind=? AND fingerprint_hash=? AND state<>'resolved')`,
      ids.issue,
      event.service_name,
      event.kind,
      evaluation.fingerprint_hash,
      evaluation.fingerprint_hash,
      event.service_name,
      event.kind,
      event.severity,
      event.occurred_at,
      event.occurred_at,
      snapshot.policy.policy_id,
      snapshot.policy.policy_revision,
      event.event_id,
      event.event_id,
      ids.token,
      event.service_name,
      event.kind,
      evaluation.fingerprint_hash,
    ),
  );

  if (!createsIssue) {
    writes.push(
      statement(
        env,
        `UPDATE issues SET severity=?,state=?,last_seen_at=CASE WHEN last_seen_at>? THEN last_seen_at ELSE ? END,
      occurrence_count=?,policy_id=?,policy_revision=?,resolved_at=CASE WHEN ?='resolved' THEN ? ELSE resolved_at END,
      last_fault_event_id=CASE WHEN ?='record_out_of_order' THEN last_fault_event_id ELSE ? END,
      recovery_count=CASE WHEN ?='record_out_of_order' THEN recovery_count ELSE 0 END,
      last_recovery_at=CASE WHEN ?='record_out_of_order' THEN last_recovery_at ELSE NULL END,
      revision=revision+1 WHERE issue_id=? AND ${owned}`,
        evaluation.severity,
        evaluation.issue_state,
        event.occurred_at,
        event.occurred_at,
        evaluation.occurrence_count,
        snapshot.policy.policy_id,
        snapshot.policy.policy_revision,
        evaluation.issue_state,
        now,
        evaluation.action,
        event.event_id,
        evaluation.action,
        evaluation.action,
        issueId,
        event.event_id,
        ids.token,
      ),
    );
  } else if (evaluation.issue_state !== "observed") {
    writes.push(
      statement(
        env,
        `UPDATE issues SET severity=?,state=?,resolved_at=CASE WHEN ?='resolved' THEN ? ELSE NULL END,
      last_fault_event_id=?,recovery_count=0,last_recovery_at=NULL,
      revision=revision+1 WHERE issue_id=? AND ${owned}`,
        evaluation.severity,
        evaluation.issue_state,
        evaluation.issue_state,
        now,
        event.event_id,
        issueId,
        event.event_id,
        ids.token,
      ),
    );
  }

  if (event.instance_id !== undefined) {
    writes.push(
      statement(
        env,
        `INSERT INTO issue_instances(issue_id,instance_id,first_seen_at,last_seen_at)
      SELECT ?,?,?,? WHERE ${owned} ON CONFLICT(issue_id,instance_id) DO UPDATE SET
      last_seen_at=CASE WHEN issue_instances.last_seen_at>excluded.last_seen_at THEN issue_instances.last_seen_at ELSE excluded.last_seen_at END`,
        issueId,
        event.instance_id,
        event.occurred_at,
        event.occurred_at,
        event.event_id,
        ids.token,
      ),
    );
    writes.push(
      statement(
        env,
        `UPDATE issues SET affected_instance_count=(SELECT COUNT(*) FROM issue_instances WHERE issue_id=?),
      revision=revision+1 WHERE issue_id=? AND ${owned}`,
        issueId,
        issueId,
        event.event_id,
        ids.token,
      ),
    );
  }

  writes.push(
    statement(
      env,
      `INSERT INTO issue_occurrences(occurrence_id,issue_id,event_id,service_name,deployment_id,occurred_at,
    observed_at,instance_id,summary,correlation_id,evidence_count,retention_policy_id,retention_policy_revision,purge_after)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ',?,'+'||?||' days') WHERE ${owned}`,
      ids.occurrence,
      issueId,
      event.event_id,
      event.service_name,
      event.deployment_id,
      event.occurred_at,
      envelope.received_at,
      event.instance_id ?? null,
      event.summary,
      event.correlation_id,
      event.evidence.length,
      snapshot.policy.retention_policy_id,
      snapshot.policy.retention_policy_revision,
      event.occurred_at,
      snapshot.policy.occurrence_retention_days,
      event.event_id,
      ids.token,
    ),
  );
  writes.push(
    statement(
      env,
      `INSERT OR IGNORE INTO incident_occurrences(incident_id,occurrence_id,update_sequence)
      SELECT ii.incident_id,?,ii.update_sequence FROM incident_issues ii
      JOIN incident_current ic ON ic.incident_id=ii.incident_id
      WHERE ii.issue_id=? AND ic.state<>'resolved' AND ${owned}`,
      ids.occurrence,
      issueId,
      event.event_id,
      ids.token,
    ),
  );

  appendEvidenceWrites(
    writes,
    env,
    envelope,
    issueId,
    ids.occurrence,
    ids.token,
    now,
  );
  if (statusPlan !== null)
    writes.push(
      ...(statusPlan.writes as unknown as readonly D1StatementLike[]),
    );

  writes.push(
    statement(
      env,
      `INSERT INTO audit_log(audit_id,actor_type,actor_subject,actor_roles_json,action,target_type,target_id,
    before_revision,after_revision,correlation_id,occurred_at,details_json)
    SELECT ?,'machine',?,'[]','diagnostic.issue_aggregated','issue',?, ?,revision,?,?,json_object('event_id',?,'domain_action',?)
    FROM issues WHERE issue_id=? AND ${owned}`,
      ids.audit,
      envelope.producer.subject,
      issueId,
      createsIssue ? null : (snapshot.issue?.revision ?? null),
      event.correlation_id,
      now,
      event.event_id,
      evaluation.action,
      issueId,
      event.event_id,
      ids.token,
    ),
  );
  writes.push(
    statement(
      env,
      `INSERT INTO outbox(outbox_id,aggregate_type,aggregate_id,event_type,schema_version,payload_json,
    state,attempt_count,available_at,next_attempt_at,created_at)
    SELECT ?,'issue',?,'diagnostic.issue.aggregated','1.0',json_object('issue_id',?,'event_id',?,'action',?),
      'pending',0,?,?,? WHERE ${owned}`,
      ids.outbox,
      issueId,
      issueId,
      event.event_id,
      evaluation.action,
      now,
      now,
      now,
      event.event_id,
      ids.token,
    ),
  );
  writes.push(
    statement(
      env,
      `SELECT event_id,payload_digest,processing_token FROM diagnostic_event_dedup WHERE event_id=?`,
      event.event_id,
    ),
  );
  return writes;
}

/**
 * 构建显式恢复的原子写集；恢复证据绝不是故障 occurrence。
 * Build the atomic write set for explicit recovery; recovery evidence is never a
 * fault occurrence.
 */
function buildRecoveryWrites(
  env: DiagnosticConsumerEnv,
  envelope: DiagnosticQueueEnvelope,
  snapshot: Awaited<ReturnType<typeof readEvaluationSnapshot>>,
  evaluation: ReturnType<typeof evaluateWithCore>,
  ids: {
    token: string;
    assertion: string;
    audit: string;
    outbox: string;
  },
  now: string,
  digest: string,
  statusPlan: D1StatusEvaluationPlan | null,
): D1StatementLike[] {
  const event = envelope.event;
  const owned = `EXISTS(SELECT 1 FROM diagnostic_event_dedup WHERE event_id=? AND processing_token=?)`;
  const expectedPolicy =
    snapshot.policy.policy_from_issue === 1
      ? `EXISTS(SELECT 1 FROM evaluation_policies WHERE policy_id=? AND revision=?)`
      : `EXISTS(SELECT 1 FROM service_diagnostic_policies WHERE assignment_id=? AND policy_id=? AND policy_revision=? AND revision=?)`;
  const expectedIssue =
    snapshot.issue === null
      ? `NOT EXISTS(SELECT 1 FROM issues WHERE service_name=? AND kind=? AND fingerprint_hash=? AND state<>'resolved')`
      : `EXISTS(SELECT 1 FROM issues WHERE issue_id=? AND revision=? AND state<>'resolved')`;
  const expectedStatus =
    snapshot.status === null
      ? `NOT EXISTS(SELECT 1 FROM current_statuses WHERE target_type='service' AND target_id=?)`
      : `EXISTS(SELECT 1 FROM current_statuses WHERE target_type='service' AND target_id=? AND revision=?)`;
  const issueExpectationValues =
    snapshot.issue === null
      ? [event.service_name, event.kind, evaluation.fingerprint_hash]
      : [snapshot.issue.issue_id, snapshot.issue.revision];
  const statusExpectationValues =
    snapshot.status === null
      ? [event.service_name]
      : [event.service_name, snapshot.status.revision];
  const writes: D1StatementLike[] = [
    ...(statusPlan === null
      ? []
      : [
          evaluationGenerationGuard(
            env.DB as unknown as SchedulingDatabase,
            statusPlan.generation,
            event.event_id,
          ) as unknown as D1StatementLike,
        ]),
    statement(
      env,
      `INSERT INTO diagnostic_event_dedup(event_id,event_schema_version,service_name,deployment_id,kind,severity,
      occurred_at,received_at,processed_at,fingerprint_hash,payload_digest,envelope_schema_version,processing_token,
      producer_subject,correlation_id,trace_id,span_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(event_id) DO NOTHING`,
      event.event_id,
      event.schema_version,
      event.service_name,
      event.deployment_id,
      event.kind,
      event.severity,
      event.occurred_at,
      envelope.received_at,
      now,
      evaluation.fingerprint_hash,
      digest,
      envelope.schema_version,
      ids.token,
      envelope.producer.subject,
      event.correlation_id,
      event.trace_id ?? null,
      event.span_id ?? null,
    ),
    statement(
      env,
      `INSERT INTO transaction_assertions(assertion_id,passed)
      SELECT ?,CASE WHEN ${expectedPolicy} AND ${expectedIssue} AND ${expectedStatus} THEN 1 ELSE 0 END
      WHERE ${owned}`,
      ids.assertion,
      ...(snapshot.policy.policy_from_issue === 1
        ? [snapshot.policy.policy_id, snapshot.policy.policy_revision]
        : [
            snapshot.policy.assignment_id,
            snapshot.policy.policy_id,
            snapshot.policy.policy_revision,
            snapshot.policy.policy_binding_revision,
          ]),
      ...issueExpectationValues,
      ...statusExpectationValues,
      event.event_id,
      ids.token,
    ),
  ];

  if (snapshot.issue === null) {
    appendUnmatchedRecoveryWrites(writes, env, envelope, evaluation, ids, now);
  } else {
    const issueId = snapshot.issue.issue_id;
    if (
      evaluation.action === "begin_recovery" ||
      evaluation.action === "resolve_recovery"
    ) {
      writes.push(
        statement(
          env,
          `UPDATE issues SET state=?,recovery_count=?,last_recovery_at=?,
          resolved_at=CASE WHEN ?='resolved' THEN ? ELSE NULL END,
          suppression_until=CASE WHEN ?='resolved' THEN NULL ELSE suppression_until END,
          suppression_reason=CASE WHEN ?='resolved' THEN NULL ELSE suppression_reason END,
          revision=revision+1 WHERE issue_id=? AND revision=? AND ${owned}`,
          evaluation.issue_state,
          evaluation.recovery_count,
          evaluation.last_recovery_at,
          evaluation.issue_state,
          now,
          evaluation.issue_state,
          evaluation.issue_state,
          issueId,
          snapshot.issue.revision,
          event.event_id,
          ids.token,
        ),
      );
    }
    appendEvidenceWrites(writes, env, envelope, issueId, null, ids.token, now);
    writes.push(
      statement(
        env,
        `INSERT INTO audit_log(audit_id,actor_type,actor_subject,actor_roles_json,action,target_type,target_id,
        before_revision,after_revision,correlation_id,occurred_at,details_json)
        SELECT ?,'machine',?,'[]','diagnostic.recovery_evaluated','issue',?,?,revision,?,?,
          json_object('event_id',?,'recovery_of_event_id',?,'domain_action',?,'policy_id',?,'policy_revision',?)
        FROM issues WHERE issue_id=? AND ${owned}`,
        ids.audit,
        envelope.producer.subject,
        issueId,
        snapshot.issue.revision,
        event.correlation_id,
        now,
        event.event_id,
        event.recovery_of_event_id,
        evaluation.action,
        snapshot.policy.policy_id,
        snapshot.policy.policy_revision,
        issueId,
        event.event_id,
        ids.token,
      ),
      statement(
        env,
        `INSERT INTO outbox(outbox_id,aggregate_type,aggregate_id,event_type,schema_version,payload_json,
        state,attempt_count,available_at,next_attempt_at,created_at)
        SELECT ?,'issue',?,'diagnostic.issue.recovery_evaluated','1.0',
          json_object('issue_id',?,'event_id',?,'action',?,'state',state,'revision',revision),
          'pending',0,?,?,? FROM issues WHERE issue_id=? AND ${owned}`,
        ids.outbox,
        issueId,
        issueId,
        event.event_id,
        evaluation.action,
        now,
        now,
        now,
        issueId,
        event.event_id,
        ids.token,
      ),
    );
  }

  if (statusPlan !== null)
    writes.push(
      ...(statusPlan.writes as unknown as readonly D1StatementLike[]),
    );

  writes.push(
    statement(
      env,
      `SELECT event_id,payload_digest,processing_token FROM diagnostic_event_dedup WHERE event_id=?`,
      event.event_id,
    ),
  );
  return writes;
}

/** 为无匹配 Issue 的恢复证据追加可审计的无操作。 / Append an auditable no-op for recovery evidence with no matching Issue. */
function appendUnmatchedRecoveryWrites(
  writes: D1StatementLike[],
  env: DiagnosticConsumerEnv,
  envelope: DiagnosticQueueEnvelope,
  evaluation: ReturnType<typeof evaluateWithCore>,
  ids: { token: string; audit: string; outbox: string },
  now: string,
): void {
  const event = envelope.event;
  const owned = `EXISTS(SELECT 1 FROM diagnostic_event_dedup WHERE event_id=? AND processing_token=?)`;
  writes.push(
    statement(
      env,
      `INSERT INTO audit_log(audit_id,actor_type,actor_subject,actor_roles_json,action,target_type,target_id,
      before_revision,after_revision,correlation_id,occurred_at,details_json)
      SELECT ?,'machine',?,'[]','diagnostic.recovery_unmatched','service',?,NULL,NULL,?,?,
        json_object('event_id',?,'recovery_of_event_id',?,'domain_action',?) WHERE ${owned}`,
      ids.audit,
      envelope.producer.subject,
      event.service_name,
      event.correlation_id,
      now,
      event.event_id,
      event.recovery_of_event_id,
      evaluation.action,
      event.event_id,
      ids.token,
    ),
    statement(
      env,
      `INSERT INTO outbox(outbox_id,aggregate_type,aggregate_id,event_type,schema_version,payload_json,
      state,attempt_count,available_at,next_attempt_at,created_at)
      SELECT ?,'service',?,'diagnostic.recovery.unmatched','1.0',json_object('service_name',?,'event_id',?),
      'pending',0,?,?,? WHERE ${owned}`,
      ids.outbox,
      event.service_name,
      event.service_name,
      event.event_id,
      now,
      now,
      now,
      event.event_id,
      ids.token,
    ),
  );
}

/** 把每个 evidence 保存为后端无关的来源记录。 / Persist each evidence item as a backend-neutral provenance record. */
function appendEvidenceWrites(
  writes: D1StatementLike[],
  env: DiagnosticConsumerEnv,
  envelope: DiagnosticQueueEnvelope,
  issueId: string,
  occurrenceId: string | null,
  token: string,
  now: string,
): void {
  const event = envelope.event;
  for (const evidence of event.evidence) {
    const referenceId = uuidV7(new Date(now));
    const timeRange =
      "time_range" in evidence ? evidence.time_range : undefined;
    const locatorTrace =
      evidence.kind === "trace" ? evidence.locator.trace_id : event.trace_id;
    const locatorSpan =
      evidence.kind === "trace" ? evidence.locator.span_id : event.span_id;
    writes.push(
      statement(
        env,
        `INSERT INTO telemetry_references(telemetry_reference_id,kind,backend_name,locator_json,
      range_start,range_end,service_name,deployment_id,correlation_id,trace_id,span_id,expires_at,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,NULL,? WHERE EXISTS(
        SELECT 1 FROM diagnostic_event_dedup WHERE event_id=? AND processing_token=?)`,
        referenceId,
        evidence.kind,
        evidence.backend,
        JSON.stringify(evidence.locator),
        timeRange?.start ?? null,
        timeRange?.end ?? null,
        event.service_name,
        event.deployment_id,
        event.correlation_id,
        locatorTrace ?? null,
        locatorSpan ?? null,
        now,
        event.event_id,
        token,
      ),
    );
    writes.push(
      statement(
        env,
        `INSERT INTO issue_telemetry_references(issue_id,telemetry_reference_id,occurrence_id,linked_at)
      SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM diagnostic_event_dedup WHERE event_id=? AND processing_token=?)`,
        issueId,
        referenceId,
        occurrenceId,
        now,
        event.event_id,
        token,
      ),
    );
    writes.push(
      statement(
        env,
        `INSERT OR IGNORE INTO incident_telemetry_references(incident_id,telemetry_reference_id,update_sequence)
        SELECT ii.incident_id,?,ii.update_sequence FROM incident_issues ii
        JOIN incident_current ic ON ic.incident_id=ii.incident_id
        WHERE ii.issue_id=? AND ic.state<>'resolved' AND EXISTS(
          SELECT 1 FROM diagnostic_event_dedup WHERE event_id=? AND processing_token=?)`,
        referenceId,
        issueId,
        event.event_id,
        token,
      ),
    );
  }
}

/**
 * 处理一个已验证信封，并在单个 D1 batch 事务中写入所有领域效果。
 * Process one validated envelope and commit every domain effect in one D1 batch transaction.
 *
 * 返回 `duplicate` 时没有 occurrence、revision、transition、audit 或 outbox 副作用。
 * A `duplicate` result has no occurrence, revision, transition, audit, or outbox side effect.
 */
export async function processDiagnosticEnvelope(
  input: unknown,
  env: DiagnosticConsumerEnv,
): Promise<"processed" | "duplicate"> {
  const parsed = DiagnosticQueueEnvelopeSchema.safeParse(input);
  if (!parsed.success)
    throw new ConsumerStageError(
      "envelope_validation",
      "invalid-diagnostic-envelope",
    );
  const envelope = parsed.data;
  let fingerprintHash: string;
  try {
    validateWithCore(env.DIAGNOSTIC_CORE, envelope.event);
    fingerprintHash = fingerprintWithCore(
      env.DIAGNOSTIC_CORE,
      envelope.event,
    ).hash;
  } catch (error) {
    throw new ConsumerStageError(
      "domain_validation",
      "diagnostic-domain-validation-failed",
      error,
    );
  }

  const nowDate = (env.now ?? (() => new Date()))();
  const now = nowDate.toISOString();
  let snapshot: Awaited<ReturnType<typeof readEvaluationSnapshot>>;
  try {
    snapshot = await readEvaluationSnapshot(
      env,
      envelope.event,
      fingerprintHash,
      envelope.origin?.kind === "monitor" ? envelope.origin.monitor_id : null,
    );
  } catch (error) {
    throw new ConsumerStageError(
      "d1_transaction",
      "diagnostic-snapshot-read-failed",
      error,
    );
  }
  let evaluation: ReturnType<typeof evaluateWithCore>;
  try {
    evaluation = evaluateWithCore(
      env.DIAGNOSTIC_CORE,
      envelope.event,
      decodeRules(snapshot.policy),
      snapshot.issue,
      snapshot.status,
      now,
    );
    if (evaluation.fingerprint_hash !== fingerprintHash)
      throw new Error(
        "evaluation fingerprint does not match canonical fingerprint",
      );
  } catch (error) {
    throw new ConsumerStageError(
      "policy_evaluation",
      "diagnostic-policy-evaluation-failed",
      error,
    );
  }

  const ids = {
    token: uuidV7(nowDate),
    issue: uuidV7(nowDate),
    occurrence: uuidV7(nowDate),
    assertion: uuidV7(nowDate),
    audit: uuidV7(nowDate),
    outbox: uuidV7(nowDate),
  };
  const digest = await payloadDigest(envelope.event);
  let statusPlan: D1StatusEvaluationPlan | null = null;
  const createsIssue =
    snapshot.issue === null || evaluation.action === "create_recurrence";
  const plannedIssueId = createsIssue ? ids.issue : snapshot.issue!.issue_id;
  const previouslyPublic =
    snapshot.issue?.state === "active" ||
    snapshot.issue?.state === "recovering";
  const becomesPublic =
    evaluation.issue_state === "active" ||
    evaluation.issue_state === "recovering";
  if (previouslyPublic || becomesPublic) {
    try {
      const reevaluator = new D1TargetReevaluator(
        env.DB as unknown as SchedulingDatabase,
        env.DIAGNOSTIC_CORE as unknown as RustDispatcher,
        () => nowDate.getTime(),
      );
      statusPlan = await reevaluator.plan(
        { type: "service", id: envelope.event.service_name },
        { type: "diagnostic_event", id: envelope.event.event_id },
        {
          evaluatedAt: now,
          issue: {
            issueId: plannedIssueId,
            state: evaluation.issue_state,
            severity: evaluation.severity,
            fingerprintHash: evaluation.fingerprint_hash,
            diagnosticRulesJson: snapshot.policy.diagnostic_rules_json,
          },
          policy: {
            policyId: snapshot.policy.policy_id,
            policyRevision: snapshot.policy.policy_revision,
            freshUntil: new Date(
              Date.parse(now) + snapshot.policy.stale_after_seconds * 1000,
            ).toISOString(),
          },
          ownership: {
            eventId: envelope.event.event_id,
            processingToken: ids.token,
          },
        },
      );
    } catch (error) {
      throw new ConsumerStageError(
        "d1_transaction",
        "diagnostic-status-plan-failed",
        error,
      );
    }
  }
  if (statusPlan)
    measurement(
      env.TELEMETRY,
      "status.evaluation.duration",
      statusPlan.metrics.durationMs,
      "diagnostic",
      true,
    );
  let results: D1ResultLike[];
  try {
    results = await env.DB.batch(
      envelope.event.signal === "recovery"
        ? buildRecoveryWrites(
            env,
            envelope,
            snapshot,
            evaluation,
            ids,
            now,
            digest,
            statusPlan,
          )
        : buildDomainWrites(
            env,
            envelope,
            snapshot,
            evaluation,
            ids,
            now,
            digest,
            statusPlan,
          ),
    );
  } catch (error) {
    throw new ConsumerStageError(
      "d1_transaction",
      "diagnostic-transaction-failed",
      error,
    );
  }
  const ownership = soleRow<{
    payload_digest: string;
    processing_token: string;
  }>(results.at(-1));
  if (ownership?.processing_token === ids.token) {
    if (statusPlan)
      measurement(
        env.TELEMETRY,
        "status.transition.count",
        statusPlan.metrics.transitionCount,
        "diagnostic",
      );
    if (createsIssue && envelope.event.signal !== "recovery")
      measurement(env.TELEMETRY, "issue.creation.count", 1, "diagnostic");
    return "processed";
  }
  if (ownership?.payload_digest === digest) return "duplicate";
  throw new ConsumerStageError(
    "idempotency_conflict",
    "diagnostic-event-id-conflict",
  );
}

/** 处理单条 Queue 消息，并按尝试次数选择 retry 或显式 DLQ。 / Process one Queue message and choose retry or explicit DLQ by attempt count. */
async function consumeMessage(
  message: QueueMessageLike<unknown>,
  env: DiagnosticConsumerEnv,
): Promise<void> {
  try {
    await processDiagnosticEnvelope(message.body, env);
    message.ack();
  } catch (error) {
    const failure =
      error instanceof ConsumerStageError
        ? error
        : new ConsumerStageError(
            "d1_transaction",
            "diagnostic-consumer-failed",
            error,
          );
    const maximumAttempts = env.DIAGNOSTIC_MAX_ATTEMPTS ?? 5;
    if (
      message.attempts < maximumAttempts ||
      env.DIAGNOSTIC_DLQ === undefined
    ) {
      message.retry({
        delaySeconds: Math.min(300, 2 ** Math.max(0, message.attempts - 1)),
      });
      return;
    }
    const deadLetter: DiagnosticDeadLetterEnvelope = {
      schema_version: "1.0",
      original: message.body,
      failure: {
        stage: failure.stage,
        problem_type: `https://status.moesegfault.dev/problems/${failure.problemType}`,
        attempt: message.attempts,
        failed_at: (env.now ?? (() => new Date()))().toISOString(),
        queue_message_id: message.id,
      },
    };
    try {
      await env.DIAGNOSTIC_DLQ.send(deadLetter, { contentType: "json" });
      message.ack();
    } catch {
      message.retry({ delaySeconds: 300 });
    }
  }
}

/**
 * Cloudflare Queue batch consumer。 / Cloudflare Queue batch consumer.
 *
 * 每条消息独立 ack/retry，一条毒消息不会重放已成功的同批消息。
 * Each message is acknowledged independently so one poison message cannot replay successful siblings.
 */
export async function consume(
  batch: QueueBatchLike<unknown>,
  env: DiagnosticConsumerEnv,
): Promise<void> {
  await Promise.all(
    batch.messages.map((message) => consumeMessage(message, env)),
  );
}

/** 与 Worker 入口命名对称的别名。 / Alias symmetric with the Worker entry-point naming. */
export const consumeDiagnosticBatch = consume;

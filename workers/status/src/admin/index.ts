import type { Telemetry } from "@moesegfault/telemetry";
import { measurement } from "../platform/instrumentation.js";
import {
  AcknowledgeIssueRpcRequestSchema,
  AdminIncidentSchema,
  AssignDiagnosticPolicyRpcRequestSchema,
  CheckHealthRpcRequestSchema,
  CreateMonitorRpcRequestSchema,
  CreateIncidentRpcRequestSchema,
  CreateMaintenanceWindowRpcRequestSchema,
  DeploymentArtifactDeclarationSchema,
  GetIncidentRpcRequestSchema,
  IssueSummarySchema,
  MaintenanceWindowSchema,
  MonitorConfigSchema,
  QueryDiagnosticContextRpcRequestSchema,
  RegisterBackendRpcRequestSchema,
  RegisterEvaluationPolicyRpcRequestSchema,
  RegisterServiceRpcRequestSchema,
  RegisterTelemetryBackendRpcRequestSchema,
  SearchIssuesRpcRequestSchema,
  ServiceRegistrationSchema,
  SetStatusOverrideRpcRequestSchema,
  StatusOverrideSchema,
  SuppressIssueRpcRequestSchema,
  TelemetryReferenceSchema,
  TelemetryBackendQueryAdapterSchema,
  UpdateIncidentRpcRequestSchema,
  UpdateMaintenanceWindowRpcRequestSchema,
  UpdateMonitorRpcRequestSchema,
  type AcknowledgeIssueRpcRequest,
  type AcknowledgeIssueRpcResult,
  type AdminIncident,
  type AdminPrincipal,
  type AssignDiagnosticPolicyRpcRequest,
  type AssignDiagnosticPolicyRpcResult,
  type CheckHealthRpcRequest,
  type CheckHealthRpcResult,
  type CreateIncidentRpcRequest,
  type CreateIncidentRpcResult,
  type CreateMaintenanceWindowRpcRequest,
  type CreateMaintenanceWindowRpcResult,
  type CreateMonitorRpcRequest,
  type CreateMonitorRpcResult,
  type DeploymentManifest,
  type DiagnosticAffectedService,
  type DiagnosticAuditSummary,
  type DiagnosticContext,
  type DiagnosticContextLocator,
  type DiagnosticDependencyPath,
  type DiagnosticPolicyAssignment,
  type DiagnosticSourceLocation,
  type DiagnosticStatusTransition,
  type EvaluationPolicy,
  type GetIncidentRpcRequest,
  type GetIncidentRpcResult,
  type IssueSummary,
  type MaintenanceWindow,
  type MonitorConfig,
  type ProblemDetails,
  type QueryDiagnosticContextRpcRequest,
  type QueryDiagnosticContextRpcResult,
  type RegisterBackendRpcRequest,
  type RegisterBackendRpcResult,
  type RegisterEvaluationPolicyRpcRequest,
  type RegisterEvaluationPolicyRpcResult,
  type RegisterServiceRpcRequest,
  type RegisterServiceRpcResult,
  type RegisterTelemetryBackendRpcRequest,
  type RegisterTelemetryBackendRpcResult,
  type SearchIssuesRpcRequest,
  type SearchIssuesRpcResult,
  type SetStatusOverrideRpcRequest,
  type SetStatusOverrideRpcResult,
  type ServiceRegistration,
  type SuppressIssueRpcRequest,
  type SuppressIssueRpcResult,
  type TelemetryReference,
  type TelemetryBackendRegistration,
  type UpdateIncidentRpcRequest,
  type UpdateIncidentRpcResult,
  type UpdateMaintenanceWindowRpcRequest,
  type UpdateMaintenanceWindowRpcResult,
  type UpdateMonitorRpcRequest,
  type UpdateMonitorRpcResult,
} from "@moesegfault/contracts";
import { z } from "zod";
import {
  D1TargetReevaluator,
  type D1StatusEvaluationPlan,
  type StatusEvaluationOptions,
} from "../scheduling/reevaluate.js";
import type { RustDispatcher } from "../scheduling/types.js";

/** 管理领域所需绑定 / Bindings required by the administrative domain. */
export interface AdminEnvironment {
  /** invocation 共享的非序列化遥测。 / Nonserialized invocation-shared telemetry. */
  readonly TELEMETRY?: Telemetry;
  /** 权威领域数据库 / Authoritative domain database. */
  readonly DB: D1Database;
  /** 游标 HMAC 密钥；必须是部署 secret / Cursor HMAC secret; it must be a deployment secret. */
  readonly CURSOR_SIGNING_KEY: string;
  /** 不透明的部署版本 / Opaque deployed service version. */
  readonly STATUS_VERSION: string;
  /**
   * 真实 Rust/Wasm dispatcher；只读/非状态写可省略，状态 mutation 缺失时失败关闭。
   * Real Rust/Wasm dispatcher; reads/non-status writes may omit it, while status mutations fail closed.
   */
  readonly DOMAIN_CORE?: RustDispatcher;
}

type RpcResult<T> = { data: T } | { problem: ProblemDetails };
type Role = "viewer" | "operator" | "admin";

interface IncidentRow {
  incident_id: string;
  title: string;
  state: "investigating" | "identified" | "monitoring" | "resolved";
  impact: "degraded" | "partial_outage" | "major_outage";
  started_at: string;
  detected_at: string;
  resolved_at: string | null;
  cause: string | null;
  revision: number;
}

interface IssueRow {
  issue_id: string;
  fingerprint_hash: string;
  service_name: string;
  kind: string;
  severity: "info" | "warning" | "error" | "critical";
  state: "observed" | "active" | "recovering" | "suppressed" | "resolved";
  first_seen_at: string;
  last_seen_at: string;
  occurrence_count: number;
  affected_instance_count: number;
  policy_id: string;
  policy_revision: number;
  suppression_until: string | null;
  suppression_reason: string | null;
  revision: number;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
}

interface EvidenceRow {
  telemetry_reference_id: string;
  kind: TelemetryReference["kind"];
  backend_name: string;
  locator_json: string;
  range_start: string | null;
  range_end: string | null;
  service_name: string;
  deployment_id: string;
  correlation_id: string | null;
  trace_id: string | null;
  span_id: string | null;
  expires_at: string | null;
  created_at: string;
  issue_id?: string;
}

const ISSUE_COLUMNS = `
  i.issue_id, i.fingerprint_hash, i.service_name, i.kind, i.severity, i.state,
  i.first_seen_at, i.last_seen_at, i.occurrence_count, i.affected_instance_count,
  i.policy_id, i.policy_revision, i.suppression_until, i.suppression_reason, i.revision,
  (SELECT a.occurred_at FROM issue_actions a WHERE a.issue_id=i.issue_id AND a.action='acknowledged'
   ORDER BY a.occurred_at DESC LIMIT 1) AS acknowledged_at,
  (SELECT a.actor_subject FROM issue_actions a WHERE a.issue_id=i.issue_id AND a.action='acknowledged'
   ORDER BY a.occurred_at DESC LIMIT 1) AS acknowledged_by`;

const INCIDENT_COLUMNS = `
  c.incident_id, c.title, c.state, c.impact, c.started_at, c.detected_at,
  c.resolved_at, c.cause, c.revision`;

/**
 * 管理边界总是重新校验共享 schema 与角色，而不信任 Service Binding。
 * Revalidates the shared schema and role at the domain boundary; Service Binding is not authorization.
 */
function authorize<T>(
  schema: z.ZodType<T>,
  raw: unknown,
  required: Role,
  rpc: string,
):
  | { request: T; principal: AdminPrincipal; correlationId: string }
  | { problem: ProblemDetails } {
  const parsed = schema.safeParse(raw);
  const candidate = raw as {
    principal?: Partial<AdminPrincipal>;
    correlation_id?: string;
  } | null;
  const correlationId = candidate?.correlation_id ?? uuidv7();
  if (!parsed.success) {
    return {
      problem: problem(
        400,
        "Invalid RPC request",
        correlationId,
        rpc,
        parsed.error.issues.map((issue) => issue.message).join("; "),
      ),
    };
  }
  const request = parsed.data;
  const principal = (request as { principal: AdminPrincipal }).principal;
  const ranks: Record<Role, number> = { viewer: 1, operator: 2, admin: 3 };
  const allowed = principal.roles.some(
    (role) => ranks[role] >= ranks[required],
  );
  if (!allowed) {
    return {
      problem: problem(
        403,
        "Forbidden",
        correlationId,
        rpc,
        `Role ${required} is required.`,
      ),
    };
  }
  return { request, principal, correlationId };
}

function problem(
  status: number,
  title: string,
  correlationId: string,
  rpc: string,
  detail?: string,
): ProblemDetails {
  return {
    type: `https://status.moesegfault.dev/problems/${status === 409 ? "revision-conflict" : status === 404 ? "not-found" : status === 403 ? "forbidden" : status === 400 ? "invalid-request" : "dependency-unavailable"}`,
    title,
    status,
    ...(detail === undefined ? {} : { detail }),
    instance: `/rpc/${rpc}`,
    correlation_id: correlationId,
  };
}

function now(): string {
  return new Date().toISOString();
}

/** 生成符合 RFC 9562 布局的 UUIDv7 / Generates an RFC 9562-layout UUIDv7. */
export function uuidv7(timestamp = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let time = BigInt(timestamp);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(time & 0xffn);
    time >>= 8n;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableJson(value));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${[...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function expiry(createdAt: string): string {
  return new Date(
    Date.parse(createdAt) + 7 * 24 * 60 * 60 * 1_000,
  ).toISOString();
}

async function idempotentResource(
  db: D1Database,
  scope: string,
  key: string,
  requestDigest: string,
  correlationId: string,
): Promise<{ resourceId: string } | { problem: ProblemDetails } | null> {
  const row = await db
    .prepare(
      "SELECT request_digest, resource_id FROM idempotency_keys WHERE scope=? AND idempotency_key=?",
    )
    .bind(scope, key)
    .first<{ request_digest: string; resource_id: string | null }>();
  if (row === null) return null;
  if (row.request_digest !== requestDigest) {
    return {
      problem: problem(
        409,
        "Idempotency key conflict",
        correlationId,
        scope,
        "The command_id was already used with different content.",
      ),
    };
  }
  if (row.resource_id === null) {
    return {
      problem: problem(409, "Incomplete prior command", correlationId, scope),
    };
  }
  return { resourceId: row.resource_id };
}

function idempotencyStatement(
  db: D1Database,
  scope: string,
  key: string,
  requestDigest: string,
  resourceType: string,
  resourceId: string,
  createdAt: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO idempotency_keys
    (scope,idempotency_key,request_digest,resource_type,resource_id,response_status,response_json,created_at,expires_at)
    VALUES (?,?,?,?,?,200,?, ?,?)`,
    )
    .bind(
      scope,
      key,
      requestDigest,
      resourceType,
      resourceId,
      JSON.stringify({ resource_id: resourceId }),
      createdAt,
      expiry(createdAt),
    );
}

function auditStatement(
  db: D1Database,
  principal: AdminPrincipal,
  correlationId: string,
  action: string,
  targetType: string,
  targetId: string,
  beforeRevision: number | null,
  afterRevision: number | null,
  occurredAt: string,
  details: unknown = {},
  auditId: string = uuidv7(),
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_log
    (audit_id,actor_type,actor_subject,actor_roles_json,action,target_type,target_id,before_revision,after_revision,correlation_id,occurred_at,details_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      auditId,
      "human",
      principal.subject,
      JSON.stringify(principal.roles),
      action,
      targetType,
      targetId,
      beforeRevision,
      afterRevision,
      correlationId,
      occurredAt,
      JSON.stringify(details),
    );
}

function outboxStatement(
  db: D1Database,
  aggregateType: string,
  aggregateId: string,
  eventType: string,
  payload: unknown,
  occurredAt: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO outbox
    (outbox_id,aggregate_type,aggregate_id,event_type,schema_version,payload_json,state,attempt_count,available_at,next_attempt_at,created_at)
    VALUES (?,?,?,?,? ,?,'pending',0,?,?,?)`,
    )
    .bind(
      uuidv7(),
      aggregateType,
      aggregateId,
      eventType,
      "1.0",
      JSON.stringify(payload),
      occurredAt,
      occurredAt,
      occurredAt,
    );
}

interface ReevaluationTarget {
  readonly type: "service" | "component";
  readonly id: string;
}

/**
 * 展开服务到直属及支撑组件，确保维护或 Issue 变化不会留下继承状态。
 * Expands services to owned and supported components so maintenance or Issue changes cannot leave inherited status stale.
 */
async function expandReevaluationTargets(
  db: D1Database,
  serviceIds: readonly string[],
  componentIds: readonly string[],
): Promise<ReevaluationTarget[]> {
  const services = [...new Set(serviceIds)];
  const components = new Set(componentIds);
  if (services.length > 0) {
    const placeholders = services.map(() => "?").join(",");
    const rows = await db
      .prepare(
        `SELECT component_id FROM components WHERE service_name IN (${placeholders})
         UNION SELECT component_id FROM component_services WHERE service_name IN (${placeholders})`,
      )
      .bind(...services, ...services)
      .all<{ component_id: string }>();
    for (const row of rows.results) components.add(row.component_id);
  }
  return [
    ...services.map((id) => ({ type: "service" as const, id })),
    ...[...components].map((id) => ({ type: "component" as const, id })),
  ];
}

/** 构造调度器可消费的标准重评估事件 / Builds standard reevaluation events consumed by the scheduler. */
function reevaluationStatements(
  db: D1Database,
  targets: readonly ReevaluationTarget[],
  sourceType: string,
  sourceId: string,
  occurredAt: string,
): D1PreparedStatement[] {
  return targets.map((target) =>
    outboxStatement(
      db,
      "status_target",
      target.id,
      "status.reevaluation_requested",
      {
        target_type: target.type,
        target_id: target.id,
        source_type: sourceType,
        source_id: sourceId,
      },
      occurredAt,
    ),
  );
}

/** 构造受同事务 mutation 标记保护的重评估事件 / Builds reevaluation events gated by the causal mutation marker. */
function gatedReevaluationStatements(
  db: D1Database,
  targets: readonly ReevaluationTarget[],
  sourceType: string,
  sourceId: string,
  occurredAt: string,
  gateSql: string,
  gateBindings: readonly unknown[],
): D1PreparedStatement[] {
  return targets.map((target) =>
    db
      .prepare(
        `INSERT INTO outbox
         (outbox_id,aggregate_type,aggregate_id,event_type,schema_version,payload_json,state,attempt_count,available_at,next_attempt_at,created_at)
         SELECT ?,'status_target',?,'status.reevaluation_requested','1.0',?,'pending',0,?,?,?
         WHERE ${gateSql}`,
      )
      .bind(
        uuidv7(),
        target.id,
        JSON.stringify({
          target_type: target.type,
          target_id: target.id,
          source_type: sourceType,
          source_id: sourceId,
        }),
        occurredAt,
        occurredAt,
        occurredAt,
        ...gateBindings,
      ),
  );
}

/** 为未来到期时刻创建受 mutation 标记保护的重评估 / Schedules mutation-gated reevaluation for a future expiry. */
function scheduledReevaluationStatements(
  db: D1Database,
  targets: readonly ReevaluationTarget[],
  eventType: "suppression.expired",
  sourceType: string,
  sourceId: string,
  dueAt: string,
  createdAt: string,
  gateSql: string,
  gateBindings: readonly unknown[],
): D1PreparedStatement[] {
  return targets.map((target) =>
    db
      .prepare(
        `INSERT INTO outbox
         (outbox_id,aggregate_type,aggregate_id,event_type,schema_version,payload_json,state,attempt_count,available_at,next_attempt_at,created_at)
         SELECT ?,'status_target',?,?,'1.0',?,'pending',0,?,?,? WHERE ${gateSql}`,
      )
      .bind(
        uuidv7(),
        target.id,
        eventType,
        JSON.stringify({
          target_type: target.type,
          target_id: target.id,
          source_type: sourceType,
          source_id: sourceId,
        }),
        dueAt,
        dueAt,
        createdAt,
        ...gateBindings,
      ),
  );
}

/**
 * 从同一全信号快照为所有目标构造计划；相同 generation 只保留一个 guard。
 * Plans every target from one full-signal snapshot and retains one guard per shared generation.
 */
async function planStatusReevaluation(
  env: AdminEnvironment,
  targets: readonly ReevaluationTarget[],
  source: { readonly type: string; readonly id: string },
  options: StatusEvaluationOptions,
): Promise<{
  readonly guards: D1PreparedStatement[];
  readonly writes: D1PreparedStatement[];
  readonly transitionCount: number;
}> {
  if (env.DOMAIN_CORE === undefined)
    throw new Error("admin_domain_core_not_configured");
  const reevaluator = new D1TargetReevaluator(env.DB, env.DOMAIN_CORE, () =>
    Date.parse(options.evaluatedAt ?? now()),
  );
  const plans = await Promise.all(
    targets.map((target) => reevaluator.plan(target, source, options)),
  );
  for (const plan of plans)
    measurement(
      env.TELEMETRY,
      "status.evaluation.duration",
      plan.metrics.durationMs,
      "admin",
      true,
    );
  const byGeneration = new Map<number, D1StatusEvaluationPlan>();
  for (const plan of plans)
    if (!byGeneration.has(plan.generation))
      byGeneration.set(plan.generation, plan);
  return {
    guards: [...byGeneration.values()].map(
      (plan) => plan.guard as D1PreparedStatement,
    ),
    writes: plans.flatMap((plan) => plan.writes as D1PreparedStatement[]),
    transitionCount: plans.reduce(
      (total, plan) => total + plan.metrics.transitionCount,
      0,
    ),
  };
}

/** 缺少完整领域核心时拒绝降级写入 / Rejects a weakened mutation when the full domain core is absent. */
function requireDomainCore(
  env: AdminEnvironment,
  correlationId: string,
  rpc: string,
): { problem: ProblemDetails } | null {
  return env.DOMAIN_CORE === undefined
    ? {
        problem: problem(
          503,
          "Status evaluation core unavailable",
          correlationId,
          rpc,
          "The mutation was not attempted because atomic full-signal evaluation is unavailable.",
        ),
      }
    : null;
}

/** 构造会在零行 mutation 时中止整个 D1 batch 的断言 / Builds an assertion that aborts the whole D1 batch on a zero-row mutation. */
function assertPreviousMutation(
  db: D1Database,
  id: string,
): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO transaction_assertions(assertion_id,passed) VALUES (?,CASE WHEN changes()=1 THEN 1 ELSE 0 END)",
    )
    .bind(id);
}

async function evidenceForIssues(
  db: D1Database,
  issueIds: readonly string[],
): Promise<Map<string, TelemetryReference[]>> {
  const grouped = new Map<string, TelemetryReference[]>();
  if (issueIds.length === 0) return grouped;
  const placeholders = issueIds.map(() => "?").join(",");
  const result = await db
    .prepare(
      `SELECT r.issue_id, t.* FROM issue_telemetry_references r
    JOIN telemetry_references t ON t.telemetry_reference_id=r.telemetry_reference_id
    WHERE r.issue_id IN (${placeholders}) ORDER BY r.linked_at DESC LIMIT 3200`,
    )
    .bind(...issueIds)
    .all<EvidenceRow>();
  for (const row of result.results) {
    const values = grouped.get(row.issue_id!) ?? [];
    if (values.length < 32) values.push(mapEvidence(row));
    grouped.set(row.issue_id!, values);
  }
  return grouped;
}

function mapEvidence(row: EvidenceRow): TelemetryReference {
  const base: Record<string, unknown> = {
    id: row.telemetry_reference_id,
    kind: row.kind,
    backend: row.backend_name,
    locator: JSON.parse(row.locator_json),
    service_name: row.service_name,
    deployment_id: row.deployment_id,
  };
  if (row.range_start !== null && row.range_end !== null)
    base.time_range = { start: row.range_start, end: row.range_end };
  if (row.correlation_id !== null) base.correlation_id = row.correlation_id;
  if (row.trace_id !== null) base.trace_id = row.trace_id;
  if (row.span_id !== null) base.span_id = row.span_id;
  if (row.expires_at !== null) base.expires_at = row.expires_at;
  return TelemetryReferenceSchema.parse(base);
}

function mapIssue(
  row: IssueRow,
  evidence: readonly TelemetryReference[],
): IssueSummary {
  return IssueSummarySchema.parse({
    issue_id: row.issue_id,
    fingerprint_hash: `sha256:${row.fingerprint_hash}`,
    service_name: row.service_name,
    kind: row.kind,
    severity: row.severity,
    state: row.state,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    occurrence_count: row.occurrence_count,
    affected_instance_count: row.affected_instance_count,
    policy_revision: `${row.policy_id}:${row.policy_revision}`,
    latest_evidence: evidence,
    acknowledged_at: row.acknowledged_at,
    acknowledged_by: row.acknowledged_by,
    suppressed_until: row.suppression_until,
    suppression_reason: row.suppression_reason,
    revision: row.revision,
  });
}

async function getIssueData(
  db: D1Database,
  issueId: string,
): Promise<IssueSummary | null> {
  const row = await db
    .prepare(`SELECT ${ISSUE_COLUMNS} FROM issues i WHERE i.issue_id=?`)
    .bind(issueId)
    .first<IssueRow>();
  if (row === null) return null;
  const evidence = await evidenceForIssues(db, [issueId]);
  return mapIssue(row, evidence.get(issueId) ?? []);
}

async function getIncidentData(
  db: D1Database,
  incidentId: string,
): Promise<AdminIncident | null> {
  const row = await db
    .prepare(
      `SELECT ${INCIDENT_COLUMNS} FROM incident_current c WHERE c.incident_id=?`,
    )
    .bind(incidentId)
    .first<IncidentRow>();
  if (row === null) return null;
  const [componentResult, serviceResult, issueResult, updateResult] =
    await Promise.all([
      db
        .prepare(
          "SELECT component_id FROM incident_components WHERE incident_id=? ORDER BY component_id",
        )
        .bind(incidentId)
        .all<{ component_id: string }>(),
      db
        .prepare(
          "SELECT service_name FROM incident_services WHERE incident_id=? ORDER BY service_name",
        )
        .bind(incidentId)
        .all<{ service_name: string }>(),
      db
        .prepare(
          "SELECT issue_id FROM incident_issues WHERE incident_id=? ORDER BY issue_id",
        )
        .bind(incidentId)
        .all<{ issue_id: string }>(),
      db
        .prepare(
          `SELECT sequence,state,impact,public_message AS message,occurred_at AS published_at
      FROM incident_updates WHERE incident_id=? ORDER BY sequence`,
        )
        .bind(incidentId)
        .all(),
    ]);
  return AdminIncidentSchema.parse({
    ...row,
    affected_components: componentResult.results.map(
      (item) => item.component_id,
    ),
    affected_services: serviceResult.results.map((item) => item.service_name),
    issue_ids: issueResult.results.map((item) => item.issue_id),
    updates: updateResult.results,
  });
}

function maintenanceState(
  startsAt: string,
  endsAt: string,
  explicit?: "scheduled" | "active" | "cancelled",
): "scheduled" | "active" | "completed" | "cancelled" {
  if (explicit === "cancelled") return "cancelled";
  const timestamp = Date.now();
  if (Date.parse(endsAt) <= timestamp) return "completed";
  if (Date.parse(startsAt) <= timestamp) return "active";
  return "scheduled";
}

async function getMaintenanceData(
  db: D1Database,
  id: string,
): Promise<MaintenanceWindow | null> {
  const row = await db
    .prepare("SELECT * FROM maintenance_windows WHERE maintenance_id=?")
    .bind(id)
    .first<Record<string, unknown>>();
  if (row === null) return null;
  const targets = await db
    .prepare(
      "SELECT target_type,target_id FROM maintenance_targets WHERE maintenance_id=? ORDER BY target_type,target_id",
    )
    .bind(id)
    .all<{ target_type: "service" | "component"; target_id: string }>();
  return MaintenanceWindowSchema.parse({
    maintenance_id: row.maintenance_id,
    title: row.title,
    description: row.description,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    expected_impact: row.expected_impact,
    state: row.state,
    created_by: row.created_by,
    revision: row.revision,
    target_services: targets.results
      .filter((target) => target.target_type === "service")
      .map((target) => target.target_id),
    target_components: targets.results
      .filter((target) => target.target_type === "component")
      .map((target) => target.target_id),
  });
}

function bool(value: number): boolean {
  return value === 1;
}

async function getMonitorData(
  db: D1Database,
  monitorId: string,
): Promise<MonitorConfig | null> {
  const row = await db
    .prepare("SELECT * FROM monitors WHERE monitor_id=?")
    .bind(monitorId)
    .first<Record<string, unknown>>();
  if (row === null) return null;
  const locations = await db
    .prepare(
      "SELECT location FROM monitor_locations WHERE monitor_id=? AND enabled=1 ORDER BY location",
    )
    .bind(monitorId)
    .all<{ location: string }>();
  return MonitorConfigSchema.parse({
    monitor_id: row.monitor_id,
    service_name:
      row.target_type === "service"
        ? row.target_id
        : (
            await db
              .prepare(
                "SELECT service_name FROM components WHERE component_id=?",
              )
              .bind(row.target_id)
              .first<{ service_name: string }>()
          )?.service_name,
    target_type: row.target_type,
    target_id: row.target_id,
    probe_kind: row.probe_kind,
    probe_config: JSON.parse(row.probe_config_json as string),
    schedule_kind: row.schedule_kind,
    schedule_expression: row.schedule_expression,
    interval_seconds: row.interval_seconds,
    timeout_ms: row.timeout_ms,
    locations: locations.results.map((item) => item.location),
    policy_id: row.policy_id,
    policy_revision: row.policy_revision,
    enabled: bool(row.enabled as number),
    revision: row.revision,
  });
}

async function getServiceData(
  db: D1Database,
  serviceName: string,
): Promise<ServiceRegistration | null> {
  const row = await db
    .prepare("SELECT * FROM services WHERE service_name=?")
    .bind(serviceName)
    .first<Record<string, unknown>>();
  if (row === null) return null;
  const [components, dependencies] = await Promise.all([
    db
      .prepare(
        "SELECT component_id,display_name,public,sort_order FROM components WHERE service_name=? ORDER BY sort_order,component_id",
      )
      .bind(serviceName)
      .all<Record<string, unknown>>(),
    db
      .prepare(
        "SELECT target_service,kind,criticality,capability FROM service_dependencies WHERE source_service=? ORDER BY target_service,capability",
      )
      .bind(serviceName)
      .all(),
  ]);
  return ServiceRegistrationSchema.parse({
    service_name: row.service_name,
    display_name: row.display_name,
    description: row.description,
    owner: row.owner,
    criticality: row.criticality,
    enabled: bool(row.enabled as number),
    components: components.results.map((component) => ({
      ...component,
      public: bool(component.public as number),
    })),
    dependencies: dependencies.results,
    revision: row.revision,
    registered_at: row.created_at,
  });
}

function changes(result: D1Result<unknown> | undefined): number {
  const meta = result?.meta as { changes?: number } | undefined;
  return meta?.changes ?? 0;
}

/** 检查管理 RPC 与权威 D1，而不是推断公共状态 / Checks RPC and authoritative D1, not public status. */
export async function checkHealth(
  env: AdminEnvironment,
  raw: CheckHealthRpcRequest,
): Promise<CheckHealthRpcResult> {
  const auth = authorize(
    CheckHealthRpcRequestSchema,
    raw,
    "viewer",
    "checkHealth",
  );
  if ("problem" in auth) return auth;
  const checkedAt = now();
  try {
    await env.DB.prepare("SELECT 1 AS ok").first();
    return {
      data: {
        status: "ok",
        checked_at: checkedAt,
        service_name: "status",
        version: env.STATUS_VERSION,
        dependencies: [
          { name: "d1", status: "ok", last_success_at: checkedAt },
        ],
      },
    };
  } catch {
    return {
      data: {
        status: "degraded",
        checked_at: checkedAt,
        service_name: "status",
        version: env.STATUS_VERSION,
        dependencies: [
          { name: "d1", status: "unavailable", last_success_at: null },
        ],
      },
    };
  }
}

/** 读取包含不可变时间线的 Incident / Reads an Incident with its immutable timeline. */
export async function getIncident(
  env: AdminEnvironment,
  raw: GetIncidentRpcRequest,
): Promise<GetIncidentRpcResult> {
  const auth = authorize(
    GetIncidentRpcRequestSchema,
    raw,
    "viewer",
    "getIncident",
  );
  if ("problem" in auth) return auth;
  const incident = await getIncidentData(env.DB, auth.request.incident_id);
  return incident === null
    ? {
        problem: problem(
          404,
          "Incident not found",
          auth.correlationId,
          "getIncident",
        ),
      }
    : { data: incident };
}

interface IssueCursor {
  readonly last_seen_at: string;
  readonly issue_id: string;
  readonly query_digest: string;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decode64url(value: string): Uint8Array {
  const normalized = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function signCursor(secret: string, value: IssueCursor): Promise<string> {
  const payload = new TextEncoder().encode(JSON.stringify(value));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, payload),
  );
  return `${base64url(payload)}.${base64url(signature)}`;
}

async function readCursor(
  secret: string,
  cursor: string,
): Promise<IssueCursor | null> {
  const parts = cursor.split(".");
  if (parts.length !== 2) return null;
  try {
    const payload = decode64url(parts[0]!);
    const signature = decode64url(parts[1]!);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    if (
      !(await crypto.subtle.verify(
        "HMAC",
        key,
        Uint8Array.from(signature).buffer,
        Uint8Array.from(payload).buffer,
      ))
    )
      return null;
    const value = JSON.parse(new TextDecoder().decode(payload)) as IssueCursor;
    return typeof value.last_seen_at === "string" &&
      typeof value.issue_id === "string" &&
      typeof value.query_digest === "string"
      ? value
      : null;
  } catch {
    return null;
  }
}

/** 查询 Issue；游标经 HMAC 签名并绑定过滤器 / Searches Issues using an HMAC-signed, query-bound cursor. */
export async function searchIssues(
  env: AdminEnvironment,
  raw: SearchIssuesRpcRequest,
): Promise<SearchIssuesRpcResult> {
  const auth = authorize(
    SearchIssuesRpcRequestSchema,
    raw,
    "viewer",
    "searchIssues",
  );
  if ("problem" in auth) return auth;
  const query = auth.request.query;
  const bindingDigest = await digest({ ...query, cursor: undefined });
  const cursor =
    query.cursor === undefined
      ? null
      : await readCursor(env.CURSOR_SIGNING_KEY, query.cursor);
  if (
    query.cursor !== undefined &&
    (cursor === null || cursor.query_digest !== bindingDigest)
  ) {
    return {
      problem: problem(
        400,
        "Invalid cursor",
        auth.correlationId,
        "searchIssues",
        "Cursor signature or query binding is invalid.",
      ),
    };
  }
  const clauses: string[] = [];
  const bindings: unknown[] = [];
  if (query.service_name !== undefined) {
    clauses.push("i.service_name=?");
    bindings.push(query.service_name);
  }
  if (query.states !== undefined && query.states.length > 0) {
    clauses.push(`i.state IN (${query.states.map(() => "?").join(",")})`);
    bindings.push(...query.states);
  }
  if (query.severities !== undefined && query.severities.length > 0) {
    clauses.push(
      `i.severity IN (${query.severities.map(() => "?").join(",")})`,
    );
    bindings.push(...query.severities);
  }
  if (query.kind !== undefined) {
    clauses.push("i.kind=?");
    bindings.push(query.kind);
  }
  if (query.seen_after !== undefined) {
    clauses.push("i.last_seen_at>=?");
    bindings.push(query.seen_after);
  }
  if (query.seen_before !== undefined) {
    clauses.push("i.last_seen_at<=?");
    bindings.push(query.seen_before);
  }
  if (cursor !== null) {
    clauses.push("(i.last_seen_at < ? OR (i.last_seen_at=? AND i.issue_id<?))");
    bindings.push(cursor.last_seen_at, cursor.last_seen_at, cursor.issue_id);
  }
  const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
  const result = await env.DB.prepare(
    `SELECT ${ISSUE_COLUMNS} FROM issues i ${where}
    ORDER BY i.last_seen_at DESC,i.issue_id DESC LIMIT ?`,
  )
    .bind(...bindings, query.limit + 1)
    .all<IssueRow>();
  const hasNext = result.results.length > query.limit;
  const rows = result.results.slice(0, query.limit);
  const evidence = await evidenceForIssues(
    env.DB,
    rows.map((row) => row.issue_id),
  );
  const data = rows.map((row) =>
    mapIssue(row, evidence.get(row.issue_id) ?? []),
  );
  const last = rows.at(-1);
  const nextCursor =
    hasNext && last !== undefined
      ? await signCursor(env.CURSOR_SIGNING_KEY, {
          last_seen_at: last.last_seen_at,
          issue_id: last.issue_id,
          query_digest: bindingDigest,
        })
      : null;
  return { data: { data, next_cursor: nextCursor } };
}

async function validateIds(
  db: D1Database,
  table: "issues" | "components" | "services",
  column: string,
  values: readonly string[],
): Promise<boolean> {
  const ids = [...new Set(values)];
  if (ids.length === 0) return true;
  const result = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM ${table} WHERE ${column} IN (${ids.map(() => "?").join(",")})`,
    )
    .bind(...ids)
    .first<{ count: number }>();
  return result?.count === ids.length;
}

const INCIDENT_TRANSITIONS: Readonly<
  Record<IncidentRow["state"], readonly IncidentRow["state"][]>
> = {
  investigating: ["investigating", "identified", "monitoring"],
  identified: ["identified", "monitoring", "resolved"],
  monitoring: ["monitoring", "investigating", "resolved"],
  resolved: ["resolved"],
};

function relationStatements(
  db: D1Database,
  table: "incident_issue_relations" | "incident_component_relations",
  idColumn: "issue_id" | "component_id",
  incidentId: string,
  sequence: number,
  previous: readonly string[],
  desired: readonly string[],
  updateId: string,
): D1PreparedStatement[] {
  const oldIds = new Set(previous);
  const newIds = new Set(desired);
  const statements: D1PreparedStatement[] = [];
  for (const id of newIds) {
    if (!oldIds.has(id)) {
      statements.push(
        db
          .prepare(
            `INSERT INTO ${table} (incident_id,${idColumn},update_sequence,action)
        SELECT ?,?,?,'added' WHERE EXISTS (SELECT 1 FROM incident_updates WHERE update_id=?)`,
          )
          .bind(incidentId, id, sequence, updateId),
      );
    }
  }
  for (const id of oldIds) {
    if (!newIds.has(id)) {
      statements.push(
        db
          .prepare(
            `INSERT INTO ${table} (incident_id,${idColumn},update_sequence,action)
        SELECT ?,?,?,'removed' WHERE EXISTS (SELECT 1 FROM incident_updates WHERE update_id=?)`,
          )
          .bind(incidentId, id, sequence, updateId),
      );
    }
  }
  return statements;
}

async function desiredServices(
  db: D1Database,
  issueIds: readonly string[],
  componentIds: readonly string[],
): Promise<string[]> {
  const values = new Set<string>();
  if (issueIds.length > 0) {
    const rows = await db
      .prepare(
        `SELECT DISTINCT service_name FROM issues WHERE issue_id IN (${issueIds.map(() => "?").join(",")})`,
      )
      .bind(...issueIds)
      .all<{ service_name: string }>();
    for (const row of rows.results) values.add(row.service_name);
  }
  if (componentIds.length > 0) {
    const rows = await db
      .prepare(
        `SELECT DISTINCT service_name FROM components WHERE component_id IN (${componentIds.map(() => "?").join(",")})`,
      )
      .bind(...componentIds)
      .all<{ service_name: string }>();
    for (const row of rows.results) values.add(row.service_name);
  }
  return [...values].sort();
}

function serviceRelationStatements(
  db: D1Database,
  incidentId: string,
  sequence: number,
  previous: readonly string[],
  desired: readonly string[],
  updateId: string,
): D1PreparedStatement[] {
  const oldIds = new Set(previous);
  const newIds = new Set(desired);
  return [
    ...[...newIds]
      .filter((id) => !oldIds.has(id))
      .map((id) =>
        db
          .prepare(
            `INSERT INTO incident_service_relations
      (incident_id,service_name,update_sequence,action) SELECT ?,?,?,'added'
      WHERE EXISTS (SELECT 1 FROM incident_updates WHERE update_id=?)`,
          )
          .bind(incidentId, id, sequence, updateId),
      ),
    ...[...oldIds]
      .filter((id) => !newIds.has(id))
      .map((id) =>
        db
          .prepare(
            `INSERT INTO incident_service_relations
      (incident_id,service_name,update_sequence,action) SELECT ?,?,?,'removed'
      WHERE EXISTS (SELECT 1 FROM incident_updates WHERE update_id=?)`,
          )
          .bind(incidentId, id, sequence, updateId),
      ),
  ];
}

/**
 * 固定每个新关联 Issue 最近的 20 条 occurrence 摘要，防止 Incident 证据被保留任务删除。
 * Pins the latest 20 occurrence summaries for each newly linked Issue so retention cannot erase Incident evidence.
 */
function occurrencePinStatements(
  db: D1Database,
  incidentId: string,
  sequence: number,
  issueIds: readonly string[],
  updateId?: string,
): D1PreparedStatement[] {
  return issueIds.map((issueId) => {
    const gate =
      updateId === undefined
        ? ""
        : "AND EXISTS (SELECT 1 FROM incident_updates WHERE update_id=?)";
    return db
      .prepare(
        `INSERT OR IGNORE INTO incident_occurrences (incident_id,occurrence_id,update_sequence)
         SELECT ?,o.occurrence_id,? FROM issue_occurrences o
         WHERE o.issue_id=? ${gate}
         ORDER BY o.occurred_at DESC,o.occurrence_id DESC LIMIT 20`,
      )
      .bind(
        incidentId,
        sequence,
        issueId,
        ...(updateId === undefined ? [] : [updateId]),
      );
  });
}

/**
 * 将新关联 Issue 最近的有界 TelemetryReference 固定到本次 IncidentUpdate。
 * Pins bounded recent TelemetryReferences from newly linked Issues to this IncidentUpdate.
 */
function incidentEvidenceLinkStatements(
  db: D1Database,
  incidentId: string,
  sequence: number,
  issueIds: readonly string[],
  updateId?: string,
): D1PreparedStatement[] {
  return issueIds.map((issueId) => {
    const gate =
      updateId === undefined
        ? ""
        : "AND EXISTS (SELECT 1 FROM incident_updates WHERE update_id=?)";
    return db
      .prepare(
        `INSERT OR IGNORE INTO incident_telemetry_references
          (incident_id,telemetry_reference_id,update_sequence)
         SELECT ?,r.telemetry_reference_id,? FROM issue_telemetry_references r
         WHERE r.issue_id=? ${gate}
         ORDER BY r.linked_at DESC,r.telemetry_reference_id DESC LIMIT 32`,
      )
      .bind(
        incidentId,
        sequence,
        issueId,
        ...(updateId === undefined ? [] : [updateId]),
      );
  });
}

/** 创建 Incident、首条 update、关联、审计和 outbox 的单一原子批次 / Atomically creates an Incident, first update, relations, audit, and outbox. */
export async function createIncident(
  env: AdminEnvironment,
  raw: CreateIncidentRpcRequest,
): Promise<CreateIncidentRpcResult> {
  const auth = authorize(
    CreateIncidentRpcRequestSchema,
    raw,
    "operator",
    "createIncident",
  );
  if ("problem" in auth) return auth;
  const command = auth.request.command;
  const requestDigest = await digest(command);
  const prior = await idempotentResource(
    env.DB,
    "createIncident",
    command.command_id,
    requestDigest,
    auth.correlationId,
  );
  if (prior !== null) {
    if ("problem" in prior) return prior;
    const incident = await getIncidentData(env.DB, prior.resourceId);
    return incident === null
      ? {
          problem: problem(
            409,
            "Prior result is unavailable",
            auth.correlationId,
            "createIncident",
          ),
        }
      : { data: incident };
  }
  const issueIds = [...new Set(command.issue_ids)];
  const componentIds = [...new Set(command.affected_components)];
  if (Date.parse(command.started_at) > Date.now()) {
    return {
      problem: problem(
        400,
        "Incident cannot start in the future",
        auth.correlationId,
        "createIncident",
      ),
    };
  }
  if (
    !(await validateIds(env.DB, "issues", "issue_id", issueIds)) ||
    !(await validateIds(env.DB, "components", "component_id", componentIds))
  ) {
    return {
      problem: problem(
        400,
        "Unknown incident relation",
        auth.correlationId,
        "createIncident",
        "Every issue and component must already be registered.",
      ),
    };
  }
  const serviceIds = await desiredServices(env.DB, issueIds, componentIds);
  const incidentId = uuidv7();
  const updateId = uuidv7();
  const occurredAt = now();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      "INSERT INTO incidents (incident_id,started_at,detected_at,created_at,created_by) VALUES (?,?,?,?,?)",
    ).bind(
      incidentId,
      command.started_at,
      occurredAt,
      occurredAt,
      auth.principal.subject,
    ),
    env.DB.prepare(
      `INSERT INTO incident_updates
      (update_id,incident_id,sequence,title,state,impact,cause,public_message,resolved_at,actor_subject,correlation_id,occurred_at)
      VALUES (?,?,1,?,'investigating',?,NULL,?,NULL,?,?,?)`,
    ).bind(
      updateId,
      incidentId,
      command.title,
      command.impact,
      command.initial_message,
      auth.principal.subject,
      auth.correlationId,
      occurredAt,
    ),
    ...issueIds.map((id) =>
      env.DB.prepare(
        "INSERT INTO incident_issue_relations (incident_id,issue_id,update_sequence,action) VALUES (?,?,1,'added')",
      ).bind(incidentId, id),
    ),
    ...occurrencePinStatements(env.DB, incidentId, 1, issueIds),
    ...incidentEvidenceLinkStatements(env.DB, incidentId, 1, issueIds),
    ...componentIds.map((id) =>
      env.DB.prepare(
        "INSERT INTO incident_component_relations (incident_id,component_id,update_sequence,action) VALUES (?,?,1,'added')",
      ).bind(incidentId, id),
    ),
    ...serviceIds.map((id) =>
      env.DB.prepare(
        "INSERT INTO incident_service_relations (incident_id,service_name,update_sequence,action) VALUES (?,?,1,'added')",
      ).bind(incidentId, id),
    ),
    auditStatement(
      env.DB,
      auth.principal,
      auth.correlationId,
      "incident.created",
      "incident",
      incidentId,
      null,
      1,
      occurredAt,
    ),
    outboxStatement(
      env.DB,
      "incident",
      incidentId,
      "incident.created",
      { incident_id: incidentId, revision: 1 },
      occurredAt,
    ),
    idempotencyStatement(
      env.DB,
      "createIncident",
      command.command_id,
      requestDigest,
      "incident",
      incidentId,
      occurredAt,
    ),
  ];
  try {
    await env.DB.batch(statements);
  } catch {
    const raced = await idempotentResource(
      env.DB,
      "createIncident",
      command.command_id,
      requestDigest,
      auth.correlationId,
    );
    if (raced !== null && !("problem" in raced)) {
      const incident = await getIncidentData(env.DB, raced.resourceId);
      if (incident !== null) return { data: incident };
    }
    return {
      problem:
        raced !== null && "problem" in raced
          ? raced.problem
          : problem(
              409,
              "Incident creation conflict",
              auth.correlationId,
              "createIncident",
            ),
    };
  }
  return { data: (await getIncidentData(env.DB, incidentId))! };
}

/** 以 sequence 作为 revision 追加 IncidentUpdate；从不改写历史 / Appends an IncidentUpdate using sequence as revision; history is never rewritten. */
export async function updateIncident(
  env: AdminEnvironment,
  raw: UpdateIncidentRpcRequest,
): Promise<UpdateIncidentRpcResult> {
  const auth = authorize(
    UpdateIncidentRpcRequestSchema,
    raw,
    "operator",
    "updateIncident",
  );
  if ("problem" in auth) return auth;
  const {
    command,
    incident_id: incidentId,
    expected_revision: expectedRevision,
  } = auth.request;
  const requestDigest = await digest({ incidentId, expectedRevision, command });
  const prior = await idempotentResource(
    env.DB,
    "updateIncident",
    command.command_id,
    requestDigest,
    auth.correlationId,
  );
  if (prior !== null) {
    if ("problem" in prior) return prior;
    const value = await getIncidentData(env.DB, prior.resourceId);
    return value === null
      ? {
          problem: problem(
            409,
            "Prior result is unavailable",
            auth.correlationId,
            "updateIncident",
          ),
        }
      : { data: value };
  }
  const current = await getIncidentData(env.DB, incidentId);
  if (current === null)
    return {
      problem: problem(
        404,
        "Incident not found",
        auth.correlationId,
        "updateIncident",
      ),
    };
  if (current.revision !== expectedRevision)
    return {
      problem: problem(
        409,
        "Incident revision conflict",
        auth.correlationId,
        "updateIncident",
      ),
    };
  const state = command.state ?? current.state;
  if (!INCIDENT_TRANSITIONS[current.state].includes(state)) {
    return {
      problem: problem(
        409,
        "Invalid Incident state transition",
        auth.correlationId,
        "updateIncident",
        `${current.state} cannot transition to ${state}.`,
      ),
    };
  }
  const issueIds = [...new Set(command.issue_ids ?? current.issue_ids)];
  const componentIds = [
    ...new Set(command.affected_components ?? current.affected_components),
  ];
  if (
    !(await validateIds(env.DB, "issues", "issue_id", issueIds)) ||
    !(await validateIds(env.DB, "components", "component_id", componentIds))
  ) {
    return {
      problem: problem(
        400,
        "Unknown incident relation",
        auth.correlationId,
        "updateIncident",
      ),
    };
  }
  const serviceIds = await desiredServices(env.DB, issueIds, componentIds);
  const sequence = expectedRevision + 1;
  const occurredAt = now();
  const updateId = uuidv7();
  const resolvedAt =
    state === "resolved" ? (current.resolved_at ?? occurredAt) : null;
  const insert = env.DB.prepare(
    `INSERT INTO incident_updates
    (update_id,incident_id,sequence,title,state,impact,cause,public_message,resolved_at,actor_subject,correlation_id,occurred_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT revision FROM incident_current WHERE incident_id=?)=?`,
  ).bind(
    updateId,
    incidentId,
    sequence,
    command.title ?? current.title,
    state,
    command.impact ?? current.impact,
    command.cause === undefined ? current.cause : command.cause,
    command.message,
    resolvedAt,
    auth.principal.subject,
    auth.correlationId,
    occurredAt,
    incidentId,
    expectedRevision,
  );
  const statements: D1PreparedStatement[] = [
    insert,
    ...relationStatements(
      env.DB,
      "incident_issue_relations",
      "issue_id",
      incidentId,
      sequence,
      current.issue_ids,
      issueIds,
      updateId,
    ),
    ...occurrencePinStatements(
      env.DB,
      incidentId,
      sequence,
      issueIds.filter((id) => !current.issue_ids.includes(id)),
      updateId,
    ),
    ...incidentEvidenceLinkStatements(
      env.DB,
      incidentId,
      sequence,
      issueIds.filter((id) => !current.issue_ids.includes(id)),
      updateId,
    ),
    ...relationStatements(
      env.DB,
      "incident_component_relations",
      "component_id",
      incidentId,
      sequence,
      current.affected_components,
      componentIds,
      updateId,
    ),
    ...serviceRelationStatements(
      env.DB,
      incidentId,
      sequence,
      current.affected_services,
      serviceIds,
      updateId,
    ),
    env.DB.prepare(
      `INSERT INTO audit_log
      (audit_id,actor_type,actor_subject,actor_roles_json,action,target_type,target_id,before_revision,after_revision,correlation_id,occurred_at,details_json)
      SELECT ?,'human',?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM incident_updates WHERE update_id=?)`,
    ).bind(
      uuidv7(),
      auth.principal.subject,
      JSON.stringify(auth.principal.roles),
      "incident.updated",
      "incident",
      incidentId,
      expectedRevision,
      sequence,
      auth.correlationId,
      occurredAt,
      "{}",
      updateId,
    ),
    env.DB.prepare(
      `INSERT INTO outbox
      (outbox_id,aggregate_type,aggregate_id,event_type,schema_version,payload_json,state,attempt_count,available_at,next_attempt_at,created_at)
      SELECT ?,'incident',?,'incident.updated','1.0',?,'pending',0,?,?,? WHERE EXISTS (SELECT 1 FROM incident_updates WHERE update_id=?)`,
    ).bind(
      uuidv7(),
      incidentId,
      JSON.stringify({ incident_id: incidentId, revision: sequence }),
      occurredAt,
      occurredAt,
      occurredAt,
      updateId,
    ),
    env.DB.prepare(
      `INSERT INTO idempotency_keys
      (scope,idempotency_key,request_digest,resource_type,resource_id,response_status,response_json,created_at,expires_at)
      SELECT 'updateIncident',?,?, 'incident',?,200,?,?,? WHERE EXISTS (SELECT 1 FROM incident_updates WHERE update_id=?)`,
    ).bind(
      command.command_id,
      requestDigest,
      incidentId,
      JSON.stringify({ resource_id: incidentId }),
      occurredAt,
      expiry(occurredAt),
      updateId,
    ),
  ];
  try {
    const results = await env.DB.batch(statements);
    if (changes(results[0]) !== 1)
      return {
        problem: problem(
          409,
          "Incident revision conflict",
          auth.correlationId,
          "updateIncident",
        ),
      };
  } catch {
    const raced = await idempotentResource(
      env.DB,
      "updateIncident",
      command.command_id,
      requestDigest,
      auth.correlationId,
    );
    if (raced !== null && !("problem" in raced)) {
      const value = await getIncidentData(env.DB, raced.resourceId);
      if (value !== null) return { data: value };
    }
    return {
      problem:
        raced !== null && "problem" in raced
          ? raced.problem
          : problem(
              409,
              "Incident update conflict",
              auth.correlationId,
              "updateIncident",
            ),
    };
  }
  return { data: (await getIncidentData(env.DB, incidentId))! };
}

async function mutateIssue(
  env: AdminEnvironment,
  raw: AcknowledgeIssueRpcRequest | SuppressIssueRpcRequest,
  kind: "acknowledge" | "suppress",
): Promise<RpcResult<IssueSummary>> {
  const schema =
    kind === "acknowledge"
      ? AcknowledgeIssueRpcRequestSchema
      : SuppressIssueRpcRequestSchema;
  const auth = authorize(schema, raw, "operator", `${kind}Issue`);
  if ("problem" in auth) return auth;
  if (kind === "suppress") {
    const missingCore = requireDomainCore(
      env,
      auth.correlationId,
      "suppressIssue",
    );
    if (missingCore !== null) return missingCore;
  }
  const request = auth.request as
    AcknowledgeIssueRpcRequest | SuppressIssueRpcRequest;
  const requestDigest = await digest({
    issue_id: request.issue_id,
    expected_revision: request.expected_revision,
    command_id: request.command_id,
    ...(kind === "suppress"
      ? {
          until: (request as SuppressIssueRpcRequest).until,
          reason: (request as SuppressIssueRpcRequest).reason,
        }
      : {}),
  });
  const scope = `${kind}Issue`;
  const prior = await idempotentResource(
    env.DB,
    scope,
    request.command_id,
    requestDigest,
    auth.correlationId,
  );
  if (prior !== null) {
    if ("problem" in prior) return prior;
    const value = await getIssueData(env.DB, prior.resourceId);
    return value === null
      ? {
          problem: problem(
            409,
            "Prior result is unavailable",
            auth.correlationId,
            scope,
          ),
        }
      : { data: value };
  }
  const current = await getIssueData(env.DB, request.issue_id);
  if (current === null)
    return {
      problem: problem(404, "Issue not found", auth.correlationId, scope),
    };
  if (current.revision !== request.expected_revision)
    return {
      problem: problem(
        409,
        "Issue revision conflict",
        auth.correlationId,
        scope,
      ),
    };
  if (current.state === "resolved")
    return {
      problem: problem(
        409,
        "Resolved Issue is immutable",
        auth.correlationId,
        scope,
      ),
    };
  if (kind === "suppress" && current.state !== "active") {
    return {
      problem: problem(
        409,
        "Only an active Issue can be suppressed",
        auth.correlationId,
        scope,
      ),
    };
  }
  const occurredAt = now();
  if (
    kind === "suppress" &&
    Date.parse((request as SuppressIssueRpcRequest).until) <=
      Date.parse(occurredAt)
  ) {
    return {
      problem: problem(
        400,
        "Suppression must expire in the future",
        auth.correlationId,
        scope,
      ),
    };
  }
  const actionId = uuidv7();
  const nextRevision = request.expected_revision + 1;
  const suppress =
    kind === "suppress" ? (request as SuppressIssueRpcRequest) : null;
  const reevaluationTargets =
    kind === "suppress"
      ? await expandReevaluationTargets(env.DB, [current.service_name], [])
      : [];
  const issuePolicy =
    kind === "suppress"
      ? await env.DB.prepare(
          `SELECT i.severity,i.fingerprint_hash,p.diagnostic_rules_json
             FROM issues i JOIN evaluation_policies p ON p.policy_id=i.policy_id AND p.revision=i.policy_revision
             WHERE i.issue_id=?`,
        )
          .bind(request.issue_id)
          .first<{
            severity: "info" | "warning" | "error" | "critical";
            fingerprint_hash: string;
            diagnostic_rules_json: string;
          }>()
      : null;
  const statusPlan =
    kind === "suppress" && issuePolicy !== null
      ? await planStatusReevaluation(
          env,
          reevaluationTargets,
          { type: "issue", id: request.issue_id },
          {
            evaluatedAt: occurredAt,
            issue: {
              issueId: request.issue_id,
              state: "suppressed",
              severity: issuePolicy.severity,
              fingerprintHash: issuePolicy.fingerprint_hash,
              diagnosticRulesJson: issuePolicy.diagnostic_rules_json,
            },
          },
        )
      : {
          guards: [] as D1PreparedStatement[],
          writes: [] as D1PreparedStatement[],
          transitionCount: 0,
        };
  const update =
    kind === "acknowledge"
      ? env.DB.prepare(
          "UPDATE issues SET revision=revision+1 WHERE issue_id=? AND revision=? AND state<>'resolved'",
        ).bind(request.issue_id, request.expected_revision)
      : env.DB.prepare(
          "UPDATE issues SET state='suppressed',suppression_until=?,suppression_reason=?,revision=revision+1 WHERE issue_id=? AND revision=? AND state<>'resolved'",
        ).bind(
          suppress!.until,
          suppress!.reason,
          request.issue_id,
          request.expected_revision,
        );
  const statements: D1PreparedStatement[] = [
    update,
    assertPreviousMutation(
      env.DB,
      `issue-${kind}:${request.issue_id}:${nextRevision}`,
    ),
    env.DB.prepare(
      `INSERT INTO issue_actions
      (action_id,issue_id,issue_revision,action,reason,until_at,actor_subject,correlation_id,occurred_at)
      SELECT ?,?,?,?,?,?,?,?,? WHERE changes()=1`,
    ).bind(
      actionId,
      request.issue_id,
      nextRevision,
      kind === "acknowledge" ? "acknowledged" : "suppressed",
      suppress?.reason ?? "",
      suppress?.until ?? null,
      auth.principal.subject,
      auth.correlationId,
      occurredAt,
    ),
    env.DB.prepare(
      `INSERT INTO audit_log
      (audit_id,actor_type,actor_subject,actor_roles_json,action,target_type,target_id,before_revision,after_revision,correlation_id,occurred_at,details_json)
      SELECT ?,'human',?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM issue_actions WHERE action_id=?)`,
    ).bind(
      uuidv7(),
      auth.principal.subject,
      JSON.stringify(auth.principal.roles),
      `issue.${kind === "acknowledge" ? "acknowledged" : "suppressed"}`,
      "issue",
      request.issue_id,
      request.expected_revision,
      nextRevision,
      auth.correlationId,
      occurredAt,
      JSON.stringify(
        suppress === null
          ? {}
          : { until: suppress.until, reason: suppress.reason },
      ),
      actionId,
    ),
    ...gatedReevaluationStatements(
      env.DB,
      reevaluationTargets,
      "issue",
      request.issue_id,
      occurredAt,
      "EXISTS (SELECT 1 FROM issue_actions WHERE action_id=?)",
      [actionId],
    ),
    ...scheduledReevaluationStatements(
      env.DB,
      reevaluationTargets.filter((target) => target.type === "component"),
      "suppression.expired",
      "suppression",
      request.issue_id,
      suppress?.until ?? occurredAt,
      occurredAt,
      "EXISTS (SELECT 1 FROM issue_actions WHERE action_id=?)",
      [actionId],
    ),
    env.DB.prepare(
      `INSERT INTO outbox
      (outbox_id,aggregate_type,aggregate_id,event_type,schema_version,payload_json,state,attempt_count,available_at,next_attempt_at,created_at)
      SELECT ?,'issue',?,?, '1.0',?,'pending',0,?,?,? WHERE EXISTS (SELECT 1 FROM issue_actions WHERE action_id=?)`,
    ).bind(
      uuidv7(),
      request.issue_id,
      `issue.${kind === "acknowledge" ? "acknowledged" : "suppressed"}`,
      JSON.stringify({ issue_id: request.issue_id, revision: nextRevision }),
      occurredAt,
      occurredAt,
      occurredAt,
      actionId,
    ),
    env.DB.prepare(
      `INSERT INTO idempotency_keys
      (scope,idempotency_key,request_digest,resource_type,resource_id,response_status,response_json,created_at,expires_at)
      SELECT ?,?,?,'issue',?,200,?,?,? WHERE EXISTS (SELECT 1 FROM issue_actions WHERE action_id=?)`,
    ).bind(
      scope,
      request.command_id,
      requestDigest,
      request.issue_id,
      JSON.stringify({ resource_id: request.issue_id }),
      occurredAt,
      expiry(occurredAt),
      actionId,
    ),
  ];
  try {
    await env.DB.batch([
      ...statusPlan.guards,
      ...statements,
      ...statusPlan.writes,
    ]);
    measurement(
      env.TELEMETRY,
      "status.transition.count",
      statusPlan.transitionCount,
      "admin",
    );
  } catch {
    const raced = await idempotentResource(
      env.DB,
      scope,
      request.command_id,
      requestDigest,
      auth.correlationId,
    );
    if (raced !== null && !("problem" in raced)) {
      const value = await getIssueData(env.DB, raced.resourceId);
      if (value !== null) return { data: value };
    }
    return {
      problem:
        raced !== null && "problem" in raced
          ? raced.problem
          : problem(409, "Issue mutation conflict", auth.correlationId, scope),
    };
  }
  return { data: (await getIssueData(env.DB, request.issue_id))! };
}

/** 确认 Issue，并原子记录 action/audit/outbox / Acknowledges an Issue with atomic action/audit/outbox records. */
export async function acknowledgeIssue(
  env: AdminEnvironment,
  request: AcknowledgeIssueRpcRequest,
): Promise<AcknowledgeIssueRpcResult> {
  return mutateIssue(env, request, "acknowledge");
}

/** 临时抑制 Issue；不伪造观测成功 / Temporarily suppresses an Issue without inventing successful observations. */
export async function suppressIssue(
  env: AdminEnvironment,
  request: SuppressIssueRpcRequest,
): Promise<SuppressIssueRpcResult> {
  return mutateIssue(env, request, "suppress");
}

/** 原子创建维护窗口、目标、审计与重评估事件 / Atomically creates a maintenance window, targets, audit, and reevaluation event. */
export async function createMaintenanceWindow(
  env: AdminEnvironment,
  raw: CreateMaintenanceWindowRpcRequest,
): Promise<CreateMaintenanceWindowRpcResult> {
  const auth = authorize(
    CreateMaintenanceWindowRpcRequestSchema,
    raw,
    "operator",
    "createMaintenanceWindow",
  );
  if ("problem" in auth) return auth;
  const missingCore = requireDomainCore(
    env,
    auth.correlationId,
    "createMaintenanceWindow",
  );
  if (missingCore !== null) return missingCore;
  const command = auth.request.command;
  const requestDigest = await digest(command);
  const prior = await idempotentResource(
    env.DB,
    "createMaintenanceWindow",
    command.command_id,
    requestDigest,
    auth.correlationId,
  );
  if (prior !== null) {
    if ("problem" in prior) return prior;
    const value = await getMaintenanceData(env.DB, prior.resourceId);
    return value === null
      ? {
          problem: problem(
            409,
            "Prior result is unavailable",
            auth.correlationId,
            "createMaintenanceWindow",
          ),
        }
      : { data: value };
  }
  const services = [...new Set(command.target_services)];
  const components = [...new Set(command.target_components)];
  if (
    !(await validateIds(env.DB, "services", "service_name", services)) ||
    !(await validateIds(env.DB, "components", "component_id", components))
  ) {
    return {
      problem: problem(
        400,
        "Unknown maintenance target",
        auth.correlationId,
        "createMaintenanceWindow",
      ),
    };
  }
  const id = uuidv7();
  const occurredAt = now();
  const state = maintenanceState(command.starts_at, command.ends_at);
  const reevaluationTargets = await expandReevaluationTargets(
    env.DB,
    services,
    components,
  );
  const statusPlan = await planStatusReevaluation(
    env,
    reevaluationTargets,
    { type: "maintenance", id },
    {
      evaluatedAt: occurredAt,
      maintenance: {
        maintenanceId: id,
        state,
        startsAt: command.starts_at,
        endsAt: command.ends_at,
        targets: [
          ...services.map((targetId) => ({
            type: "service" as const,
            id: targetId,
          })),
          ...components.map((targetId) => ({
            type: "component" as const,
            id: targetId,
          })),
        ],
      },
    },
  );
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO maintenance_windows
      (maintenance_id,title,description,expected_impact,starts_at,ends_at,state,created_by,created_at,updated_at,revision)
      VALUES (?,?,?,?,?,?,?,?,?,?,1)`,
    ).bind(
      id,
      command.title,
      command.description,
      command.expected_impact,
      command.starts_at,
      command.ends_at,
      state,
      auth.principal.subject,
      occurredAt,
      occurredAt,
    ),
    ...services.map((service) =>
      env.DB.prepare(
        "INSERT INTO maintenance_targets (maintenance_id,target_type,target_id) VALUES (?,'service',?)",
      ).bind(id, service),
    ),
    ...components.map((component) =>
      env.DB.prepare(
        "INSERT INTO maintenance_targets (maintenance_id,target_type,target_id) VALUES (?,'component',?)",
      ).bind(id, component),
    ),
    auditStatement(
      env.DB,
      auth.principal,
      auth.correlationId,
      "maintenance.created",
      "maintenance",
      id,
      null,
      1,
      occurredAt,
    ),
    ...reevaluationStatements(
      env.DB,
      reevaluationTargets,
      "maintenance",
      id,
      occurredAt,
    ),
    idempotencyStatement(
      env.DB,
      "createMaintenanceWindow",
      command.command_id,
      requestDigest,
      "maintenance",
      id,
      occurredAt,
    ),
  ];
  try {
    await env.DB.batch([
      ...statusPlan.guards,
      ...statements,
      ...statusPlan.writes,
    ]);
    measurement(
      env.TELEMETRY,
      "status.transition.count",
      statusPlan.transitionCount,
      "admin",
    );
  } catch {
    const raced = await idempotentResource(
      env.DB,
      "createMaintenanceWindow",
      command.command_id,
      requestDigest,
      auth.correlationId,
    );
    if (raced !== null && !("problem" in raced)) {
      const value = await getMaintenanceData(env.DB, raced.resourceId);
      if (value !== null) return { data: value };
    }
    return {
      problem:
        raced !== null && "problem" in raced
          ? raced.problem
          : problem(
              409,
              "Maintenance creation conflict",
              auth.correlationId,
              "createMaintenanceWindow",
            ),
    };
  }
  return { data: (await getMaintenanceData(env.DB, id))! };
}

/** OCC 更新维护窗口并替换目标集合 / OCC-updates a maintenance window and replaces its target set. */
export async function updateMaintenanceWindow(
  env: AdminEnvironment,
  raw: UpdateMaintenanceWindowRpcRequest,
): Promise<UpdateMaintenanceWindowRpcResult> {
  const auth = authorize(
    UpdateMaintenanceWindowRpcRequestSchema,
    raw,
    "operator",
    "updateMaintenanceWindow",
  );
  if ("problem" in auth) return auth;
  const missingCore = requireDomainCore(
    env,
    auth.correlationId,
    "updateMaintenanceWindow",
  );
  if (missingCore !== null) return missingCore;
  const { command, id, expected_revision: expectedRevision } = auth.request;
  const requestDigest = await digest({ id, expectedRevision, command });
  const prior = await idempotentResource(
    env.DB,
    "updateMaintenanceWindow",
    command.command_id,
    requestDigest,
    auth.correlationId,
  );
  if (prior !== null) {
    if ("problem" in prior) return prior;
    const value = await getMaintenanceData(env.DB, prior.resourceId);
    return value === null
      ? {
          problem: problem(
            409,
            "Prior result is unavailable",
            auth.correlationId,
            "updateMaintenanceWindow",
          ),
        }
      : { data: value };
  }
  const current = await getMaintenanceData(env.DB, id);
  if (current === null)
    return {
      problem: problem(
        404,
        "Maintenance window not found",
        auth.correlationId,
        "updateMaintenanceWindow",
      ),
    };
  if (current.revision !== expectedRevision)
    return {
      problem: problem(
        409,
        "Maintenance revision conflict",
        auth.correlationId,
        "updateMaintenanceWindow",
      ),
    };
  const startsAt = command.starts_at ?? current.starts_at;
  const endsAt = command.ends_at ?? current.ends_at;
  if (Date.parse(startsAt) >= Date.parse(endsAt))
    return {
      problem: problem(
        400,
        "Invalid maintenance interval",
        auth.correlationId,
        "updateMaintenanceWindow",
      ),
    };
  if (current.state === "completed" || current.state === "cancelled") {
    return {
      problem: problem(
        409,
        "Terminal maintenance window is immutable",
        auth.correlationId,
        "updateMaintenanceWindow",
      ),
    };
  }
  const services = [
    ...new Set(command.target_services ?? current.target_services),
  ];
  const components = [
    ...new Set(command.target_components ?? current.target_components),
  ];
  if (services.length === 0 && components.length === 0)
    return {
      problem: problem(
        400,
        "Maintenance needs a target",
        auth.correlationId,
        "updateMaintenanceWindow",
      ),
    };
  if (
    !(await validateIds(env.DB, "services", "service_name", services)) ||
    !(await validateIds(env.DB, "components", "component_id", components))
  ) {
    return {
      problem: problem(
        400,
        "Unknown maintenance target",
        auth.correlationId,
        "updateMaintenanceWindow",
      ),
    };
  }
  const occurredAt = now();
  const nextRevision = expectedRevision + 1;
  const state = maintenanceState(startsAt, endsAt, command.state);
  const reevaluationTargets = await expandReevaluationTargets(
    env.DB,
    [...current.target_services, ...services],
    [...current.target_components, ...components],
  );
  const statusPlan = await planStatusReevaluation(
    env,
    reevaluationTargets,
    { type: "maintenance", id },
    {
      evaluatedAt: occurredAt,
      maintenance: {
        maintenanceId: id,
        state,
        startsAt,
        endsAt,
        targets: [
          ...services.map((targetId) => ({
            type: "service" as const,
            id: targetId,
          })),
          ...components.map((targetId) => ({
            type: "component" as const,
            id: targetId,
          })),
        ],
      },
    },
  );
  const update = env.DB.prepare(
    `UPDATE maintenance_windows SET title=?,description=?,expected_impact=?,starts_at=?,ends_at=?,state=?,updated_at=?,revision=revision+1
    WHERE maintenance_id=? AND revision=?`,
  ).bind(
    command.title ?? current.title,
    command.description ?? current.description,
    command.expected_impact ?? current.expected_impact,
    startsAt,
    endsAt,
    state,
    occurredAt,
    id,
    expectedRevision,
  );
  const gate =
    "EXISTS (SELECT 1 FROM maintenance_windows WHERE maintenance_id=? AND revision=? AND updated_at=?)";
  const statements: D1PreparedStatement[] = [
    update,
    assertPreviousMutation(env.DB, `maintenance-update:${id}:${nextRevision}`),
    env.DB.prepare(
      `DELETE FROM maintenance_targets WHERE maintenance_id=? AND ${gate}`,
    ).bind(id, id, nextRevision, occurredAt),
    ...services.map((service) =>
      env.DB.prepare(
        `INSERT INTO maintenance_targets (maintenance_id,target_type,target_id)
      SELECT ?,'service',? WHERE ${gate}`,
      ).bind(id, service, id, nextRevision, occurredAt),
    ),
    ...components.map((component) =>
      env.DB.prepare(
        `INSERT INTO maintenance_targets (maintenance_id,target_type,target_id)
      SELECT ?,'component',? WHERE ${gate}`,
      ).bind(id, component, id, nextRevision, occurredAt),
    ),
    env.DB.prepare(
      `INSERT INTO audit_log
      (audit_id,actor_type,actor_subject,actor_roles_json,action,target_type,target_id,before_revision,after_revision,correlation_id,occurred_at,details_json)
      SELECT ?,'human',?,?,?,?,?,?,?,?,?,? WHERE ${gate}`,
    ).bind(
      uuidv7(),
      auth.principal.subject,
      JSON.stringify(auth.principal.roles),
      "maintenance.updated",
      "maintenance",
      id,
      expectedRevision,
      nextRevision,
      auth.correlationId,
      occurredAt,
      "{}",
      id,
      nextRevision,
      occurredAt,
    ),
    ...gatedReevaluationStatements(
      env.DB,
      reevaluationTargets,
      "maintenance",
      id,
      occurredAt,
      gate,
      [id, nextRevision, occurredAt],
    ),
    env.DB.prepare(
      `INSERT INTO idempotency_keys
      (scope,idempotency_key,request_digest,resource_type,resource_id,response_status,response_json,created_at,expires_at)
      SELECT 'updateMaintenanceWindow',?,?,'maintenance',?,200,?,?,? WHERE ${gate}`,
    ).bind(
      command.command_id,
      requestDigest,
      id,
      JSON.stringify({ resource_id: id }),
      occurredAt,
      expiry(occurredAt),
      id,
      nextRevision,
      occurredAt,
    ),
  ];
  try {
    await env.DB.batch([
      ...statusPlan.guards,
      ...statements,
      ...statusPlan.writes,
    ]);
    measurement(
      env.TELEMETRY,
      "status.transition.count",
      statusPlan.transitionCount,
      "admin",
    );
  } catch {
    const raced = await idempotentResource(
      env.DB,
      "updateMaintenanceWindow",
      command.command_id,
      requestDigest,
      auth.correlationId,
    );
    if (raced !== null && !("problem" in raced)) {
      const value = await getMaintenanceData(env.DB, raced.resourceId);
      if (value !== null) return { data: value };
    }
    return {
      problem:
        raced !== null && "problem" in raced
          ? raced.problem
          : problem(
              409,
              "Maintenance update conflict",
              auth.correlationId,
              "updateMaintenanceWindow",
            ),
    };
  }
  return { data: (await getMaintenanceData(env.DB, id))! };
}

/** 注册服务目录、组件与有向依赖；相同 command_id 安全重放 / Registers a service, components, and directed dependencies with safe command replay. */
export async function registerService(
  env: AdminEnvironment,
  raw: RegisterServiceRpcRequest,
): Promise<RegisterServiceRpcResult> {
  const auth = authorize(
    RegisterServiceRpcRequestSchema,
    raw,
    "admin",
    "registerService",
  );
  if ("problem" in auth) return auth;
  const command = auth.request.command;
  const requestDigest = await digest(command);
  const prior = await idempotentResource(
    env.DB,
    "registerService",
    command.command_id,
    requestDigest,
    auth.correlationId,
  );
  if (prior !== null) {
    if ("problem" in prior) return prior;
    const value = await getServiceData(env.DB, prior.resourceId);
    return value === null
      ? {
          problem: problem(
            409,
            "Prior result is unavailable",
            auth.correlationId,
            "registerService",
          ),
        }
      : { data: value };
  }
  if (
    command.dependencies.some(
      (dependency) => dependency.target_service === command.service_name,
    )
  ) {
    return {
      problem: problem(
        400,
        "Self dependency is not allowed",
        auth.correlationId,
        "registerService",
      ),
    };
  }
  if (
    !(await validateIds(
      env.DB,
      "services",
      "service_name",
      command.dependencies.map((dependency) => dependency.target_service),
    ))
  ) {
    return {
      problem: problem(
        400,
        "Unknown dependency service",
        auth.correlationId,
        "registerService",
        "Register target services before their dependents.",
      ),
    };
  }
  const occurredAt = now();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO services
      (service_name,display_name,description,owner,criticality,enabled,created_at,updated_at,revision)
      VALUES (?,?,?,?,?,?,?,?,1)`,
    ).bind(
      command.service_name,
      command.display_name,
      command.description,
      command.owner,
      command.criticality,
      command.enabled ? 1 : 0,
      occurredAt,
      occurredAt,
    ),
    ...command.components.map((component) =>
      env.DB.prepare(
        `INSERT INTO components
      (component_id,service_name,display_name,public,sort_order,created_at,updated_at,revision)
      VALUES (?,?,?,?,?,?,?,1)`,
      ).bind(
        component.component_id,
        command.service_name,
        component.display_name,
        component.public ? 1 : 0,
        component.sort_order,
        occurredAt,
        occurredAt,
      ),
    ),
    ...command.dependencies.map((dependency) =>
      env.DB.prepare(
        `INSERT INTO service_dependencies
      (source_service,target_service,capability,kind,criticality,created_at) VALUES (?,?,?,?,?,?)`,
      ).bind(
        command.service_name,
        dependency.target_service,
        dependency.capability,
        dependency.kind,
        dependency.criticality,
        occurredAt,
      ),
    ),
    auditStatement(
      env.DB,
      auth.principal,
      auth.correlationId,
      "service.registered",
      "service",
      command.service_name,
      null,
      1,
      occurredAt,
    ),
    outboxStatement(
      env.DB,
      "service",
      command.service_name,
      "catalog.changed",
      { service_name: command.service_name, revision: 1 },
      occurredAt,
    ),
    idempotencyStatement(
      env.DB,
      "registerService",
      command.command_id,
      requestDigest,
      "service",
      command.service_name,
      occurredAt,
    ),
  ];
  try {
    await env.DB.batch(statements);
  } catch {
    const raced = await idempotentResource(
      env.DB,
      "registerService",
      command.command_id,
      requestDigest,
      auth.correlationId,
    );
    if (raced !== null && !("problem" in raced)) {
      const value = await getServiceData(env.DB, raced.resourceId);
      if (value !== null) return { data: value };
    }
    return {
      problem:
        raced !== null && "problem" in raced
          ? raced.problem
          : problem(
              409,
              "Service registration conflict",
              auth.correlationId,
              "registerService",
            ),
    };
  }
  return { data: (await getServiceData(env.DB, command.service_name))! };
}

/** 乐观更新 Monitor 及其位置集合 / Optimistically updates a Monitor and its location set. */
export async function updateMonitor(
  env: AdminEnvironment,
  raw: UpdateMonitorRpcRequest,
): Promise<UpdateMonitorRpcResult> {
  const auth = authorize(
    UpdateMonitorRpcRequestSchema,
    raw,
    "admin",
    "updateMonitor",
  );
  if ("problem" in auth) return auth;
  const {
    command,
    monitor_id: monitorId,
    expected_revision: expectedRevision,
  } = auth.request;
  const requestDigest = await digest({ monitorId, expectedRevision, command });
  const prior = await idempotentResource(
    env.DB,
    "updateMonitor",
    command.command_id,
    requestDigest,
    auth.correlationId,
  );
  if (prior !== null) {
    if ("problem" in prior) return prior;
    const value = await getMonitorData(env.DB, prior.resourceId);
    return value === null
      ? {
          problem: problem(
            409,
            "Prior result is unavailable",
            auth.correlationId,
            "updateMonitor",
          ),
        }
      : { data: value };
  }
  const current = await getMonitorData(env.DB, monitorId);
  if (current === null)
    return {
      problem: problem(
        404,
        "Monitor not found",
        auth.correlationId,
        "updateMonitor",
      ),
    };
  if (current.revision !== expectedRevision)
    return {
      problem: problem(
        409,
        "Monitor revision conflict",
        auth.correlationId,
        "updateMonitor",
      ),
    };
  const policyId = command.policy_id ?? current.policy_id;
  const policyRevision = command.policy_revision ?? current.policy_revision;
  const policy = await env.DB.prepare(
    "SELECT 1 AS ok FROM evaluation_policies WHERE policy_id=? AND revision=?",
  )
    .bind(policyId, policyRevision)
    .first();
  if (policy === null)
    return {
      problem: problem(
        400,
        "Evaluation policy not found",
        auth.correlationId,
        "updateMonitor",
      ),
    };
  const locations = [...new Set(command.locations ?? current.locations)];
  const merged = MonitorConfigSchema.safeParse({
    monitor_id: current.monitor_id,
    service_name: current.service_name,
    target_type: current.target_type,
    target_id: current.target_id,
    probe_kind: command.probe_kind ?? current.probe_kind,
    probe_config: command.probe_config ?? current.probe_config,
    schedule_kind: command.schedule_kind ?? current.schedule_kind,
    schedule_expression:
      command.schedule_expression === undefined
        ? current.schedule_expression
        : command.schedule_expression,
    interval_seconds:
      command.interval_seconds === undefined
        ? current.interval_seconds
        : command.interval_seconds,
    timeout_ms: command.timeout_ms ?? current.timeout_ms,
    locations,
    policy_id: policyId,
    policy_revision: policyRevision,
    enabled: command.enabled ?? current.enabled,
    revision: expectedRevision + 1,
  });
  if (!merged.success) {
    return {
      problem: problem(
        400,
        "Invalid monitor configuration",
        auth.correlationId,
        "updateMonitor",
        merged.error.issues.map((issue) => issue.message).join("; "),
      ),
    };
  }
  const occurredAt = now();
  const nextRevision = expectedRevision + 1;
  const update = env.DB.prepare(
    `UPDATE monitors SET probe_kind=?,probe_config_json=?,schedule_kind=?,schedule_expression=?,interval_seconds=?,timeout_ms=?,policy_id=?,policy_revision=?,enabled=?,updated_at=?,revision=revision+1
    WHERE monitor_id=? AND revision=?`,
  ).bind(
    merged.data.probe_kind,
    JSON.stringify(merged.data.probe_config),
    merged.data.schedule_kind,
    merged.data.schedule_expression,
    merged.data.interval_seconds,
    merged.data.timeout_ms,
    policyId,
    policyRevision,
    merged.data.enabled ? 1 : 0,
    occurredAt,
    monitorId,
    expectedRevision,
  );
  const gate =
    "EXISTS (SELECT 1 FROM monitors WHERE monitor_id=? AND revision=? AND updated_at=?)";
  const statements: D1PreparedStatement[] = [
    update,
    env.DB.prepare(
      `DELETE FROM monitor_locations WHERE monitor_id=? AND ${gate}`,
    ).bind(monitorId, monitorId, nextRevision, occurredAt),
    ...locations.map((location) =>
      env.DB.prepare(
        `INSERT INTO monitor_locations (monitor_id,location,enabled)
      SELECT ?,?,1 WHERE ${gate}`,
      ).bind(monitorId, location, monitorId, nextRevision, occurredAt),
    ),
    env.DB.prepare(
      `INSERT INTO audit_log
      (audit_id,actor_type,actor_subject,actor_roles_json,action,target_type,target_id,before_revision,after_revision,correlation_id,occurred_at,details_json)
      SELECT ?,'human',?,?,?,?,?,?,?,?,?,? WHERE ${gate}`,
    ).bind(
      uuidv7(),
      auth.principal.subject,
      JSON.stringify(auth.principal.roles),
      "monitor.updated",
      "monitor",
      monitorId,
      expectedRevision,
      nextRevision,
      auth.correlationId,
      occurredAt,
      "{}",
      monitorId,
      nextRevision,
      occurredAt,
    ),
    env.DB.prepare(
      `INSERT INTO outbox
      (outbox_id,aggregate_type,aggregate_id,event_type,schema_version,payload_json,state,attempt_count,available_at,next_attempt_at,created_at)
      SELECT ?,'monitor',?,'monitor.updated','1.0',?,'pending',0,?,?,? WHERE ${gate}`,
    ).bind(
      uuidv7(),
      monitorId,
      JSON.stringify({ monitor_id: monitorId, revision: nextRevision }),
      occurredAt,
      occurredAt,
      occurredAt,
      monitorId,
      nextRevision,
      occurredAt,
    ),
    env.DB.prepare(
      `INSERT INTO idempotency_keys
      (scope,idempotency_key,request_digest,resource_type,resource_id,response_status,response_json,created_at,expires_at)
      SELECT 'updateMonitor',?,?,'monitor',?,200,?,?,? WHERE ${gate}`,
    ).bind(
      command.command_id,
      requestDigest,
      monitorId,
      JSON.stringify({ resource_id: monitorId }),
      occurredAt,
      expiry(occurredAt),
      monitorId,
      nextRevision,
      occurredAt,
    ),
  ];
  try {
    const results = await env.DB.batch(statements);
    if (changes(results[0]) !== 1)
      return {
        problem: problem(
          409,
          "Monitor revision conflict",
          auth.correlationId,
          "updateMonitor",
        ),
      };
  } catch {
    const raced = await idempotentResource(
      env.DB,
      "updateMonitor",
      command.command_id,
      requestDigest,
      auth.correlationId,
    );
    if (raced !== null && !("problem" in raced)) {
      const value = await getMonitorData(env.DB, raced.resourceId);
      if (value !== null) return { data: value };
    }
    return {
      problem:
        raced !== null && "problem" in raced
          ? raced.problem
          : problem(
              409,
              "Monitor update conflict",
              auth.correlationId,
              "updateMonitor",
            ),
    };
  }
  return { data: (await getMonitorData(env.DB, monitorId))! };
}

async function deploymentData(
  db: D1Database,
  ids: readonly string[],
): Promise<DeploymentManifest[]> {
  const unique = [...new Set(ids)].slice(0, 100);
  if (unique.length === 0) return [];
  const rows = await db
    .prepare(
      `SELECT * FROM deployments WHERE deployment_id IN (${unique.map(() => "?").join(",")})`,
    )
    .bind(...unique)
    .all<Record<string, unknown>>();
  const output: DeploymentManifest[] = [];
  for (const row of rows.results) {
    const [regions, artifacts] = await Promise.all([
      db
        .prepare(
          "SELECT region FROM deployment_regions WHERE deployment_id=? ORDER BY region",
        )
        .bind(row.deployment_id)
        .all<{ region: string }>(),
      db
        .prepare(
          `SELECT kind,file_name,media_type,size_bytes,artifact_digest,build_id FROM deployment_artifact_requirements
        WHERE deployment_id=? AND size_bytes>0 ORDER BY kind,file_name`,
        )
        .bind(row.deployment_id)
        .all<Record<string, unknown>>(),
    ]);
    output.push({
      deployment_id: row.deployment_id as string,
      service_name: row.service_name as string,
      environment: row.environment as DeploymentManifest["environment"],
      service_version: row.service_version as string,
      repository_url: row.repository_url as string,
      git_commit: row.git_commit as string,
      git_ref: row.git_ref as string,
      artifact_digest: row.artifact_digest as string,
      ci_provider: row.ci_provider as string,
      ci_run_id: row.ci_run_id as string,
      deployed_at: row.deployed_at as string,
      region: regions.results.map((item) => item.region),
      artifacts: artifacts.results.map((artifact) =>
        DeploymentArtifactDeclarationSchema.parse({
          kind: artifact.kind as DeploymentManifest["artifacts"][number]["kind"],
          file_name: artifact.file_name as string,
          media_type: artifact.media_type as string,
          size_bytes: artifact.size_bytes as number,
          artifact_digest: artifact.artifact_digest as string,
          ...(artifact.build_id === null
            ? {}
            : { build_id: artifact.build_id as string }),
        }),
      ),
    });
  }
  return output;
}

type ContextRelation = DiagnosticAffectedService["relations"][number];

interface ContextEdgeRow {
  readonly source_service: string;
  readonly target_service: string;
  readonly capability: string;
  readonly kind: "required" | "optional" | "degraded_fallback";
  readonly criticality: "low" | "medium" | "high" | "critical";
}

interface ContextStatusRow {
  readonly target_id: string;
  readonly direct_status:
    | "operational"
    | "degraded"
    | "partial_outage"
    | "major_outage"
    | "maintenance"
    | "unknown";
  readonly dependency_risk:
    "none" | "degraded" | "partial_outage" | "major_outage" | "unknown";
  readonly effective_impact:
    | "operational"
    | "degraded"
    | "partial_outage"
    | "major_outage"
    | "maintenance"
    | "unknown";
  readonly evaluated_at: string;
  readonly fresh_until: string;
  readonly revision: number;
}

/** 收集带类型来源及当前 freshness 的服务集合 / Collect services with typed provenance and current freshness. */
async function diagnosticAffectedServices(
  db: D1Database,
  locator: DiagnosticContextLocator,
  issues: readonly IssueSummary[],
  incidents: readonly AdminIncident[],
  evidence: readonly TelemetryReference[],
  deployments: readonly DeploymentManifest[],
): Promise<{ items: DiagnosticAffectedService[]; truncated: boolean }> {
  const relations = new Map<string, Map<string, ContextRelation>>();
  let relationTruncated = false;
  const add = (service: string, relation: ContextRelation) => {
    const values = relations.get(service) ?? new Map<string, ContextRelation>();
    values.set(JSON.stringify(relation), relation);
    relations.set(service, values);
  };
  if (locator.kind === "service")
    add(locator.service_name, { kind: "locator" });
  for (const issue of issues)
    add(issue.service_name, { kind: "issue", issue_id: issue.issue_id });
  for (const incident of incidents)
    for (const service of incident.affected_services)
      add(service, { kind: "incident", incident_id: incident.incident_id });
  for (const item of evidence)
    add(item.service_name, {
      kind: "evidence",
      telemetry_reference_id: item.id,
    });
  for (const deployment of deployments)
    add(deployment.service_name, {
      kind: "deployment",
      deployment_id: deployment.deployment_id,
    });

  const incidentIds = incidents.map((incident) => incident.incident_id);
  if (incidentIds.length > 0) {
    const componentRows = await db
      .prepare(
        `SELECT DISTINCT related.incident_id,related.component_id,related.service_name
           FROM (
             SELECT x.incident_id,x.component_id,c.service_name
               FROM incident_components AS x
               JOIN components AS c ON c.component_id=x.component_id
              WHERE x.incident_id IN (${incidentIds.map(() => "?").join(",")})
             UNION ALL
             SELECT x.incident_id,x.component_id,cs.service_name
               FROM incident_components AS x
               JOIN component_services AS cs ON cs.component_id=x.component_id
              WHERE x.incident_id IN (${incidentIds.map(() => "?").join(",")})
           ) AS related
          ORDER BY related.incident_id,related.component_id,related.service_name LIMIT 501`,
      )
      .bind(...incidentIds, ...incidentIds)
      .all<{
        incident_id: string;
        component_id: string;
        service_name: string;
      }>();
    for (const row of componentRows.results.slice(0, 500))
      add(row.service_name, {
        kind: "component",
        component_id: row.component_id,
      });
    if (componentRows.results.length > 500) relationTruncated = true;
  }

  const names = [...relations.keys()].sort();
  const selected = names.slice(0, 100);
  const statusByService = new Map<string, ContextStatusRow>();
  if (selected.length > 0) {
    const rows = await db
      .prepare(
        `SELECT target_id,direct_status,dependency_risk,effective_impact,
                evaluated_at,fresh_until,revision
           FROM current_statuses WHERE target_type='service'
            AND target_id IN (${selected.map(() => "?").join(",")})`,
      )
      .bind(...selected)
      .all<ContextStatusRow>();
    for (const row of rows.results) statusByService.set(row.target_id, row);
  }
  return {
    items: selected.map((serviceName) => {
      const status = statusByService.get(serviceName);
      return {
        service_name: serviceName,
        relations: [...relations.get(serviceName)!.values()]
          .sort((left, right) =>
            JSON.stringify(left).localeCompare(JSON.stringify(right)),
          )
          .slice(0, 100),
        current_status:
          status === undefined
            ? null
            : {
                direct_status: status.direct_status,
                dependency_risk: status.dependency_risk,
                effective_impact: status.effective_impact,
                evaluated_at: status.evaluated_at,
                fresh_until: status.fresh_until,
                revision: status.revision,
              },
      };
    }),
    truncated:
      relationTruncated ||
      names.length > 100 ||
      selected.some((name) => relations.get(name)!.size > 100),
  };
}

/** 展开最多八跳且无重复节点的目录依赖路径 / Expand catalog dependency paths to eight hops without repeated nodes. */
async function diagnosticDependencyPaths(
  db: D1Database,
  roots: readonly string[],
): Promise<{ items: DiagnosticDependencyPath[]; truncated: boolean }> {
  type Work = { root: string; services: string[]; edges: ContextEdgeRow[] };
  let frontier: Work[] = [...new Set(roots)].sort().map((root) => ({
    root,
    services: [root],
    edges: [],
  }));
  const paths: DiagnosticDependencyPath[] = [];
  let truncated = false;
  for (let depth = 0; depth < 8 && frontier.length > 0; depth += 1) {
    const sources = [
      ...new Set(frontier.map((item) => item.services.at(-1)!)),
    ].sort();
    const rows = await db
      .prepare(
        `SELECT source_service,target_service,capability,kind,criticality
           FROM service_dependencies
          WHERE source_service IN (${sources.map(() => "?").join(",")})
          ORDER BY source_service,target_service,capability LIMIT 501`,
      )
      .bind(...sources)
      .all<ContextEdgeRow>();
    if (rows.results.length > 500) truncated = true;
    const bySource = new Map<string, ContextEdgeRow[]>();
    for (const edge of rows.results.slice(0, 500)) {
      const values = bySource.get(edge.source_service) ?? [];
      values.push(edge);
      bySource.set(edge.source_service, values);
    }
    const next: Work[] = [];
    for (const work of frontier) {
      const source = work.services.at(-1)!;
      for (const edge of bySource.get(source) ?? []) {
        if (work.services.includes(edge.target_service)) continue;
        const edges = [...work.edges, edge];
        paths.push({
          root_service: work.root,
          leaf_service: edge.target_service,
          edges,
        });
        if (paths.length === 100) {
          truncated = true;
          return { items: paths, truncated };
        }
        next.push({
          root: work.root,
          services: [...work.services, edge.target_service],
          edges,
        });
      }
    }
    frontier = next;
  }
  if (frontier.length > 0) truncated = true;
  return { items: paths, truncated };
}

/** 只从返回的 source reference 投影源码位置并验证 deployment 来源 / Project source locations only from returned source references and verify deployment provenance. */
function diagnosticSourceLocations(
  evidence: readonly TelemetryReference[],
  deployments: readonly DeploymentManifest[],
): DiagnosticSourceLocation[] {
  const byId = new Map(
    deployments.map((deployment) => [deployment.deployment_id, deployment]),
  );
  return evidence
    .filter(
      (item): item is Extract<TelemetryReference, { kind: "source" }> =>
        item.kind === "source",
    )
    .map((item) => {
      const deployment = byId.get(item.deployment_id);
      return {
        telemetry_reference_id: item.id,
        deployment_id: item.deployment_id,
        repository_url: item.locator.repository_url,
        git_commit: item.locator.git_commit,
        path: item.locator.path,
        ...(item.locator.line === undefined ? {} : { line: item.locator.line }),
        ...(item.locator.column === undefined
          ? {}
          : { column: item.locator.column }),
        provenance_verified:
          deployment !== undefined &&
          canonicalRepositoryUrl(deployment.repository_url) ===
            canonicalRepositoryUrl(item.locator.repository_url) &&
          deployment.git_commit === item.locator.git_commit,
      };
    })
    .sort((left, right) =>
      `${left.telemetry_reference_id}\0${left.path}`.localeCompare(
        `${right.telemetry_reference_id}\0${right.path}`,
      ),
    );
}

function canonicalRepositoryUrl(raw: string): string {
  const url = new URL(raw);
  return `${url.origin}${url.pathname.replace(/\/$/u, "").replace(/\.git$/u, "")}`;
}

interface ContextTimeRange {
  readonly start: string;
  readonly end: string;
}

function diagnosticTimeRange(
  locator: DiagnosticContextLocator,
  issues: readonly IssueSummary[],
  incidents: readonly AdminIncident[],
  evidenceRows: readonly EvidenceRow[],
  deployments: readonly DeploymentManifest[],
): ContextTimeRange | null {
  if (locator.kind === "service")
    return { start: locator.start, end: locator.end };
  const starts = [
    ...issues.map((issue) => issue.first_seen_at),
    ...incidents.map((incident) => incident.started_at),
    ...evidenceRows.map((item) => item.range_start ?? item.created_at),
    ...deployments.map((deployment) => deployment.deployed_at),
  ].filter(validDate);
  const ends = [
    ...issues.map((issue) => issue.last_seen_at),
    ...incidents.map(
      (incident) => incident.resolved_at ?? incident.detected_at,
    ),
    ...incidents.flatMap((incident) =>
      incident.updates.map((update) => update.published_at),
    ),
    ...issues
      .map((issue) => issue.acknowledged_at)
      .filter((value): value is string => value !== null),
    ...evidenceRows.map((item) => item.range_end ?? item.created_at),
    ...deployments.map((deployment) => deployment.deployed_at),
  ].filter(validDate);
  if (starts.length === 0 || ends.length === 0) return null;
  starts.sort((left, right) => Date.parse(left) - Date.parse(right));
  ends.sort((left, right) => Date.parse(left) - Date.parse(right));
  return { start: starts[0]!, end: ends.at(-1)! };
}

function validDate(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

interface ContextTransitionRow {
  readonly transition_id: string;
  readonly target_type: "service" | "component";
  readonly target_id: string;
  readonly service_name: string;
  readonly sequence: number;
  readonly from_status: DiagnosticStatusTransition["from_status"];
  readonly to_status: DiagnosticStatusTransition["to_status"];
  readonly source_type: DiagnosticStatusTransition["source_type"];
  readonly source_id: string;
  readonly policy_id: string | null;
  readonly policy_revision: number | null;
  readonly correlation_id: string | null;
  readonly occurred_at: string;
}

/** 查询受影响服务及其组件在诊断时间窗内的状态事实 / Query status facts for affected services and their components within the diagnostic window. */
async function diagnosticStatusTransitions(
  db: D1Database,
  serviceNames: readonly string[],
  timeRange: ContextTimeRange | null,
): Promise<{ items: DiagnosticStatusTransition[]; truncated: boolean }> {
  if (serviceNames.length === 0 || timeRange === null)
    return { items: [], truncated: false };
  const placeholders = serviceNames.map(() => "?").join(",");
  const rows = await db
    .prepare(
      `SELECT t.transition_id,t.target_type,t.target_id,t.sequence,t.from_status,
              t.to_status,t.source_type,t.source_id,t.policy_id,t.policy_revision,
              t.correlation_id,t.occurred_at,
              CASE WHEN t.target_type='service' THEN t.target_id ELSE c.service_name END AS service_name
         FROM status_transitions AS t
         LEFT JOIN components AS c
           ON t.target_type='component' AND c.component_id=t.target_id
        WHERE t.occurred_at>=? AND t.occurred_at<=?
          AND (t.target_type='service' AND t.target_id IN (${placeholders})
            OR t.target_type='component' AND c.service_name IN (${placeholders}))
        ORDER BY t.occurred_at,t.target_type,t.target_id,t.sequence LIMIT 201`,
    )
    .bind(timeRange.start, timeRange.end, ...serviceNames, ...serviceNames)
    .all<ContextTransitionRow>();
  return {
    items: rows.results.slice(0, 200).map((row) => ({
      transition_id: row.transition_id,
      target_type: row.target_type,
      target_id: row.target_id,
      service_name: row.service_name,
      sequence: row.sequence,
      from_status: row.from_status,
      to_status: row.to_status,
      source_type: row.source_type,
      source_id: row.source_id,
      policy:
        row.policy_id === null || row.policy_revision === null
          ? null
          : { policy_id: row.policy_id, revision: row.policy_revision },
      correlation_id: validUuidV7(row.correlation_id)
        ? row.correlation_id
        : null,
      occurred_at: row.occurred_at,
    })),
    truncated: rows.results.length > 200,
  };
}

interface ContextAuditRow {
  readonly audit_id: string;
  readonly actor_type: "human" | "machine" | "system";
  readonly actor_subject: string;
  readonly action: string;
  readonly occurred_at: string;
}

/** 汇总只与选中图节点或关联 ID 有关的审计事件 / Summarize audit events related only to selected graph nodes or correlation IDs. */
async function diagnosticAuditSummary(
  db: D1Database,
  issues: readonly IssueSummary[],
  incidents: readonly AdminIncident[],
  deployments: readonly DeploymentManifest[],
  evidence: readonly TelemetryReference[],
  services: readonly DiagnosticAffectedService[],
  locator: DiagnosticContextLocator,
  timeRange: ContextTimeRange | null,
): Promise<{
  summary: DiagnosticAuditSummary;
  truncated: boolean;
}> {
  const clauses: string[] = [];
  const bindings: unknown[] = [];
  const addTargets = (type: string, ids: readonly string[]) => {
    const values = [...new Set(ids)];
    if (values.length === 0) return;
    clauses.push(
      `(target_type=? AND target_id IN (${values.map(() => "?").join(",")}))`,
    );
    bindings.push(type, ...values);
  };
  addTargets(
    "issue",
    issues.map((item) => item.issue_id),
  );
  addTargets(
    "incident",
    incidents.map((item) => item.incident_id),
  );
  addTargets(
    "deployment",
    deployments.map((item) => item.deployment_id),
  );
  addTargets(
    "service",
    services.map((item) => item.service_name),
  );
  addTargets(
    "telemetry_reference",
    evidence.map((item) => item.id),
  );
  const correlations = new Set(
    evidence
      .map((item) => item.correlation_id)
      .filter((value): value is string => value !== undefined),
  );
  if (locator.kind === "correlation") correlations.add(locator.correlation_id);
  if (correlations.size > 0) {
    clauses.push(
      `correlation_id IN (${[...correlations].map(() => "?").join(",")})`,
    );
    bindings.push(...correlations);
  }
  if (clauses.length === 0)
    return {
      summary: {
        event_count: 0,
        first_occurred_at: null,
        last_occurred_at: null,
        actions: [],
        actors: [],
      },
      truncated: false,
    };
  const timeClause =
    timeRange === null ? "" : "AND occurred_at>=? AND occurred_at<=?";
  if (timeRange !== null) bindings.push(timeRange.start, timeRange.end);
  const rows = await db
    .prepare(
      `SELECT audit_id,actor_type,actor_subject,action,occurred_at
         FROM audit_log WHERE (${clauses.join(" OR ")}) ${timeClause}
        ORDER BY occurred_at,audit_id LIMIT 501`,
    )
    .bind(...bindings)
    .all<ContextAuditRow>();
  const selected = rows.results.slice(0, 500);
  const actionCounts = new Map<string, number>();
  const actorCounts = new Map<
    string,
    {
      actor_type: ContextAuditRow["actor_type"];
      actor_subject: string;
      count: number;
    }
  >();
  for (const row of selected) {
    actionCounts.set(row.action, (actionCounts.get(row.action) ?? 0) + 1);
    const key = `${row.actor_type}\0${row.actor_subject}`;
    const actor = actorCounts.get(key) ?? {
      actor_type: row.actor_type,
      actor_subject: row.actor_subject,
      count: 0,
    };
    actor.count += 1;
    actorCounts.set(key, actor);
  }
  return {
    summary: {
      event_count: selected.length,
      first_occurred_at: selected[0]?.occurred_at ?? null,
      last_occurred_at: selected.at(-1)?.occurred_at ?? null,
      actions: [...actionCounts]
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(0, 100)
        .map(([action, count]) => ({ action, count })),
      actors: [...actorCounts.values()]
        .sort((left, right) =>
          `${left.actor_type}\0${left.actor_subject}`.localeCompare(
            `${right.actor_type}\0${right.actor_subject}`,
          ),
        )
        .slice(0, 100)
        .map((actor) => ({
          actor_type: actor.actor_type,
          actor_subject: actor.actor_subject,
          event_count: actor.count,
        })),
    },
    truncated:
      rows.results.length > 500 ||
      actionCounts.size > 100 ||
      actorCounts.size > 100,
  };
}

function validUuidV7(value: string | null): value is string {
  return (
    value !== null &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      value,
    )
  );
}

/**
 * 查询有界的证据图：Issue → Incident → TelemetryReference → Deployment。
 * Queries a bounded evidence graph: Issue → Incident → TelemetryReference → Deployment.
 */
export async function queryDiagnosticContext(
  env: AdminEnvironment,
  raw: QueryDiagnosticContextRpcRequest,
): Promise<QueryDiagnosticContextRpcResult> {
  const auth = authorize(
    QueryDiagnosticContextRpcRequestSchema,
    raw,
    "viewer",
    "queryDiagnosticContext",
  );
  if ("problem" in auth) return auth;
  const locator = auth.request.locator;
  let issueRows: IssueRow[] = [];
  let forcedIncidentId: string | null = null;
  let directEvidenceWhere = "0";
  const directBindings: unknown[] = [];
  if (locator.kind === "issue") {
    const result = await env.DB.prepare(
      `SELECT ${ISSUE_COLUMNS} FROM issues i WHERE i.issue_id=? LIMIT 101`,
    )
      .bind(locator.issue_id)
      .all<IssueRow>();
    issueRows = result.results;
  } else if (locator.kind === "incident") {
    forcedIncidentId = locator.incident_id;
    const result = await env.DB.prepare(
      `SELECT ${ISSUE_COLUMNS} FROM issues i JOIN incident_issues x ON x.issue_id=i.issue_id
      WHERE x.incident_id=? LIMIT 101`,
    )
      .bind(locator.incident_id)
      .all<IssueRow>();
    issueRows = result.results;
  } else if (
    locator.kind === "correlation" ||
    locator.kind === "trace" ||
    locator.kind === "deployment"
  ) {
    const column =
      locator.kind === "correlation"
        ? "correlation_id"
        : locator.kind === "trace"
          ? "trace_id"
          : "deployment_id";
    const value =
      locator.kind === "correlation"
        ? locator.correlation_id
        : locator.kind === "trace"
          ? locator.trace_id
          : locator.deployment_id;
    directEvidenceWhere = `t.${column}=?`;
    directBindings.push(value);
    const occurrenceClause = locator.kind === "trace" ? "0" : `o.${column}=?`;
    const result = await env.DB.prepare(
      `SELECT DISTINCT ${ISSUE_COLUMNS} FROM issues i
      LEFT JOIN issue_telemetry_references x ON x.issue_id=i.issue_id
      LEFT JOIN telemetry_references t ON t.telemetry_reference_id=x.telemetry_reference_id
      LEFT JOIN issue_occurrences o ON o.issue_id=i.issue_id
      WHERE t.${column}=? OR ${occurrenceClause} LIMIT 101`,
    )
      .bind(...(locator.kind === "trace" ? [value] : [value, value]))
      .all<IssueRow>();
    issueRows = result.results;
  } else {
    const result = await env.DB.prepare(
      `SELECT ${ISSUE_COLUMNS} FROM issues i
      WHERE i.service_name=? AND i.last_seen_at>=? AND i.first_seen_at<=? ORDER BY i.last_seen_at DESC LIMIT 101`,
    )
      .bind(locator.service_name, locator.start, locator.end)
      .all<IssueRow>();
    issueRows = result.results;
    directEvidenceWhere =
      "t.service_name=? AND COALESCE(t.range_end,t.created_at)>=? AND COALESCE(t.range_start,t.created_at)<=?";
    directBindings.push(locator.service_name, locator.start, locator.end);
  }
  const truncatedIssues = issueRows.length > 100;
  issueRows = issueRows.slice(0, 100);
  const issueIds = issueRows.map((row) => row.issue_id);
  const incidentIds = new Set<string>();
  if (forcedIncidentId !== null) incidentIds.add(forcedIncidentId);
  if (issueIds.length > 0) {
    const rows = await env.DB.prepare(
      `SELECT DISTINCT incident_id FROM incident_issues WHERE issue_id IN (${issueIds.map(() => "?").join(",")}) LIMIT 101`,
    )
      .bind(...issueIds)
      .all<{ incident_id: string }>();
    for (const row of rows.results) incidentIds.add(row.incident_id);
  }
  const selectedIncidents = [...incidentIds].slice(0, 100);
  const incidents = (
    await Promise.all(
      selectedIncidents.map((id) => getIncidentData(env.DB, id)),
    )
  ).filter((value): value is AdminIncident => value !== null);
  const evidenceClauses: string[] = [directEvidenceWhere];
  const evidenceBindings: unknown[] = [...directBindings];
  if (issueIds.length > 0) {
    evidenceClauses.push(
      `EXISTS (SELECT 1 FROM issue_telemetry_references x WHERE x.telemetry_reference_id=t.telemetry_reference_id AND x.issue_id IN (${issueIds.map(() => "?").join(",")}))`,
    );
    evidenceBindings.push(...issueIds);
  }
  if (selectedIncidents.length > 0) {
    evidenceClauses.push(
      `EXISTS (SELECT 1 FROM incident_telemetry_references x WHERE x.telemetry_reference_id=t.telemetry_reference_id AND x.incident_id IN (${selectedIncidents.map(() => "?").join(",")}))`,
    );
    evidenceBindings.push(...selectedIncidents);
  }
  const evidenceResult = await env.DB.prepare(
    `SELECT t.* FROM telemetry_references t WHERE ${evidenceClauses.map((item) => `(${item})`).join(" OR ")}
    ORDER BY t.created_at DESC LIMIT 201`,
  )
    .bind(...evidenceBindings)
    .all<EvidenceRow>();
  const evidence = evidenceResult.results.slice(0, 200).map(mapEvidence);
  const grouped = await evidenceForIssues(env.DB, issueIds);
  const issues = issueRows.map((row) =>
    mapIssue(row, grouped.get(row.issue_id) ?? []),
  );
  const deploymentIds = new Set(evidence.map((item) => item.deployment_id));
  if (locator.kind === "deployment") deploymentIds.add(locator.deployment_id);
  const deployments = await deploymentData(env.DB, [...deploymentIds]);
  const affected = await diagnosticAffectedServices(
    env.DB,
    locator,
    issues,
    incidents,
    evidence,
    deployments,
  );
  const dependencyPaths = await diagnosticDependencyPaths(
    env.DB,
    affected.items.map((item) => item.service_name),
  );
  const sourceLocations = diagnosticSourceLocations(evidence, deployments);
  const timeRange = diagnosticTimeRange(
    locator,
    issues,
    incidents,
    evidenceResult.results.slice(0, 200),
    deployments,
  );
  const transitions = await diagnosticStatusTransitions(
    env.DB,
    affected.items.map((item) => item.service_name),
    timeRange,
  );
  const audit = await diagnosticAuditSummary(
    env.DB,
    issues,
    incidents,
    deployments,
    evidence,
    affected.items,
    locator,
    timeRange,
  );
  const data: DiagnosticContext = {
    issues,
    incidents,
    affected_services: affected.items,
    dependency_paths: dependencyPaths.items,
    evidence,
    deployments,
    source_locations: sourceLocations,
    status_transitions: transitions.items,
    audit_summary: audit.summary,
    truncated:
      truncatedIssues ||
      incidentIds.size > 100 ||
      evidenceResult.results.length > 200 ||
      deploymentIds.size > 100 ||
      affected.truncated ||
      dependencyPaths.truncated ||
      transitions.truncated ||
      audit.truncated,
  };
  return { data };
}

async function registeredPolicy(
  env: AdminEnvironment,
  policyId: string,
  revision: number,
): Promise<EvaluationPolicy | null> {
  const row = await env.DB.prepare(
    "SELECT diagnostic_rules_json FROM evaluation_policies WHERE policy_id=? AND revision=?",
  )
    .bind(policyId, revision)
    .first<{ diagnostic_rules_json: string }>();
  if (row === null) return null;
  const parsed = JSON.parse(row.diagnostic_rules_json) as {
    contract?: EvaluationPolicy;
  };
  return parsed.contract ?? null;
}

/** 注册不可变 Evaluation Policy revision / Registers an immutable Evaluation Policy revision. */
export async function registerEvaluationPolicy(
  env: AdminEnvironment,
  raw: RegisterEvaluationPolicyRpcRequest,
): Promise<RegisterEvaluationPolicyRpcResult> {
  const auth = authorize(
    RegisterEvaluationPolicyRpcRequestSchema,
    raw,
    "admin",
    "registerEvaluationPolicy",
  );
  if ("problem" in auth) return auth;
  const { command } = auth.request;
  const requestDigest = await digest(command);
  const resourceId = `${command.policy.policy_id}:${command.policy.revision}`;
  const prior = await idempotentResource(
    env.DB,
    "registerEvaluationPolicy",
    command.command_id,
    requestDigest,
    auth.correlationId,
  );
  if (prior !== null) {
    if ("problem" in prior) return prior;
    const value = await registeredPolicy(
      env,
      command.policy.policy_id,
      command.policy.revision,
    );
    return value === null
      ? {
          problem: problem(
            409,
            "Prior result is unavailable",
            auth.correlationId,
            "registerEvaluationPolicy",
          ),
        }
      : { data: value };
  }
  const policy = command.policy;
  const occurredAt = now();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO evaluation_policies
        (policy_id,revision,schema_version,name,observation_window_seconds,minimum_samples,failure_threshold,recovery_threshold,
         latency_threshold_ms,stale_after_seconds,location_quorum,fingerprint_template_json,status_mapping_json,diagnostic_rules_json,created_by,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        policy.policy_id,
        policy.revision,
        "1.0",
        `${policy.policy_id}@${policy.revision}`,
        policy.window_seconds,
        policy.minimum_samples,
        policy.failure_threshold.numerator /
          policy.failure_threshold.denominator,
        policy.recovery_threshold.numerator /
          policy.recovery_threshold.denominator,
        policy.latency_threshold_ms,
        policy.stale_after_seconds,
        policy.quorum.minimum_locations,
        JSON.stringify({ fields: policy.issue_fingerprint_template }),
        JSON.stringify({ failure: policy.failure_status }),
        JSON.stringify({
          contract: policy,
          exact_thresholds: {
            failure: policy.failure_threshold,
            recovery: policy.recovery_threshold,
          },
          quorum: policy.quorum,
        }),
        auth.principal.subject,
        occurredAt,
      ),
      auditStatement(
        env.DB,
        auth.principal,
        auth.correlationId,
        "evaluation_policy.registered",
        "evaluation_policy",
        resourceId,
        null,
        policy.revision,
        occurredAt,
      ),
      outboxStatement(
        env.DB,
        "evaluation_policy",
        resourceId,
        "evaluation_policy.registered",
        { policy_id: policy.policy_id, revision: policy.revision },
        occurredAt,
      ),
      idempotencyStatement(
        env.DB,
        "registerEvaluationPolicy",
        command.command_id,
        requestDigest,
        "evaluation_policy",
        resourceId,
        occurredAt,
      ),
    ]);
  } catch {
    const raced = await idempotentResource(
      env.DB,
      "registerEvaluationPolicy",
      command.command_id,
      requestDigest,
      auth.correlationId,
    );
    if (raced !== null && !("problem" in raced)) {
      const value = await registeredPolicy(
        env,
        policy.policy_id,
        policy.revision,
      );
      if (value !== null) return { data: value };
    }
    return {
      problem:
        raced !== null && "problem" in raced
          ? raced.problem
          : problem(
              409,
              "Policy registration conflict",
              auth.correlationId,
              "registerEvaluationPolicy",
            ),
    };
  }
  return { data: policy };
}

/** 创建完整可执行 Monitor；配置与 locations 在同一事务登记 / Creates a complete executable Monitor with locations in the same transaction. */
export async function createMonitor(
  env: AdminEnvironment,
  raw: CreateMonitorRpcRequest,
): Promise<CreateMonitorRpcResult> {
  const auth = authorize(
    CreateMonitorRpcRequestSchema,
    raw,
    "admin",
    "createMonitor",
  );
  if ("problem" in auth) return auth;
  const command = auth.request.command;
  const requestDigest = await digest(command);
  const prior = await idempotentResource(
    env.DB,
    "createMonitor",
    command.command_id,
    requestDigest,
    auth.correlationId,
  );
  if (prior !== null) {
    if ("problem" in prior) return prior;
    const value = await getMonitorData(env.DB, prior.resourceId);
    return value === null
      ? {
          problem: problem(
            409,
            "Prior result is unavailable",
            auth.correlationId,
            "createMonitor",
          ),
        }
      : { data: value };
  }
  const service =
    command.target_type === "service"
      ? command.target_id === command.service_name
        ? { service_name: command.service_name }
        : null
      : await env.DB.prepare(
          "SELECT service_name FROM components WHERE component_id=?",
        )
          .bind(command.target_id)
          .first<{ service_name: string }>();
  if (service?.service_name !== command.service_name)
    return {
      problem: problem(
        400,
        "Monitor target does not belong to service",
        auth.correlationId,
        "createMonitor",
      ),
    };
  if (
    (await env.DB.prepare(
      "SELECT 1 FROM evaluation_policies WHERE policy_id=? AND revision=?",
    )
      .bind(command.policy_id, command.policy_revision)
      .first()) === null
  ) {
    return {
      problem: problem(
        400,
        "Evaluation policy not found",
        auth.correlationId,
        "createMonitor",
      ),
    };
  }
  const occurredAt = now();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO monitors
        (monitor_id,target_type,target_id,probe_kind,schedule_kind,schedule_expression,interval_seconds,timeout_ms,probe_config_json,
         policy_id,policy_revision,next_run_at,critical,enabled,revision,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,1,?,?)`,
      ).bind(
        command.monitor_id,
        command.target_type,
        command.target_id,
        command.probe_kind,
        command.schedule_kind,
        command.schedule_expression,
        command.interval_seconds,
        command.timeout_ms,
        JSON.stringify(command.probe_config),
        command.policy_id,
        command.policy_revision,
        occurredAt,
        command.enabled ? 1 : 0,
        occurredAt,
        occurredAt,
      ),
      ...[...new Set(command.locations)].map((location) =>
        env.DB.prepare(
          "INSERT INTO monitor_locations (monitor_id,location,enabled) VALUES (?,?,1)",
        ).bind(command.monitor_id, location),
      ),
      auditStatement(
        env.DB,
        auth.principal,
        auth.correlationId,
        "monitor.created",
        "monitor",
        command.monitor_id,
        null,
        1,
        occurredAt,
      ),
      outboxStatement(
        env.DB,
        "monitor",
        command.monitor_id,
        "monitor.created",
        { monitor_id: command.monitor_id, revision: 1 },
        occurredAt,
      ),
      idempotencyStatement(
        env.DB,
        "createMonitor",
        command.command_id,
        requestDigest,
        "monitor",
        command.monitor_id,
        occurredAt,
      ),
    ]);
  } catch {
    const raced = await idempotentResource(
      env.DB,
      "createMonitor",
      command.command_id,
      requestDigest,
      auth.correlationId,
    );
    if (raced !== null && !("problem" in raced)) {
      const value = await getMonitorData(env.DB, raced.resourceId);
      if (value !== null) return { data: value };
    }
    return {
      problem:
        raced !== null && "problem" in raced
          ? raced.problem
          : problem(
              409,
              "Monitor creation conflict",
              auth.correlationId,
              "createMonitor",
            ),
    };
  }
  return { data: (await getMonitorData(env.DB, command.monitor_id))! };
}

/** 注册后端元数据；auth_reference 只能引用 secret，绝不保存凭据 / Registers backend metadata; auth_reference names a secret and never stores credentials. */
export async function registerBackend(
  env: AdminEnvironment,
  raw: RegisterBackendRpcRequest,
): Promise<RegisterBackendRpcResult> {
  const auth = authorize(
    RegisterBackendRpcRequestSchema,
    raw,
    "admin",
    "registerBackend",
  );
  if ("problem" in auth) return auth;
  const { command } = auth.request;
  const requestDigest = await digest(command);
  const prior = await idempotentResource(
    env.DB,
    "registerBackend",
    command.command_id,
    requestDigest,
    auth.correlationId,
  );
  if (prior !== null) {
    if ("problem" in prior) return prior;
    const row = await env.DB.prepare(
      "SELECT * FROM telemetry_backends WHERE backend_name=?",
    )
      .bind(prior.resourceId)
      .first<Record<string, unknown>>();
    if (row === null)
      return {
        problem: problem(
          409,
          "Prior result is unavailable",
          auth.correlationId,
          "registerBackend",
        ),
      };
    return { data: mapBackend(row) };
  }
  const backend = command.backend;
  const occurredAt = now();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO telemetry_backends
        (backend_name,capabilities_json,query_adapter,ui_url_template,retention_class,auth_reference,enabled,revision,created_at,updated_at)
        VALUES (?,?,?,?,?,?,1,1,?,?)`,
      ).bind(
        backend.name,
        JSON.stringify(backend.capabilities),
        backend.query_adapter,
        backend.ui_url_template,
        backend.retention_class,
        backend.auth_reference,
        occurredAt,
        occurredAt,
      ),
      auditStatement(
        env.DB,
        auth.principal,
        auth.correlationId,
        "telemetry_backend.registered",
        "telemetry_backend",
        backend.name,
        null,
        1,
        occurredAt,
      ),
      outboxStatement(
        env.DB,
        "telemetry_backend",
        backend.name,
        "telemetry_backend.registered",
        { name: backend.name, revision: 1 },
        occurredAt,
      ),
      idempotencyStatement(
        env.DB,
        "registerBackend",
        command.command_id,
        requestDigest,
        "telemetry_backend",
        backend.name,
        occurredAt,
      ),
    ]);
  } catch {
    const raced = await idempotentResource(
      env.DB,
      "registerBackend",
      command.command_id,
      requestDigest,
      auth.correlationId,
    );
    if (raced !== null && !("problem" in raced)) {
      const row = await env.DB.prepare(
        "SELECT * FROM telemetry_backends WHERE backend_name=?",
      )
        .bind(raced.resourceId)
        .first<Record<string, unknown>>();
      if (row !== null) return { data: mapBackend(row) };
    }
    return {
      problem:
        raced !== null && "problem" in raced
          ? raced.problem
          : problem(
              409,
              "Backend registration conflict",
              auth.correlationId,
              "registerBackend",
            ),
    };
  }
  return { data: backend };
}

function mapBackend(
  row: Record<string, unknown>,
): TelemetryBackendRegistration {
  return {
    name: row.backend_name as string,
    capabilities: JSON.parse(row.capabilities_json as string),
    query_adapter: TelemetryBackendQueryAdapterSchema.parse(row.query_adapter),
    ui_url_template: row.ui_url_template as string,
    retention_class: row.retention_class as string,
    auth_reference: row.auth_reference as string,
  };
}

/** 兼容旧内部名称；新调用方使用 registerBackend / Compatibility alias; new callers use registerBackend. */
export const registerTelemetryBackend = registerBackend;

/**
 * 将不可变策略 revision 绑定到 monitor 或具体 Diagnostic kind。
 * Assigns an immutable policy revision to a monitor or a concrete Diagnostic kind.
 */
export async function assignDiagnosticPolicy(
  env: AdminEnvironment,
  raw: AssignDiagnosticPolicyRpcRequest,
): Promise<AssignDiagnosticPolicyRpcResult> {
  const auth = authorize(
    AssignDiagnosticPolicyRpcRequestSchema,
    raw,
    "admin",
    "assignDiagnosticPolicy",
  );
  if ("problem" in auth) return auth;
  const { command } = auth.request;
  const requestDigest = await digest(command);
  const prior = await idempotentResource(
    env.DB,
    "assignDiagnosticPolicy",
    command.command_id,
    requestDigest,
    auth.correlationId,
  );
  if (prior !== null) {
    if ("problem" in prior) return prior;
    const value = await getPolicyAssignment(env.DB, prior.resourceId);
    return value === null
      ? {
          problem: problem(
            409,
            "Prior result is unavailable",
            auth.correlationId,
            "assignDiagnosticPolicy",
          ),
        }
      : { data: value };
  }
  if (
    (await env.DB.prepare(
      "SELECT 1 FROM evaluation_policies WHERE policy_id=? AND revision=?",
    )
      .bind(command.policy_id, command.policy_revision)
      .first()) === null
  ) {
    return {
      problem: problem(
        400,
        "Evaluation policy not found",
        auth.correlationId,
        "assignDiagnosticPolicy",
      ),
    };
  }
  const monitorId =
    command.selector.kind === "monitor" ? command.selector.monitor_id : null;
  const serviceName =
    command.selector.kind === "monitor" ? null : command.selector.service_name;
  const diagnosticKind =
    command.selector.kind === "service_kind"
      ? command.selector.diagnostic_kind
      : null;
  if (
    monitorId !== null &&
    (await env.DB.prepare("SELECT 1 FROM monitors WHERE monitor_id=?")
      .bind(monitorId)
      .first()) === null
  ) {
    return {
      problem: problem(
        400,
        "Monitor not found",
        auth.correlationId,
        "assignDiagnosticPolicy",
      ),
    };
  }
  if (
    serviceName !== null &&
    !(await validateIds(env.DB, "services", "service_name", [serviceName]))
  ) {
    return {
      problem: problem(
        400,
        "Service not found",
        auth.correlationId,
        "assignDiagnosticPolicy",
      ),
    };
  }
  const selectorKind = command.selector.kind;
  const existing =
    selectorKind === "monitor"
      ? await env.DB.prepare(
          "SELECT assignment_id,revision FROM service_diagnostic_policies WHERE selector_kind='monitor' AND monitor_id=?",
        )
          .bind(monitorId)
          .first<{ assignment_id: string; revision: number }>()
      : selectorKind === "service_kind"
        ? await env.DB.prepare(
            "SELECT assignment_id,revision FROM service_diagnostic_policies WHERE selector_kind='service_kind' AND service_name=? AND diagnostic_kind=?",
          )
            .bind(serviceName, diagnosticKind)
            .first<{ assignment_id: string; revision: number }>()
        : await env.DB.prepare(
            "SELECT assignment_id,revision FROM service_diagnostic_policies WHERE selector_kind='service_default' AND service_name=?",
          )
            .bind(serviceName)
            .first<{ assignment_id: string; revision: number }>();
  const assignmentId = existing?.assignment_id ?? uuidv7();
  const nextRevision = (existing?.revision ?? 0) + 1;
  const occurredAt = now();
  const mutate =
    existing === null
      ? env.DB.prepare(
          `INSERT INTO service_diagnostic_policies
      (assignment_id,selector_kind,monitor_id,service_name,diagnostic_kind,policy_id,policy_revision,assigned_by,assigned_at,revision)
      VALUES (?,?,?,?,?,?,?,?,?,1)`,
        ).bind(
          assignmentId,
          selectorKind,
          monitorId,
          serviceName,
          diagnosticKind,
          command.policy_id,
          command.policy_revision,
          auth.principal.subject,
          occurredAt,
        )
      : env.DB.prepare(
          `UPDATE service_diagnostic_policies SET policy_id=?,policy_revision=?,assigned_by=?,assigned_at=?,revision=revision+1
      WHERE assignment_id=? AND revision=?`,
        ).bind(
          command.policy_id,
          command.policy_revision,
          auth.principal.subject,
          occurredAt,
          assignmentId,
          existing.revision,
        );
  const gate =
    "EXISTS (SELECT 1 FROM service_diagnostic_policies WHERE assignment_id=? AND revision=? AND assigned_at=?)";
  const statements = [
    mutate,
    env.DB.prepare(
      `INSERT INTO audit_log
      (audit_id,actor_type,actor_subject,actor_roles_json,action,target_type,target_id,before_revision,after_revision,correlation_id,occurred_at,details_json)
      SELECT ?,'human',?,?,?,?,?,?,?,?,?,? WHERE ${gate}`,
    ).bind(
      uuidv7(),
      auth.principal.subject,
      JSON.stringify(auth.principal.roles),
      "diagnostic_policy.assigned",
      "diagnostic_policy_assignment",
      assignmentId,
      existing?.revision ?? null,
      nextRevision,
      auth.correlationId,
      occurredAt,
      JSON.stringify({
        selector: command.selector,
        policy_id: command.policy_id,
        policy_revision: command.policy_revision,
      }),
      assignmentId,
      nextRevision,
      occurredAt,
    ),
    env.DB.prepare(
      `INSERT INTO outbox
      (outbox_id,aggregate_type,aggregate_id,event_type,schema_version,payload_json,state,attempt_count,available_at,next_attempt_at,created_at)
      SELECT ?,'diagnostic_policy_assignment',?,'diagnostic_policy.assigned','1.0',?,'pending',0,?,?,? WHERE ${gate}`,
    ).bind(
      uuidv7(),
      assignmentId,
      JSON.stringify({ assignment_id: assignmentId, revision: nextRevision }),
      occurredAt,
      occurredAt,
      occurredAt,
      assignmentId,
      nextRevision,
      occurredAt,
    ),
    env.DB.prepare(
      `INSERT INTO idempotency_keys
      (scope,idempotency_key,request_digest,resource_type,resource_id,response_status,response_json,created_at,expires_at)
      SELECT 'assignDiagnosticPolicy',?,?,'diagnostic_policy_assignment',?,200,?,?,? WHERE ${gate}`,
    ).bind(
      command.command_id,
      requestDigest,
      assignmentId,
      JSON.stringify({ resource_id: assignmentId }),
      occurredAt,
      expiry(occurredAt),
      assignmentId,
      nextRevision,
      occurredAt,
    ),
  ];
  try {
    const results = await env.DB.batch(statements);
    if (changes(results[0]) !== 1)
      return {
        problem: problem(
          409,
          "Policy assignment conflict",
          auth.correlationId,
          "assignDiagnosticPolicy",
        ),
      };
  } catch {
    const raced = await idempotentResource(
      env.DB,
      "assignDiagnosticPolicy",
      command.command_id,
      requestDigest,
      auth.correlationId,
    );
    if (raced !== null && !("problem" in raced)) {
      const value = await getPolicyAssignment(env.DB, raced.resourceId);
      if (value !== null) return { data: value };
    }
    return {
      problem:
        raced !== null && "problem" in raced
          ? raced.problem
          : problem(
              409,
              "Policy assignment conflict",
              auth.correlationId,
              "assignDiagnosticPolicy",
            ),
    };
  }
  return { data: (await getPolicyAssignment(env.DB, assignmentId))! };
}

async function getPolicyAssignment(
  db: D1Database,
  id: string,
): Promise<DiagnosticPolicyAssignment | null> {
  const row = await db
    .prepare("SELECT * FROM service_diagnostic_policies WHERE assignment_id=?")
    .bind(id)
    .first<Record<string, unknown>>();
  if (row === null) return null;
  const selector =
    row.selector_kind === "monitor"
      ? { kind: "monitor" as const, monitor_id: row.monitor_id as string }
      : row.selector_kind === "service_kind"
        ? {
            kind: "service_kind" as const,
            service_name: row.service_name as string,
            diagnostic_kind: row.diagnostic_kind as string,
          }
        : {
            kind: "service_default" as const,
            service_name: row.service_name as string,
          };
  return {
    assignment_id: row.assignment_id as string,
    selector,
    policy_id: row.policy_id as string,
    policy_revision: row.policy_revision as number,
    assigned_at: row.assigned_at as string,
    assigned_by: row.assigned_by as string,
    revision: row.revision as number,
  };
}

/** 创建有明确期限的人工状态覆盖；Maintenance 必须由维护窗口表达 / Creates an expiring status override; Maintenance must use a maintenance window. */
export async function setStatusOverride(
  env: AdminEnvironment,
  raw: SetStatusOverrideRpcRequest,
): Promise<SetStatusOverrideRpcResult> {
  const auth = authorize(
    SetStatusOverrideRpcRequestSchema,
    raw,
    "operator",
    "setStatusOverride",
  );
  if ("problem" in auth) return auth;
  const missingCore = requireDomainCore(
    env,
    auth.correlationId,
    "setStatusOverride",
  );
  if (missingCore !== null) return missingCore;
  const { command } = auth.request;
  const requestDigest = await digest(command);
  const prior = await idempotentResource(
    env.DB,
    "setStatusOverride",
    command.command_id,
    requestDigest,
    auth.correlationId,
  );
  if (prior !== null) {
    if ("problem" in prior) return prior;
    const value = await getOverride(env.DB, prior.resourceId);
    return value === null
      ? {
          problem: problem(
            409,
            "Prior result is unavailable",
            auth.correlationId,
            "setStatusOverride",
          ),
        }
      : { data: value };
  }
  const occurredAt = now();
  if (Date.parse(command.expires_at) <= Date.parse(occurredAt)) {
    return {
      problem: problem(
        400,
        "Override expiry must be in the future",
        auth.correlationId,
        "setStatusOverride",
      ),
    };
  }
  const targetId =
    command.target.target_type === "service"
      ? command.target.service_name
      : command.target.component_id;
  if (command.target.target_type === "component") {
    const owner = await env.DB.prepare(
      "SELECT service_name FROM components WHERE component_id=?",
    )
      .bind(targetId)
      .first<{ service_name: string }>();
    if (owner?.service_name !== command.target.service_name)
      return {
        problem: problem(
          400,
          "Component does not belong to service",
          auth.correlationId,
          "setStatusOverride",
        ),
      };
  } else if (
    !(await validateIds(env.DB, "services", "service_name", [targetId]))
  ) {
    return {
      problem: problem(
        400,
        "Unknown override target",
        auth.correlationId,
        "setStatusOverride",
      ),
    };
  }
  const existing = await env.DB.prepare(
    `SELECT override_id,expires_at,revision FROM status_overrides
    WHERE target_type=? AND target_id=? AND revoked_at IS NULL`,
  )
    .bind(command.target.target_type, targetId)
    .first<{ override_id: string; expires_at: string; revision: number }>();
  if (
    existing !== null &&
    Date.parse(existing.expires_at) > Date.parse(occurredAt)
  ) {
    return {
      problem: problem(
        409,
        "An active override already exists",
        auth.correlationId,
        "setStatusOverride",
      ),
    };
  }
  const reevaluationTargets = await expandReevaluationTargets(
    env.DB,
    command.target.target_type === "service" ? [targetId] : [],
    command.target.target_type === "component" ? [targetId] : [],
  );
  const id = uuidv7();
  const overrideAuditId = uuidv7();
  const statusPlan = await planStatusReevaluation(
    env,
    reevaluationTargets,
    { type: "override", id },
    {
      evaluatedAt: occurredAt,
      override: {
        overrideId: id,
        target: { type: command.target.target_type, id: targetId },
        status: command.status,
        startsAt: occurredAt,
        expiresAt: command.expires_at,
        revoked: false,
        auditId: overrideAuditId,
      },
    },
  );
  const statements: D1PreparedStatement[] = [];
  if (existing !== null) {
    statements.push(
      env.DB.prepare(
        "UPDATE status_overrides SET revoked_at=?,revoked_by=?,revision=revision+1 WHERE override_id=? AND revoked_at IS NULL AND expires_at<=?",
      ).bind(
        occurredAt,
        auth.principal.subject,
        existing.override_id,
        occurredAt,
      ),
      env.DB.prepare(
        `INSERT INTO audit_log
          (audit_id,actor_type,actor_subject,actor_roles_json,action,target_type,target_id,before_revision,after_revision,correlation_id,occurred_at,details_json)
          SELECT ?,'human',?,?,?,?,?,?,?,?,?,? WHERE EXISTS
            (SELECT 1 FROM status_overrides WHERE override_id=? AND revoked_at=? AND revision=?)`,
      ).bind(
        uuidv7(),
        auth.principal.subject,
        JSON.stringify(auth.principal.roles),
        "status_override.expired_replaced",
        "status_override",
        existing.override_id,
        existing.revision,
        existing.revision + 1,
        auth.correlationId,
        occurredAt,
        JSON.stringify({ replacement_override_id: id }),
        existing.override_id,
        occurredAt,
        existing.revision + 1,
      ),
    );
  }
  statements.push(
    env.DB.prepare(
      `INSERT INTO status_overrides
      (override_id,target_type,target_id,status,reason,starts_at,expires_at,actor_subject,correlation_id,created_at,revision)
      VALUES (?,?,?,?,?,?,?,?,?,?,1)`,
    ).bind(
      id,
      command.target.target_type,
      targetId,
      command.status,
      command.reason,
      occurredAt,
      command.expires_at,
      auth.principal.subject,
      auth.correlationId,
      occurredAt,
    ),
    auditStatement(
      env.DB,
      auth.principal,
      auth.correlationId,
      "status_override.created",
      "status_override",
      id,
      null,
      1,
      occurredAt,
      {
        target_type: command.target.target_type,
        target_id: targetId,
        status: command.status,
        expires_at: command.expires_at,
        replaced_override_id: existing?.override_id,
      },
      overrideAuditId,
    ),
    ...reevaluationStatements(
      env.DB,
      reevaluationTargets,
      "override",
      id,
      occurredAt,
    ),
    idempotencyStatement(
      env.DB,
      "setStatusOverride",
      command.command_id,
      requestDigest,
      "status_override",
      id,
      occurredAt,
    ),
  );
  try {
    await env.DB.batch([
      ...statusPlan.guards,
      ...statements,
      ...statusPlan.writes,
    ]);
    measurement(
      env.TELEMETRY,
      "status.transition.count",
      statusPlan.transitionCount,
      "admin",
    );
  } catch {
    const raced = await idempotentResource(
      env.DB,
      "setStatusOverride",
      command.command_id,
      requestDigest,
      auth.correlationId,
    );
    if (raced !== null && !("problem" in raced)) {
      const value = await getOverride(env.DB, raced.resourceId);
      if (value !== null) return { data: value };
    }
    return {
      problem:
        raced !== null && "problem" in raced
          ? raced.problem
          : problem(
              409,
              "Status override conflict",
              auth.correlationId,
              "setStatusOverride",
            ),
    };
  }
  return { data: (await getOverride(env.DB, id))! };
}

async function getOverride(
  db: D1Database,
  id: string,
): Promise<z.infer<typeof StatusOverrideSchema> | null> {
  const row = await db
    .prepare("SELECT * FROM status_overrides WHERE override_id=?")
    .bind(id)
    .first<Record<string, unknown>>();
  if (row === null) return null;
  const target =
    row.target_type === "service"
      ? { target_type: "service" as const, service_name: row.target_id }
      : {
          target_type: "component" as const,
          component_id: row.target_id,
          service_name: (
            await db
              .prepare(
                "SELECT service_name FROM components WHERE component_id=?",
              )
              .bind(row.target_id)
              .first<{ service_name: string }>()
          )?.service_name,
        };
  return StatusOverrideSchema.parse({
    override_id: row.override_id,
    target,
    status: row.status,
    expires_at: row.expires_at,
    reason: row.reason,
    created_at: row.created_at,
    created_by: row.actor_subject,
    revision: row.revision,
  });
}

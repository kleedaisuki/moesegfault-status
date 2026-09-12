import {
  ComponentCatalogSchema,
  CreateComponentRpcRequestSchema,
  ServiceCatalogSchema,
  UpdateComponentCatalogRpcRequestSchema,
  UpdateServiceCatalogRpcRequestSchema,
  type AdminPrincipal,
  type CatalogDependency,
  type ComponentCatalog,
  type CreateComponentRpcRequest,
  type CreateComponentRpcResult,
  type ProblemDetails,
  type ServiceCatalog,
  type UpdateComponentCatalogRpcRequest,
  type UpdateComponentCatalogRpcResult,
  type UpdateServiceCatalogRpcRequest,
  type UpdateServiceCatalogRpcResult,
} from "@moesegfault/contracts";
import { z } from "zod";

/** 目录命令需要的最小持久化绑定。 / Minimal persistence binding required by catalog commands. */
export interface CatalogEnvironment {
  /** 权威目录数据库。 / Authoritative catalog database. */
  readonly DB: D1Database;
}

type Role = "viewer" | "operator" | "admin";

interface DependencyRow {
  readonly target_service: string;
  readonly capability: string;
  readonly kind: CatalogDependency["kind"];
  readonly criticality: CatalogDependency["criticality"];
}

interface ComponentServiceRow {
  readonly service_name: string;
  readonly role: "owner" | "supporting";
}

interface CommandAuth<Request> {
  readonly request: Request;
  readonly principal: AdminPrincipal;
  readonly correlationId: string;
}

/**
 * 以不可变外部 ID 为中心执行服务目录更新。
 * Update a service catalog aggregate around its immutable external ID.
 *
 * dependencies 出现时代表调用方完整 authored set，而非增量 patch。环合法；self
 * edge 被拒绝。只有 OCC 更新成功后，关系 diff、审计、outbox 与幂等记录才会运行。
 * When dependencies is present it is the caller's complete authored set, not
 * an incremental patch. Cycles are legal; self edges are rejected. Relation
 * diffs, audit, outbox, and idempotency are gated on the successful OCC write.
 */
export async function updateServiceCatalog(
  env: CatalogEnvironment,
  raw: UpdateServiceCatalogRpcRequest,
): Promise<UpdateServiceCatalogRpcResult> {
  const auth = authorize(
    UpdateServiceCatalogRpcRequestSchema,
    raw,
    "admin",
    "updateServiceCatalog",
  );
  if ("problem" in auth) return auth;

  const {
    command,
    expected_revision: expected,
    service_name: serviceName,
  } = auth.request;
  const requestDigest = await digest({ serviceName, expected, command });
  const prior = await replay(
    env.DB,
    "updateServiceCatalog",
    command.command_id,
    requestDigest,
    auth.correlationId,
  );
  if (prior !== null)
    return resolveServiceReplay(env.DB, prior, auth.correlationId);

  const before = await readService(env.DB, serviceName);
  if (before === null)
    return fail(
      404,
      "Service not found",
      auth.correlationId,
      "updateServiceCatalog",
    );
  if (before.revision !== expected)
    return conflict(
      "Service revision conflict",
      auth.correlationId,
      "updateServiceCatalog",
    );

  const authored = command.dependencies;
  if (authored?.some((edge) => edge.target_service === serviceName)) {
    return fail(
      400,
      "Self dependency is not allowed",
      auth.correlationId,
      "updateServiceCatalog",
    );
  }
  if (
    authored !== undefined &&
    !(await servicesExist(
      env.DB,
      authored.map((edge) => edge.target_service),
    ))
  ) {
    return fail(
      400,
      "Unknown dependency service",
      auth.correlationId,
      "updateServiceCatalog",
    );
  }

  const occurredAt = new Date().toISOString();
  const nextRevision = expected + 1;
  const dependencyDiff = diffDependencies(
    before.dependencies,
    authored ?? before.dependencies,
  );
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE services SET display_name=?,description=?,owner=?,criticality=?,enabled=?,
       updated_at=?,revision=revision+1 WHERE service_name=? AND revision=?`,
    ).bind(
      command.display_name ?? before.display_name,
      command.description ?? before.description,
      command.owner ?? before.owner,
      command.criticality ?? before.criticality,
      command.enabled === undefined
        ? before.enabled
          ? 1
          : 0
        : command.enabled
          ? 1
          : 0,
      occurredAt,
      serviceName,
      expected,
    ),
  ];

  if (authored !== undefined) {
    for (const edge of dependencyDiff.removed) {
      statements.push(
        env.DB.prepare(
          `DELETE FROM service_dependencies
           WHERE source_service=? AND target_service=? AND capability=?
             AND ${serviceGate()}`,
        ).bind(
          serviceName,
          edge.target_service,
          edge.capability,
          serviceName,
          nextRevision,
          occurredAt,
        ),
      );
    }
    for (const change of dependencyDiff.updated) {
      statements.push(
        env.DB.prepare(
          `UPDATE service_dependencies SET kind=?,criticality=?
           WHERE source_service=? AND target_service=? AND capability=?
             AND ${serviceGate()}`,
        ).bind(
          change.after.kind,
          change.after.criticality,
          serviceName,
          change.after.target_service,
          change.after.capability,
          serviceName,
          nextRevision,
          occurredAt,
        ),
      );
    }
    for (const edge of dependencyDiff.added) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO service_dependencies
           (source_service,target_service,capability,kind,criticality,created_at)
           SELECT ?,?,?,?,?,? WHERE ${serviceGate()}`,
        ).bind(
          serviceName,
          edge.target_service,
          edge.capability,
          edge.kind,
          edge.criticality,
          occurredAt,
          serviceName,
          nextRevision,
          occurredAt,
        ),
      );
    }
  }

  const changedFields = [
    "display_name",
    "description",
    "owner",
    "criticality",
    "enabled",
  ].filter((field) => command[field as keyof typeof command] !== undefined);
  statements.push(
    gatedAudit(
      env.DB,
      auth.principal,
      auth.correlationId,
      "service.catalog_updated",
      "service",
      serviceName,
      expected,
      nextRevision,
      occurredAt,
      {
        changed_fields: changedFields,
        dependency_diff: dependencyDiff,
      },
      serviceGate(),
      [serviceName, nextRevision, occurredAt],
    ),
    gatedOutbox(
      env.DB,
      "service",
      serviceName,
      { service_name: serviceName, revision: nextRevision },
      occurredAt,
      serviceGate(),
      [serviceName, nextRevision, occurredAt],
    ),
    gatedIdempotency(
      env.DB,
      "updateServiceCatalog",
      command.command_id,
      requestDigest,
      "service",
      serviceName,
      occurredAt,
      serviceGate(),
      [serviceName, nextRevision, occurredAt],
    ),
  );

  try {
    const results = await env.DB.batch(statements);
    if (changes(results[0]) !== 1)
      return conflict(
        "Service revision conflict",
        auth.correlationId,
        "updateServiceCatalog",
      );
  } catch {
    const raced = await replay(
      env.DB,
      "updateServiceCatalog",
      command.command_id,
      requestDigest,
      auth.correlationId,
    );
    if (raced !== null)
      return resolveServiceReplay(env.DB, raced, auth.correlationId);
    return conflict(
      "Service catalog update conflict",
      auth.correlationId,
      "updateServiceCatalog",
    );
  }
  return { data: (await readService(env.DB, serviceName))! };
}

/** 创建 Component；全局 ID 消除“同名但不同 owner”的特殊情况。 / Create a Component; its global ID eliminates owner-scoped identity special cases. */
export async function createComponent(
  env: CatalogEnvironment,
  raw: CreateComponentRpcRequest,
): Promise<CreateComponentRpcResult> {
  const auth = authorize(
    CreateComponentRpcRequestSchema,
    raw,
    "admin",
    "createComponent",
  );
  if ("problem" in auth) return auth;
  const { command } = auth.request;
  const requestDigest = await digest(command);
  const prior = await replay(
    env.DB,
    "createComponent",
    command.command_id,
    requestDigest,
    auth.correlationId,
  );
  if (prior !== null)
    return resolveComponentReplay(
      env.DB,
      prior,
      auth.correlationId,
      "createComponent",
    );
  if (
    !(await servicesExist(env.DB, [
      command.owner_service,
      ...command.supporting_services,
    ]))
  ) {
    return fail(
      400,
      "Unknown component service",
      auth.correlationId,
      "createComponent",
    );
  }

  const occurredAt = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO components
       (component_id,service_name,display_name,description,public,sort_order,enabled,created_at,updated_at,revision)
       VALUES (?,?,?,?,?,?,?,?,?,1)`,
    ).bind(
      command.component_id,
      command.owner_service,
      command.display_name,
      command.description,
      command.public ? 1 : 0,
      command.sort_order,
      command.enabled ? 1 : 0,
      occurredAt,
      occurredAt,
    ),
    env.DB.prepare(
      `INSERT INTO component_services(component_id,service_name,role,created_at)
       VALUES (?,?,'owner',?)`,
    ).bind(command.component_id, command.owner_service, occurredAt),
    ...command.supporting_services.map((service) =>
      env.DB.prepare(
        `INSERT INTO component_services(component_id,service_name,role,created_at)
         VALUES (?,?,'supporting',?)`,
      ).bind(command.component_id, service, occurredAt),
    ),
    audit(
      env.DB,
      auth.principal,
      auth.correlationId,
      "component.created",
      "component",
      command.component_id,
      null,
      1,
      occurredAt,
      {
        owner_service: command.owner_service,
        supporting_services: command.supporting_services,
      },
    ),
    outbox(
      env.DB,
      "component",
      command.component_id,
      {
        component_id: command.component_id,
        owner_service: command.owner_service,
        revision: 1,
      },
      occurredAt,
    ),
    idempotency(
      env.DB,
      "createComponent",
      command.command_id,
      requestDigest,
      "component",
      command.component_id,
      occurredAt,
    ),
  ];
  try {
    await env.DB.batch(statements);
  } catch {
    const raced = await replay(
      env.DB,
      "createComponent",
      command.command_id,
      requestDigest,
      auth.correlationId,
    );
    if (raced !== null)
      return resolveComponentReplay(
        env.DB,
        raced,
        auth.correlationId,
        "createComponent",
      );
    return conflict(
      "Component creation conflict",
      auth.correlationId,
      "createComponent",
    );
  }
  return { data: (await readComponent(env.DB, command.component_id))! };
}

/** 以 OCC 修改 Component；移除 Component 必须改用 enabled=false。 / Mutate a Component with OCC; retirement must use enabled=false rather than deletion. */
export async function updateComponentCatalog(
  env: CatalogEnvironment,
  raw: UpdateComponentCatalogRpcRequest,
): Promise<UpdateComponentCatalogRpcResult> {
  const auth = authorize(
    UpdateComponentCatalogRpcRequestSchema,
    raw,
    "admin",
    "updateComponentCatalog",
  );
  if ("problem" in auth) return auth;
  const {
    command,
    component_id: componentId,
    expected_revision: expected,
  } = auth.request;
  const requestDigest = await digest({ componentId, expected, command });
  const prior = await replay(
    env.DB,
    "updateComponentCatalog",
    command.command_id,
    requestDigest,
    auth.correlationId,
  );
  if (prior !== null)
    return resolveComponentReplay(
      env.DB,
      prior,
      auth.correlationId,
      "updateComponentCatalog",
    );

  const before = await readComponent(env.DB, componentId);
  if (before === null)
    return fail(
      404,
      "Component not found",
      auth.correlationId,
      "updateComponentCatalog",
    );
  if (before.revision !== expected)
    return conflict(
      "Component revision conflict",
      auth.correlationId,
      "updateComponentCatalog",
    );
  if (command.supporting_services?.includes(before.owner_service) === true) {
    return fail(
      400,
      "Owner cannot be a supporting service",
      auth.correlationId,
      "updateComponentCatalog",
    );
  }
  if (
    command.supporting_services !== undefined &&
    !(await servicesExist(env.DB, command.supporting_services))
  ) {
    return fail(
      400,
      "Unknown supporting service",
      auth.correlationId,
      "updateComponentCatalog",
    );
  }
  const ownerLinks = await env.DB.prepare(
    "SELECT service_name FROM component_services WHERE component_id=? AND role='owner'",
  )
    .bind(componentId)
    .all<{ service_name: string }>();
  if (
    ownerLinks.results.some(
      (link) => link.service_name !== before.owner_service,
    )
  ) {
    return conflict(
      "Component owner relationship is inconsistent",
      auth.correlationId,
      "updateComponentCatalog",
    );
  }

  const occurredAt = new Date().toISOString();
  const nextRevision = expected + 1;
  const desiredSupport =
    command.supporting_services ?? before.supporting_services;
  const supportDiff = diffStrings(before.supporting_services, desiredSupport);
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE components SET display_name=?,description=?,public=?,sort_order=?,enabled=?,
       updated_at=?,revision=revision+1 WHERE component_id=? AND revision=?`,
    ).bind(
      command.display_name ?? before.display_name,
      command.description ?? before.description,
      command.public === undefined
        ? before.public
          ? 1
          : 0
        : command.public
          ? 1
          : 0,
      command.sort_order ?? before.sort_order,
      command.enabled === undefined
        ? before.enabled
          ? 1
          : 0
        : command.enabled
          ? 1
          : 0,
      occurredAt,
      componentId,
      expected,
    ),
    // Legacy registerService rows did not materialize the redundant owner link.
    env.DB.prepare(
      `INSERT INTO component_services(component_id,service_name,role,created_at)
       SELECT ?,?,'owner',? WHERE ${componentGate()}
       ON CONFLICT(component_id,service_name) DO NOTHING`,
    ).bind(
      componentId,
      before.owner_service,
      occurredAt,
      componentId,
      nextRevision,
      occurredAt,
    ),
  ];
  if (command.supporting_services !== undefined) {
    for (const service of supportDiff.removed) {
      statements.push(
        env.DB.prepare(
          `DELETE FROM component_services
           WHERE component_id=? AND service_name=? AND role='supporting'
             AND ${componentGate()}`,
        ).bind(componentId, service, componentId, nextRevision, occurredAt),
      );
    }
    for (const service of supportDiff.added) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO component_services(component_id,service_name,role,created_at)
           SELECT ?,?,'supporting',? WHERE ${componentGate()}`,
        ).bind(
          componentId,
          service,
          occurredAt,
          componentId,
          nextRevision,
          occurredAt,
        ),
      );
    }
  }
  const changedFields = [
    "display_name",
    "description",
    "public",
    "sort_order",
    "enabled",
  ].filter((field) => command[field as keyof typeof command] !== undefined);
  statements.push(
    gatedAudit(
      env.DB,
      auth.principal,
      auth.correlationId,
      "component.catalog_updated",
      "component",
      componentId,
      expected,
      nextRevision,
      occurredAt,
      { changed_fields: changedFields, supporting_service_diff: supportDiff },
      componentGate(),
      [componentId, nextRevision, occurredAt],
    ),
    gatedOutbox(
      env.DB,
      "component",
      componentId,
      {
        component_id: componentId,
        owner_service: before.owner_service,
        revision: nextRevision,
      },
      occurredAt,
      componentGate(),
      [componentId, nextRevision, occurredAt],
    ),
    gatedIdempotency(
      env.DB,
      "updateComponentCatalog",
      command.command_id,
      requestDigest,
      "component",
      componentId,
      occurredAt,
      componentGate(),
      [componentId, nextRevision, occurredAt],
    ),
  );
  try {
    const results = await env.DB.batch(statements);
    if (changes(results[0]) !== 1)
      return conflict(
        "Component revision conflict",
        auth.correlationId,
        "updateComponentCatalog",
      );
  } catch {
    const raced = await replay(
      env.DB,
      "updateComponentCatalog",
      command.command_id,
      requestDigest,
      auth.correlationId,
    );
    if (raced !== null)
      return resolveComponentReplay(
        env.DB,
        raced,
        auth.correlationId,
        "updateComponentCatalog",
      );
    return conflict(
      "Component catalog update conflict",
      auth.correlationId,
      "updateComponentCatalog",
    );
  }
  return { data: (await readComponent(env.DB, componentId))! };
}

/** 读取服务目录快照，供 RPC 成功和幂等重放共用。 / Read a service snapshot shared by success and replay paths. */
export async function readService(
  db: D1Database,
  serviceName: string,
): Promise<ServiceCatalog | null> {
  const row = await db
    .prepare("SELECT * FROM services WHERE service_name=?")
    .bind(serviceName)
    .first<Record<string, unknown>>();
  if (row === null) return null;
  const dependencies = await db
    .prepare(
      `SELECT target_service,capability,kind,criticality FROM service_dependencies
     WHERE source_service=? ORDER BY target_service,capability`,
    )
    .bind(serviceName)
    .all<DependencyRow>();
  return ServiceCatalogSchema.parse({
    service_name: row.service_name,
    display_name: row.display_name,
    description: row.description,
    owner: row.owner,
    criticality: row.criticality,
    enabled: Boolean(row.enabled),
    dependencies: dependencies.results,
    created_at: row.created_at,
    updated_at: row.updated_at,
    revision: row.revision,
  });
}

/** 读取 Component 与额外支撑关系；owner 始终取 components 外键。 / Read a Component and additional support links; owner always comes from the components foreign key. */
export async function readComponent(
  db: D1Database,
  componentId: string,
): Promise<ComponentCatalog | null> {
  const row = await db
    .prepare("SELECT * FROM components WHERE component_id=?")
    .bind(componentId)
    .first<Record<string, unknown>>();
  if (row === null) return null;
  const supporting = await db
    .prepare(
      `SELECT service_name,role FROM component_services
     WHERE component_id=? AND role='supporting' ORDER BY service_name`,
    )
    .bind(componentId)
    .all<ComponentServiceRow>();
  return ComponentCatalogSchema.parse({
    component_id: row.component_id,
    owner_service: row.service_name,
    display_name: row.display_name,
    description: row.description,
    public: Boolean(row.public),
    sort_order: row.sort_order,
    enabled: Boolean(row.enabled),
    supporting_services: supporting.results.map((link) => link.service_name),
    created_at: row.created_at,
    updated_at: row.updated_at,
    revision: row.revision,
  });
}

function authorize<Request>(
  schema: z.ZodType<Request>,
  raw: unknown,
  required: Role,
  rpc: string,
): CommandAuth<Request> | { problem: ProblemDetails } {
  const correlationId =
    (raw as { correlation_id?: string } | null)?.correlation_id ?? uuidv7();
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    return fail(
      400,
      "Invalid RPC request",
      correlationId,
      rpc,
      parsed.error.issues.map((issue) => issue.message).join("; "),
    );
  const principal = (parsed.data as { principal: AdminPrincipal }).principal;
  const ranks: Record<Role, number> = { viewer: 1, operator: 2, admin: 3 };
  if (!principal.roles.some((role) => ranks[role] >= ranks[required]))
    return fail(
      403,
      "Forbidden",
      correlationId,
      rpc,
      `Role ${required} is required.`,
    );
  return { request: parsed.data, principal, correlationId };
}

function fail(
  status: number,
  title: string,
  correlationId: string,
  rpc: string,
  detail?: string,
): { problem: ProblemDetails } {
  const slug =
    status === 409
      ? "revision-conflict"
      : status === 404
        ? "not-found"
        : status === 403
          ? "forbidden"
          : status === 400
            ? "invalid-request"
            : "dependency-unavailable";
  return {
    problem: {
      type: `https://status.moesegfault.dev/problems/${slug}`,
      title,
      status,
      ...(detail === undefined ? {} : { detail }),
      instance: `/rpc/${rpc}`,
      correlation_id: correlationId,
    },
  };
}

function conflict(title: string, correlationId: string, rpc: string) {
  return fail(409, title, correlationId, rpc);
}

function serviceGate(): string {
  return "EXISTS (SELECT 1 FROM services WHERE service_name=? AND revision=? AND updated_at=?)";
}

function componentGate(): string {
  return "EXISTS (SELECT 1 FROM components WHERE component_id=? AND revision=? AND updated_at=?)";
}

function diffDependencies(
  before: CatalogDependency[],
  after: CatalogDependency[],
) {
  const key = (edge: CatalogDependency) =>
    `${edge.target_service}\u0000${edge.capability}`;
  const old = new Map(before.map((edge) => [key(edge), edge]));
  const desired = new Map(after.map((edge) => [key(edge), edge]));
  const added = after.filter((edge) => !old.has(key(edge)));
  const removed = before.filter((edge) => !desired.has(key(edge)));
  const updated = after.flatMap((edge) => {
    const prior = old.get(key(edge));
    return prior !== undefined &&
      (prior.kind !== edge.kind || prior.criticality !== edge.criticality)
      ? [{ before: prior, after: edge }]
      : [];
  });
  return { added, removed, updated };
}

function diffStrings(before: string[], after: string[]) {
  const old = new Set(before);
  const desired = new Set(after);
  return {
    added: after.filter((item) => !old.has(item)),
    removed: before.filter((item) => !desired.has(item)),
  };
}

async function servicesExist(
  db: D1Database,
  names: string[],
): Promise<boolean> {
  const unique = [...new Set(names)];
  if (unique.length === 0) return true;
  const rows = await db
    .prepare(
      `SELECT service_name FROM services WHERE service_name IN (${unique.map(() => "?").join(",")})`,
    )
    .bind(...unique)
    .all<{ service_name: string }>();
  return rows.results.length === unique.length;
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
  return new Date(Date.parse(createdAt) + 7 * 86_400_000).toISOString();
}

async function replay(
  db: D1Database,
  scope: string,
  key: string,
  requestDigest: string,
  correlationId: string,
): Promise<{ resourceId: string } | { problem: ProblemDetails } | null> {
  const row = await db
    .prepare(
      "SELECT request_digest,resource_id FROM idempotency_keys WHERE scope=? AND idempotency_key=?",
    )
    .bind(scope, key)
    .first<{ request_digest: string; resource_id: string | null }>();
  if (row === null) return null;
  if (row.request_digest !== requestDigest)
    return fail(
      409,
      "Idempotency key conflict",
      correlationId,
      scope,
      "The command_id was already used with different content.",
    );
  return row.resource_id === null
    ? fail(409, "Incomplete prior command", correlationId, scope)
    : { resourceId: row.resource_id };
}

async function resolveServiceReplay(
  db: D1Database,
  replayResult: { resourceId: string } | { problem: ProblemDetails },
  correlationId: string,
): Promise<UpdateServiceCatalogRpcResult> {
  if ("problem" in replayResult) return replayResult;
  const data = await readService(db, replayResult.resourceId);
  return data === null
    ? conflict(
        "Prior result is unavailable",
        correlationId,
        "updateServiceCatalog",
      )
    : { data };
}

async function resolveComponentReplay(
  db: D1Database,
  replayResult: { resourceId: string } | { problem: ProblemDetails },
  correlationId: string,
  rpc: "createComponent" | "updateComponentCatalog",
): Promise<CreateComponentRpcResult | UpdateComponentCatalogRpcResult> {
  if ("problem" in replayResult) return replayResult;
  const data = await readComponent(db, replayResult.resourceId);
  return data === null
    ? conflict("Prior result is unavailable", correlationId, rpc)
    : { data };
}

function uuidv7(timestamp = Date.now()): string {
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

function audit(
  db: D1Database,
  principal: AdminPrincipal,
  correlationId: string,
  action: string,
  targetType: string,
  targetId: string,
  beforeRevision: number | null,
  afterRevision: number,
  occurredAt: string,
  details: unknown,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_log
     (audit_id,actor_type,actor_subject,actor_roles_json,action,target_type,target_id,before_revision,after_revision,correlation_id,occurred_at,details_json)
     VALUES (?,'human',?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      uuidv7(),
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

function gatedAudit(
  db: D1Database,
  principal: AdminPrincipal,
  correlationId: string,
  action: string,
  targetType: string,
  targetId: string,
  beforeRevision: number,
  afterRevision: number,
  occurredAt: string,
  details: unknown,
  gate: string,
  gateValues: unknown[],
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_log
     (audit_id,actor_type,actor_subject,actor_roles_json,action,target_type,target_id,before_revision,after_revision,correlation_id,occurred_at,details_json)
     SELECT ?,'human',?,?,?,?,?,?,?,?,?,? WHERE ${gate}`,
    )
    .bind(
      uuidv7(),
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
      ...gateValues,
    );
}

function outbox(
  db: D1Database,
  aggregateType: string,
  aggregateId: string,
  payload: unknown,
  occurredAt: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO outbox
     (outbox_id,aggregate_type,aggregate_id,event_type,schema_version,payload_json,state,attempt_count,available_at,next_attempt_at,created_at)
     VALUES (?,?,?,'catalog.changed','1.0',?,'pending',0,?,?,?)`,
    )
    .bind(
      uuidv7(),
      aggregateType,
      aggregateId,
      JSON.stringify(payload),
      occurredAt,
      occurredAt,
      occurredAt,
    );
}

function gatedOutbox(
  db: D1Database,
  aggregateType: string,
  aggregateId: string,
  payload: unknown,
  occurredAt: string,
  gate: string,
  gateValues: unknown[],
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO outbox
     (outbox_id,aggregate_type,aggregate_id,event_type,schema_version,payload_json,state,attempt_count,available_at,next_attempt_at,created_at)
     SELECT ?,?,?,'catalog.changed','1.0',?,'pending',0,?,?,? WHERE ${gate}`,
    )
    .bind(
      uuidv7(),
      aggregateType,
      aggregateId,
      JSON.stringify(payload),
      occurredAt,
      occurredAt,
      occurredAt,
      ...gateValues,
    );
}

function idempotency(
  db: D1Database,
  scope: string,
  key: string,
  requestDigest: string,
  resourceType: string,
  resourceId: string,
  occurredAt: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO idempotency_keys
     (scope,idempotency_key,request_digest,resource_type,resource_id,response_status,response_json,created_at,expires_at)
     VALUES (?,?,?,?,?,200,?,?,?)`,
    )
    .bind(
      scope,
      key,
      requestDigest,
      resourceType,
      resourceId,
      JSON.stringify({ resource_id: resourceId }),
      occurredAt,
      expiry(occurredAt),
    );
}

function gatedIdempotency(
  db: D1Database,
  scope: string,
  key: string,
  requestDigest: string,
  resourceType: string,
  resourceId: string,
  occurredAt: string,
  gate: string,
  gateValues: unknown[],
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO idempotency_keys
     (scope,idempotency_key,request_digest,resource_type,resource_id,response_status,response_json,created_at,expires_at)
     SELECT ?,?,?,?,?,200,?,?,? WHERE ${gate}`,
    )
    .bind(
      scope,
      key,
      requestDigest,
      resourceType,
      resourceId,
      JSON.stringify({ resource_id: resourceId }),
      occurredAt,
      expiry(occurredAt),
      ...gateValues,
    );
}

function changes(result: D1Result<unknown> | undefined): number {
  return (result?.meta as { changes?: number } | undefined)?.changes ?? 0;
}

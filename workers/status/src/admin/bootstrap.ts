import {
  ActivateDeploymentRpcRequestSchema,
  RegisterAndAssignRetentionPolicyRpcRequestSchema,
  type ActivateDeploymentRpcRequest,
  type ActivateDeploymentRpcResult,
  type ActiveDeployment,
  type AdminPrincipal,
  type ProblemDetails,
  type RegisterAndAssignRetentionPolicyRpcRequest,
  type RegisterAndAssignRetentionPolicyRpcResult,
  type ServiceRetentionPolicyAssignment,
} from "@moesegfault/contracts";
import type { z } from "zod";

import { uuidv7, type AdminEnvironment } from "./index.js";

const RETENTION_SCOPE = "registerAndAssignRetentionPolicy";
const ACTIVATION_SCOPE = "activateDeployment";

interface IdempotencyRow {
  readonly request_digest: string;
  readonly resource_id: string | null;
}

interface DeploymentStateRow {
  readonly deployment_id: string;
  readonly service_name: string;
  readonly environment: "development" | "test" | "staging" | "production";
  readonly state: string;
  readonly revision: number;
}

interface PointerRow {
  readonly deployment_id: string;
  readonly revision: number;
}

type Authorized<T> = {
  readonly request: T;
  readonly principal: AdminPrincipal;
  readonly correlationId: string;
};

/**
 * 原子登记不可变保留策略 revision，并以显式 CAS 绑定服务。
 * Atomically registers an immutable retention-policy revision and assigns it with explicit CAS.
 */
export async function registerAndAssignRetentionPolicy(
  env: AdminEnvironment,
  raw: RegisterAndAssignRetentionPolicyRpcRequest,
): Promise<RegisterAndAssignRetentionPolicyRpcResult> {
  const auth = authorize(
    RegisterAndAssignRetentionPolicyRpcRequestSchema,
    raw,
    RETENTION_SCOPE,
  );
  if ("problem" in auth) return auth;

  const command = auth.request.command;
  const requestDigest = await digest(command);
  const prior = await idempotentResource(
    env.DB,
    RETENTION_SCOPE,
    command.command_id,
    requestDigest,
    auth.correlationId,
  );
  if (prior !== null) {
    if ("problem" in prior) return prior;
    return existingRetentionResult(
      env.DB,
      prior.resourceId,
      auth.correlationId,
    );
  }

  const service = await env.DB.prepare(
    "SELECT 1 FROM services WHERE service_name=?",
  )
    .bind(command.service_name)
    .first();
  if (service === null) {
    return {
      problem: rpcProblem(
        404,
        "Service not found",
        auth.correlationId,
        RETENTION_SCOPE,
      ),
    };
  }

  const current = await env.DB.prepare(
    "SELECT revision FROM service_retention_policies WHERE service_name=?",
  )
    .bind(command.service_name)
    .first<{ revision: number }>();
  if (
    !matchesExpected(current?.revision, command.expected_assignment_revision)
  ) {
    return {
      problem: rpcProblem(
        409,
        "Retention assignment revision conflict",
        auth.correlationId,
        RETENTION_SCOPE,
      ),
    };
  }

  const occurredAt = new Date().toISOString();
  const policy = command.policy;
  const nextRevision = (current?.revision ?? 0) + 1;
  const mutation =
    current === null
      ? env.DB.prepare(
          `INSERT INTO service_retention_policies
           (service_name,policy_id,policy_revision,assigned_by,assigned_at,revision)
           VALUES (?,?,?,?,?,1)`,
        ).bind(
          command.service_name,
          policy.policy_id,
          policy.revision,
          auth.principal.subject,
          occurredAt,
        )
      : env.DB.prepare(
          `UPDATE service_retention_policies
           SET policy_id=?,policy_revision=?,assigned_by=?,assigned_at=?,revision=revision+1
           WHERE service_name=? AND revision=?`,
        ).bind(
          policy.policy_id,
          policy.revision,
          auth.principal.subject,
          occurredAt,
          command.service_name,
          command.expected_assignment_revision,
        );

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO data_retention_policies
         (policy_id,revision,occurrence_retention_days,cleanup_batch_size,created_by,created_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(policy_id,revision) DO NOTHING`,
      ).bind(
        policy.policy_id,
        policy.revision,
        policy.occurrence_retention_days,
        policy.cleanup_batch_size,
        auth.principal.subject,
        occurredAt,
      ),
      policyRegistrationAuditIfInserted(
        env.DB,
        auth.principal,
        auth.correlationId,
        policy.policy_id,
        policy.revision,
        occurredAt,
        {
          occurrence_retention_days: policy.occurrence_retention_days,
          cleanup_batch_size: policy.cleanup_batch_size,
        },
      ),
      assertion(
        env.DB,
        `EXISTS (
          SELECT 1 FROM data_retention_policies
          WHERE policy_id=? AND revision=? AND occurrence_retention_days=? AND cleanup_batch_size=?
        )`,
        policy.policy_id,
        policy.revision,
        policy.occurrence_retention_days,
        policy.cleanup_batch_size,
      ),
      mutation,
      changesAssertion(env.DB),
      auditStatement(
        env.DB,
        auth.principal,
        auth.correlationId,
        "retention_policy.assigned",
        "service_retention_policy",
        command.service_name,
        current?.revision ?? null,
        nextRevision,
        occurredAt,
        {
          policy_id: policy.policy_id,
          policy_revision: policy.revision,
          occurrence_retention_days: policy.occurrence_retention_days,
          cleanup_batch_size: policy.cleanup_batch_size,
        },
      ),
      outboxStatement(
        env.DB,
        "service_retention_policy",
        command.service_name,
        "retention_policy.assigned",
        {
          service_name: command.service_name,
          policy_id: policy.policy_id,
          policy_revision: policy.revision,
          assignment_revision: nextRevision,
        },
        occurredAt,
      ),
      idempotencyStatement(
        env.DB,
        RETENTION_SCOPE,
        command.command_id,
        requestDigest,
        "service_retention_policy",
        command.service_name,
        occurredAt,
      ),
    ]);
  } catch {
    const raced = await idempotentResource(
      env.DB,
      RETENTION_SCOPE,
      command.command_id,
      requestDigest,
      auth.correlationId,
    );
    if (raced !== null && !("problem" in raced)) {
      return existingRetentionResult(
        env.DB,
        raced.resourceId,
        auth.correlationId,
      );
    }
    return {
      problem:
        raced !== null && "problem" in raced
          ? raced.problem
          : rpcProblem(
              409,
              "Retention policy or assignment conflict",
              auth.correlationId,
              RETENTION_SCOPE,
            ),
    };
  }

  return existingRetentionResult(
    env.DB,
    command.service_name,
    auth.correlationId,
  );
}

/**
 * 在真实部署完成后显式激活 ready deployment，并切换唯一权威指针。
 * Explicitly activates a ready deployment after the real deploy and switches the sole authoritative pointer.
 */
export async function activateDeployment(
  env: AdminEnvironment,
  raw: ActivateDeploymentRpcRequest,
): Promise<ActivateDeploymentRpcResult> {
  const auth = authorize(
    ActivateDeploymentRpcRequestSchema,
    raw,
    ACTIVATION_SCOPE,
  );
  if ("problem" in auth) return auth;

  const { command, deployment_id: deploymentId } = auth.request;
  const requestDigest = await digest({ deployment_id: deploymentId, command });
  const prior = await idempotentResource(
    env.DB,
    ACTIVATION_SCOPE,
    command.command_id,
    requestDigest,
    auth.correlationId,
  );
  if (prior !== null) {
    if ("problem" in prior) return prior;
    return existingActivationResult(
      env.DB,
      prior.resourceId,
      auth.correlationId,
    );
  }

  const target = await deploymentState(env.DB, deploymentId);
  if (target === null) {
    return {
      problem: rpcProblem(
        404,
        "Deployment not found",
        auth.correlationId,
        ACTIVATION_SCOPE,
      ),
    };
  }
  if (
    target.state !== "ready" ||
    target.revision !== command.expected_deployment_revision
  ) {
    return {
      problem: rpcProblem(
        409,
        "Deployment is not the expected ready revision",
        auth.correlationId,
        ACTIVATION_SCOPE,
      ),
    };
  }

  const pointer = await env.DB.prepare(
    `SELECT deployment_id,revision FROM service_environment_deployments
     WHERE service_name=? AND environment=?`,
  )
    .bind(target.service_name, target.environment)
    .first<PointerRow>();
  if (!matchesExpected(pointer?.revision, command.expected_pointer_revision)) {
    return {
      problem: rpcProblem(
        409,
        "Current deployment pointer revision conflict",
        auth.correlationId,
        ACTIVATION_SCOPE,
      ),
    };
  }

  const previous =
    pointer !== null && pointer.deployment_id !== deploymentId
      ? await deploymentState(env.DB, pointer.deployment_id)
      : null;
  if (previous !== null && previous.state !== "active") {
    return {
      problem: rpcProblem(
        409,
        "Previous pointer does not reference an active deployment",
        auth.correlationId,
        ACTIVATION_SCOPE,
      ),
    };
  }

  const occurredAt = new Date().toISOString();
  const nextDeploymentRevision = target.revision + 1;
  const nextPointerRevision = (pointer?.revision ?? 0) + 1;
  const pointerMutation =
    pointer === null
      ? env.DB.prepare(
          `INSERT INTO service_environment_deployments
           (service_name,environment,deployment_id,activated_at,revision)
           VALUES (?,?,?,?,1)`,
        ).bind(
          target.service_name,
          target.environment,
          deploymentId,
          occurredAt,
        )
      : env.DB.prepare(
          `UPDATE service_environment_deployments
           SET deployment_id=?,activated_at=?,revision=revision+1
           WHERE service_name=? AND environment=? AND revision=?`,
        ).bind(
          deploymentId,
          occurredAt,
          target.service_name,
          target.environment,
          command.expected_pointer_revision,
        );

  try {
    const statements: D1PreparedStatement[] = [
      assertion(
        env.DB,
        `EXISTS (
          SELECT 1 FROM deployment_current_status
          WHERE deployment_id=? AND state='ready' AND revision=?
        )`,
        deploymentId,
        command.expected_deployment_revision,
      ),
      pointer === null
        ? assertion(
            env.DB,
            `NOT EXISTS (
              SELECT 1 FROM service_environment_deployments
              WHERE service_name=? AND environment=?
            )`,
            target.service_name,
            target.environment,
          )
        : assertion(
            env.DB,
            `EXISTS (
              SELECT 1 FROM service_environment_deployments
              WHERE service_name=? AND environment=? AND deployment_id=? AND revision=?
            )`,
            target.service_name,
            target.environment,
            pointer.deployment_id,
            command.expected_pointer_revision,
          ),
      env.DB.prepare(
        `INSERT INTO deployment_status_history
         (deployment_id,sequence,state,reason,actor_subject,correlation_id,occurred_at)
         VALUES (?,?,'active',?,?,?,?)`,
      ).bind(
        deploymentId,
        nextDeploymentRevision,
        command.reason,
        auth.principal.subject,
        auth.correlationId,
        occurredAt,
      ),
    ];
    if (previous !== null) {
      statements.push(
        assertion(
          env.DB,
          `EXISTS (
            SELECT 1 FROM deployment_current_status
            WHERE deployment_id=? AND state='active' AND revision=?
          )`,
          previous.deployment_id,
          previous.revision,
        ),
        env.DB.prepare(
          `INSERT INTO deployment_status_history
           (deployment_id,sequence,state,reason,actor_subject,correlation_id,occurred_at)
           VALUES (?,?,'retired',?,?,?,?)`,
        ).bind(
          previous.deployment_id,
          previous.revision + 1,
          `Superseded by ${deploymentId}`,
          auth.principal.subject,
          auth.correlationId,
          occurredAt,
        ),
      );
    }
    statements.push(
      pointerMutation,
      changesAssertion(env.DB),
      auditStatement(
        env.DB,
        auth.principal,
        auth.correlationId,
        "deployment.activated",
        "deployment",
        deploymentId,
        target.revision,
        nextDeploymentRevision,
        occurredAt,
        {
          service_name: target.service_name,
          environment: target.environment,
          pointer_before_revision: pointer?.revision ?? null,
          pointer_after_revision: nextPointerRevision,
          previous_deployment_id: previous?.deployment_id ?? null,
          reason: command.reason,
        },
      ),
      outboxStatement(
        env.DB,
        "deployment",
        deploymentId,
        "deployment.activated",
        {
          deployment_id: deploymentId,
          service_name: target.service_name,
          environment: target.environment,
          deployment_revision: nextDeploymentRevision,
          pointer_revision: nextPointerRevision,
          previous_deployment_id: previous?.deployment_id ?? null,
        },
        occurredAt,
      ),
      idempotencyStatement(
        env.DB,
        ACTIVATION_SCOPE,
        command.command_id,
        requestDigest,
        "deployment",
        deploymentId,
        occurredAt,
      ),
    );
    await env.DB.batch(statements);
  } catch {
    const raced = await idempotentResource(
      env.DB,
      ACTIVATION_SCOPE,
      command.command_id,
      requestDigest,
      auth.correlationId,
    );
    if (raced !== null && !("problem" in raced)) {
      return existingActivationResult(
        env.DB,
        raced.resourceId,
        auth.correlationId,
      );
    }
    return {
      problem:
        raced !== null && "problem" in raced
          ? raced.problem
          : rpcProblem(
              409,
              "Deployment activation conflict",
              auth.correlationId,
              ACTIVATION_SCOPE,
            ),
    };
  }

  return existingActivationResult(env.DB, deploymentId, auth.correlationId);
}

/** 在 status 领域边界重新校验 schema 与 admin 角色 / Revalidates schema and admin role at the status domain boundary. */
function authorize<T>(
  schema: z.ZodType<T>,
  raw: unknown,
  rpc: string,
): Authorized<T> | { problem: ProblemDetails } {
  const parsed = schema.safeParse(raw);
  const candidate = raw as {
    correlation_id?: string;
    principal?: Partial<AdminPrincipal>;
  } | null;
  const correlationId = candidate?.correlation_id ?? uuidv7();
  if (!parsed.success) {
    return {
      problem: rpcProblem(
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
  if (!principal.roles.includes("admin")) {
    return {
      problem: rpcProblem(
        403,
        "Forbidden",
        correlationId,
        rpc,
        "Role admin is required.",
      ),
    };
  }
  return { request, principal, correlationId };
}

/** 读取服务的保留策略绑定 / Reads the service retention-policy assignment. */
async function retentionAssignment(
  db: D1Database,
  serviceName: string,
): Promise<ServiceRetentionPolicyAssignment | null> {
  const row = await db
    .prepare(
      `SELECT s.service_name,s.policy_id,s.policy_revision,s.revision AS assignment_revision,
              s.assigned_at,s.assigned_by,p.occurrence_retention_days,p.cleanup_batch_size,
              p.created_at AS policy_registered_at,p.created_by AS policy_registered_by
       FROM service_retention_policies AS s
       JOIN data_retention_policies AS p
         ON p.policy_id=s.policy_id AND p.revision=s.policy_revision
       WHERE s.service_name=?`,
    )
    .bind(serviceName)
    .first<Record<string, unknown>>();
  if (row === null) return null;
  return {
    service_name: row.service_name as string,
    policy: {
      policy_id: row.policy_id as string,
      revision: row.policy_revision as number,
      occurrence_retention_days: row.occurrence_retention_days as number,
      cleanup_batch_size: row.cleanup_batch_size as number,
    },
    assignment_revision: row.assignment_revision as number,
    assigned_at: row.assigned_at as string,
    assigned_by: row.assigned_by as string,
    policy_registered_at: row.policy_registered_at as string,
    policy_registered_by: row.policy_registered_by as string,
  };
}

/** 将丢失的幂等结果视为冲突，而不是伪造成功 / Treats a missing idempotent resource as conflict rather than fabricating success. */
async function existingRetentionResult(
  db: D1Database,
  serviceName: string,
  correlationId: string,
): Promise<RegisterAndAssignRetentionPolicyRpcResult> {
  const data = await retentionAssignment(db, serviceName);
  return data === null
    ? {
        problem: rpcProblem(
          409,
          "Prior result is unavailable",
          correlationId,
          RETENTION_SCOPE,
        ),
      }
    : { data };
}

/** 读取不可变 deployment 与追加状态的当前 revision / Reads immutable deployment identity and current append-only state revision. */
async function deploymentState(
  db: D1Database,
  deploymentId: string,
): Promise<DeploymentStateRow | null> {
  return db
    .prepare(
      `SELECT d.deployment_id,d.service_name,d.environment,s.state,s.revision
       FROM deployments AS d
       JOIN deployment_current_status AS s ON s.deployment_id=d.deployment_id
       WHERE d.deployment_id=?`,
    )
    .bind(deploymentId)
    .first<DeploymentStateRow>();
}

/** 读取 active 状态与权威服务/环境指针的联合快照 / Reads the joined active state and authoritative service/environment pointer. */
async function activeDeployment(
  db: D1Database,
  deploymentId: string,
): Promise<ActiveDeployment | null> {
  const row = await db
    .prepare(
      `SELECT d.deployment_id,d.service_name,d.environment,s.state AS deployment_state,
              s.revision AS deployment_revision,p.revision AS pointer_revision,
              p.activated_at,s.actor_subject AS activated_by
       FROM deployments AS d
       JOIN deployment_current_status AS s ON s.deployment_id=d.deployment_id
       JOIN service_environment_deployments AS p
         ON p.deployment_id=d.deployment_id AND p.service_name=d.service_name AND p.environment=d.environment
       WHERE d.deployment_id=? AND s.state='active'`,
    )
    .bind(deploymentId)
    .first<Record<string, unknown>>();
  if (row === null) return null;
  return {
    deployment_id: row.deployment_id as string,
    service_name: row.service_name as string,
    environment: row.environment as ActiveDeployment["environment"],
    deployment_state: "active",
    deployment_revision: row.deployment_revision as number,
    pointer_revision: row.pointer_revision as number,
    activated_at: row.activated_at as string,
    activated_by: row.activated_by as string,
  };
}

/** 返回可验证的激活结果 / Returns a verifiable activation result. */
async function existingActivationResult(
  db: D1Database,
  deploymentId: string,
  correlationId: string,
): Promise<ActivateDeploymentRpcResult> {
  const data = await activeDeployment(db, deploymentId);
  return data === null
    ? {
        problem: rpcProblem(
          409,
          "Prior result is no longer current",
          correlationId,
          ACTIVATION_SCOPE,
        ),
      }
    : { data };
}

/** `null` 明确表示期待资源不存在 / `null` explicitly means the caller expects absence. */
function matchesExpected(
  actual: number | undefined,
  expected: number | null,
): boolean {
  return expected === null ? actual === undefined : actual === expected;
}

/** 构造事务内领域断言；失败会回滚整个 D1 batch / Builds an in-transaction domain assertion; failure rolls back the entire D1 batch. */
function assertion(
  db: D1Database,
  predicateSql: string,
  ...values: unknown[]
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO transaction_assertions(assertion_id,passed)
       SELECT ?, CASE WHEN ${predicateSql} THEN 1 ELSE 0 END`,
    )
    .bind(uuidv7(), ...values);
}

/** 断言紧邻的条件 mutation 精确改写一行 / Asserts that the immediately preceding conditional mutation changed exactly one row. */
function changesAssertion(db: D1Database): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO transaction_assertions(assertion_id,passed)
       VALUES (?,CASE WHEN changes()=1 THEN 1 ELSE 0 END)`,
    )
    .bind(uuidv7());
}

/** 写入不可变审计事件 / Writes an immutable audit event. */
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
  details: unknown,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_log
       (audit_id,actor_type,actor_subject,actor_roles_json,action,target_type,target_id,before_revision,after_revision,correlation_id,occurred_at,details_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      uuidv7(),
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

/**
 * 仅在紧邻的策略 INSERT 真正创建 revision 时追加注册审计。
 * Appends a registration audit only when the immediately preceding policy INSERT created the revision.
 */
function policyRegistrationAuditIfInserted(
  db: D1Database,
  principal: AdminPrincipal,
  correlationId: string,
  policyId: string,
  revision: number,
  occurredAt: string,
  details: unknown,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_log
       (audit_id,actor_type,actor_subject,actor_roles_json,action,target_type,target_id,before_revision,after_revision,correlation_id,occurred_at,details_json)
       SELECT ?,?,?,?,?,?,?,NULL,?,?,?,? WHERE changes()=1`,
    )
    .bind(
      uuidv7(),
      "human",
      principal.subject,
      JSON.stringify(principal.roles),
      "retention_policy.registered",
      "retention_policy",
      `${policyId}:${revision}`,
      revision,
      correlationId,
      occurredAt,
      JSON.stringify(details),
    );
}

/** 写入事务 outbox 事件 / Writes a transactional outbox event. */
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
       VALUES (?,?,?,?,?,?,'pending',0,?,?,?)`,
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

/** 写入 7 天可重放幂等账本 / Writes the seven-day replay ledger. */
function idempotencyStatement(
  db: D1Database,
  scope: string,
  key: string,
  requestDigest: string,
  resourceType: string,
  resourceId: string,
  occurredAt: string,
): D1PreparedStatement {
  const expiresAt = new Date(
    Date.parse(occurredAt) + 7 * 24 * 60 * 60 * 1_000,
  ).toISOString();
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
      expiresAt,
    );
}

/** 查找并验证已有幂等键 / Looks up and validates an existing idempotency key. */
async function idempotentResource(
  db: D1Database,
  scope: string,
  key: string,
  requestDigest: string,
  correlationId: string,
): Promise<
  { readonly resourceId: string } | { problem: ProblemDetails } | null
> {
  const row = await db
    .prepare(
      "SELECT request_digest,resource_id FROM idempotency_keys WHERE scope=? AND idempotency_key=?",
    )
    .bind(scope, key)
    .first<IdempotencyRow>();
  if (row === null) return null;
  if (row.request_digest !== requestDigest) {
    return {
      problem: rpcProblem(
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
      problem: rpcProblem(
        409,
        "Incomplete prior command",
        correlationId,
        scope,
      ),
    };
  }
  return { resourceId: row.resource_id };
}

/** 对结构化命令生成稳定 SHA-256 / Produces a stable SHA-256 for a structured command. */
async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableJson(value));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${[...hash]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

/** 以排序对象键生成 canonical JSON / Produces canonical JSON with sorted object keys. */
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

/** 创建不泄露 SQL 或异常文本的 RPC Problem / Creates an RPC Problem without exposing SQL or exception text. */
function rpcProblem(
  status: number,
  title: string,
  correlationId: string,
  rpc: string,
  detail?: string,
): ProblemDetails {
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
    type: `https://status.moesegfault.dev/problems/${slug}`,
    title,
    status,
    ...(detail === undefined ? {} : { detail }),
    instance: `/rpc/${rpc}`,
    correlation_id: correlationId,
  };
}

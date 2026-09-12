import {
  ComponentCatalogSchema,
  DeploymentActivationContextSchema,
  GetComponentCatalogRpcRequestSchema,
  GetDeploymentActivationContextRpcRequestSchema,
  GetServiceCatalogRpcRequestSchema,
  GetServiceRetentionPolicyAssignmentRpcRequestSchema,
  ServiceCatalogSchema,
  ServiceRetentionPolicyAssignmentSchema,
  type AdminPrincipal,
  type GetComponentCatalogRpcRequest,
  type GetComponentCatalogRpcResult,
  type GetDeploymentActivationContextRpcRequest,
  type GetDeploymentActivationContextRpcResult,
  type GetServiceCatalogRpcRequest,
  type GetServiceCatalogRpcResult,
  type GetServiceRetentionPolicyAssignmentRpcRequest,
  type GetServiceRetentionPolicyAssignmentRpcResult,
  type ProblemDetails,
} from "@moesegfault/contracts";
import { z } from "zod";

/** 管理读取所需的最小权威存储 / Minimal authoritative storage for administrative reads. */
export interface AdminReadEnvironment {
  /** status 权威 D1 / Authoritative status D1 database. */
  readonly DB: D1Database;
}

type RpcResult<T> = { readonly data: T } | { readonly problem: ProblemDetails };

/** 获取服务与其完整依赖集合 / Get a service and its complete dependency set. */
export async function getServiceCatalog(
  env: AdminReadEnvironment,
  raw: GetServiceCatalogRpcRequest,
): Promise<GetServiceCatalogRpcResult> {
  return read(
    GetServiceCatalogRpcRequestSchema,
    raw,
    "getServiceCatalog",
    async (request) => {
      const row = await env.DB.prepare(
        `SELECT s.*,
          COALESCE((SELECT json_group_array(json_object(
            'target_service',ordered.target_service,'capability',ordered.capability,
            'kind',ordered.kind,'criticality',ordered.criticality))
            FROM (SELECT target_service,capability,kind,criticality
                    FROM service_dependencies WHERE source_service=s.service_name
                   ORDER BY target_service,capability) AS ordered),json('[]')) AS dependencies_json
         FROM services AS s WHERE s.service_name=?`,
      )
        .bind(request.service_name)
        .first<Record<string, unknown>>();
      if (row === null) return null;
      return ServiceCatalogSchema.parse({
        service_name: row.service_name,
        display_name: row.display_name,
        description: row.description,
        owner: row.owner,
        criticality: row.criticality,
        enabled: Boolean(row.enabled),
        dependencies: JSON.parse(String(row.dependencies_json)) as unknown,
        created_at: row.created_at,
        updated_at: row.updated_at,
        revision: row.revision,
      });
    },
  );
}

/** 获取 Component 与完整 supporting service 集合 / Get a component and its complete supporting-service set. */
export async function getComponentCatalog(
  env: AdminReadEnvironment,
  raw: GetComponentCatalogRpcRequest,
): Promise<GetComponentCatalogRpcResult> {
  return read(
    GetComponentCatalogRpcRequestSchema,
    raw,
    "getComponentCatalog",
    async (request) => {
      const row = await env.DB.prepare(
        `SELECT c.*,
          COALESCE((SELECT json_group_array(ordered.service_name)
            FROM (SELECT service_name FROM component_services
                   WHERE component_id=c.component_id AND role='supporting'
                   ORDER BY service_name) AS ordered),json('[]')) AS supporting_json
         FROM components AS c WHERE c.component_id=?`,
      )
        .bind(request.component_id)
        .first<Record<string, unknown>>();
      if (row === null) return null;
      return ComponentCatalogSchema.parse({
        component_id: row.component_id,
        owner_service: row.service_name,
        display_name: row.display_name,
        description: row.description,
        public: Boolean(row.public),
        sort_order: row.sort_order,
        enabled: Boolean(row.enabled),
        supporting_services: JSON.parse(String(row.supporting_json)) as unknown,
        created_at: row.created_at,
        updated_at: row.updated_at,
        revision: row.revision,
      });
    },
  );
}

/** 获取服务当前保留策略绑定；未绑定明确返回 404 / Get the current service retention assignment; absence is explicitly 404. */
export async function getServiceRetentionPolicyAssignment(
  env: AdminReadEnvironment,
  raw: GetServiceRetentionPolicyAssignmentRpcRequest,
): Promise<GetServiceRetentionPolicyAssignmentRpcResult> {
  return read(
    GetServiceRetentionPolicyAssignmentRpcRequestSchema,
    raw,
    "getServiceRetentionPolicyAssignment",
    async (request) => {
      const row = await env.DB.prepare(
        `SELECT s.service_name,s.policy_id,s.policy_revision,s.revision AS assignment_revision,
                s.assigned_at,s.assigned_by,p.occurrence_retention_days,p.cleanup_batch_size,
                p.created_at AS policy_registered_at,p.created_by AS policy_registered_by
           FROM service_retention_policies AS s
           JOIN data_retention_policies AS p
             ON p.policy_id=s.policy_id AND p.revision=s.policy_revision
          WHERE s.service_name=?`,
      )
        .bind(request.service_name)
        .first<Record<string, unknown>>();
      if (row === null) return null;
      return ServiceRetentionPolicyAssignmentSchema.parse({
        service_name: row.service_name,
        policy: {
          policy_id: row.policy_id,
          revision: row.policy_revision,
          occurrence_retention_days: row.occurrence_retention_days,
          cleanup_batch_size: row.cleanup_batch_size,
        },
        assignment_revision: row.assignment_revision,
        assigned_at: row.assigned_at,
        assigned_by: row.assigned_by,
        policy_registered_at: row.policy_registered_at,
        policy_registered_by: row.policy_registered_by,
      });
    },
  );
}

/** 获取 deployment 状态及同 service/environment 当前指针 / Get deployment state and the current pointer for its service/environment. */
export async function getDeploymentActivationContext(
  env: AdminReadEnvironment,
  raw: GetDeploymentActivationContextRpcRequest,
): Promise<GetDeploymentActivationContextRpcResult> {
  return read(
    GetDeploymentActivationContextRpcRequestSchema,
    raw,
    "getDeploymentActivationContext",
    async (request) => {
      const row = await env.DB.prepare(
        `SELECT d.deployment_id,d.service_name,d.environment,s.state,
                s.revision AS deployment_revision,
                p.deployment_id AS pointer_deployment_id,p.revision AS pointer_revision
           FROM deployments AS d
           JOIN deployment_current_status AS s ON s.deployment_id=d.deployment_id
           LEFT JOIN service_environment_deployments AS p
             ON p.service_name=d.service_name AND p.environment=d.environment
          WHERE d.deployment_id=?`,
      )
        .bind(request.deployment_id)
        .first<Record<string, unknown>>();
      if (row === null) return null;
      return DeploymentActivationContextSchema.parse({
        deployment_id: row.deployment_id,
        service_name: row.service_name,
        environment: row.environment,
        state: row.state,
        deployment_revision: row.deployment_revision,
        current_pointer:
          row.pointer_deployment_id === null
            ? null
            : {
                deployment_id: row.pointer_deployment_id,
                revision: row.pointer_revision,
              },
      });
    },
  );
}

async function read<Request, Result>(
  schema: z.ZodType<Request>,
  raw: unknown,
  rpc: string,
  load: (request: Request) => Promise<Result | null>,
): Promise<RpcResult<Result>> {
  const parsed = schema.safeParse(raw);
  const correlationId = safeCorrelation(raw);
  if (!parsed.success)
    return {
      problem: rpcProblem(
        400,
        "Invalid RPC request",
        correlationId,
        rpc,
        parsed.error.issues.map((issue) => issue.message).join("; "),
      ),
    };
  const principal = (parsed.data as { principal: AdminPrincipal }).principal;
  if (
    !principal.roles.some(
      (role) => role === "viewer" || role === "operator" || role === "admin",
    )
  )
    return { problem: rpcProblem(403, "Forbidden", correlationId, rpc) };
  const data = await load(parsed.data);
  return data === null
    ? {
        problem: rpcProblem(
          404,
          "Administrative snapshot not found",
          correlationId,
          rpc,
        ),
      }
    : { data };
}

function safeCorrelation(raw: unknown): string {
  const candidate = (raw as { correlation_id?: unknown } | null)
    ?.correlation_id;
  return typeof candidate === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      candidate,
    )
    ? candidate
    : "018f0000-0000-7000-8000-000000000000";
}

function rpcProblem(
  status: 400 | 403 | 404,
  title: string,
  correlationId: string,
  rpc: string,
  detail?: string,
): ProblemDetails {
  return {
    type: `https://status.moesegfault.dev/problems/${status === 404 ? "not-found" : status === 403 ? "forbidden" : "invalid-request"}`,
    title,
    status,
    ...(detail === undefined ? {} : { detail: detail.slice(0, 4096) }),
    instance: `/rpc/${rpc}`,
    correlation_id: correlationId,
  };
}

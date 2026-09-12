import {
  ActivateDeploymentRpcRequestSchema,
  ActivateDeploymentRpcResultSchema,
  AcknowledgeIssueRpcRequestSchema,
  AcknowledgeIssueRpcResultSchema,
  AssignDiagnosticPolicyRpcRequestSchema,
  AssignDiagnosticPolicyRpcResultSchema,
  CheckHealthRpcRequestSchema,
  CheckHealthRpcResultSchema,
  CreateIncidentRpcRequestSchema,
  CreateIncidentRpcResultSchema,
  CreateComponentRpcRequestSchema,
  CreateComponentRpcResultSchema,
  CreateMaintenanceWindowRpcRequestSchema,
  CreateMaintenanceWindowRpcResultSchema,
  CreateMonitorRpcRequestSchema,
  CreateMonitorRpcResultSchema,
  GetIncidentRpcRequestSchema,
  GetIncidentRpcResultSchema,
  GetComponentCatalogRpcRequestSchema,
  GetComponentCatalogRpcResultSchema,
  GetDeploymentActivationContextRpcRequestSchema,
  GetDeploymentActivationContextRpcResultSchema,
  GetServiceCatalogRpcRequestSchema,
  GetServiceCatalogRpcResultSchema,
  GetServiceRetentionPolicyAssignmentRpcRequestSchema,
  GetServiceRetentionPolicyAssignmentRpcResultSchema,
  QueryDiagnosticContextRpcRequestSchema,
  QueryDiagnosticContextRpcResultSchema,
  QueryTelemetryReferenceRpcRequestSchema,
  QueryTelemetryReferenceRpcResultSchema,
  RegisterBackendRpcRequestSchema,
  RegisterBackendRpcResultSchema,
  RegisterAndAssignRetentionPolicyRpcRequestSchema,
  RegisterAndAssignRetentionPolicyRpcResultSchema,
  RegisterEvaluationPolicyRpcRequestSchema,
  RegisterEvaluationPolicyRpcResultSchema,
  RegisterServiceRpcRequestSchema,
  RegisterServiceRpcResultSchema,
  SearchIssuesRpcRequestSchema,
  SearchIssuesRpcResultSchema,
  SetStatusOverrideRpcRequestSchema,
  SetStatusOverrideRpcResultSchema,
  SuppressIssueRpcRequestSchema,
  SuppressIssueRpcResultSchema,
  UpdateIncidentRpcRequestSchema,
  UpdateIncidentRpcResultSchema,
  UpdateComponentCatalogRpcRequestSchema,
  UpdateComponentCatalogRpcResultSchema,
  UpdateServiceCatalogRpcRequestSchema,
  UpdateServiceCatalogRpcResultSchema,
  UpdateMaintenanceWindowRpcRequestSchema,
  UpdateMaintenanceWindowRpcResultSchema,
  UpdateMonitorRpcRequestSchema,
  UpdateMonitorRpcResultSchema,
  type AcknowledgeIssueRpcRequest,
  type AcknowledgeIssueRpcResult,
  type ActivateDeploymentRpcRequest,
  type ActivateDeploymentRpcResult,
  type AdminPrincipal,
  type AssignDiagnosticPolicyRpcRequest,
  type AssignDiagnosticPolicyRpcResult,
  type CheckHealthRpcRequest,
  type CheckHealthRpcResult,
  type CreateIncidentRpcRequest,
  type CreateIncidentRpcResult,
  type CreateComponentRpcRequest,
  type CreateComponentRpcResult,
  type CreateMaintenanceWindowRpcRequest,
  type CreateMaintenanceWindowRpcResult,
  type CreateMonitorRpcRequest,
  type CreateMonitorRpcResult,
  type GetIncidentRpcRequest,
  type GetIncidentRpcResult,
  type GetComponentCatalogRpcRequest,
  type GetComponentCatalogRpcResult,
  type GetDeploymentActivationContextRpcRequest,
  type GetDeploymentActivationContextRpcResult,
  type GetServiceCatalogRpcRequest,
  type GetServiceCatalogRpcResult,
  type GetServiceRetentionPolicyAssignmentRpcRequest,
  type GetServiceRetentionPolicyAssignmentRpcResult,
  type QueryDiagnosticContextRpcRequest,
  type QueryDiagnosticContextRpcResult,
  type QueryTelemetryReferenceRpcRequest,
  type QueryTelemetryReferenceRpcResult,
  type RegisterBackendRpcRequest,
  type RegisterBackendRpcResult,
  type RegisterAndAssignRetentionPolicyRpcRequest,
  type RegisterAndAssignRetentionPolicyRpcResult,
  type RegisterEvaluationPolicyRpcRequest,
  type RegisterEvaluationPolicyRpcResult,
  type RegisterServiceRpcRequest,
  type RegisterServiceRpcResult,
  type SearchIssuesRpcRequest,
  type SearchIssuesRpcResult,
  type SetStatusOverrideRpcRequest,
  type SetStatusOverrideRpcResult,
  type SuppressIssueRpcRequest,
  type SuppressIssueRpcResult,
  type UpdateIncidentRpcRequest,
  type UpdateIncidentRpcResult,
  type UpdateComponentCatalogRpcRequest,
  type UpdateComponentCatalogRpcResult,
  type UpdateServiceCatalogRpcRequest,
  type UpdateServiceCatalogRpcResult,
  type UpdateMaintenanceWindowRpcRequest,
  type UpdateMaintenanceWindowRpcResult,
  type UpdateMonitorRpcRequest,
  type UpdateMonitorRpcResult,
} from "@moesegfault/contracts";
import type { TraceContext } from "@moesegfault/telemetry";
import { hasRequiredRole, type AdminRole } from "./access.js";
import {
  HttpProblem,
  enforceMutationGuards,
  jsonResponse,
  problem,
  problemResponse,
  readBoundedJson,
  requireExpectedRevision,
} from "./http.js";

/** status Worker 的最小私有能力面 / Minimal private capability surface of the status Worker. */
export interface AdminRpcClient {
  checkHealth(request: CheckHealthRpcRequest): Promise<CheckHealthRpcResult>;
  getIncident(request: GetIncidentRpcRequest): Promise<GetIncidentRpcResult>;
  getServiceCatalog(
    request: GetServiceCatalogRpcRequest,
  ): Promise<GetServiceCatalogRpcResult>;
  getComponentCatalog(
    request: GetComponentCatalogRpcRequest,
  ): Promise<GetComponentCatalogRpcResult>;
  getServiceRetentionPolicyAssignment(
    request: GetServiceRetentionPolicyAssignmentRpcRequest,
  ): Promise<GetServiceRetentionPolicyAssignmentRpcResult>;
  getDeploymentActivationContext(
    request: GetDeploymentActivationContextRpcRequest,
  ): Promise<GetDeploymentActivationContextRpcResult>;
  searchIssues(request: SearchIssuesRpcRequest): Promise<SearchIssuesRpcResult>;
  createIncident(
    request: CreateIncidentRpcRequest,
  ): Promise<CreateIncidentRpcResult>;
  updateIncident(
    request: UpdateIncidentRpcRequest,
  ): Promise<UpdateIncidentRpcResult>;
  acknowledgeIssue(
    request: AcknowledgeIssueRpcRequest,
  ): Promise<AcknowledgeIssueRpcResult>;
  suppressIssue(
    request: SuppressIssueRpcRequest,
  ): Promise<SuppressIssueRpcResult>;
  createMaintenanceWindow(
    request: CreateMaintenanceWindowRpcRequest,
  ): Promise<CreateMaintenanceWindowRpcResult>;
  updateMaintenanceWindow(
    request: UpdateMaintenanceWindowRpcRequest,
  ): Promise<UpdateMaintenanceWindowRpcResult>;
  queryDiagnosticContext(
    request: QueryDiagnosticContextRpcRequest,
  ): Promise<QueryDiagnosticContextRpcResult>;
  queryTelemetryReference(
    request: QueryTelemetryReferenceRpcRequest,
  ): Promise<QueryTelemetryReferenceRpcResult>;
  registerService(
    request: RegisterServiceRpcRequest,
  ): Promise<RegisterServiceRpcResult>;
  updateServiceCatalog(
    request: UpdateServiceCatalogRpcRequest,
  ): Promise<UpdateServiceCatalogRpcResult>;
  createComponent(
    request: CreateComponentRpcRequest,
  ): Promise<CreateComponentRpcResult>;
  updateComponentCatalog(
    request: UpdateComponentCatalogRpcRequest,
  ): Promise<UpdateComponentCatalogRpcResult>;
  registerAndAssignRetentionPolicy(
    request: RegisterAndAssignRetentionPolicyRpcRequest,
  ): Promise<RegisterAndAssignRetentionPolicyRpcResult>;
  activateDeployment(
    request: ActivateDeploymentRpcRequest,
  ): Promise<ActivateDeploymentRpcResult>;
  createMonitor(
    request: CreateMonitorRpcRequest,
  ): Promise<CreateMonitorRpcResult>;
  updateMonitor(
    request: UpdateMonitorRpcRequest,
  ): Promise<UpdateMonitorRpcResult>;
  registerEvaluationPolicy(
    request: RegisterEvaluationPolicyRpcRequest,
  ): Promise<RegisterEvaluationPolicyRpcResult>;
  assignDiagnosticPolicy(
    request: AssignDiagnosticPolicyRpcRequest,
  ): Promise<AssignDiagnosticPolicyRpcResult>;
  registerBackend(
    request: RegisterBackendRpcRequest,
  ): Promise<RegisterBackendRpcResult>;
  setStatusOverride(
    request: SetStatusOverrideRpcRequest,
  ): Promise<SetStatusOverrideRpcResult>;
}

/** 路由所需且不可由浏览器覆盖的上下文 / Routing context that the browser cannot override. */
export interface GatewayRequestContext {
  readonly principal: AdminPrincipal;
  readonly correlationId: string;
  readonly allowedOrigin: string;
  readonly trace: TraceContext;
}

type RpcUnion =
  | { readonly data: unknown }
  | {
      readonly problem: {
        readonly type: string;
        readonly title: string;
        readonly status: number;
        readonly correlation_id: string;
        readonly detail?: string | undefined;
      };
    };
type RpcSchema<T extends RpcUnion> = { parse(value: unknown): T };

/**
 * 将固定 HTTP allowlist 映射到固定的具名 RPC；不存在动态方法选择。
 * Maps a fixed HTTP allowlist to fixed named RPC calls; no dynamic method selection exists.
 */
export async function routeApiRequest(
  request: Request,
  status: AdminRpcClient,
  context: GatewayRequestContext,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.search !== "")
    throw new HttpProblem(
      problem("unexpected-query", "Query parameters are not accepted", 400),
    );

  const base = {
    principal: context.principal,
    correlation_id: context.correlationId,
    trace_context: {
      traceparent: context.trace.traceparent,
      ...(context.trace.tracestate === undefined
        ? {}
        : { tracestate: context.trace.tracestate }),
    },
  };
  if (request.method === "GET" && url.pathname === "/api/session") {
    requireRole(context.principal, "viewer");
    return jsonResponse(
      { data: context.principal },
      200,
      context.correlationId,
    );
  }
  if (request.method === "GET" && url.pathname === "/api/health") {
    requireRole(context.principal, "viewer");
    const input = CheckHealthRpcRequestSchema.parse(base);
    return rpcResponse(
      CheckHealthRpcResultSchema,
      await status.checkHealth(input),
      200,
      url.pathname,
      context.correlationId,
    );
  }

  const incidentId = matchId(url.pathname, /^\/api\/incidents\/([^/]+)$/);
  if (request.method === "GET" && incidentId !== undefined) {
    requireRole(context.principal, "viewer");
    const input = GetIncidentRpcRequestSchema.parse({
      ...base,
      incident_id: incidentId,
    });
    return rpcResponse(
      GetIncidentRpcResultSchema,
      await status.getIncident(input),
      200,
      url.pathname,
      context.correlationId,
    );
  }

  const telemetryReferenceId = matchId(
    url.pathname,
    /^\/api\/evidence\/([^/]+)$/,
  );
  if (request.method === "GET" && telemetryReferenceId !== undefined) {
    requireRole(context.principal, "viewer");
    const input = QueryTelemetryReferenceRpcRequestSchema.parse({
      ...base,
      telemetry_reference_id: telemetryReferenceId,
    });
    return rpcResponse(
      QueryTelemetryReferenceRpcResultSchema,
      await status.queryTelemetryReference(input),
      200,
      url.pathname,
      context.correlationId,
    );
  }

  const readCatalogServiceName = matchId(
    url.pathname,
    /^\/api\/catalog\/services\/([^/]+)$/,
  );
  if (request.method === "GET" && readCatalogServiceName !== undefined) {
    requireRole(context.principal, "viewer");
    const input = GetServiceCatalogRpcRequestSchema.parse({
      ...base,
      service_name: readCatalogServiceName,
    });
    return rpcResponse(
      GetServiceCatalogRpcResultSchema,
      await status.getServiceCatalog(input),
      200,
      url.pathname,
      context.correlationId,
    );
  }

  const readCatalogComponentId = matchId(
    url.pathname,
    /^\/api\/catalog\/components\/([^/]+)$/,
  );
  if (request.method === "GET" && readCatalogComponentId !== undefined) {
    requireRole(context.principal, "viewer");
    const input = GetComponentCatalogRpcRequestSchema.parse({
      ...base,
      component_id: readCatalogComponentId,
    });
    return rpcResponse(
      GetComponentCatalogRpcResultSchema,
      await status.getComponentCatalog(input),
      200,
      url.pathname,
      context.correlationId,
    );
  }

  const retentionServiceName = matchId(
    url.pathname,
    /^\/api\/retention-policy-assignments\/([^/]+)$/,
  );
  if (request.method === "GET" && retentionServiceName !== undefined) {
    requireRole(context.principal, "viewer");
    const input = GetServiceRetentionPolicyAssignmentRpcRequestSchema.parse({
      ...base,
      service_name: retentionServiceName,
    });
    return rpcResponse(
      GetServiceRetentionPolicyAssignmentRpcResultSchema,
      await status.getServiceRetentionPolicyAssignment(input),
      200,
      url.pathname,
      context.correlationId,
    );
  }

  const activationDeploymentId = matchId(
    url.pathname,
    /^\/api\/deployments\/([^/]+)\/activation-context$/,
  );
  if (request.method === "GET" && activationDeploymentId !== undefined) {
    requireRole(context.principal, "viewer");
    const input = GetDeploymentActivationContextRpcRequestSchema.parse({
      ...base,
      deployment_id: activationDeploymentId,
    });
    return rpcResponse(
      GetDeploymentActivationContextRpcResultSchema,
      await status.getDeploymentActivationContext(input),
      200,
      url.pathname,
      context.correlationId,
    );
  }

  if (request.method === "GET") {
    throw new HttpProblem(
      problem("route-not-found", "Administrative API route not found", 404),
    );
  }
  if (request.method === "OPTIONS") {
    throw new HttpProblem(
      problem("method-not-allowed", "CORS preflight is not supported", 405),
    );
  }
  if (request.method !== "POST" && request.method !== "PATCH") {
    throw new HttpProblem(
      problem("method-not-allowed", "HTTP method is not allowed", 405),
    );
  }
  const requiredRole = mutationRequiredRole(request.method, url.pathname);
  if (requiredRole === undefined) {
    throw new HttpProblem(
      problem("route-not-found", "Administrative API route not found", 404),
    );
  }
  requireRole(context.principal, requiredRole);
  enforceMutationGuards(request, context.allowedOrigin);
  const body = await readBoundedJson(request);

  if (request.method === "POST" && url.pathname === "/api/issues/search") {
    const input = SearchIssuesRpcRequestSchema.parse({ ...base, query: body });
    return rpcResponse(
      SearchIssuesRpcResultSchema,
      await status.searchIssues(input),
      200,
      url.pathname,
      context.correlationId,
    );
  }
  if (request.method === "POST" && url.pathname === "/api/incidents") {
    const input = CreateIncidentRpcRequestSchema.parse({
      ...base,
      command: body,
    });
    return rpcResponse(
      CreateIncidentRpcResultSchema,
      await status.createIncident(input),
      201,
      url.pathname,
      context.correlationId,
    );
  }
  if (request.method === "PATCH" && incidentId !== undefined) {
    const input = UpdateIncidentRpcRequestSchema.parse({
      ...base,
      incident_id: incidentId,
      expected_revision: requireExpectedRevision(request),
      command: body,
    });
    return rpcResponse(
      UpdateIncidentRpcResultSchema,
      await status.updateIncident(input),
      200,
      url.pathname,
      context.correlationId,
    );
  }

  const acknowledgedIssueId = matchId(
    url.pathname,
    /^\/api\/issues\/([^/]+)\/acknowledge$/,
  );
  if (request.method === "POST" && acknowledgedIssueId !== undefined) {
    const input = AcknowledgeIssueRpcRequestSchema.parse({
      ...commandFields(body),
      ...base,
      issue_id: acknowledgedIssueId,
      expected_revision: requireExpectedRevision(request),
    });
    return rpcResponse(
      AcknowledgeIssueRpcResultSchema,
      await status.acknowledgeIssue(input),
      200,
      url.pathname,
      context.correlationId,
    );
  }

  const suppressedIssueId = matchId(
    url.pathname,
    /^\/api\/issues\/([^/]+)\/suppress$/,
  );
  if (request.method === "POST" && suppressedIssueId !== undefined) {
    const input = SuppressIssueRpcRequestSchema.parse({
      ...commandFields(body),
      ...base,
      issue_id: suppressedIssueId,
      expected_revision: requireExpectedRevision(request),
    });
    return rpcResponse(
      SuppressIssueRpcResultSchema,
      await status.suppressIssue(input),
      200,
      url.pathname,
      context.correlationId,
    );
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/maintenance-windows"
  ) {
    const input = CreateMaintenanceWindowRpcRequestSchema.parse({
      ...base,
      command: body,
    });
    return rpcResponse(
      CreateMaintenanceWindowRpcResultSchema,
      await status.createMaintenanceWindow(input),
      201,
      url.pathname,
      context.correlationId,
    );
  }
  const maintenanceId = matchId(
    url.pathname,
    /^\/api\/maintenance-windows\/([^/]+)$/,
  );
  if (request.method === "PATCH" && maintenanceId !== undefined) {
    const input = UpdateMaintenanceWindowRpcRequestSchema.parse({
      ...base,
      id: maintenanceId,
      expected_revision: requireExpectedRevision(request),
      command: body,
    });
    return rpcResponse(
      UpdateMaintenanceWindowRpcResultSchema,
      await status.updateMaintenanceWindow(input),
      200,
      url.pathname,
      context.correlationId,
    );
  }
  if (
    request.method === "POST" &&
    url.pathname === "/api/diagnostic-context/query"
  ) {
    const input = QueryDiagnosticContextRpcRequestSchema.parse({
      ...base,
      locator: body,
    });
    return rpcResponse(
      QueryDiagnosticContextRpcResultSchema,
      await status.queryDiagnosticContext(input),
      200,
      url.pathname,
      context.correlationId,
    );
  }
  if (request.method === "POST" && url.pathname === "/api/services") {
    const input = RegisterServiceRpcRequestSchema.parse({
      ...base,
      command: body,
    });
    return rpcResponse(
      RegisterServiceRpcResultSchema,
      await status.registerService(input),
      201,
      url.pathname,
      context.correlationId,
    );
  }
  const catalogServiceName = matchId(
    url.pathname,
    /^\/api\/services\/([^/]+)$/,
  );
  if (request.method === "PATCH" && catalogServiceName !== undefined) {
    const input = UpdateServiceCatalogRpcRequestSchema.parse({
      ...base,
      service_name: catalogServiceName,
      expected_revision: requireExpectedRevision(request),
      command: body,
    });
    return rpcResponse(
      UpdateServiceCatalogRpcResultSchema,
      await status.updateServiceCatalog(input),
      200,
      url.pathname,
      context.correlationId,
    );
  }
  if (request.method === "POST" && url.pathname === "/api/components") {
    const input = CreateComponentRpcRequestSchema.parse({
      ...base,
      command: body,
    });
    return rpcResponse(
      CreateComponentRpcResultSchema,
      await status.createComponent(input),
      201,
      url.pathname,
      context.correlationId,
    );
  }
  const catalogComponentId = matchId(
    url.pathname,
    /^\/api\/components\/([^/]+)$/,
  );
  if (request.method === "PATCH" && catalogComponentId !== undefined) {
    const input = UpdateComponentCatalogRpcRequestSchema.parse({
      ...base,
      component_id: catalogComponentId,
      expected_revision: requireExpectedRevision(request),
      command: body,
    });
    return rpcResponse(
      UpdateComponentCatalogRpcResultSchema,
      await status.updateComponentCatalog(input),
      200,
      url.pathname,
      context.correlationId,
    );
  }
  if (
    request.method === "POST" &&
    url.pathname === "/api/retention-policy-assignments"
  ) {
    const input = RegisterAndAssignRetentionPolicyRpcRequestSchema.parse({
      ...base,
      command: body,
    });
    return rpcResponse(
      RegisterAndAssignRetentionPolicyRpcResultSchema,
      await status.registerAndAssignRetentionPolicy(input),
      200,
      url.pathname,
      context.correlationId,
    );
  }
  const activatedDeploymentId = matchId(
    url.pathname,
    /^\/api\/deployments\/([^/]+)\/activate$/,
  );
  if (request.method === "POST" && activatedDeploymentId !== undefined) {
    const input = ActivateDeploymentRpcRequestSchema.parse({
      ...base,
      deployment_id: activatedDeploymentId,
      command: body,
    });
    return rpcResponse(
      ActivateDeploymentRpcResultSchema,
      await status.activateDeployment(input),
      200,
      url.pathname,
      context.correlationId,
    );
  }
  if (request.method === "POST" && url.pathname === "/api/monitors") {
    const input = CreateMonitorRpcRequestSchema.parse({
      ...base,
      command: body,
    });
    return rpcResponse(
      CreateMonitorRpcResultSchema,
      await status.createMonitor(input),
      201,
      url.pathname,
      context.correlationId,
    );
  }
  const monitorId = matchId(url.pathname, /^\/api\/monitors\/([^/]+)$/);
  if (request.method === "PATCH" && monitorId !== undefined) {
    const input = UpdateMonitorRpcRequestSchema.parse({
      ...base,
      monitor_id: monitorId,
      expected_revision: requireExpectedRevision(request),
      command: body,
    });
    return rpcResponse(
      UpdateMonitorRpcResultSchema,
      await status.updateMonitor(input),
      200,
      url.pathname,
      context.correlationId,
    );
  }
  if (
    request.method === "POST" &&
    url.pathname === "/api/evaluation-policies"
  ) {
    const input = RegisterEvaluationPolicyRpcRequestSchema.parse({
      ...base,
      command: body,
    });
    return rpcResponse(
      RegisterEvaluationPolicyRpcResultSchema,
      await status.registerEvaluationPolicy(input),
      201,
      url.pathname,
      context.correlationId,
    );
  }
  if (
    request.method === "POST" &&
    url.pathname === "/api/diagnostic-policy-assignments"
  ) {
    const input = AssignDiagnosticPolicyRpcRequestSchema.parse({
      ...base,
      command: body,
    });
    return rpcResponse(
      AssignDiagnosticPolicyRpcResultSchema,
      await status.assignDiagnosticPolicy(input),
      201,
      url.pathname,
      context.correlationId,
    );
  }
  if (request.method === "POST" && url.pathname === "/api/telemetry-backends") {
    const input = RegisterBackendRpcRequestSchema.parse({
      ...base,
      command: body,
    });
    return rpcResponse(
      RegisterBackendRpcResultSchema,
      await status.registerBackend(input),
      201,
      url.pathname,
      context.correlationId,
    );
  }
  if (request.method === "POST" && url.pathname === "/api/status-overrides") {
    const input = SetStatusOverrideRpcRequestSchema.parse({
      ...base,
      command: body,
    });
    return rpcResponse(
      SetStatusOverrideRpcResultSchema,
      await status.setStatusOverride(input),
      201,
      url.pathname,
      context.correlationId,
    );
  }

  throw new HttpProblem(
    problem("route-not-found", "Administrative API route not found", 404),
  );
}

/** 对 RPC 结果二次校验并把 Problem 安全投影到 HTTP / Revalidates RPC results and safely projects Problems onto HTTP. */
function rpcResponse<T extends RpcUnion>(
  schema: RpcSchema<T>,
  raw: unknown,
  successStatus: number,
  instance: string,
  correlationId: string,
): Response {
  let result: T;
  try {
    result = schema.parse(raw);
  } catch {
    throw new HttpProblem(
      problem(
        "invalid-rpc-response",
        "Status management service returned an invalid response",
        502,
      ),
    );
  }
  if ("problem" in result) {
    const downstream = result.problem;
    if (downstream.correlation_id !== correlationId) {
      throw new HttpProblem(
        problem(
          "invalid-rpc-response",
          "Status management service returned a mismatched correlation identity",
          502,
        ),
      );
    }
    return problemResponse(
      downstream.detail === undefined
        ? {
            type: downstream.type,
            title: downstream.title,
            status: downstream.status,
          }
        : {
            type: downstream.type,
            title: downstream.title,
            status: downstream.status,
            detail: downstream.detail,
          },
      instance,
      correlationId,
    );
  }

  const response = jsonResponse(result, successStatus, correlationId);
  const revision = revisionOf(result.data);
  if (revision !== undefined) response.headers.set("etag", `"${revision}"`);
  return response;
}

/** 解码单个不透明 path segment；非法编码直接拒绝 / Decodes one opaque path segment and rejects malformed encoding. */
function matchId(pathname: string, pattern: RegExp): string | undefined {
  const encoded = pattern.exec(pathname)?.[1];
  if (encoded === undefined) return undefined;
  try {
    return decodeURIComponent(encoded);
  } catch {
    throw new HttpProblem(
      problem("invalid-path", "Path contains invalid encoding", 400),
    );
  }
}

/** 拒绝数组与标量后再合并小型命令字段 / Rejects arrays and scalars before merging small command fields. */
function commandFields(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpProblem(
      problem("invalid-command", "Command must be a JSON object", 400),
    );
  }
  return value as Record<string, unknown>;
}

/** 从领域快照中安全提取 revision 供强 ETag 使用 / Safely extracts a revision for a strong ETag from a domain snapshot. */
function revisionOf(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null || !("revision" in value))
    return undefined;
  const revision = (value as { readonly revision?: unknown }).revision;
  return typeof revision === "number" && Number.isSafeInteger(revision)
    ? revision
    : undefined;
}

/** 在 Gateway 先做粗粒度授权；status 必须再次执行领域授权 / Performs coarse gateway authorization; status must reauthorize in its domain layer. */
function requireRole(principal: AdminPrincipal, required: AdminRole): void {
  if (!hasRequiredRole(principal.roles, required)) {
    throw new HttpProblem(
      problem("insufficient-role", "Administrative role is insufficient", 403),
    );
  }
}

/** 固定路由到最低角色的映射；未知路径不读取正文 / Fixed route-to-minimum-role map; unknown paths are rejected before body reads. */
function mutationRequiredRole(
  method: "POST" | "PATCH",
  pathname: string,
): AdminRole | undefined {
  if (
    method === "POST" &&
    (pathname === "/api/issues/search" ||
      pathname === "/api/diagnostic-context/query")
  ) {
    return "viewer";
  }
  if (
    (method === "POST" &&
      (pathname === "/api/incidents" ||
        pathname === "/api/maintenance-windows" ||
        pathname === "/api/status-overrides")) ||
    (method === "PATCH" &&
      (/^\/api\/incidents\/[^/]+$/.test(pathname) ||
        /^\/api\/maintenance-windows\/[^/]+$/.test(pathname))) ||
    (method === "POST" &&
      /^\/api\/issues\/[^/]+\/(?:acknowledge|suppress)$/.test(pathname))
  ) {
    return "operator";
  }
  if (
    (method === "POST" &&
      [
        "/api/services",
        "/api/components",
        "/api/monitors",
        "/api/evaluation-policies",
        "/api/diagnostic-policy-assignments",
        "/api/retention-policy-assignments",
        "/api/telemetry-backends",
      ].includes(pathname)) ||
    (method === "POST" &&
      /^\/api\/deployments\/[^/]+\/activate$/.test(pathname)) ||
    (method === "PATCH" &&
      (/^\/api\/monitors\/[^/]+$/.test(pathname) ||
        /^\/api\/services\/[^/]+$/.test(pathname) ||
        /^\/api\/components\/[^/]+$/.test(pathname)))
  ) {
    return "admin";
  }
  return undefined;
}

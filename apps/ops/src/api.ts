import {
  GetServiceCatalogRpcResultSchema,
  GetComponentCatalogRpcResultSchema,
  GetServiceRetentionPolicyAssignmentRpcResultSchema,
  GetDeploymentActivationContextRpcResultSchema,
  QueryTelemetryReferenceRpcResultSchema,
  ActivateDeploymentRpcResultSchema,
  RegisterAndAssignRetentionPolicyRpcResultSchema,
  CreateComponentRpcResultSchema,
  UpdateComponentCatalogRpcResultSchema,
  UpdateServiceCatalogRpcResultSchema,
  AdminPrincipalSchema,
  AcknowledgeIssueRpcResultSchema,
  AssignDiagnosticPolicyRpcResultSchema,
  CheckHealthResultSchema,
  CreateIncidentRpcResultSchema,
  CreateMaintenanceWindowRpcResultSchema,
  CreateMonitorRpcResultSchema,
  GetIncidentRpcResultSchema,
  PlatformStatusResponseSchema,
  ProblemDetailsSchema,
  PublicIncidentListResponseSchema,
  PublicServiceListResponseSchema,
  QueryDiagnosticContextRpcResultSchema,
  RegisterBackendRpcResultSchema,
  RegisterEvaluationPolicyRpcResultSchema,
  RegisterServiceRpcResultSchema,
  SearchIssuesRpcResultSchema,
  SetStatusOverrideRpcResultSchema,
  SuppressIssueRpcResultSchema,
  UpdateIncidentRpcResultSchema,
  UpdateMaintenanceWindowRpcResultSchema,
  UpdateMonitorRpcResultSchema,
  type AdminPrincipal,
  type CheckHealthResult,
  type PlatformStatusResponse,
  type PublicIncidentListResponse,
  type PublicServiceListResponse,
  type SearchIssuesRpcResult,
} from "@moesegfault/contracts";

/** 运行时解码器的最小接口 / Minimal interface for a runtime response decoder. */
interface Decoder<T> {
  parse(value: unknown): T;
}

/** 带 HTTP 状态和关联 ID 的 API 错误 / API error carrying HTTP status and correlation identity. */
export class ApiError extends Error {
  /** 创建一个可展示但不泄露响应正文的错误 / Create a display-safe error without leaking response bodies. */
  public constructor(
    message: string,
    public readonly status: number,
    public readonly correlationId: string | null,
  ) {
    super(message);
  }
}

const PUBLIC_ORIGIN = "https://status.moesegfault.dev";

/**
 * 获取 JSON 并用共享契约在浏览器中验证；无效响应按故障处理。
 * Fetch JSON and validate it in-browser with shared contracts; invalid responses fail closed.
 */
async function request<T>(
  url: string,
  decoder: Decoder<T>,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    signal: AbortSignal.timeout(15_000),
    ...init,
  });
  const correlationId = response.headers.get("x-moesegfault-correlation-id");
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new ApiError(
      "服务返回了无法解析的响应",
      response.status,
      correlationId,
    );
  }

  if (!response.ok) {
    const problem = ProblemDetailsSchema.safeParse(value);
    throw new ApiError(
      problem.success
        ? (problem.data.detail ?? problem.data.title)
        : `请求失败（HTTP ${response.status}）`,
      response.status,
      correlationId,
    );
  }
  try {
    const domainProblem = ProblemDetailsSchema.safeParse(
      typeof value === "object" && value !== null && "problem" in value
        ? value.problem
        : undefined,
    );
    if (domainProblem.success)
      throw new ApiError(
        domainProblem.data.detail ?? domainProblem.data.title,
        domainProblem.data.status,
        correlationId,
      );
    return decoder.parse(value);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      "服务响应不符合共享契约，已安全拒绝",
      response.status,
      correlationId,
    );
  }
}

/** 管理 RPC 的同源写请求头 / Same-origin headers required for management writes. */
const writeHeaders = {
  "content-type": "application/json",
  "x-moesegfault-csrf": "1",
} as const;

/** 认证写入允许空成功响应；错误永远不包含响应正文或秘密。 / Auth writes accept empty success and never expose response bodies or secrets. */
async function authenticate(
  action: "login" | "logout",
  body: unknown,
): Promise<void> {
  const response = await fetch(`/api/auth/${action}`, {
    method: "POST",
    credentials: "same-origin",
    headers: writeHeaders,
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw new ApiError("身份验证失败，请重试", response.status, null);
}

/** 可供 UI 调用的、严格解码后的 API / Strictly decoded API surface consumed by the UI. */
export const api = {
  login: (password: string) => authenticate("login", { password }),
  logout: () => authenticate("logout", {}),
  catalogSnapshot: (
    kind: "service" | "component" | "retention" | "activation",
    id: string,
  ) => {
    const encoded = encodeURIComponent(id);
    const routes = {
      service: [
        `/api/catalog/services/${encoded}`,
        GetServiceCatalogRpcResultSchema,
      ],
      component: [
        `/api/catalog/components/${encoded}`,
        GetComponentCatalogRpcResultSchema,
      ],
      retention: [
        `/api/retention-policy-assignments/${encoded}`,
        GetServiceRetentionPolicyAssignmentRpcResultSchema,
      ],
      activation: [
        `/api/deployments/${encoded}/activation-context`,
        GetDeploymentActivationContextRpcResultSchema,
      ],
    } as const;
    const [path, decoder] = routes[kind];
    return request<unknown>(path, decoder);
  },
  evidence: (id: string) =>
    request(
      `/api/evidence/${encodeURIComponent(id)}`,
      QueryTelemetryReferenceRpcResultSchema,
    ),
  session: (): Promise<{ data: AdminPrincipal }> =>
    request("/api/session", {
      parse: (value) => ({
        data: AdminPrincipalSchema.parse((value as { data?: unknown }).data),
      }),
    }),
  health: (): Promise<{ data: CheckHealthResult }> =>
    request("/api/health", {
      parse: (value) => ({
        data: CheckHealthResultSchema.parse((value as { data?: unknown }).data),
      }),
    }),
  platform: (): Promise<PlatformStatusResponse> =>
    request(`${PUBLIC_ORIGIN}/v1/status`, PlatformStatusResponseSchema),
  services: (): Promise<PublicServiceListResponse> =>
    request(`${PUBLIC_ORIGIN}/v1/services`, PublicServiceListResponseSchema),
  incidents: (): Promise<PublicIncidentListResponse> =>
    request(`${PUBLIC_ORIGIN}/v1/incidents`, PublicIncidentListResponseSchema),
  searchIssues: (
    query: Record<string, unknown>,
  ): Promise<SearchIssuesRpcResult> =>
    request("/api/issues/search", SearchIssuesRpcResultSchema, {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify(query),
    }),
  incident: (id: string): Promise<unknown> =>
    request(
      `/api/incidents/${encodeURIComponent(id)}`,
      GetIncidentRpcResultSchema,
    ),
  diagnosticContext: (incidentId: string): Promise<unknown> =>
    request(
      "/api/diagnostic-context/query",
      QueryDiagnosticContextRpcResultSchema,
      {
        method: "POST",
        headers: writeHeaders,
        body: JSON.stringify({ kind: "incident", incident_id: incidentId }),
      },
    ),
  write: (
    path: string,
    body: unknown,
    method: "POST" | "PATCH" = "POST",
    revision?: number,
  ): Promise<unknown> =>
    request(path, mutationDecoder(path), {
      method,
      headers:
        revision === undefined
          ? writeHeaders
          : { ...writeHeaders, "if-match": `"${revision}"` },
      body: JSON.stringify(body),
    }),
};

/** 为允许的变更路径选择严格响应 schema / Select a strict response schema for an allowlisted mutation path. */
function mutationDecoder(path: string): Decoder<unknown> {
  if (path === "/api/retention-policy-assignments")
    return RegisterAndAssignRetentionPolicyRpcResultSchema;
  if (/^\/api\/deployments\/[^/]+\/activate$/.test(path))
    return ActivateDeploymentRpcResultSchema;
  if (path === "/api/components") return CreateComponentRpcResultSchema;
  if (/^\/api\/components\/[^/]+$/.test(path))
    return UpdateComponentCatalogRpcResultSchema;
  if (/^\/api\/services\/[^/]+$/.test(path))
    return UpdateServiceCatalogRpcResultSchema;
  if (path === "/api/incidents") return CreateIncidentRpcResultSchema;
  if (path === "/api/maintenance-windows")
    return CreateMaintenanceWindowRpcResultSchema;
  if (/^\/api\/maintenance-windows\/[^/]+$/.test(path))
    return UpdateMaintenanceWindowRpcResultSchema;
  if (path === "/api/services") return RegisterServiceRpcResultSchema;
  if (path === "/api/evaluation-policies")
    return RegisterEvaluationPolicyRpcResultSchema;
  if (path === "/api/diagnostic-policy-assignments")
    return AssignDiagnosticPolicyRpcResultSchema;
  if (path === "/api/monitors") return CreateMonitorRpcResultSchema;
  if (/^\/api\/monitors\/[^/]+$/.test(path))
    return UpdateMonitorRpcResultSchema;
  if (path === "/api/telemetry-backends") return RegisterBackendRpcResultSchema;
  if (path === "/api/status-overrides") return SetStatusOverrideRpcResultSchema;
  if (/^\/api\/incidents\/[^/]+$/.test(path))
    return UpdateIncidentRpcResultSchema;
  if (/^\/api\/issues\/[^/]+\/acknowledge$/.test(path))
    return AcknowledgeIssueRpcResultSchema;
  if (/^\/api\/issues\/[^/]+\/suppress$/.test(path))
    return SuppressIssueRpcResultSchema;
  throw new ApiError("前端拒绝了未列入许可清单的变更路径", 0, null);
}

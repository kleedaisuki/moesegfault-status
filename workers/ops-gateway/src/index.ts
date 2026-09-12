import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  BoundaryContext,
  Telemetry,
  WorkersSpan,
} from "@moesegfault/telemetry";
import { parseAccessConfig, verifyAccessJwt } from "./access.js";
import {
  HttpProblem,
  parseConfiguredOrigin,
  problem,
  problemResponse,
} from "./http.js";
import { routeApiRequest, type AdminRpcClient } from "./router.js";
import { beginGatewayBoundary, createGatewayTelemetry } from "./telemetry.js";

/** Access assertion 的防御性长度上限 / Defensive length limit for an Access assertion. */
const MAX_ASSERTION_CHARS = 16 * 1024;

/**
 * Cloudflare Access 后的唯一管理 HTTP 入口。
 * The sole administrative HTTP entrypoint behind Cloudflare Access.
 *
 * @example
 * ```ts
 * // 浏览器 mutation 必须同源，并携带不可由的自定义 CSRF 头。
 * // Browser mutations must be same-origin and carry the non-simple CSRF header.
 * await fetch("/api/incidents", {
 *   method: "POST",
 *   headers: { "Content-Type": "application/json", "X-MoeSegFault-CSRF": "1" },
 *   body: JSON.stringify(command),
 * });
 * ```
 */
export default class GatewayEntrypoint extends WorkerEntrypoint<Env> {
  /** 验证 Access、建立可信主体，再调度到私有 status RPC / Verifies Access, builds a trusted principal, then dispatches to private status RPC. */
  async fetch(request: Request): Promise<Response> {
    const instance = safeInstance(request.url);
    let telemetry: Telemetry | undefined;
    try {
      telemetry = createGatewayTelemetry(this.env);
    } catch {
      const boundary = beginGatewayBoundary(request, undefined);
      return finishResponse(
        problemResponse(
          problem(
            "gateway-misconfigured",
            "Administrative gateway is unavailable",
            503,
          ),
          instance,
          boundary.correlationId,
        ),
        boundary,
      );
    }

    const boundary = beginGatewayBoundary(request, telemetry);
    const operation = async (
      span: WorkersSpan | undefined,
    ): Promise<Response> => {
      const response = await this.#handle(
        request,
        instance,
        telemetry,
        boundary,
      );
      span?.setAttribute("http.response.status_code", response.status);
      return response;
    };
    const response =
      telemetry === undefined
        ? await operation(undefined)
        : await telemetry.withSpan(
            this.ctx.tracing,
            "ops-gateway.request",
            { "http.request.method": request.method },
            operation,
          );
    emitCompletion(telemetry, boundary, request.method, response.status);
    return finishResponse(response, boundary);
  }

  /** 认证与严格路由实现；所有响应由外层注入执行上下文 / Authentication and strict routing; the outer boundary injects execution context into every response. */
  async #handle(
    request: Request,
    instance: string,
    telemetry: Telemetry | undefined,
    boundary: BoundaryContext,
  ): Promise<Response> {
    const correlationId = boundary.correlationId;

    let allowedOrigin: string;
    let accessConfig: ReturnType<typeof parseAccessConfig>;
    try {
      allowedOrigin = parseConfiguredOrigin(this.env.OPS_ORIGIN);
      accessConfig = parseAccessConfig({
        issuer: this.env.ACCESS_ISSUER,
        audience: this.env.ACCESS_AUDIENCE,
        maxTokenAgeSeconds: this.env.ACCESS_MAX_TOKEN_AGE_SECONDS,
        roleMapping: this.env.ACCESS_ROLE_MAPPING,
      });
    } catch {
      emitFailure(
        telemetry,
        boundary,
        "GatewayConfigurationError",
        request.method,
      );
      return problemResponse(
        problem(
          "gateway-misconfigured",
          "Administrative gateway is unavailable",
          503,
        ),
        instance,
        correlationId,
      );
    }

    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/") || url.origin !== allowedOrigin) {
      return problemResponse(
        problem("route-not-found", "Administrative API route not found", 404),
        instance,
        correlationId,
      );
    }

    const assertion = request.headers.get("cf-access-jwt-assertion");
    if (!isCompactAssertion(assertion)) {
      emitFailure(
        telemetry,
        boundary,
        "AccessAssertionMissingOrMalformed",
        request.method,
        "WARN",
      );
      return problemResponse(
        problem(
          "access-denied",
          "A valid Cloudflare Access session is required",
          401,
        ),
        instance,
        correlationId,
      );
    }

    let principal;
    try {
      principal = await verifyAccessJwt(assertion, accessConfig);
    } catch {
      emitFailure(
        telemetry,
        boundary,
        "AccessJwtRejected",
        request.method,
        "WARN",
      );
      return problemResponse(
        problem(
          "access-denied",
          "A valid Cloudflare Access session is required",
          401,
        ),
        instance,
        correlationId,
      );
    }

    try {
      const status = requireAdminRpcClient(this.env.STATUS);
      return await routeApiRequest(request, status, {
        principal,
        correlationId,
        allowedOrigin,
        trace: boundary.trace,
      });
    } catch (error) {
      if (error instanceof HttpProblem)
        return problemResponse(error.problem, instance, correlationId);
      if (isContractValidationError(error)) {
        return problemResponse(
          problem(
            "invalid-command",
            "Administrative command does not match its contract",
            400,
          ),
          instance,
          correlationId,
        );
      }
      emitFailure(telemetry, boundary, "StatusRpcUnavailable", request.method);
      return problemResponse(
        problem(
          "status-rpc-unavailable",
          "Status management service is unavailable",
          502,
        ),
        instance,
        correlationId,
      );
    }
  }
}

/** 验证生成的 Service Binding 确实暴露固定 RPC 面 / Verifies that the generated Service Binding exposes the fixed RPC surface. */
function requireAdminRpcClient(value: object): AdminRpcClient {
  const methods = [
    "checkHealth",
    "getIncident",
    "getServiceCatalog",
    "getComponentCatalog",
    "getServiceRetentionPolicyAssignment",
    "getDeploymentActivationContext",
    "searchIssues",
    "createIncident",
    "updateIncident",
    "acknowledgeIssue",
    "suppressIssue",
    "createMaintenanceWindow",
    "updateMaintenanceWindow",
    "queryDiagnosticContext",
    "queryTelemetryReference",
    "registerService",
    "updateServiceCatalog",
    "createComponent",
    "updateComponentCatalog",
    "registerAndAssignRetentionPolicy",
    "activateDeployment",
    "createMonitor",
    "updateMonitor",
    "registerEvaluationPolicy",
    "assignDiagnosticPolicy",
    "registerBackend",
    "setStatusOverride",
  ] as const;
  if (
    methods.every((method) => typeof Reflect.get(value, method) === "function")
  )
    return value as AdminRpcClient;
  throw new Error("STATUS Service Binding does not expose AdminRpc");
}

/** 只接受有界 JWT compact serialization / Accepts only a bounded JWT compact serialization. */
function isCompactAssertion(value: string | null): value is string {
  if (value === null || value.length < 32 || value.length > MAX_ASSERTION_CHARS)
    return false;
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}

/** 从不可信 URL 中仅提取 problem instance path / Extracts only the Problem instance path from an untrusted URL. */
function safeInstance(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return url.pathname.slice(0, 2_048);
  } catch {
    return "/";
  }
}

/** 识别 schema 错误但不把字段值写入响应 / Recognizes schema failures without reflecting field values. */
function isContractValidationError(error: unknown): boolean {
  return error instanceof Error && error.name === "ZodError";
}

/** 注入独立 W3C trace 与平台关联 ID / Injects the independent W3C trace and platform correlation ID. */
function finishResponse(
  response: Response,
  boundary: BoundaryContext,
): Response {
  boundary.inject(response.headers);
  return response;
}

/** 通过共享隐私策略输出失败日志 / Emits a failure log through the shared privacy policy. */
function emitFailure(
  telemetry: Telemetry | undefined,
  boundary: BoundaryContext,
  errorType: string,
  method: string,
  severity: "WARN" | "ERROR" = "ERROR",
): void {
  telemetry?.logger.emit(
    {
      eventName: "gateway.request.failed",
      severity,
      body: "Administrative gateway request failed",
      attributes: {
        "error.type": errorType,
        "http.request.method": method,
      },
    },
    { trace: boundary.trace, correlationId: boundary.correlationId },
  );
}

/** 记录有界请求结果；不包含 URL、主体或正文 / Records a bounded request outcome without URL, principal, or body. */
function emitCompletion(
  telemetry: Telemetry | undefined,
  boundary: BoundaryContext,
  method: string,
  status: number,
): void {
  telemetry?.logger.emit(
    {
      eventName: "gateway.request.completed",
      severity: status >= 500 ? "ERROR" : "INFO",
      body: "Administrative gateway request completed",
      attributes: {
        "http.request.method": method,
        "http.response.status_code": status,
      },
    },
    { trace: boundary.trace, correlationId: boundary.correlationId },
  );
}

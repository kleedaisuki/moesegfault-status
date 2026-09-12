import { z } from "zod";
import type {
  ProblemDetails,
  TelemetryReference,
} from "@moesegfault/contracts";
import { TelemetryReferenceSchema } from "@moesegfault/contracts";
import {
  QueryTelemetryReferenceRpcRequestSchema,
  TelemetryCapabilitySchema,
  TelemetryQueryAdapterSchema,
  type EvidenceQueryResult,
  type QueryTelemetryReferenceRpcRequest,
  type QueryTelemetryReferenceRpcResult,
} from "../../../../packages/contracts/src/backend-query.js";

import { executeAdapter } from "./adapters.js";
import { parseBackendConfigs, parseTelemetrySecrets } from "./config.js";
import type {
  EvidenceEnvironment,
  ResolvedEvidenceReference,
} from "./types.js";

type Role = "viewer" | "operator" | "admin";

interface EvidenceRow {
  readonly telemetry_reference_id: string;
  readonly kind: string;
  readonly backend_name: string;
  readonly locator_json: string;
  readonly range_start: string | null;
  readonly range_end: string | null;
  readonly service_name: string;
  readonly deployment_id: string;
  readonly correlation_id: string | null;
  readonly trace_id: string | null;
  readonly span_id: string | null;
  readonly expires_at: string | null;
  readonly capabilities_json: string;
  readonly query_adapter: string;
  readonly ui_url_template: string;
  readonly auth_reference: string;
  readonly enabled: number;
  readonly repository_url: string;
  readonly git_commit: string;
}

/** 可注入的时间与 HTTP 依赖，使安全边界可确定测试 / Injectable clock and HTTP dependencies for deterministic boundary tests. */
export interface EvidenceServiceOptions {
  /** 出站 HTTP 实现 / Outbound HTTP implementation. */
  readonly fetch?: typeof fetch;
  /** 当前时间提供器 / Current-time provider. */
  readonly now?: () => Date;
}

/** 创建仅能按已知 ID 查询的 evidence capability / Create an evidence capability that only queries by known reference ID. */
export function createEvidenceService(
  env: EvidenceEnvironment,
  options: EvidenceServiceOptions = {},
): (
  request: QueryTelemetryReferenceRpcRequest,
) => Promise<QueryTelemetryReferenceRpcResult> {
  return (request) => queryTelemetryReference(env, request, options);
}

/**
 * 查询数据库中已存在的 TelemetryReference；永不接受 URL 或临时查询表达式。
 * Query an existing database TelemetryReference; never accepts a URL or ad-hoc expression.
 *
 * @example
 * ```ts
 * const query = createEvidenceService(env);
 * const result = await query({ principal, correlation_id, telemetry_reference_id });
 * ```
 */
export async function queryTelemetryReference(
  env: EvidenceEnvironment,
  raw: unknown,
  options: EvidenceServiceOptions = {},
): Promise<QueryTelemetryReferenceRpcResult> {
  const authorization = authorize(raw);
  if ("problem" in authorization) return authorization;
  const request = authorization.request;
  const resolved = await resolveReference(
    env.DB,
    request.telemetry_reference_id,
    request.correlation_id,
  );
  if (resolved === null)
    return {
      problem: requestProblem(404, "Telemetry reference not found", request),
    };
  if ("problem" in resolved) return { problem: resolved.problem };

  const now = options.now?.() ?? new Date();
  if (
    resolved.reference.expires_at !== undefined &&
    Date.parse(resolved.reference.expires_at) <= now.getTime()
  ) {
    return {
      data: terminal(
        resolved,
        "expired",
        now,
        "Telemetry retention has expired",
      ),
    };
  }
  if (!resolved.enabled)
    return {
      data: terminal(
        resolved,
        "unavailable",
        now,
        "Telemetry backend is disabled",
      ),
    };
  if (!resolved.capabilities.includes(resolved.reference.kind))
    return {
      data: terminal(
        resolved,
        "unsupported",
        now,
        "Backend does not declare this capability",
      ),
    };
  const adapter = TelemetryQueryAdapterSchema.safeParse(resolved.adapterText);
  if (!adapter.success)
    return {
      data: terminal(
        resolved,
        "unsupported",
        now,
        "Backend query adapter is not supported",
      ),
    };
  if (!adapterMatches(adapter.data, resolved.reference.kind))
    return {
      data: terminal(
        resolved,
        "unsupported",
        now,
        "Adapter cannot query this evidence kind",
      ),
    };

  if (
    resolved.reference.kind === "artifact" &&
    !(await artifactExists(env.DB, resolved.reference))
  ) {
    return {
      data: terminal(
        resolved,
        "unavailable",
        now,
        "Artifact is not registered for this deployment",
      ),
    };
  }
  const configs = parseBackendConfigs(env.TELEMETRY_BACKEND_CONFIG_JSON);
  const config = configs[resolved.reference.backend];
  if (config === undefined)
    return {
      data: terminal(
        resolved,
        "unavailable",
        now,
        "Backend runtime configuration is unavailable",
      ),
    };
  const secrets = parseTelemetrySecrets(env.TELEMETRY_AUTH_JSON);
  let result;
  try {
    result = await executeAdapter({
      resolved,
      adapter: adapter.data,
      config,
      credential: secrets[resolved.authReference],
      fetch: options.fetch ?? fetch,
      now,
    });
  } catch {
    return {
      data: terminal(
        resolved,
        "unavailable",
        now,
        "Evidence adapter rejected unsafe or invalid backend data",
      ),
    };
  }
  return {
    data: {
      telemetry_reference: resolved.reference,
      ...result,
      queried_at: now.toISOString(),
    },
  };
}

/** 向后便捷别名 / Convenience alias. */
export const queryEvidence = queryTelemetryReference;

async function resolveReference(
  database: D1Database,
  id: string,
  correlationId: string,
): Promise<
  ResolvedEvidenceReference | { readonly problem: ProblemDetails } | null
> {
  const row = await database
    .prepare(
      `SELECT t.*, b.capabilities_json, b.query_adapter, b.ui_url_template,
            b.auth_reference, b.enabled, d.repository_url, d.git_commit
       FROM telemetry_references AS t
       JOIN telemetry_backends AS b ON b.backend_name=t.backend_name
       JOIN deployments AS d ON d.deployment_id=t.deployment_id
      WHERE t.telemetry_reference_id=?`,
    )
    .bind(id)
    .first<EvidenceRow>();
  if (row === null) return null;
  try {
    const locator = JSON.parse(row.locator_json) as unknown;
    const common = {
      id: row.telemetry_reference_id,
      backend: row.backend_name,
      locator,
      service_name: row.service_name,
      deployment_id: row.deployment_id,
      ...(row.correlation_id === null
        ? {}
        : { correlation_id: row.correlation_id }),
      ...(row.trace_id === null ? {} : { trace_id: row.trace_id }),
      ...(row.span_id === null ? {} : { span_id: row.span_id }),
      ...(row.expires_at === null ? {} : { expires_at: row.expires_at }),
    };
    const candidate =
      row.kind === "log_query" ||
      row.kind === "metric_query" ||
      row.kind === "profile"
        ? {
            ...common,
            kind: row.kind,
            time_range: { start: row.range_start, end: row.range_end },
          }
        : { ...common, kind: row.kind };
    const reference = TelemetryReferenceSchema.parse(candidate);
    const capabilities = z
      .array(TelemetryCapabilitySchema)
      .max(6)
      .parse(JSON.parse(row.capabilities_json));
    return {
      reference,
      adapterText: row.query_adapter,
      capabilities,
      uiUrlTemplate: row.ui_url_template,
      authReference: row.auth_reference,
      enabled: row.enabled === 1,
      repositoryUrl: row.repository_url,
      gitCommit: row.git_commit,
    };
  } catch {
    return {
      problem: {
        type: "https://status.moesegfault.dev/problems/dependency-unavailable",
        title: "Stored telemetry reference is invalid",
        status: 503,
        correlation_id: correlationId,
      },
    };
  }
}

async function artifactExists(
  database: D1Database,
  reference: TelemetryReference,
): Promise<boolean> {
  if (reference.kind !== "artifact") return false;
  const locator = reference.locator;
  const found = await database
    .prepare(
      `SELECT artifact_id FROM deployment_artifacts
      WHERE deployment_id=? AND artifact_digest=? AND kind=?
        AND (? IS NULL OR build_id=?) LIMIT 1`,
    )
    .bind(
      reference.deployment_id,
      locator.artifact_digest,
      locator.artifact_kind,
      locator.build_id ?? null,
      locator.build_id ?? null,
    )
    .first<string>("artifact_id");
  return found !== null;
}

function authorize(
  raw: unknown,
):
  | { readonly request: QueryTelemetryReferenceRpcRequest }
  | { readonly problem: ProblemDetails } {
  const parsed = QueryTelemetryReferenceRpcRequestSchema.safeParse(raw);
  const candidate = raw as { correlation_id?: string } | null;
  const correlation =
    typeof candidate?.correlation_id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      candidate.correlation_id,
    )
      ? candidate.correlation_id
      : "018f0000-0000-7000-8000-000000000000";
  if (!parsed.success)
    return {
      problem: {
        type: "https://status.moesegfault.dev/problems/invalid-request",
        title: "Invalid evidence query request",
        status: 400,
        detail: parsed.error.issues
          .map((issue) => issue.message)
          .join("; ")
          .slice(0, 4096),
        correlation_id: correlation,
      },
    };
  if (!hasRole(parsed.data.principal.roles, "viewer"))
    return {
      problem: {
        type: "https://status.moesegfault.dev/problems/forbidden",
        title: "Forbidden",
        status: 403,
        detail: "Role viewer, operator, or admin is required.",
        correlation_id: parsed.data.correlation_id,
      },
    };
  return { request: parsed.data };
}

function hasRole(roles: readonly Role[], required: Role): boolean {
  const rank: Record<Role, number> = { viewer: 1, operator: 2, admin: 3 };
  return roles.some((role) => rank[role] >= rank[required]);
}

function adapterMatches(
  adapter: z.infer<typeof TelemetryQueryAdapterSchema>,
  kind: TelemetryReference["kind"],
): boolean {
  return (
    (
      {
        tempo: "trace",
        loki: "log_query",
        pyroscope: "profile",
        prometheus: "metric_query",
        "source-commit": "source",
        "artifact-registry": "artifact",
      } as const
    )[adapter] === kind
  );
}

function terminal(
  resolved: ResolvedEvidenceReference,
  status: EvidenceQueryResult["status"],
  now: Date,
  detail: string,
): EvidenceQueryResult {
  return {
    telemetry_reference: resolved.reference,
    status,
    ui_url: null,
    records: [],
    truncated: false,
    queried_at: now.toISOString(),
    detail,
  };
}

function requestProblem(
  status: 404,
  title: string,
  request: QueryTelemetryReferenceRpcRequest,
): ProblemDetails {
  return {
    type: "https://status.moesegfault.dev/problems/not-found",
    title,
    status,
    instance: "/rpc/queryTelemetryReference",
    correlation_id: request.correlation_id,
  };
}

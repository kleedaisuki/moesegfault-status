import {
  ArtifactEvidenceSchema,
  LogQueryEvidenceSchema,
  MetricQueryEvidenceSchema,
  ProfileEvidenceSchema,
  SourceEvidenceSchema,
  TraceEvidenceSchema,
  type DiagnosticEvidence,
  type TimeRange,
} from "@moesegfault/contracts";
import { sanitizeText } from "@moesegfault/telemetry";

/** Locator query 可携带的安全标量。/ Safe scalar accepted in locator queries. */
export type SafeQueryValue = string | number | boolean;

/** 日志 locator 的固定低基数键。/ Fixed low-cardinality keys for log locators. */
export type LogQueryKey =
  | "service"
  | "environment"
  | "deployment_id"
  | "trace_id"
  | "span_id"
  | "severity"
  | "operation"
  | "component"
  | "error_type";

/** Profile locator 的固定低基数键。/ Fixed low-cardinality keys for profile locators. */
export type ProfileQueryKey =
  "service" | "environment" | "deployment_id" | "region" | "instance_id";

/** Metric locator 的固定低基数键。/ Fixed low-cardinality keys for metric locators. */
export type MetricQueryKey =
  | "service"
  | "environment"
  | "deployment_id"
  | "region"
  | "operation"
  | "component"
  | "dependency";

declare const SAFE_EVIDENCE: unique symbol;

/** 由有限 builder 产生的安全证据联合。/ Safe evidence union produced by finite builders. */
export type SafeDiagnosticEvidence = DiagnosticEvidence & {
  readonly [SAFE_EVIDENCE]: true;
};

const LOG_KEYS = new Set<LogQueryKey>([
  "service",
  "environment",
  "deployment_id",
  "trace_id",
  "span_id",
  "severity",
  "operation",
  "component",
  "error_type",
]);
const PROFILE_KEYS = new Set<ProfileQueryKey>([
  "service",
  "environment",
  "deployment_id",
  "region",
  "instance_id",
]);
const METRIC_KEYS = new Set<MetricQueryKey>([
  "service",
  "environment",
  "deployment_id",
  "region",
  "operation",
  "component",
  "dependency",
]);

/** 构建 trace locator，不接受 URL、headers 或自由查询。/ Builds a trace locator without URLs, headers, or free-form queries. */
export function traceEvidence(
  input: Readonly<{
    backend: string;
    traceId: string;
    spanId?: string;
  }>,
): SafeDiagnosticEvidence {
  return safe(
    TraceEvidenceSchema.parse({
      kind: "trace",
      backend: input.backend,
      locator: {
        trace_id: input.traceId,
        ...(input.spanId === undefined ? {} : { span_id: input.spanId }),
      },
    }),
  );
}

/** 构建固定键日志查询 locator。/ Builds a fixed-key structured-log query locator. */
export function logQueryEvidence(
  input: Readonly<{
    backend: string;
    query: Readonly<Partial<Record<LogQueryKey, SafeQueryValue>>>;
    timeRange: TimeRange;
  }>,
): SafeDiagnosticEvidence {
  return safe(
    LogQueryEvidenceSchema.parse({
      kind: "log_query",
      backend: input.backend,
      locator: { query: safeQuery(input.query, LOG_KEYS) },
      time_range: input.timeRange,
    }),
  );
}

/** 构建固定键 profile locator。/ Builds a fixed-key continuous-profile locator. */
export function profileEvidence(
  input: Readonly<{
    backend: string;
    profileType:
      "cpu" | "memory" | "allocations" | "mutex" | "goroutine" | "wall";
    profileId?: string;
    query?: Readonly<Partial<Record<ProfileQueryKey, SafeQueryValue>>>;
    timeRange: TimeRange;
  }>,
): SafeDiagnosticEvidence {
  return safe(
    ProfileEvidenceSchema.parse({
      kind: "profile",
      backend: input.backend,
      locator: {
        profile_type: input.profileType,
        ...(input.profileId === undefined
          ? {}
          : { profile_id: sanitizeRequired(input.profileId, 256) }),
        ...(input.query === undefined
          ? {}
          : { query: safeQuery(input.query, PROFILE_KEYS) }),
      },
      time_range: input.timeRange,
    }),
  );
}

/** 构建固定键 metric locator。/ Builds a fixed-key metric-query locator. */
export function metricQueryEvidence(
  input: Readonly<{
    backend: string;
    metricName: string;
    query: Readonly<Partial<Record<MetricQueryKey, SafeQueryValue>>>;
    timeRange: TimeRange;
  }>,
): SafeDiagnosticEvidence {
  return safe(
    MetricQueryEvidenceSchema.parse({
      kind: "metric_query",
      backend: input.backend,
      locator: {
        metric_name: sanitizeRequired(input.metricName, 255),
        query: safeQuery(input.query, METRIC_KEYS),
      },
      time_range: input.timeRange,
    }),
  );
}

/** 构建固定 commit 的源码 locator，并拒绝 URL 凭据、query 与 fragment。/ Builds a commit-pinned source locator and rejects URL credentials, queries, and fragments. */
export function sourceEvidence(
  input: Readonly<{
    backend: string;
    repositoryUrl: string | URL;
    gitCommit: string;
    path: string;
    line?: number;
    column?: number;
  }>,
): SafeDiagnosticEvidence {
  const repositoryUrl = safeRepositoryUrl(input.repositoryUrl);
  return safe(
    SourceEvidenceSchema.parse({
      kind: "source",
      backend: input.backend,
      locator: {
        repository_url: repositoryUrl,
        git_commit: input.gitCommit,
        path: sanitizeRequired(input.path, 1_024),
        ...(input.line === undefined ? {} : { line: input.line }),
        ...(input.column === undefined ? {} : { column: input.column }),
      },
    }),
  );
}

/** 构建内容寻址的不可变产物 locator。/ Builds a content-addressed immutable-artifact locator. */
export function artifactEvidence(
  input: Readonly<{
    backend: string;
    artifactDigest: `sha256:${string}`;
    artifactKind:
      "binary" | "debug_symbols" | "source_map" | "sbom" | "manifest" | "other";
    buildId?: string;
  }>,
): SafeDiagnosticEvidence {
  return safe(
    ArtifactEvidenceSchema.parse({
      kind: "artifact",
      backend: input.backend,
      locator: {
        artifact_digest: input.artifactDigest,
        artifact_kind: input.artifactKind,
        ...(input.buildId === undefined
          ? {}
          : { build_id: sanitizeRequired(input.buildId, 256) }),
      },
    }),
  );
}

/**
 * 在最终事件边界重建证据，阻止类型断言绕过有限 locator API。
 * Rebuilds evidence at the final event boundary so type assertions cannot bypass the finite locator API.
 *
 * @internal
 */
export function validateSafeEvidence(
  input: SafeDiagnosticEvidence,
): SafeDiagnosticEvidence {
  switch (input.kind) {
    case "trace":
      return traceEvidence({
        backend: input.backend,
        traceId: input.locator.trace_id,
        ...(input.locator.span_id === undefined
          ? {}
          : { spanId: input.locator.span_id }),
      });
    case "log_query":
      return logQueryEvidence({
        backend: input.backend,
        query: input.locator.query,
        timeRange: input.time_range,
      });
    case "profile":
      return profileEvidence({
        backend: input.backend,
        profileType: input.locator.profile_type,
        ...(input.locator.profile_id === undefined
          ? {}
          : { profileId: input.locator.profile_id }),
        ...(input.locator.query === undefined
          ? {}
          : { query: input.locator.query }),
        timeRange: input.time_range,
      });
    case "metric_query":
      return metricQueryEvidence({
        backend: input.backend,
        metricName: input.locator.metric_name,
        query: input.locator.query,
        timeRange: input.time_range,
      });
    case "source":
      return sourceEvidence({
        backend: input.backend,
        repositoryUrl: input.locator.repository_url,
        gitCommit: input.locator.git_commit,
        path: input.locator.path,
        ...(input.locator.line === undefined
          ? {}
          : { line: input.locator.line }),
        ...(input.locator.column === undefined
          ? {}
          : { column: input.locator.column }),
      });
    case "artifact":
      return artifactEvidence({
        backend: input.backend,
        artifactDigest: input.locator.artifact_digest as `sha256:${string}`,
        artifactKind: input.locator.artifact_kind,
        ...(input.locator.build_id === undefined
          ? {}
          : { buildId: input.locator.build_id }),
      });
  }
}

/** 仅复制显式固定键并清理字符串值。/ Copies only explicit fixed keys and scrubs string values. */
function safeQuery<K extends string>(
  input: Readonly<Partial<Record<K, SafeQueryValue>>>,
  allowed: ReadonlySet<K>,
): Readonly<Record<string, SafeQueryValue>> {
  const output: Record<string, SafeQueryValue> = Object.create(null) as Record<
    string,
    SafeQueryValue
  >;
  for (const key of Object.keys(input).sort()) {
    if (!allowed.has(key as K)) {
      throw new TypeError(`locator query key is not allowed: ${key}`);
    }
    const value = input[key as K];
    if (typeof value === "string") output[key] = sanitizeRequired(value, 512);
    else if (typeof value === "boolean") output[key] = value;
    else if (typeof value === "number" && Number.isFinite(value))
      output[key] = value;
    else throw new TypeError(`locator query value is invalid: ${key}`);
  }
  if (Object.keys(output).length === 0) {
    throw new TypeError("locator query requires at least one fixed key");
  }
  return Object.freeze(output);
}

/** 清理必须保持非空的 locator 文本。/ Scrubs locator text that must remain non-empty. */
function sanitizeRequired(value: string, maxLength: number): string {
  const safe = sanitizeText(value, maxLength);
  if (safe.length === 0) throw new TypeError("locator text must not be empty");
  return safe;
}

/** 解析安全的源码仓库 URL。/ Parses a safe source-repository URL. */
function safeRepositoryUrl(value: string | URL): string {
  let url: URL;
  try {
    url = new URL(value.toString());
  } catch {
    throw new TypeError("repositoryUrl must be an absolute HTTPS URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError(
      "repositoryUrl must use HTTPS and contain no credentials, query, or fragment",
    );
  }
  if (sanitizeText(url.href, 2_048) !== url.href) {
    throw new TypeError("repositoryUrl contains a credential-like value");
  }
  return url.href;
}

/** 深冻结由 Zod 克隆后的 JSON 值。/ Deep-freezes the JSON value cloned by Zod. */
function freeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value))
    return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

/** 标记并冻结已重建的安全证据。/ Brands and freezes rebuilt safe evidence. */
function safe(value: DiagnosticEvidence): SafeDiagnosticEvidence {
  return freeze(value) as SafeDiagnosticEvidence;
}

/** 证据 locator query 的有限标量。/ Finite scalar admitted by evidence locator queries. */
export type LocatorQueryValue = string | number | boolean;

/** 顶层 TelemetryReference 提供的不可变查询身份。/ Immutable query identity supplied by the top-level TelemetryReference. */
export interface QueryIdentity {
  /** 权威 service name。/ Authoritative service name. */
  readonly serviceName: string;
  /** 权威 deployment UUIDv7。/ Authoritative deployment UUIDv7. */
  readonly deploymentId: string;
}

const LOG_KEYS = Object.freeze([
  "service",
  "environment",
  "deployment_id",
  "trace_id",
  "span_id",
  "severity",
  "operation",
  "component",
  "error_type",
] as const);
const METRIC_KEYS = Object.freeze([
  "service",
  "environment",
  "deployment_id",
  "region",
  "operation",
  "component",
  "dependency",
] as const);
const PROFILE_KEYS = Object.freeze([
  "service",
  "environment",
  "deployment_id",
  "region",
  "instance_id",
] as const);

const LABEL_NAMES: Readonly<Record<string, string>> = Object.freeze({
  service: "service_name",
  environment: "environment",
  deployment_id: "deployment_id",
  trace_id: "trace_id",
  span_id: "span_id",
  severity: "severity",
  operation: "operation",
  component: "component",
  error_type: "error_type",
  region: "region",
  dependency: "dependency",
  instance_id: "instance_id",
});

/** 将通用 SDK 类别映射到稳定的 Pyroscope 默认 sample type。/ Maps generic SDK categories to stable default Pyroscope sample types. */
const PROFILE_TYPE = Object.freeze({
  cpu: "process_cpu:cpu:nanoseconds:cpu:nanoseconds",
  memory: "memory:inuse_space:bytes:space:bytes",
  allocations: "memory:alloc_space:bytes:space:bytes",
  mutex: "mutex:delay:nanoseconds:contentions:count",
  goroutine: "goroutine:goroutine:count:goroutine:count",
  wall: "wall:wall:nanoseconds:cpu:nanoseconds",
} satisfies Readonly<Record<string, string>>);

const PROMETHEUS_METRIC = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/u;
const PROMETHEUS_RESERVED_METRICS = new Set([
  "bool",
  "on",
  "ignoring",
  "group_left",
  "group_right",
]);
const MAX_COMPILED_LENGTH = 4_096;

/**
 * 将 SDK 固定键编译为带 service/deployment 范围的 LogQL stream selector。
 * Compiles SDK fixed keys into a LogQL stream selector scoped by service and deployment.
 *
 * 任意 `expression` 不被接受，因为无法在不解析完整 LogQL AST 时安全注入 identity scope。
 * Arbitrary `expression` is rejected because identity scope cannot be safely injected without a full LogQL AST parser.
 *
 * @see https://grafana.com/docs/loki/latest/query/query_reference/
 */
export function compileLogQuery(
  query: Readonly<Record<string, LocatorQueryValue>>,
  identity: QueryIdentity,
): string | undefined {
  return compileSelector(query, LOG_KEYS, identity);
}

/**
 * 将 SDK 固定键编译为 PromQL vector selector，不再静默丢弃 filters。
 * Compiles SDK fixed keys into a PromQL vector selector without silently dropping filters.
 *
 * @see https://prometheus.io/docs/prometheus/latest/querying/basics/
 */
export function compileMetricQuery(
  metricName: string,
  query: Readonly<Record<string, LocatorQueryValue>>,
  identity: QueryIdentity,
): string | undefined {
  if (
    !PROMETHEUS_METRIC.test(metricName) ||
    PROMETHEUS_RESERVED_METRICS.has(metricName)
  )
    return undefined;
  const selector = compileSelector(query, METRIC_KEYS, identity);
  if (selector === undefined) return undefined;
  return bounded(`${metricName}${selector}`);
}

/**
 * 将 SDK profile 类型与固定键编译为 Pyroscope profile selector。
 * Compiles an SDK profile type and fixed keys into a Pyroscope profile selector.
 *
 * 旧 render API 把 `profileId` 当任意 query 字符串，无法证明 identity scope，因此拒绝。
 * The legacy render API treats `profileId` as an arbitrary query string and cannot prove identity scope, so it is rejected.
 *
 * @see https://grafana.com/docs/pyroscope/latest/reference-server-api/
 */
export function compileProfileQuery(
  profileType: keyof typeof PROFILE_TYPE,
  profileId: string | undefined,
  query: Readonly<Record<string, LocatorQueryValue>> | undefined,
  identity: QueryIdentity,
): string | undefined {
  if (query === undefined || profileId !== undefined) return undefined;
  const selector = compileSelector(query, PROFILE_KEYS, identity);
  if (selector === undefined) return undefined;
  return bounded(`${PROFILE_TYPE[profileType]}${selector}`);
}

/** 编译确定顺序的相等 label matchers。/ Compiles deterministic equality label matchers. */
function compileSelector<const K extends string>(
  query: Readonly<Record<string, LocatorQueryValue>>,
  allowedKeys: readonly K[],
  identity: QueryIdentity,
): string | undefined {
  const keys = Object.keys(query);
  if (keys.length === 0 || keys.some((key) => !allowedKeys.includes(key as K)))
    return undefined;
  if (
    !matchesIdentity(query.service, identity.serviceName) ||
    !matchesIdentity(query.deployment_id, identity.deploymentId)
  )
    return undefined;

  const matchers = [
    `service_name=${quoteLabelValue(identity.serviceName)}`,
    `deployment_id=${quoteLabelValue(identity.deploymentId)}`,
  ];
  for (const key of allowedKeys) {
    if (key === "service" || key === "deployment_id") continue;
    const value = query[key];
    if (!isScalar(value)) return undefined;
    if (value !== undefined) {
      const labelName = LABEL_NAMES[key];
      if (labelName === undefined) return undefined;
      matchers.push(`${labelName}=${quoteLabelValue(String(value))}`);
    }
  }
  return bounded(`{${matchers.join(",")}}`);
}

/** 仅允许精确匹配权威 identity。/ Allows only an exact match with authoritative identity. */
function matchesIdentity(
  candidate: LocatorQueryValue | undefined,
  expected: string,
): boolean {
  return candidate === undefined || candidate === expected;
}

/** 使用 Go/LogQL/PromQL 双引号规则转义 label value。/ Escapes a label value using Go-compatible LogQL/PromQL double-quoted syntax. */
function quoteLabelValue(value: string): string {
  let output = '"';
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (character === "\\") output += "\\\\";
    else if (character === '"') output += '\\"';
    else if (character === "\n") output += "\\n";
    else if (character === "\r") output += "\\r";
    else if (character === "\t") output += "\\t";
    else if (code < 0x20 || code === 0x7f)
      output += `\\x${code.toString(16).padStart(2, "0")}`;
    else if (code >= 0xd800 && code <= 0xdfff && character.length === 1)
      output += `\\u${code.toString(16).padStart(4, "0")}`;
    else output += character;
  }
  return `${output}"`;
}

/** 验证 locator 标量，undefined 只表示字段缺失。/ Validates locator scalars; undefined means only that a field is absent. */
function isScalar(
  value: LocatorQueryValue | undefined,
): value is LocatorQueryValue | undefined {
  return (
    value === undefined ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

/** 应用编译查询的硬长度上限。/ Applies the hard compiled-query length bound. */
function bounded(value: string): string | undefined {
  return value.length <= MAX_COMPILED_LENGTH ? value : undefined;
}

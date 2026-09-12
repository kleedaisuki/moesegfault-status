import { sanitizeAttributes } from "./privacy.js";
import type { AttributePolicy, DeploymentEnvironment } from "./types.js";

const METRIC_NAME = /^[a-z][a-z0-9_.]{0,254}$/;
const METRIC_UNIT = /^[A-Za-z0-9%*/.^()[\]'_+-]{1,32}$/;
const METRIC_KINDS = new Set([
  "counter",
  "histogram",
  "up_down_counter",
  "gauge",
]);
const FORBIDDEN_DIMENSION =
  /(?:^|\.)(?:user|correlation|trace|span|resource)(?:\.|$)|(?:^|\.)(?:message|sql|url|path)(?:\.|$)|(?:^|\.)id$/i;
const HIGH_CARDINALITY_VALUE = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f-]{27,})$/i;
const MAX_POINTS_PER_INVOCATION = 250;
const MAX_BLOBS = 20;
const MAX_BLOB_BYTES = 16 * 1024;
const MAX_INDEX_BYTES = 96;

/**
 * Analytics Engine 原生数据点的最小结构。
 * Minimal native Analytics Engine data-point shape.
 */
export interface AnalyticsEngineDataPoint {
  /** 位置固定的字符串维度。/ Positionally fixed string dimensions. */
  readonly blobs?: string[];
  /** 数值测量。/ Numeric measurements. */
  readonly doubles?: number[];
  /** 唯一采样索引。/ The single sampling index. */
  readonly indexes?: string[];
}

/**
 * Analytics Engine binding 的结构类型。
 * Structural type of an Analytics Engine binding.
 */
export interface AnalyticsEngineDatasetLike {
  /** 非阻塞写入数据点。/ Writes a data point without blocking. */
  writeDataPoint(point?: AnalyticsEngineDataPoint): void;
}

/**
 * 指标仪器种类。/ Metric instrument kind.
 */
export type MetricKind = "counter" | "histogram" | "up_down_counter" | "gauge";

/**
 * 一个高频指标样本。/ One high-frequency metric sample.
 */
export interface MetricSample {
  /** 不含单位、环境或服务名的稳定指标名。/ Stable metric name without unit, environment, or service. */
  readonly name: string;
  /** 仪器种类。/ Instrument kind. */
  readonly kind: MetricKind;
  /** UCUM 单位，例如 ms、By 或 1。/ UCUM unit such as ms, By, or 1. */
  readonly unit: string;
  /** 有限数值。/ Finite numeric value. */
  readonly value: number;
  /** 仅允许低基数维度。/ Only low-cardinality dimensions are permitted. */
  readonly attributes?: Readonly<Record<string, unknown>>;
}

/**
 * Analytics Engine 指标适配器。/ Analytics Engine metrics adapter.
 */
export interface AnalyticsMetrics {
  /**
   * 尝试非阻塞写入；binding 缺失、无效或平台抛错时返回 false。
   * Attempts a non-blocking write; returns false for a missing binding, invalid input, or platform error.
   */
  write(sample: MetricSample): boolean;
  /** 本 invocation 已丢弃样本数。/ Samples dropped by this invocation-scoped adapter. */
  readonly dropped: number;
}

/**
 * 指标适配器配置。/ Metrics adapter configuration.
 */
export interface AnalyticsMetricsOptions {
  /** 稳定服务名。/ Stable service name. */
  readonly serviceName: string;
  /** 部署环境。/ Deployment environment. */
  readonly environment: DeploymentEnvironment;
  /** 不可变部署 UUIDv7。/ Immutable deployment UUIDv7. */
  readonly deploymentId: string;
  /** 自定义维度允许列表；缺省时不接受任何自定义维度。/ Custom dimension allowlist; none are accepted by default. */
  readonly dimensionPolicy?: AttributePolicy;
  /** invocation 写入硬上限，不能超过平台的 250。/ Invocation write cap, never above the platform limit of 250. */
  readonly maxPoints?: number;
  /** 丢弃计数回调。/ Drop counter callback. */
  readonly onDrop?: (count: number) => void;
}

/**
 * 创建 invocation 局部的高频指标适配器。
 * Creates an invocation-scoped adapter for high-frequency metric samples.
 *
 * blobs 的固定 schema 为 name, kind, unit, service, environment, deployment, sorted key=value。
 * The fixed blobs schema is name, kind, unit, service, environment, deployment, sorted key=value.
 */
export function createAnalyticsMetrics(
  dataset: AnalyticsEngineDatasetLike | undefined,
  options: AnalyticsMetricsOptions,
): AnalyticsMetrics {
  if (
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.serviceName) ||
    options.serviceName.length > 63
  ) {
    throw new TypeError("serviceName must be lowercase kebab-case");
  }
  if (
    !["development", "test", "staging", "production"].includes(
      options.environment,
    )
  ) {
    throw new TypeError("environment is invalid");
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      options.deploymentId,
    )
  ) {
    throw new TypeError("deploymentId must be UUIDv7");
  }
  const maxPoints = options.maxPoints ?? MAX_POINTS_PER_INVOCATION;
  if (
    !Number.isSafeInteger(maxPoints) ||
    maxPoints < 1 ||
    maxPoints > MAX_POINTS_PER_INVOCATION
  ) {
    throw new RangeError("maxPoints must be an integer in 1..250");
  }
  const index = `${options.serviceName}:${options.environment}`;
  if (utf8Length(index) > MAX_INDEX_BYTES) {
    throw new RangeError("Analytics Engine index exceeds 96 UTF-8 bytes");
  }

  let attempts = 0;
  let dropped = 0;
  const drop = (): false => {
    dropped += 1;
    try {
      options.onDrop?.(1);
    } catch {
      // A self-observability callback cannot break the caller.
    }
    return false;
  };

  return Object.freeze({
    write(sample: MetricSample): boolean {
      if (
        dataset === undefined ||
        attempts >= maxPoints ||
        !validSample(sample)
      )
        return drop();
      const dimensions = metricDimensions(
        sample.attributes,
        options.dimensionPolicy,
      );
      const blobs = [
        sample.name,
        sample.kind,
        sample.unit,
        options.serviceName,
        options.environment,
        options.deploymentId,
        ...dimensions,
      ];
      if (
        blobs.length > MAX_BLOBS ||
        blobs.reduce((sum, value) => sum + utf8Length(value), 0) >
          MAX_BLOB_BYTES
      ) {
        return drop();
      }

      try {
        attempts += 1;
        dataset.writeDataPoint({
          blobs,
          doubles: [sample.value],
          indexes: [index],
        });
        return true;
      } catch {
        return drop();
      }
    },
    get dropped(): number {
      return dropped;
    },
  });
}

/** 验证样本基础字段。/ Validates a sample's base fields. */
function validSample(sample: MetricSample): boolean {
  return (
    METRIC_NAME.test(sample.name) &&
    METRIC_KINDS.has(sample.kind) &&
    METRIC_UNIT.test(sample.unit) &&
    Number.isFinite(sample.value)
  );
}

/** 安全编码低基数维度。/ Safely encodes low-cardinality dimensions. */
function metricDimensions(
  attributes: Readonly<Record<string, unknown>> | undefined,
  policy: AttributePolicy | undefined,
): string[] {
  if (attributes === undefined || policy === undefined) return [];
  const safe = sanitizeAttributes(attributes, policy);
  const result: string[] = [];
  for (const [key, value] of Object.entries(safe)) {
    if (
      FORBIDDEN_DIMENSION.test(key) ||
      Array.isArray(value) ||
      HIGH_CARDINALITY_VALUE.test(String(value))
    )
      continue;
    result.push(`${key}=${String(value)}`);
  }
  return result.slice(0, MAX_BLOBS - 6);
}

/** 计算 UTF-8 字节数。/ Counts UTF-8 bytes. */
function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

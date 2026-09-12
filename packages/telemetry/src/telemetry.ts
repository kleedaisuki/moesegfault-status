import { createLogger } from "./log.js";
import type {
  InstrumentationScope,
  LoggerOptions,
  TelemetryLogger,
} from "./log.js";
import { createAnalyticsMetrics } from "./metrics.js";
import type {
  AnalyticsEngineDatasetLike,
  AnalyticsMetrics,
  AnalyticsMetricsOptions,
} from "./metrics.js";
import { shouldSample } from "./sampling.js";
import { defineResource } from "./resource.js";
import { withWorkerSpan } from "./spans.js";
import type { WorkersSpan, WorkersTracing } from "./spans.js";
import {
  acceptCorrelationId,
  acceptTraceContext,
  injectTraceContext,
  parseTraceParent,
} from "./trace.js";
import type { TraceContext } from "./trace.js";
import type {
  AttributePolicy,
  ConsoleLike,
  ResourceIdentity,
} from "./types.js";

/**
 * HTTP/RPC 边界配置。/ HTTP/RPC boundary configuration.
 */
export interface BoundaryOptions {
  /** 公网边界不信任关联 ID；内部边界传播合法值。/ Public boundaries distrust correlation IDs; internal boundaries propagate valid values. */
  readonly kind: "public" | "internal";
  /** 是否信任合法入站 W3C 上下文，默认 true。/ Whether valid inbound W3C context is trusted; defaults to true. */
  readonly trustIncomingTrace?: boolean;
  /** 新 trace 的确定性采样率。/ Deterministic sample rate for a new trace. */
  readonly sampleRate?: number;
}

/**
 * 一个请求的显式执行上下文；不得存入模块级可变状态。
 * Explicit execution context for one request; never store it in module-level mutable state.
 */
export interface BoundaryContext {
  /** 独立 W3C 上下文。/ Independent W3C context. */
  readonly trace: TraceContext;
  /** 平台关联 UUIDv7。/ Platform correlation UUIDv7. */
  readonly correlationId: string;
  /**
   * 把 W3C 与关联 ID 注入出站或响应 Headers。
   * Injects W3C and correlation IDs into outbound or response Headers.
   */
  inject(headers: Headers): Headers;
}

/**
 * invocation 局部遥测门面。/ Invocation-scoped telemetry facade.
 */
export interface Telemetry {
  /** 不可变资源身份。/ Immutable resource identity. */
  readonly resource: Readonly<ResourceIdentity>;
  /** 安全结构化日志器。/ Safe structured logger. */
  readonly logger: TelemetryLogger;
  /** 高频 Analytics Engine 指标。/ High-frequency Analytics Engine metrics. */
  readonly metrics: AnalyticsMetrics;
  /** 从请求建立显式边界上下文。/ Creates explicit boundary context from a request. */
  beginBoundary(request: Request, options: BoundaryOptions): BoundaryContext;
  /** 用官方 Workers custom span 包裹领域操作。/ Wraps a domain operation in an official Workers custom span. */
  withSpan<T>(
    tracing: WorkersTracing | undefined,
    name: string,
    attributes: Readonly<Record<string, unknown>>,
    operation: (span: WorkersSpan | undefined) => T,
  ): T;
}

/**
 * 遥测门面配置。/ Telemetry facade configuration.
 */
export interface TelemetryOptions {
  /** 必需资源身份。/ Required resource identity. */
  readonly resource: Readonly<ResourceIdentity>;
  /** 仪器作用域。/ Instrumentation scope. */
  readonly instrumentation: InstrumentationScope;
  /** log 与 span 共用的显式 allowlist。/ Explicit allowlist shared by logs and spans. */
  readonly attributePolicy: AttributePolicy;
  /** 可选 Analytics Engine binding。/ Optional Analytics Engine binding. */
  readonly metricsDataset?: AnalyticsEngineDatasetLike;
  /** 可选指标配置覆盖。/ Optional metrics configuration overrides. */
  readonly metrics?: Omit<
    AnalyticsMetricsOptions,
    "serviceName" | "environment" | "deploymentId"
  >;
  /** 可替换 Console。/ Injectable Console. */
  readonly console?: ConsoleLike;
  /** 日志普通事件采样率。/ Normal-event log sampling rate. */
  readonly logSampleRate?: number;
  /** 采样策略版本。/ Sampling policy revision. */
  readonly samplingPolicyRevision?: string;
  /** 采样丢弃计数回调。/ Sampling-drop counter callback. */
  readonly onSampleDrop?: (count: number) => void;
  /** 可测试时钟。/ Testable clock. */
  readonly now?: () => Date;
}

/**
 * 创建无隐式请求状态的遥测门面；应在每次 invocation 中创建。
 * Creates a telemetry facade without implicit request state; instantiate it once per invocation.
 */
export function createTelemetry(options: TelemetryOptions): Telemetry {
  const resource = defineResource(options.resource);
  const loggerOptions: LoggerOptions = {
    resource,
    instrumentation: options.instrumentation,
    attributePolicy: options.attributePolicy,
    ...(options.console === undefined ? {} : { console: options.console }),
    ...(options.logSampleRate === undefined
      ? {}
      : { sampleRate: options.logSampleRate }),
    ...(options.samplingPolicyRevision === undefined
      ? {}
      : { policyRevision: options.samplingPolicyRevision }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.onSampleDrop === undefined
      ? {}
      : { onSampleDrop: options.onSampleDrop }),
  };
  const metricOptions: AnalyticsMetricsOptions = {
    ...options.metrics,
    serviceName: resource["service.name"],
    environment: resource["deployment.environment.name"],
    deploymentId: resource["moesegfault.deployment.id"],
  };
  const metrics = createAnalyticsMetrics(options.metricsDataset, metricOptions);
  const logger = createLogger(loggerOptions);

  return Object.freeze({
    resource,
    logger,
    metrics,
    beginBoundary(
      request: Request,
      boundaryOptions: BoundaryOptions,
    ): BoundaryContext {
      const rate = boundaryOptions.sampleRate ?? 1;
      if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
        throw new RangeError("sampleRate must be between 0 and 1");
      }
      const trustIncoming = boundaryOptions.trustIncomingTrace !== false;
      const incoming = trustIncoming
        ? parseTraceParent(request.headers.get("traceparent"))
        : null;
      let trace = acceptTraceContext(request.headers, { trustIncoming });
      if (incoming === null)
        trace = setSampled(trace, shouldSample(trace.traceId, rate));
      const correlationId = acceptCorrelationId(
        request.headers,
        boundaryOptions.kind,
      );

      return Object.freeze({
        trace,
        correlationId,
        inject(headers: Headers): Headers {
          injectTraceContext(headers, trace);
          headers.set("x-moesegfault-correlation-id", correlationId);
          return headers;
        },
      });
    },
    withSpan<T>(
      tracing: WorkersTracing | undefined,
      name: string,
      attributes: Readonly<Record<string, unknown>>,
      operation: (span: WorkersSpan | undefined) => T,
    ): T {
      return withWorkerSpan(
        tracing,
        name,
        attributes,
        options.attributePolicy,
        operation,
      );
    },
  });
}

/** 只修改 W3C sampled 位并保留其他 flags。/ Updates only the W3C sampled bit and preserves other flags. */
function setSampled(context: TraceContext, sampled: boolean): TraceContext {
  const traceFlags = sampled
    ? context.traceFlags | 1
    : context.traceFlags & 0xfe;
  return Object.freeze({
    ...context,
    traceFlags,
    traceparent: `00-${context.traceId}-${context.spanId}-${traceFlags.toString(16).padStart(2, "0")}`,
  });
}

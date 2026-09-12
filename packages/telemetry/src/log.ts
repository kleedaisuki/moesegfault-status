import { sanitizeAttributes, sanitizeText } from "./privacy.js";
import { defineResource } from "./resource.js";
import { shouldSample } from "./sampling.js";
import type {
  AttributePolicy,
  AttributeValue,
  ConsoleLike,
  ResourceIdentity,
  SeverityText,
} from "./types.js";
import { parseTraceParent } from "./trace.js";
import type { TraceContext } from "./trace.js";

const EVENT_NAME =
  /^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*$/;
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SEVERITY_NUMBER: Readonly<Record<SeverityText, number>> = Object.freeze({
  TRACE: 1,
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17,
  FATAL: 21,
});

/**
 * 日志的仪器作用域（InstrumentationScope）。
 * Instrumentation scope for a log record.
 */
export interface InstrumentationScope {
  /** 稳定的库名。/ Stable library name. */
  readonly name: string;
  /** 库版本。/ Library version. */
  readonly version?: string;
}

/**
 * 与 LogRecord 关联的请求局部执行身份。
 * Request-local execution identity correlated with a LogRecord.
 */
export interface LogContext {
  /** 独立 W3C 上下文；并非 Cloudflare 原生 trace ID。/ Independent W3C context; not Cloudflare's native trace ID. */
  readonly trace?: TraceContext;
  /** 平台关联 UUIDv7。/ Platform correlation UUIDv7. */
  readonly correlationId?: string;
}

/**
 * 创建结构化日志所需的事实。
 * Facts required to create a structured log.
 */
export interface LogInput {
  /** 小写点分稳定事件名。/ Stable lowercase dot-delimited event name. */
  readonly eventName: string;
  /** OTel 严重级别文字。/ OTel severity text. */
  readonly severity: SeverityText;
  /** 已清理的人类摘要；机器查询不得依赖它。/ Scrubbed human summary; machines must not depend on it. */
  readonly body: string;
  /** 仅由策略允许的结构化字段。/ Structured fields admitted only by policy. */
  readonly attributes?: Readonly<Record<string, unknown>>;
  /** 事件发生时间；默认当前时间。/ Event occurrence time; defaults to now. */
  readonly occurredAt?: Date;
}

/**
 * OTel 数据模型形状的、JSON 可安全序列化的 LogRecord。
 * JSON-safe LogRecord shaped after the OTel data model.
 */
export interface LogRecord {
  /** 来源时间，RFC 3339 UTC。/ Source timestamp in RFC 3339 UTC. */
  readonly Timestamp: string;
  /** 观察时间，RFC 3339 UTC。/ Observed timestamp in RFC 3339 UTC. */
  readonly ObservedTimestamp: string;
  /** OTel SeverityNumber。/ OTel SeverityNumber. */
  readonly SeverityNumber: number;
  /** OTel SeverityText。/ OTel SeverityText. */
  readonly SeverityText: SeverityText;
  /** 不可变资源身份。/ Immutable resource identity. */
  readonly Resource: Readonly<ResourceIdentity>;
  /** 产生日志的仪器作用域。/ Instrumentation scope that emitted the record. */
  readonly InstrumentationScope: Readonly<InstrumentationScope>;
  /** 稳定事件名称。/ Stable event name. */
  readonly EventName: string;
  /** 人类可读摘要。/ Human-readable summary. */
  readonly Body: string;
  /** 独立 W3C trace ID。/ Independent W3C trace ID. */
  readonly TraceId?: string;
  /** 独立 W3C span ID。/ Independent W3C span ID. */
  readonly SpanId?: string;
  /** 独立 W3C trace flags。/ Independent W3C trace flags. */
  readonly TraceFlags?: number;
  /** 已允许并清理的属性。/ Admitted and scrubbed attributes. */
  readonly Attributes: Readonly<Record<string, AttributeValue>>;
}

/**
 * 安全日志发射器。
 * Safe structured log emitter.
 */
export interface TelemetryLogger {
  /**
   * 建立记录并通过原生 Console 发送；返回值便于测试或额外路由。
   * Builds a record and sends it through native Console; the return value supports tests or additional routing.
   */
  emit(input: LogInput, context?: LogContext): LogRecord;
  /** 被确定性采样丢弃的普通记录数。/ Normal records dropped by deterministic sampling. */
  readonly sampledOut: number;
}

/**
 * 日志器配置。/ Logger configuration.
 */
export interface LoggerOptions {
  /** 必需资源身份。/ Required resource identity. */
  readonly resource: Readonly<ResourceIdentity>;
  /** 仪器作用域。/ Instrumentation scope. */
  readonly instrumentation: InstrumentationScope;
  /** 显式属性策略。/ Explicit attribute policy. */
  readonly attributePolicy: AttributePolicy;
  /** 可替换 Console；默认 globalThis.console。/ Injectable Console; defaults to globalThis.console. */
  readonly console?: ConsoleLike;
  /** 可测试时钟。/ Testable clock. */
  readonly now?: () => Date;
  /** 普通记录的确定性采样率；错误始终保留。/ Deterministic rate for normal records; errors are always kept. */
  readonly sampleRate?: number;
  /** 可审计采样策略版本。/ Auditable sampling policy revision. */
  readonly policyRevision?: string;
  /** 采样丢弃计数回调；异常会被隔离。/ Sampling-drop counter callback; callback errors are isolated. */
  readonly onSampleDrop?: (count: number) => void;
}

/**
 * 创建使用 Cloudflare 原生 Console 通道的结构化日志器。
 * Creates a structured logger using Cloudflare's native Console channel.
 */
export function createLogger(options: LoggerOptions): TelemetryLogger {
  const resource = defineResource(options.resource);
  const output = options.console ?? console;
  const now = options.now ?? (() => new Date());
  const sampleRate = options.sampleRate ?? 1;
  validateRate(sampleRate);
  requireNonempty("instrumentation.name", options.instrumentation.name);
  if (options.instrumentation.version !== undefined) {
    requireNonempty("instrumentation.version", options.instrumentation.version);
  }
  if (options.policyRevision !== undefined) {
    requireNonempty("policyRevision", options.policyRevision);
  }
  const instrumentation: InstrumentationScope = Object.freeze({
    name: options.instrumentation.name,
    ...(options.instrumentation.version === undefined
      ? {}
      : { version: options.instrumentation.version }),
  });

  let sampledOut = 0;
  return Object.freeze({
    emit(input: LogInput, context: LogContext = {}): LogRecord {
      if (!EVENT_NAME.test(input.eventName)) {
        throw new TypeError(
          "eventName must contain at least domain.entity.action in lowercase segments",
        );
      }
      const observedAt = now();
      const occurredAt = input.occurredAt ?? observedAt;
      assertValidDate("occurredAt", occurredAt);
      assertValidDate("now", observedAt);

      const baseAttributes = sanitizeAttributes(
        input.attributes ?? {},
        options.attributePolicy,
      );
      const attributes: Record<string, AttributeValue> = { ...baseAttributes };
      if (
        context.correlationId !== undefined &&
        UUID_V7.test(context.correlationId)
      ) {
        attributes["moesegfault.correlation.id"] = context.correlationId;
      }
      if (options.policyRevision !== undefined) {
        attributes["moesegfault.telemetry.sampling.policy_revision"] =
          options.policyRevision;
      }

      const trace = validTrace(context.trace);
      const record: LogRecord = Object.freeze({
        Timestamp: occurredAt.toISOString(),
        ObservedTimestamp: observedAt.toISOString(),
        SeverityNumber: SEVERITY_NUMBER[input.severity],
        SeverityText: input.severity,
        Resource: resource,
        InstrumentationScope: instrumentation,
        EventName: input.eventName,
        Body: sanitizeLogBody(
          input.body,
          options.attributePolicy.maxStringLength,
        ),
        ...(trace === undefined
          ? {}
          : {
              TraceId: trace.traceId,
              SpanId: trace.spanId,
              TraceFlags: trace.traceFlags,
            }),
        Attributes: Object.freeze(attributes),
      });

      const forceError =
        input.severity === "ERROR" || input.severity === "FATAL";
      const keep =
        trace === undefined ||
        shouldSample(trace.traceId, sampleRate, { error: forceError });
      if (keep) {
        try {
          writeToConsole(output, input.severity, record);
        } catch {
          // Telemetry output must never change business behavior.
        }
      } else {
        sampledOut += 1;
        try {
          options.onSampleDrop?.(1);
        } catch {
          // Self-observability must not recursively fail the caller.
        }
      }
      return record;
    },
    get sampledOut(): number {
      return sampledOut;
    },
  });
}

/** 只接受字段彼此一致的合法 W3C 上下文。/ Accepts only a valid W3C context whose fields agree. */
function validTrace(trace: TraceContext | undefined): TraceContext | undefined {
  if (trace === undefined) return undefined;
  const parsed = parseTraceParent(trace.traceparent);
  return parsed !== null &&
    parsed.traceId === trace.traceId &&
    parsed.spanId === trace.spanId &&
    parsed.traceFlags === trace.traceFlags
    ? trace
    : undefined;
}

/**
 * 清理自由文本中的常见凭据形态并执行长度上限。
 * Scrubs common credential shapes from free text and enforces a length limit.
 */
export function sanitizeLogBody(body: string, maxLength = 1_024): string {
  return sanitizeText(body, maxLength);
}

/** 映射 OTel 严重级别到 Console。/ Maps OTel severity to Console. */
function writeToConsole(
  output: ConsoleLike,
  severity: SeverityText,
  record: LogRecord,
): void {
  if (severity === "TRACE" || severity === "DEBUG") output.debug(record);
  else if (severity === "INFO") output.info(record);
  else if (severity === "WARN") output.warn(record);
  else output.error(record);
}

/** 验证采样率。/ Validates a sampling rate. */
function validateRate(rate: number): void {
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    throw new RangeError("sampleRate must be between 0 and 1");
  }
}

/** 验证稳定标识文本。/ Validates stable identifying text. */
function requireNonempty(name: string, value: string): void {
  if (value.length === 0 || value.length > 256 || !/^[\x21-\x7e]+$/.test(value))
    throw new TypeError(`${name} must contain 1..256 visible ASCII characters`);
}

/** 验证日期，避免 toISOString 的隐式 RangeError。/ Validates a date before toISOString can fail implicitly. */
function assertValidDate(name: string, value: Date): void {
  if (!Number.isFinite(value.getTime()))
    throw new RangeError(`${name} must be a valid Date`);
}

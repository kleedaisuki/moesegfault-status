import {
  acceptCorrelationId,
  acceptTraceContext,
  createCorrelationId,
  createTraceContext,
  parseTraceParent,
  parseTraceState,
} from "@moesegfault/telemetry";

/** 已解析且可安全传播的 Diagnostic 执行身份。/ Parsed Diagnostic execution identity safe for propagation. */
export interface DiagnosticPropagation {
  /** 平台内部关联 UUIDv7。/ Platform-internal correlation UUIDv7. */
  readonly correlationId: string;
  /** W3C 32-hex trace ID。/ W3C 32-hex trace ID. */
  readonly traceId: string;
  /** 此生产者边界创建的 W3C 16-hex span ID。/ W3C 16-hex span ID created at this producer boundary. */
  readonly spanId: string;
  /** 已规范化、可出站传播的 traceparent。/ Canonical traceparent safe for outbound propagation. */
  readonly traceparent: string;
  /** 仅当完整通过 W3C 校验时保留的 tracestate。/ Tracestate retained only when it fully passes W3C validation. */
  readonly tracestate?: string;
}

/**
 * 在请求边界解析 W3C Trace Context 与平台 correlation ID。
 * Parses W3C Trace Context and the platform correlation ID at a request boundary.
 *
 * 公网边界总是轮换 correlation ID；非法 trace 输入形成新根 trace。
 * Public boundaries always rotate the correlation ID; malformed trace input creates a new root trace.
 */
export function propagationFromHeaders(
  headers: Headers,
  boundary: "public" | "internal",
  options: Readonly<{ trustIncomingTrace?: boolean; nowMs?: number }> = {},
): DiagnosticPropagation {
  const trace = acceptTraceContext(
    headers,
    options.trustIncomingTrace === undefined
      ? {}
      : { trustIncoming: options.trustIncomingTrace },
  );
  const correlationId = acceptCorrelationId(headers, boundary, options.nowMs);
  return freezePropagation({
    correlationId,
    traceId: trace.traceId,
    spanId: trace.spanId,
    traceparent: trace.traceparent,
    ...(trace.tracestate === undefined ? {} : { tracestate: trace.tracestate }),
  });
}

/** 创建新的根 W3C 与 correlation 身份。/ Creates new root W3C and correlation identities. */
export function createDiagnosticPropagation(
  nowMs = Date.now(),
): DiagnosticPropagation {
  const trace = createTraceContext();
  return freezePropagation({
    correlationId: createCorrelationId(nowMs),
    traceId: trace.traceId,
    spanId: trace.spanId,
    traceparent: trace.traceparent,
  });
}

/** 防止伪造对象绕过解析器。/ Prevents forged objects from bypassing the parser. */
export function validatePropagation(
  input: DiagnosticPropagation,
): DiagnosticPropagation {
  const trace = parseTraceParent(input.traceparent);
  const state = parseTraceState(input.tracestate);
  if (
    trace === null ||
    trace.traceId !== input.traceId ||
    trace.spanId !== input.spanId ||
    !UUID_V7.test(input.correlationId) ||
    (input.tracestate !== undefined && state === undefined)
  ) {
    throw new TypeError("propagation identity is invalid or inconsistent");
  }
  return freezePropagation({
    correlationId: input.correlationId,
    traceId: input.traceId,
    spanId: input.spanId,
    traceparent: input.traceparent,
    ...(state === undefined ? {} : { tracestate: state }),
  });
}

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 复制并冻结传播身份。/ Copies and freezes propagation identity. */
function freezePropagation(
  value: DiagnosticPropagation,
): DiagnosticPropagation {
  return Object.freeze({ ...value });
}

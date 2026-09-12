const TRACEPARENT_V00 = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const TRACEPARENT_FUTURE =
  /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(?:-[0-9a-f]+)*$/;
const ALL_ZERO_TRACE = /^0{32}$/;
const ALL_ZERO_SPAN = /^0{16}$/;
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SIMPLE_STATE_KEY = /^[a-z][a-z0-9_\-*\/]{0,255}$/;
const MULTI_STATE_KEY =
  /^[a-z0-9][a-z0-9_\-*\/]{0,240}@[a-z][a-z0-9_\-*\/]{0,13}$/;

/**
 * 独立于 Cloudflare 原生 trace 的 W3C Trace Context。
 * W3C Trace Context independent of Cloudflare's native trace.
 */
export interface TraceContext {
  /** 32 位小写十六进制 trace ID。/ 32-character lowercase hexadecimal trace ID. */
  readonly traceId: string;
  /** 当前边界新建的 16 位 span ID。/ 16-character span ID created for this boundary. */
  readonly spanId: string;
  /** W3C trace flags 字节。/ W3C trace-flags byte. */
  readonly traceFlags: number;
  /** 可传播的规范 traceparent。/ Canonical propagatable traceparent. */
  readonly traceparent: string;
  /** 经校验的 tracestate。/ Validated tracestate. */
  readonly tracestate?: string;
}

/**
 * 严格解析 W3C traceparent；非法、全零或禁止版本返回 null。
 * Strictly parses W3C traceparent; malformed, all-zero, or forbidden versions return null.
 */
export function parseTraceParent(
  value: string | null | undefined,
): TraceContext | null {
  if (value === null || value === undefined) return null;
  const v00 = TRACEPARENT_V00.exec(value);
  const future = v00 === null ? TRACEPARENT_FUTURE.exec(value) : null;
  if (v00 === null && future === null) return null;

  const version = v00 === null ? future?.[1] : "00";
  const traceId = v00?.[1] ?? future?.[2];
  const spanId = v00?.[2] ?? future?.[3];
  const flagsText = v00?.[3] ?? future?.[4];
  if (
    traceId === undefined ||
    spanId === undefined ||
    flagsText === undefined ||
    version === "ff" ||
    (future !== null && version === "00") ||
    ALL_ZERO_TRACE.test(traceId) ||
    ALL_ZERO_SPAN.test(spanId)
  ) {
    return null;
  }

  const traceFlags = Number.parseInt(flagsText, 16);
  return Object.freeze({
    traceId,
    spanId,
    traceFlags,
    traceparent: value,
  });
}

/**
 * 校验并规范化 W3C tracestate。整个字段非法时不传播。
 * Validates and normalizes W3C tracestate. An invalid field is not propagated at all.
 */
export function parseTraceState(
  value: string | null | undefined,
): string | undefined {
  if (
    value === null ||
    value === undefined ||
    value.length === 0 ||
    value.length > 512
  ) {
    return undefined;
  }

  const members = value.split(",");
  if (members.length > 32) return undefined;
  const keys = new Set<string>();
  const normalized: string[] = [];
  for (const rawMember of members) {
    const member = rawMember.replace(/^\s+|\s+$/g, "");
    const equals = member.indexOf("=");
    if (equals <= 0 || member.indexOf("=", equals + 1) !== -1) return undefined;
    const key = member.slice(0, equals);
    const stateValue = member.slice(equals + 1);
    if (!isStateKey(key) || !isStateValue(stateValue) || keys.has(key))
      return undefined;
    keys.add(key);
    normalized.push(`${key}=${stateValue}`);
  }
  return normalized.join(",");
}

/**
 * 使用 Web Crypto 创建新的 W3C 根上下文。
 * Creates a new W3C root context with Web Crypto.
 */
export function createTraceContext(sampled = false): TraceContext {
  return makeContext(randomHex(16), randomHex(8), sampled ? 1 : 0);
}

/**
 * 接收入站上下文并在边界生成新的 span ID；不可信或非法输入会形成新 trace。
 * Accepts inbound context and generates a new span ID at the boundary; untrusted or invalid input starts a new trace.
 */
export function acceptTraceContext(
  headers: Headers,
  options: Readonly<{ trustIncoming?: boolean; sampled?: boolean }> = {},
): TraceContext {
  const incoming =
    options.trustIncoming === false
      ? null
      : parseTraceParent(headers.get("traceparent"));
  if (incoming === null) return createTraceContext(options.sampled);

  const context = makeContext(
    incoming.traceId,
    randomHex(8),
    incoming.traceFlags,
  );
  const tracestate = parseTraceState(headers.get("tracestate"));
  return tracestate === undefined
    ? context
    : Object.freeze({ ...context, tracestate });
}

/**
 * 把已校验上下文写入出站 Headers；tracestate 缺失时删除旧值。
 * Writes validated context to outbound Headers and removes stale tracestate when absent.
 */
export function injectTraceContext(
  headers: Headers,
  context: TraceContext,
): Headers {
  headers.set("traceparent", context.traceparent);
  if (context.tracestate === undefined) headers.delete("tracestate");
  else headers.set("tracestate", context.tracestate);
  return headers;
}

/**
 * 用 Web Crypto 生成 RFC 9562 UUIDv7 关联 ID。
 * Generates an RFC 9562 UUIDv7 correlation ID with Web Crypto.
 */
export function createCorrelationId(nowMs = Date.now()): string {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > 0xffff_ffff_ffff) {
    throw new RangeError("nowMs must fit the UUIDv7 48-bit timestamp");
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let timestamp = nowMs;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp % 256;
    timestamp = Math.floor(timestamp / 256);
  }
  const byte6 = bytes[6];
  const byte8 = bytes[8];
  if (byte6 === undefined || byte8 === undefined)
    throw new Error("crypto buffer invariant failed");
  bytes[6] = (byte6 & 0x0f) | 0x70;
  bytes[8] = (byte8 & 0x3f) | 0x80;
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * 公网边界总是换新关联 ID；内部边界只传播合法 UUIDv7。
 * Public boundaries always rotate the correlation ID; internal boundaries propagate only valid UUIDv7 values.
 */
export function acceptCorrelationId(
  headers: Headers,
  boundary: "public" | "internal",
  nowMs = Date.now(),
): string {
  const incoming = headers.get("x-moesegfault-correlation-id");
  return boundary === "internal" && incoming !== null && UUID_V7.test(incoming)
    ? incoming
    : createCorrelationId(nowMs);
}

/** 建立规范 v00 上下文。/ Builds a canonical v00 context. */
function makeContext(
  traceId: string,
  spanId: string,
  traceFlags: number,
): TraceContext {
  const flags = traceFlags & 0xff;
  return Object.freeze({
    traceId,
    spanId,
    traceFlags: flags,
    traceparent: `00-${traceId}-${spanId}-${flags.toString(16).padStart(2, "0")}`,
  });
}

/** 生成非全零小写十六进制 ID。/ Generates a non-zero lowercase hexadecimal ID. */
function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  do {
    crypto.getRandomValues(bytes);
  } while (bytes.every((byte) => byte === 0));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 校验 tracestate key。/ Validates a tracestate key. */
function isStateKey(value: string): boolean {
  return SIMPLE_STATE_KEY.test(value) || MULTI_STATE_KEY.test(value);
}

/** 校验 tracestate value 的 ASCII 与空格边界。/ Validates tracestate value ASCII and whitespace boundaries. */
function isStateValue(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 256 ||
    value.startsWith(" ") ||
    value.endsWith(" ")
  ) {
    return false;
  }
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code > 0x7e || character === "," || character === "=")
      return false;
  }
  return true;
}

import type { AttributePolicy, AttributeValue } from "./types.js";

const DEFAULT_MAX_STRING_LENGTH = 1_024;
const MAX_ARRAY_LENGTH = 64;
const ATTRIBUTE_KEY = /^[a-zA-Z][a-zA-Z0-9_.-]{0,254}$/;
const ALWAYS_SECRET_KEY =
  /(?:^|[._-])(authorization|cookie|password|passwd|secret|token|api[_-]?key)(?:$|[._-])/i;
const INLINE_SECRET =
  /\b(?:bearer|basic)\s+[a-z0-9._~+\-/]+=*|\b(?:password|passwd|secret|token|api[_-]?key|authorization|cookie)\s*[:=]\s*[^\s,;]+|\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/gi;
const JWT = /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/g;

/**
 * 按显式允许列表复制属性，同时删除无效类型并清理文本。
 * Copies attributes through an explicit allowlist while rejecting invalid types and scrubbing text.
 */
export function sanitizeAttributes(
  input: Readonly<Record<string, unknown>>,
  policy: AttributePolicy,
): Readonly<Record<string, AttributeValue>> {
  const output: Record<string, AttributeValue> = Object.create(null) as Record<
    string,
    AttributeValue
  >;
  const maxLength = validMaxLength(policy.maxStringLength);

  for (const key of Object.keys(input).sort()) {
    if (!policy.allowed.has(key) || !ATTRIBUTE_KEY.test(key)) continue;
    const value = input[key];
    if (policy.redact?.has(key) === true || ALWAYS_SECRET_KEY.test(key)) {
      output[key] = "[REDACTED]";
      continue;
    }
    const safe = sanitizeValue(value, maxLength);
    if (safe !== undefined) output[key] = safe;
  }
  return Object.freeze(output);
}

/**
 * 清理人类可读摘要中的常见凭据形态并限制大小。
 * Scrubs common credential shapes from human-readable summaries and bounds their size.
 *
 * 这不是任意秘密检测器；调用方仍不得把正文或凭据传入遥测。
 * This is not a general secret detector; callers must still never pass payloads or credentials.
 */
export function sanitizeText(
  value: string,
  maxLength = DEFAULT_MAX_STRING_LENGTH,
): string {
  const limit = validMaxLength(maxLength);
  const scrubbed = value
    .replace(INLINE_SECRET, "[REDACTED]")
    .replace(JWT, "[REDACTED]");
  return scrubbed.length <= limit
    ? scrubbed
    : `${scrubbed.slice(0, limit - 1)}…`;
}

/** 校验字符串界限。/ Validates the string bound. */
function validMaxLength(value: number | undefined): number {
  const candidate = value ?? DEFAULT_MAX_STRING_LENGTH;
  if (!Number.isInteger(candidate) || candidate < 16 || candidate > 16_384) {
    throw new RangeError("maxStringLength must be an integer in 16..16384");
  }
  return candidate;
}

/** 转换一个属性值。/ Converts one attribute value. */
function sanitizeValue(
  value: unknown,
  maxLength: number,
): AttributeValue | undefined {
  if (typeof value === "string") return sanitizeText(value, maxLength);
  if (typeof value === "boolean") return value;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (
    !Array.isArray(value) ||
    value.length > MAX_ARRAY_LENGTH ||
    value.length === 0
  ) {
    return undefined;
  }

  if (value.every((item): item is string => typeof item === "string")) {
    return Object.freeze(value.map((item) => sanitizeText(item, maxLength)));
  }
  if (value.every((item): item is boolean => typeof item === "boolean")) {
    return Object.freeze([...value]);
  }
  if (
    value.every(
      (item): item is number =>
        typeof item === "number" && Number.isFinite(item),
    )
  ) {
    return Object.freeze([...value]);
  }
  return undefined;
}

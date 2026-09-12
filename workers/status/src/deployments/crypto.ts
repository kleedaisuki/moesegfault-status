/** 对 JSON 做确定性排序；数组顺序具有语义，不做重排 / Deterministically sort JSON objects while preserving semantic array order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

/** 计算契约使用的 SHA-256 内容摘要 / Compute a contract-form SHA-256 content digest. */
export async function sha256Digest(value: string): Promise<`sha256:${string}`> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${toHex(digest)}`;
}

/** ArrayBuffer 的小写十六进制编码 / Lowercase hexadecimal encoding of an ArrayBuffer. */
export function toHex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** 生成 RFC 9562 UUIDv7；时间来自依赖以支持可复现测试 / Generate RFC 9562 UUIDv7 using the injected clock for reproducible tests. */
export function uuidV7(now: Date): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let milliseconds = BigInt(now.getTime());
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(milliseconds & 0xffn);
    milliseconds >>= 8n;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

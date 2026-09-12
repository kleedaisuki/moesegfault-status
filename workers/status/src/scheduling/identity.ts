/** 由稳定 seed 生成时间有序 UUIDv7，用于重试幂等事件。 / Derive a time-ordered UUIDv7 from a stable seed for retry-idempotent events. */
export async function deterministicUuidV7(
  timeMs: number,
  seed: string,
): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed)),
  );
  return formatUuidV7(timeMs, digest);
}

/** 使用 Web Crypto 生成 UUIDv7。 / Generate a UUIDv7 with Web Crypto. */
export function randomUuidV7(timeMs: number): string {
  const random = crypto.getRandomValues(new Uint8Array(16));
  return formatUuidV7(timeMs, random);
}

function formatUuidV7(timeMs: number, entropy: Uint8Array): string {
  const bytes = entropy.slice(0, 16);
  let timestamp = BigInt(Math.max(0, Math.floor(timeMs)));
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

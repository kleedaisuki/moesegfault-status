const VERSION = 1;
const TTL_SECONDS = 15 * 60;
const encoder = new TextEncoder();

/** 已签名 keyset 游标的业务载荷。 / Business payload carried by a signed keyset cursor. */
export interface CursorPayload<Key extends Record<string, unknown>> {
  /** 路由绑定防止跨 endpoint 重放。 / Route binding prevents cross-endpoint replay. */
  readonly route: string;
  /** 规范化查询绑定。 / Canonical query binding. */
  readonly query: string;
  /** 排序契约绑定。 / Sort-contract binding. */
  readonly sort: string;
  /** 最后一行的 keyset。 / Keyset of the last returned row. */
  readonly key: Key;
}

interface WireCursor<
  Key extends Record<string, unknown>,
> extends CursorPayload<Key> {
  readonly v: typeof VERSION;
  readonly exp: number;
}

/** 游标错误，可安全映射为 400。 / Cursor error safe to map to HTTP 400. */
export class InvalidCursorError extends Error {
  public constructor(message = "Invalid or expired cursor") {
    super(message);
    this.name = "InvalidCursorError";
  }
}

/** 签发与 endpoint/filter/sort 绑定的不透明 keyset 游标。 / Sign an opaque keyset cursor bound to endpoint, filters, and sort. */
export async function signCursor<Key extends Record<string, unknown>>(
  payload: CursorPayload<Key>,
  secret: string,
  now: Date,
): Promise<string> {
  assertSecret(secret);
  const wire: WireCursor<Key> = {
    v: VERSION,
    route: payload.route,
    query: payload.query,
    sort: payload.sort,
    key: payload.key,
    exp: Math.floor(now.getTime() / 1_000) + TTL_SECONDS,
  };
  const body = encodeBase64Url(encoder.encode(JSON.stringify(wire)));
  const signature = encodeBase64Url(await hmac(body, secret));
  return `${body}.${signature}`;
}

/** 验证并解码绑定的 keyset 游标。 / Verify and decode a bound keyset cursor. */
export async function verifyCursor<Key extends Record<string, unknown>>(
  value: string,
  binding: Pick<CursorPayload<Key>, "route" | "query" | "sort">,
  secret: string,
  now: Date,
): Promise<Key> {
  assertSecret(secret);
  const [body, signature, extra] = value.split(".");
  if (!body || !signature || extra !== undefined)
    throw new InvalidCursorError();

  let supplied: Uint8Array<ArrayBuffer>;
  try {
    supplied = decodeBase64Url(signature);
  } catch {
    throw new InvalidCursorError();
  }
  const key = await importHmacKey(secret);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    supplied.buffer,
    encoder.encode(body),
  );
  if (!valid) throw new InvalidCursorError();

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(decodeBase64Url(body)));
  } catch {
    throw new InvalidCursorError();
  }
  if (!isWireCursor(parsed)) throw new InvalidCursorError();
  if (
    parsed.v !== VERSION ||
    parsed.route !== binding.route ||
    parsed.query !== binding.query ||
    parsed.sort !== binding.sort
  ) {
    throw new InvalidCursorError();
  }
  if (parsed.exp <= Math.floor(now.getTime() / 1_000))
    throw new InvalidCursorError();
  return parsed.key as Key;
}

async function hmac(
  value: string,
  secret: string,
): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await importHmacKey(secret),
      encoder.encode(value),
    ),
  );
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** 处理公共路由前确认游标 secret 已配置。 / Ensure the cursor secret is configured before serving a public route. */
export function assertCursorSecret(secret: string): void {
  if (secret.trim().length === 0)
    throw new Error("Public API cursorSecret is required");
}

function assertSecret(secret: string): void {
  assertCursorSecret(secret);
}

function isWireCursor(
  value: unknown,
): value is WireCursor<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const cursor = value as Record<string, unknown>;
  return (
    cursor.v === VERSION &&
    typeof cursor.route === "string" &&
    typeof cursor.query === "string" &&
    typeof cursor.sort === "string" &&
    typeof cursor.exp === "number" &&
    Number.isSafeInteger(cursor.exp) &&
    typeof cursor.key === "object" &&
    cursor.key !== null &&
    !Array.isArray(cursor.key)
  );
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new InvalidCursorError();
  const base64 = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
}

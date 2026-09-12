import { ProblemDetailsSchema } from "@moesegfault/contracts";

const DEFAULT_PUBLIC_ORIGIN = "https://status.moesegfault.dev";

/** 可运行时校验的响应 schema。 / Runtime-validatable response schema. */
export interface RuntimeSchema<T> {
  /** 校验并返回值，失败时抛错。 / Validate and return a value, throwing on failure. */
  parse(value: unknown): T;
}

/** 输出经共享契约校验的 JSON。 / Emit JSON validated by the shared runtime contract. */
export function jsonResponse<T>(
  schema: RuntimeSchema<T>,
  value: unknown,
  correlationId: string,
  status = 200,
): Response {
  const body = schema.parse(value);
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=30, stale-if-error=60",
      "x-content-type-options": "nosniff",
      "x-moesegfault-correlation-id": correlationId,
    },
  });
}

/** 输出不包含内部异常的 RFC 9457 问题响应。 / Emit an RFC 9457 response without internal exception details. */
export function problemResponse(
  status: 400 | 404 | 500,
  slug: "invalid-request" | "not-found" | "internal-error",
  title: string,
  detail: string,
  request: Request,
  correlationId: string,
): Response {
  const body = ProblemDetailsSchema.parse({
    type: `https://status.moesegfault.dev/problems/${slug}`,
    title,
    status,
    detail,
    instance: new URL(request.url).pathname,
    correlation_id: correlationId,
  });
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/problem+json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-moesegfault-correlation-id": correlationId,
    },
  });
}

/** 生成 RFC 9562 UUIDv7，作为 root wrapper 未注入 ID 时的安全后备。 / Generate an RFC 9562 UUIDv7 fallback when the root wrapper did not inject an ID. */
export function uuidV7(now: Date): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let timestamp = BigInt(now.getTime());
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 查询输入错误。 / Public query-input error. */
export class InvalidRequestError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InvalidRequestError";
  }
}

/** 解析有界列表 limit。 / Parse a bounded list limit. */
export function parseLimit(value: string | null): number {
  if (value === null) return 50;
  if (!/^[1-9]\d{0,2}$/u.test(value))
    throw new InvalidRequestError(
      "limit must be an integer from 1 through 100",
    );
  const limit = Number(value);
  if (limit > 100)
    throw new InvalidRequestError(
      "limit must be an integer from 1 through 100",
    );
  return limit;
}

/** 拒绝未声明 query 参数，防止误以为过滤已生效。 / Reject undeclared query parameters so callers never assume an ignored filter applied. */
export function assertQueryKeys(
  search: URLSearchParams,
  allowed: ReadonlySet<string>,
): void {
  for (const key of search.keys()) {
    if (!allowed.has(key))
      throw new InvalidRequestError(`Unknown query parameter: ${key}`);
  }
}

/**
 * 以可信的 HTTPS origin 构造规范 self link，仅从请求复用 path/query。
 * Build a canonical self link from a trusted HTTPS origin, reusing only the
 * request path and query. This keeps local workerd URLs and forged Host
 * headers out of the public contract.
 */
export function publicSelfLink(
  request: Request,
  configuredOrigin?: string,
): string {
  const origin = new URL(configuredOrigin ?? DEFAULT_PUBLIC_ORIGIN);
  if (
    origin.protocol !== "https:" ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== ""
  ) {
    throw new Error(
      "publicOrigin must be an HTTPS origin without credentials, path, query, or fragment",
    );
  }
  const incoming = new URL(request.url);
  const canonical = new URL(origin.origin);
  canonical.pathname = incoming.pathname;
  canonical.search = incoming.search;
  return canonical.toString();
}

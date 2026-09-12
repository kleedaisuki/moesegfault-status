/** 有明确 HTTP 语义的安全错误；消息不得含秘密。 / Safe HTTP error; messages must never contain secrets. */
export class HttpError extends Error {
  /** 创建领域错误。 / Construct a domain HTTP error. */
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** 生成不可预测 UUIDv7，排序不依赖客户端时钟。 / Generate random UUIDv7; domain ordering never trusts client clocks. */
export function uuidv7(now = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let timestamp = BigInt(now);
  for (let index = 5; index >= 0; index--) {
    bytes[index] = Number(timestamp & 255n);
    timestamp >>= 8n;
  }
  bytes[6] = (bytes[6]! & 15) | 112;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 限制流读取，而不是相信 Content-Length。 / Bound streamed reads rather than trusting Content-Length.
 * @example const body = await readJson(request, 65536);
 */
export async function readJson(
  request: Request,
  maximumBytes = 65536,
): Promise<unknown> {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
    "application/json"
  ) {
    throw new HttpError(
      415,
      "unsupported-media-type",
      "application/json is required",
    );
  }
  const declared = request.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)
  ) {
    throw new HttpError(
      413,
      "payload-too-large",
      "Request body exceeds the limit",
    );
  }
  if (!request.body)
    throw new HttpError(400, "invalid-json", "JSON body is required");
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new HttpError(
          413,
          "payload-too-large",
          "Request body exceeds the limit",
        );
      }
      parts.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
  } catch {
    throw new HttpError(
      400,
      "invalid-json",
      "Body must contain valid UTF-8 JSON",
    );
  }
}

/** 错误响应只投影安全字段，不输出 SQL、token 或异常堆栈。 / Project only safe error fields, never SQL, tokens, or stacks. */
export function problemResponse(
  error: unknown,
  request: Request,
  correlationId: string,
): Response {
  const safe =
    error instanceof HttpError
      ? error
      : new HttpError(
          503,
          "service-unavailable",
          "Service temporarily unavailable",
        );
  return Response.json(
    {
      type: `https://status.moesegfault.dev/problems/${safe.code}`,
      title: safe.message,
      status: safe.status,
      instance: new URL(request.url).pathname,
      correlation_id: correlationId,
    },
    {
      status: safe.status,
      headers: {
        "content-type": "application/problem+json",
        "cache-control": "no-store",
        "x-moesegfault-correlation-id": correlationId,
        ...(safe.status === 503 ? { "retry-after": "5" } : {}),
      },
    },
  );
}

/** 为所有响应补充关联标识和防嗅探头。 / Attach correlation and nosniff to every response. */
export function withResponseHeaders(
  response: Response,
  correlationId: string,
): Response {
  const headers = new Headers(response.headers);
  headers.set("x-moesegfault-correlation-id", correlationId);
  headers.set("x-content-type-options", "nosniff");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** 管理命令正文的硬上限 / Hard limit for administrative command bodies. */
export const MAX_COMMAND_BYTES = 32 * 1024;

/** 网关可以安全呈现的 RFC 9457 字段 / RFC 9457 fields safe for gateway rendering. */
export interface ProblemInit {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
}

/**
 * 将预期的 HTTP 拒绝与编程错误分离。
 * Separates expected HTTP rejections from programming failures.
 */
export class HttpProblem extends Error {
  readonly problem: ProblemInit;

  constructor(problem: ProblemInit) {
    super(problem.title);
    this.name = "HttpProblem";
    this.problem = problem;
  }
}

/**
 * 验证运维前端的唯一允许来源。
 * Validates the one allowed operations-frontend origin.
 */
export function parseConfiguredOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("OPS_ORIGIN must be an absolute URL origin");
  }

  const isLocal =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (
    (url.protocol !== "https:" && !isLocal) ||
    url.origin !== value ||
    url.username ||
    url.password
  ) {
    throw new Error("OPS_ORIGIN must be an exact HTTPS origin");
  }
  return url.origin;
}

/**
 * 对所有非安全方法执行来源与自定义头双重 CSRF 防护。
 * Enforces both Origin and custom-header CSRF defenses for every unsafe method.
 */
export function enforceMutationGuards(
  request: Request,
  allowedOrigin: string,
): void {
  if (request.headers.get("origin") !== allowedOrigin) {
    throw new HttpProblem(
      problem("cross-origin-request", "Cross-origin request rejected", 403),
    );
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null && fetchSite !== "same-origin") {
    throw new HttpProblem(
      problem("cross-origin-request", "Cross-origin request rejected", 403),
    );
  }
  if (request.headers.get("x-moesegfault-csrf") !== "1") {
    throw new HttpProblem(
      problem("csrf-check-failed", "CSRF check failed", 403),
    );
  }
  const contentEncoding = request.headers
    .get("content-encoding")
    ?.toLowerCase();
  if (contentEncoding !== undefined && contentEncoding !== "identity") {
    throw new HttpProblem(
      problem(
        "unsupported-content-encoding",
        "Compressed command bodies are not accepted",
        415,
      ),
    );
  }
  const contentType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw new HttpProblem(
      problem(
        "unsupported-media-type",
        "Content-Type must be application/json",
        415,
      ),
    );
  }
}

/**
 * 以流式硬上限读取 JSON，避免伪造或缺失 Content-Length 绕过限制。
 * Reads JSON with a streaming hard limit so a forged or absent Content-Length cannot bypass it.
 */
export async function readBoundedJson(
  request: Request,
  limit = MAX_COMMAND_BYTES,
): Promise<unknown> {
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > limit)
  ) {
    throw new HttpProblem(
      problem("command-too-large", "Command body is too large", 413),
    );
  }
  if (request.body === null) {
    throw new HttpProblem(
      problem("invalid-json", "A JSON command body is required", 400),
    );
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel("command body limit exceeded").catch(() => undefined);
      throw new HttpProblem(
        problem("command-too-large", "Command body is too large", 413),
      );
    }
    chunks.push(value);
  }
  if (size === 0) {
    throw new HttpProblem(
      problem("invalid-json", "A JSON command body is required", 400),
    );
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpProblem(
      problem("invalid-json", "Command body must be valid UTF-8 JSON", 400),
    );
  }
}

/**
 * 从强 ETag 读取乐观并发 revision；不接受通配符或弱 validator。
 * Reads an optimistic revision from a strong ETag; wildcards and weak validators are rejected.
 */
export function requireExpectedRevision(request: Request): number {
  const value = request.headers.get("if-match");
  const match = /^"([1-9]\d{0,9})"$/.exec(value ?? "");
  const revision = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(revision)) {
    throw new HttpProblem(
      problem(
        "precondition-required",
        "A strong numeric If-Match value is required",
        428,
      ),
    );
  }
  return revision;
}

/**
 * 构造带统一安全头和关联 ID 的 JSON 响应。
 * Builds a JSON response with uniform security headers and correlation ID.
 */
export function jsonResponse(
  body: unknown,
  status: number,
  correlationId: string,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders("application/json; charset=utf-8", correlationId),
  });
}

/**
 * 构造完整且不泄漏内部异常的 RFC 9457 响应。
 * Builds a complete RFC 9457 response without leaking internal exceptions.
 */
export function problemResponse(
  init: ProblemInit,
  instance: string,
  correlationId: string,
): Response {
  const body: Record<string, unknown> = {
    type: init.type,
    title: init.title,
    status: init.status,
    instance,
    correlation_id: correlationId,
  };
  if (init.detail !== undefined) body.detail = init.detail;
  return new Response(JSON.stringify(body), {
    status: init.status,
    headers: responseHeaders(
      "application/problem+json; charset=utf-8",
      correlationId,
    ),
  });
}

/** 创建命名稳定的问题定义 / Creates a stable named problem definition. */
export function problem(
  slug: string,
  title: string,
  status: number,
  detail?: string,
): ProblemInit {
  const base = {
    type: `https://ops.moesegfault.dev/problems/${slug}`,
    title,
    status,
  };
  return detail === undefined ? base : { ...base, detail };
}

/** 统一禁止缓存和跨源读取 / Uniformly disables caching and cross-origin reads. */
function responseHeaders(contentType: string, correlationId: string): Headers {
  return new Headers({
    "cache-control": "no-store",
    "content-type": contentType,
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-moesegfault-correlation-id": correlationId,
  });
}

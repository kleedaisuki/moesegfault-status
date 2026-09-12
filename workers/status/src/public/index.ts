import { InvalidCursorError, assertCursorSecret } from "./cursor.js";
import {
  getIncident,
  getPlatformStatus,
  getServiceStatus,
  listIncidents,
  listMaintenanceWindows,
  listServices,
} from "./handlers.js";
import { InvalidRequestError, problemResponse, uuidV7 } from "./http.js";
import type { PublicApiContext } from "./types.js";

export {
  getIncident,
  getPlatformStatus,
  getServiceStatus,
  listIncidents,
  listMaintenanceWindows,
  listServices,
};

export type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1QueryResult,
  PublicApiContext,
  PublicDependencyCore,
} from "./types.js";

/**
 * 路由六个匿名、只读的公共状态 endpoint。
 * Route the six anonymous, read-only public status endpoints.
 *
 * 未匹配时返回 `undefined`，以便 Worker 根路由继续处理其他信任域。
 * Returns `undefined` when unmatched so the Worker root can continue routing
 * other trust domains.
 *
 * @example
 * ```ts
 * const response = await handlePublic(request, {
 *   DB: env.DB,
 *   cursorSecret: env.PUBLIC_CURSOR_SECRET,
 *   correlationId,
 *   dependencyCore: wasmCore,
 * });
 * if (response) return response;
 * ```
 */
export async function handlePublic(
  request: Request,
  context: PublicApiContext,
): Promise<Response | undefined> {
  if (request.method !== "GET") return undefined;
  const url = new URL(request.url);
  const now = context.now?.() ?? new Date();
  const correlationId = context.correlationId ?? uuidV7(now);
  try {
    assertCursorSecret(context.cursorSecret);
    if (request.url.length > 2_048)
      throw new InvalidRequestError("Request URL is too long");
    if (url.pathname === "/v1/status")
      return await getPlatformStatus(request, context, correlationId);
    if (url.pathname === "/v1/services")
      return await listServices(request, context, correlationId);
    if (url.pathname === "/v1/incidents")
      return await listIncidents(request, context, correlationId);
    if (url.pathname === "/v1/maintenance-windows")
      return await listMaintenanceWindows(request, context, correlationId);

    const service = matchPath(url.pathname, /^\/v1\/services\/([^/]+)$/u);
    if (service !== undefined)
      return await getServiceStatus(request, context, correlationId, service);
    const incident = matchPath(url.pathname, /^\/v1\/incidents\/([^/]+)$/u);
    if (incident !== undefined)
      return await getIncident(request, context, correlationId, incident);
    return undefined;
  } catch (error) {
    if (
      error instanceof InvalidRequestError ||
      error instanceof InvalidCursorError
    ) {
      return problemResponse(
        400,
        "invalid-request",
        "Invalid request",
        error.message,
        request,
        correlationId,
      );
    }
    return problemResponse(
      500,
      "internal-error",
      "Internal server error",
      "The status service could not complete the public read.",
      request,
      correlationId,
    );
  }
}

function matchPath(pathname: string, expression: RegExp): string | undefined {
  const match = expression.exec(pathname);
  if (!match?.[1]) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    throw new InvalidRequestError(
      "Path parameter contains invalid percent encoding",
    );
  }
}

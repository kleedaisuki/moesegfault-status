import {
  DiagnosticEventSchema,
  DiagnosticQueueEnvelopeSchema,
  type DiagnosticQueueEnvelope,
} from "@moesegfault/contracts";
import {
  HttpError,
  problemResponse,
  readJson,
  uuidv7,
} from "../platform/http.js";
import type {
  DiagnosticIngestContext,
  DiagnosticIngestEnv,
  MachinePrincipal,
} from "./types.js";

const MAX_BODY_BYTES = 64 * 1024;
const INGEST_SCOPE = "diagnostics:write";

/**
 * 验证认证 claims 与请求正文完全一致。 / Verify authenticated claims exactly match the request body.
 *
 * 这里不再解析 token；`principal` 必须由公共认证层构造。
 * Tokens are not parsed here; the shared authentication layer must construct `principal`.
 */
function authorize(
  event: { service_name: string; environment: string; deployment_id: string },
  principal: MachinePrincipal,
): boolean {
  return (
    principal.scopes.has(INGEST_SCOPE) &&
    principal.serviceNames.has(event.service_name) &&
    principal.environments.has(event.environment) &&
    principal.deploymentIds.has(event.deployment_id)
  );
}

/**
 * 接收并校验 DiagnosticEvent，然后只将不可变信封写入 Queue。
 * Validate a DiagnosticEvent and publish only an immutable envelope to Queue.
 *
 * @example
 * ```ts
 * return ingest(request, env, principal, { correlationId });
 * ```
 */
export async function ingest(
  request: Request,
  env: DiagnosticIngestEnv,
  principal: MachinePrincipal,
  context: DiagnosticIngestContext,
): Promise<Response> {
  let input: unknown;
  try {
    input = await readJson(request, MAX_BODY_BYTES);
  } catch (error) {
    return problemResponse(error, request, context.correlationId);
  }

  const result = DiagnosticEventSchema.safeParse(input);
  if (!result.success) {
    return problemResponse(
      new HttpError(
        422,
        "invalid-diagnostic-event",
        "Diagnostic event validation failed",
      ),
      request,
      context.correlationId,
    );
  }
  const event = result.data;
  if (!authorize(event, principal)) {
    return problemResponse(
      new HttpError(
        403,
        "diagnostic-claim-mismatch",
        "Machine identity is not authorized for this diagnostic",
      ),
      request,
      context.correlationId,
    );
  }
  if (event.correlation_id !== context.correlationId) {
    return problemResponse(
      new HttpError(
        403,
        "diagnostic-correlation-mismatch",
        "Correlation identity does not match",
      ),
      request,
      context.correlationId,
    );
  }

  const now = (context.now ?? (() => new Date()))();
  const envelopeInput = {
    schema_version: "1.0",
    message_id: uuidv7(now.getTime()),
    event,
    received_at: now.toISOString(),
    producer: {
      subject: principal.subject,
      service_name: event.service_name,
      environment: event.environment,
      deployment_id: event.deployment_id,
      // 队列只需保存已使用的权限，不扩散 token 的其他权限。
      // Persist only the exercised permission; do not spread unrelated token privileges.
      scopes: [INGEST_SCOPE],
      token_id: principal.tokenId,
      auth_method: principal.authMethod,
    },
    trace_context: {
      correlation_id: context.correlationId,
      ...(context.traceparent === undefined
        ? {}
        : { traceparent: context.traceparent }),
      ...(context.tracestate === undefined
        ? {}
        : { tracestate: context.tracestate }),
    },
  };
  const envelope: DiagnosticQueueEnvelope =
    DiagnosticQueueEnvelopeSchema.parse(envelopeInput);

  try {
    await env.DIAGNOSTIC_QUEUE.send(envelope, { contentType: "json" });
  } catch {
    return problemResponse(
      new HttpError(
        503,
        "diagnostic-queue-unavailable",
        "Diagnostic queue is temporarily unavailable",
      ),
      request,
      context.correlationId,
    );
  }

  return Response.json(
    { event_id: event.event_id, accepted: true },
    {
      status: 202,
      headers: {
        "cache-control": "no-store",
        "x-moesegfault-correlation-id": context.correlationId,
      },
    },
  );
}

/** 与 Worker router 命名一致的显式别名。 / Explicit alias matching Worker router naming. */
export const ingestDiagnosticEvent = ingest;

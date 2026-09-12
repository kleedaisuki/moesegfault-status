import { parseTraceParent, type Telemetry } from "@moesegfault/telemetry";
import {
  RegionalProbeRequestSchema,
  RegionalProbeResponseSchema,
} from "../../../packages/contracts/src/regional-probe.js";
import {
  executeProbe,
  type ProbeDependencies,
} from "../../status/src/scheduling/probes.js";
import { readRegionalJson } from "../../status/src/scheduling/regional-dispatch.js";

/** 执行器配置身份，不是地理来源。 / Executor configuration identity is not geographic provenance. */
export interface ExecutorIdentity {
  readonly executorId: string;
  readonly location: string;
  readonly allowedKinds: readonly string[];
}
/** 私有 fetch 处理器；调用方不得提供 cf-placement，平台负责注入。 / Private fetch handler; callers must omit cf-placement so the platform supplies it. */
export async function handleRegionalProbe(
  request: Request,
  identity: ExecutorIdentity,
  dependencies: ProbeDependencies,
  telemetry?: Telemetry,
): Promise<Response> {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/probe")
    return new Response(null, { status: 404 });
  try {
    const placement = /^(?:remote|local)-([A-Z]{3})$/.exec(
      request.headers.get("cf-placement") ?? "",
    );
    if (!placement) return new Response(null, { status: 503 });
    const body = RegionalProbeRequestSchema.parse(
      await readRegionalJson(
        new Response(request.body),
        AbortSignal.any([request.signal, AbortSignal.timeout(2000)]),
      ),
    );
    const remaining = Date.parse(body.deadline_at) - dependencies.now();
    if (
      body.executor_id !== identity.executorId ||
      body.location !== identity.location ||
      !identity.allowedKinds.includes(body.probe.kind)
    )
      return new Response(null, { status: 403 });
    if (remaining <= 0 || remaining > 302000)
      return new Response(null, { status: 408 });
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(Math.min(body.timeout_ms, remaining)),
    ]);
    const observation = await executeProbe(
      body.monitor_id,
      body.probe,
      body.correlation_id,
      {
        ...dependencies,
        // 区域间不能共享 Observation 身份；重试保持相同身份。 / Distinct executors cannot share observation IDs; retries retain identity.
        id: (_time, purpose) =>
          dependencies.id(
            Date.parse(body.scheduled_for),
            `${body.executor_id}:${body.run_id}:${purpose}`,
          ),
        provenance: { runtime: "cloudflare-worker", location: body.location },
      },
      signal,
      {
        correlationId: body.correlation_id,
        traceparent: body.traceparent,
        userAgent: dependencies.userAgent,
      },
    );
    const { execution: _, ...sample } = observation;
    const response = RegionalProbeResponseSchema.parse({
      version: "1",
      executor_id: identity.executorId,
      location: identity.location,
      run_id: body.run_id,
      scheduled_for: body.scheduled_for,
      actual_colo: placement[1],
      observation: sample,
    });
    const trace = parseTraceParent(body.traceparent);
    telemetry?.logger.emit(
      {
        eventName: "probe.executor.completed",
        severity: "INFO",
        body: "Regional probe completed",
        attributes: {
          "operation.name": "probe.execute",
          "http.response.status_code": 200,
        },
      },
      { correlationId: body.correlation_id, ...(trace ? { trace } : {}) },
    );
    return Response.json(response, {
      headers: { "cache-control": "no-store" },
    });
  } catch {
    return new Response(null, { status: 400 });
  }
}

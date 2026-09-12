import { createTraceContext } from "@moesegfault/telemetry";
import {
  RegionalProbeRegistrySchema,
  RegionalProbeRequestSchema,
  RegionalProbeResponseSchema,
} from "../../../../packages/contracts/src/regional-probe.js";
import type { ClaimedMonitor, Observation } from "./types.js";

/** 从有界流读取协议；响应长度不可由对端声明代替。 / Read a bounded protocol stream, never trusting the declared response length. */
export async function readRegionalJson(
  response: Response,
  signal?: AbortSignal,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("regional_body_missing");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await withinSignal(reader.read(), signal);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 16384) throw new Error("regional_body_limit");
      chunks.push(part.value);
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body));
}

/** 区域分派不把传输失败伪装为被测服务故障。 / Regional dispatch never turns executor transport failure into target failure.
 * @example createRegionalDispatcher(env, env.PROBE_REGIONAL_CONFIG).dispatch(monitor, "asia", runId, correlationId, signal)
 */
export function createRegionalDispatcher(
  env: object,
  configJson: string,
  now: () => number = Date.now,
) {
  const registry = RegionalProbeRegistrySchema.parse(JSON.parse(configJson));
  return {
    async dispatch(
      monitor: ClaimedMonitor,
      location: string,
      runId: string,
      correlationId: string,
      signal: AbortSignal,
    ): Promise<Observation | null> {
      const config = registry[location];
      if (
        !config ||
        !config.allowed_kinds.includes(monitor.probe.kind) ||
        signal.aborted
      )
        return null;
      const binding: unknown = Reflect.get(env, config.binding);
      if (
        typeof binding !== "object" ||
        binding === null ||
        !("fetch" in binding) ||
        typeof binding.fetch !== "function"
      )
        return null;
      const started = now();
      const deadline = started + monitor.timeoutMs + 2000;
      try {
        const body = RegionalProbeRequestSchema.parse({
          version: "1",
          executor_id: config.executor_id,
          location,
          run_id: runId,
          monitor_id: monitor.monitorId,
          correlation_id: correlationId,
          deadline_at: new Date(deadline).toISOString(),
          scheduled_for: monitor.scheduledFor,
          traceparent: createTraceContext().traceparent,
          timeout_ms: monitor.timeoutMs,
          probe: monitor.probe,
        });
        const timeout = AbortSignal.any([
          signal,
          AbortSignal.timeout(monitor.timeoutMs + 2000),
        ]);
        const response: Response = await withinSignal(
          binding.fetch(
            new Request("https://regional.internal/probe", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
              signal: timeout,
            }),
          ),
          timeout,
        );
        if (!response.ok) {
          await response.body?.cancel();
          return null;
        }
        const result = RegionalProbeResponseSchema.parse(
          await readRegionalJson(response, timeout),
        );
        const observed = Date.parse(result.observation.observedAt);
        if (
          result.scheduled_for !== monitor.scheduledFor ||
          result.executor_id !== config.executor_id ||
          result.location !== location ||
          result.run_id !== runId ||
          !config.allowed_colos.includes(result.actual_colo) ||
          result.observation.monitorId !== monitor.monitorId ||
          result.observation.correlationId !== correlationId ||
          observed < started - 1000 ||
          observed > now() + 1000 ||
          now() > deadline ||
          timeout.aborted
        )
          return null;
        return {
          ...result.observation,
          execution: {
            runtime: "cloudflare-worker",
            location,
            executorId: result.executor_id,
            actualColo: result.actual_colo,
          },
        };
      } catch {
        return null;
      }
    },
  };
}

/** 即使绑定忽略取消也结束本次等待。 / End this wait even if the binding ignores cancellation. */
export async function withinSignal<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    void promise.catch(() => {});
    signal.throwIfAborted();
  }
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

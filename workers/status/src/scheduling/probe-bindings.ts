import {
  ProbeBindingConfigSchema,
  RpcProbeRequestSchema,
  RpcProbeResponseSchema,
  SyntheticProbeRequestSchema,
  SyntheticProbeResponseSchema,
} from "@moesegfault/contracts";
import type {
  BindingProbeResult,
  ProbeExecutionContext,
  RpcProbeBinding,
  SyntheticProbeBinding,
} from "./probes.js";
import { TargetSecurityError } from "./security.js";

/** 经有限配置构造的运行时适配器，不应作为 Wrangler vars 注入函数。 / Runtime adapters built from finite config, never functions injected as Wrangler vars. */
export interface ProbeBindings {
  /** 无副作用 RPC 能力。 / Side-effect-free RPC capabilities. */
  readonly rpc: Readonly<Record<string, RpcProbeBinding>>;
  /** 隔离且可清理的合成场景能力。 / Isolated, cleanable synthetic capabilities. */
  readonly synthetic: Readonly<Record<string, SyntheticProbeBinding>>;
}

/**
 * 从显式声明的真实 Service Binding 构建白名单适配器。
 * Build allowlisted adapters from explicitly declared real Service bindings.
 *
 * @example
 * createProbeBindings(env, JSON.stringify({ health: { kind: "rpc",
 *   service_binding: "PROBE_SERVICE_API", operations: ["health"], timeout_ms: 1000 } }));
 *
 * 配置错误阻止调度，不把不可执行探针伪装成健康。
 * Invalid configuration stops scheduling rather than fabricating healthy probes.
 */
export function createProbeBindings(
  env: object,
  json: string,
  now = Date.now,
): ProbeBindings {
  if (json.length > 65_536)
    throw new TargetSecurityError("probe_config_too_large");
  const config = ProbeBindingConfigSchema.parse(JSON.parse(json));
  const rpc: Record<string, RpcProbeBinding> = Object.create(null);
  const synthetic: Record<string, SyntheticProbeBinding> = Object.create(null);
  for (const [alias, entry] of Object.entries(config)) {
    const binding: unknown = Reflect.get(env, entry.service_binding);
    const method = entry.kind === "rpc" ? "probe" : "run";
    const invoke = resolveMethod(binding, method);
    if (entry.kind === "rpc") {
      rpc[alias] = {
        async probe(operation, signal, context) {
          assertAllowed(entry.operations, operation);
          const request = RpcProbeRequestSchema.parse({
            ...metadata(context, now() + entry.timeout_ms),
            operation,
          });
          return invokeBounded(
            () => invoke(request),
            signal,
            entry.timeout_ms,
            (value) => {
              const parsed = RpcProbeResponseSchema.safeParse(value);
              if (!parsed.success)
                throw new TargetSecurityError("invalid_rpc_probe_response");
              return healthResult(parsed.data);
            },
          );
        },
      };
    } else {
      synthetic[alias] = {
        async run(scenario, signal, context) {
          assertAllowed(entry.scenarios, scenario);
          const request = SyntheticProbeRequestSchema.parse({
            ...metadata(context, now() + entry.timeout_ms),
            scenario,
            test_subject: entry.test_subject,
          });
          return invokeBounded(
            () => invoke(request),
            signal,
            entry.timeout_ms,
            (value) => {
              const parsed = SyntheticProbeResponseSchema.safeParse(value);
              if (
                !parsed.success ||
                parsed.data.test_subject !== entry.test_subject
              )
                throw new TargetSecurityError(
                  "invalid_synthetic_probe_response",
                );
              if (!parsed.data.cleanup_completed)
                return { ok: false, status: "cleanup_failed" };
              return healthResult(parsed.data);
            },
          );
        },
      };
    }
  }
  return { rpc: Object.freeze(rpc), synthetic: Object.freeze(synthetic) };
}

/** 固定方法保持原始 this；不复制或序列化 Service stub。 / Preserve the fixed method's original this; never copy or serialize the Service stub. */
function resolveMethod(
  binding: unknown,
  name: "probe" | "run",
): (request: unknown) => unknown {
  if (
    (typeof binding !== "object" || binding === null) &&
    typeof binding !== "function"
  )
    throw new TargetSecurityError("probe_service_binding_missing");
  const method: unknown = Reflect.get(binding, name);
  if (typeof method !== "function")
    throw new TargetSecurityError("probe_service_method_missing");
  return (request) => Reflect.apply(method, binding, [request]);
}

/** 远端只接收纯数据，不把不可克隆的 AbortSignal 跨 RPC 传递。 / Send data only; never pass a non-cloneable AbortSignal across RPC. */
function metadata(context: ProbeExecutionContext, deadline: number) {
  return {
    schema_version: "1.0" as const,
    correlation_id: context.correlationId,
    traceparent: context.traceparent,
    user_agent: context.userAgent,
    deadline_at: new Date(deadline).toISOString(),
  };
}

/** 精确能力白名单；不支持通配符。 / Exact capability allowlist without wildcards. */
function assertAllowed(allowed: readonly string[], value: string): void {
  if (!allowed.includes(value))
    throw new TargetSecurityError("probe_operation_not_allowed");
}

/** 复制纯数据后再释放 RPC 返回值。 / Copy plain data before disposing the RPC result. */
function healthResult(value: {
  ok: boolean;
  status?: string | undefined;
}): BindingProbeResult {
  return value.status === undefined
    ? { ok: value.ok }
    : { ok: value.ok, status: value.status };
}

/**
 * 限制客户端等待，释放 RPC promise 和返回对象；失败不是远端回滚的证据。
 * Bound client waiting and dispose RPC promises/results; failure is not proof of remote rollback.
 * 接收方仍必须以 deadline_at 停止工作并清理专用主体数据。
 * Receivers must still honor deadline_at and clean dedicated-principal data.
 * @see https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/
 */
async function invokeBounded<T>(
  invoke: () => unknown,
  parent: AbortSignal,
  timeoutMs: number,
  parse: (value: unknown) => T,
): Promise<T> {
  parent.throwIfAborted();
  const controller = new AbortController();
  const signal = AbortSignal.any([parent, controller.signal]);
  const timer = setTimeout(
    () => controller.abort(new DOMException("Probe deadline", "TimeoutError")),
    timeoutMs,
  );
  let pending: unknown;
  let onAbort: (() => void) | undefined;
  try {
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    pending = invoke();
    const completion = Promise.resolve(pending).then((result) => {
      try {
        signal.throwIfAborted();
        return parse(result);
      } finally {
        dispose(result);
      }
    });
    return await Promise.race([completion, aborted]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
    dispose(pending);
  }
}

/** 本地 Promise 无 disposer，workerd 的 RPC Promise/对象有；两种路径均明确释放。 / Local promises lack disposers; workerd RPC promises/objects have them; handle both explicitly. */
function dispose(value: unknown): void {
  if (
    (typeof value !== "object" || value === null) &&
    typeof value !== "function"
  )
    return;
  const close: unknown = Reflect.get(value, Symbol.dispose);
  if (typeof close === "function") Reflect.apply(close, value, []);
}

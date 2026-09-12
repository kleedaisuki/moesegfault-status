import type { AddressResolver, TargetPolicy } from "./security.js";
import { createTraceContext } from "@moesegfault/telemetry";
import {
  assertSafeHostname,
  assertSafeHttpUrl,
  assertSafeTcpTarget,
  TargetSecurityError,
} from "./security.js";
import type { ExecutionProvenance, Observation, ProbeSpec } from "./types.js";

/** TCP connect 的可测试抽象；生产适配器使用 `cloudflare:sockets`。 / Testable TCP-connect abstraction; production uses `cloudflare:sockets`. */
export interface TcpConnector {
  /** 连接成功后立即关闭；取消必须关闭 socket。 / Connect then immediately close; cancellation must close the socket. */
  connect(hostname: string, port: number, signal: AbortSignal): Promise<void>;
}

/** 可信绑定返回的最小健康结果。 / Minimal health result returned by a trusted binding. */
export interface BindingProbeResult {
  readonly ok: boolean;
  readonly status?: string;
}

/** 单次探针的独立上下文；不沿用被测业务身份。 / Independent per-probe context, never a business identity. */
export interface ProbeExecutionContext {
  /** 独立关联标识。 / Independent correlation identifier. */
  readonly correlationId: string;
  /** 出站 W3C 上下文。 / Outbound W3C context. */
  readonly traceparent: string;
  /** 固定探针客户端身份。 / Fixed probe client identity. */
  readonly userAgent: string;
}

/** RPC Service Binding；operation 必须是预注册标识符。 / RPC Service Binding whose operation is a registered identifier. */
export interface RpcProbeBinding {
  /** 执行无副作用的健康操作。 / Execute a side-effect-free health operation. */
  probe(
    operation: string,
    signal: AbortSignal,
    context: ProbeExecutionContext,
  ): Promise<BindingProbeResult>;
}

/** Synthetic Service Binding；内部拥有专用测试主体和清理逻辑。 / Synthetic Service Binding that owns its test principal and cleanup. */
export interface SyntheticProbeBinding {
  /** 执行预注册场景；不接受代码。 / Run a pre-registered scenario; code is never accepted. */
  run(
    scenario: string,
    signal: AbortSignal,
    context: ProbeExecutionContext,
  ): Promise<BindingProbeResult>;
}

/** 探针运行依赖，由根 Env 显式注入。 / Probe runtime dependencies explicitly injected by the root Env. */
export interface ProbeDependencies {
  readonly fetcher: typeof fetch;
  readonly resolver: AddressResolver;
  readonly targetPolicy: TargetPolicy;
  readonly tcp: TcpConnector;
  readonly rpcBindings: Readonly<Record<string, RpcProbeBinding>>;
  readonly syntheticBindings: Readonly<Record<string, SyntheticProbeBinding>>;
  readonly userAgent: string;
  readonly provenance: ExecutionProvenance;
  readonly now: () => number;
  readonly id: (timeMs: number, purpose: string) => Promise<string>;
}

interface ProbeOutcome {
  readonly outcome: Observation["outcome"];
  readonly protocolStatus: string | null;
  readonly errorType: string | null;
}

/** 在既有 AbortSignal 下执行探针并生成脱敏 Observation。 / Execute a probe under an existing AbortSignal and produce a redacted Observation. */
export async function executeProbe(
  monitorId: string,
  spec: ProbeSpec,
  correlationId: string,
  dependencies: ProbeDependencies,
  signal: AbortSignal,
  context?: ProbeExecutionContext,
): Promise<Observation> {
  const started = dependencies.now();
  let outcome: ProbeOutcome;
  try {
    outcome = await executeByKind(
      spec,
      dependencies,
      signal,
      context ?? {
        correlationId,
        traceparent: createTraceContext().traceparent,
        userAgent: dependencies.userAgent,
      },
    );
  } catch (error) {
    outcome = classifyFailure(error, signal);
  }
  const finished = dependencies.now();
  return {
    observationId: await dependencies.id(
      started,
      `${monitorId}:${correlationId}:observation`,
    ),
    monitorId,
    observedAt: new Date(finished).toISOString(),
    execution: dependencies.provenance,
    outcome: outcome.outcome,
    latencyMs: Math.max(0, finished - started),
    protocolStatus: outcome.protocolStatus,
    errorType: outcome.errorType,
    correlationId,
  };
}

async function executeByKind(
  spec: ProbeSpec,
  dependencies: ProbeDependencies,
  signal: AbortSignal,
  context: ProbeExecutionContext,
): Promise<ProbeOutcome> {
  switch (spec.kind) {
    case "http":
      return probeHttp(spec, dependencies, signal, context);
    case "tcp":
      return probeTcp(spec, dependencies, signal);
    case "dns":
      return probeDns(spec, dependencies, signal);
    case "rpc":
      return probeRpc(spec, dependencies, signal, context);
    case "synthetic":
      return probeSynthetic(spec, dependencies, signal, context);
  }
}

async function probeHttp(
  spec: Extract<ProbeSpec, { kind: "http" }>,
  dependencies: ProbeDependencies,
  signal: AbortSignal,
  context: ProbeExecutionContext,
): Promise<ProbeOutcome> {
  const method = spec.method ?? "HEAD";
  const expected = spec.expectedStatuses ?? [];
  const maxRedirects = Math.min(Math.max(spec.maxRedirects ?? 0, 0), 3);
  let url = await assertSafeHttpUrl(
    spec.url,
    dependencies.targetPolicy,
    dependencies.resolver,
    signal,
  );
  for (let redirects = 0; ; redirects += 1) {
    const response = await dependencies.fetcher(url, {
      method,
      redirect: "manual",
      signal,
      headers: {
        "user-agent": dependencies.userAgent,
        "cache-control": "no-store",
        "x-moesegfault-correlation-id": context.correlationId,
        traceparent: context.traceparent,
      },
    });
    const status = response.status;
    if (status >= 300 && status < 400 && response.headers.has("location")) {
      await response.body?.cancel();
      if (redirects >= maxRedirects)
        return failed(`http_${status}`, "redirect_limit");
      url = await assertSafeHttpUrl(
        new URL(response.headers.get("location")!, url).href,
        dependencies.targetPolicy,
        dependencies.resolver,
        signal,
      );
      continue;
    }
    await response.body?.cancel();
    const ok =
      expected.length > 0
        ? expected.includes(status)
        : status >= 200 && status < 400;
    return ok
      ? succeeded(`http_${status}`)
      : failed(`http_${status}`, "unexpected_status");
  }
}

async function probeTcp(
  spec: Extract<ProbeSpec, { kind: "tcp" }>,
  dependencies: ProbeDependencies,
  signal: AbortSignal,
): Promise<ProbeOutcome> {
  const target = await assertSafeTcpTarget(
    spec.hostname,
    spec.port,
    dependencies.targetPolicy,
    dependencies.resolver,
    signal,
  );
  await dependencies.tcp.connect(target.hostname, target.port, signal);
  return succeeded("connected");
}

async function probeDns(
  spec: Extract<ProbeSpec, { kind: "dns" }>,
  dependencies: ProbeDependencies,
  signal: AbortSignal,
): Promise<ProbeOutcome> {
  const host = await assertSafeHostname(
    spec.hostname,
    dependencies.targetPolicy,
    dependencies.resolver,
    signal,
  );
  const answers = await dependencies.resolver.resolve(
    host,
    signal,
    spec.recordType,
  );
  if (answers.length === 0) return failed("no_answer", "dns_no_answer");
  return succeeded(`${spec.recordType.toLowerCase()}_answer`);
}

async function probeRpc(
  spec: Extract<ProbeSpec, { kind: "rpc" }>,
  dependencies: ProbeDependencies,
  signal: AbortSignal,
  context: ProbeExecutionContext,
): Promise<ProbeOutcome> {
  assertIdentifier(spec.binding, "binding");
  assertIdentifier(spec.operation, "operation");
  const binding = dependencies.rpcBindings[spec.binding];
  if (!binding) throw new TargetSecurityError("rpc_binding_not_allowed");
  const result = await binding.probe(spec.operation, signal, context);
  return result.ok
    ? succeeded(result.status ?? "ok")
    : failed(result.status ?? "failed", "rpc_unhealthy");
}

async function probeSynthetic(
  spec: Extract<ProbeSpec, { kind: "synthetic" }>,
  dependencies: ProbeDependencies,
  signal: AbortSignal,
  context: ProbeExecutionContext,
): Promise<ProbeOutcome> {
  assertIdentifier(spec.binding, "binding");
  assertIdentifier(spec.scenario, "scenario");
  const binding = dependencies.syntheticBindings[spec.binding];
  if (!binding) throw new TargetSecurityError("synthetic_binding_not_allowed");
  const result = await binding.run(spec.scenario, signal, context);
  return result.ok
    ? succeeded(result.status ?? "ok")
    : failed(result.status ?? "failed", "synthetic_unhealthy");
}

function assertIdentifier(value: string, kind: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(value))
    throw new TargetSecurityError(`invalid_${kind}`);
}

function classifyFailure(error: unknown, signal: AbortSignal): ProbeOutcome {
  if (
    signal.aborted ||
    (error instanceof DOMException && error.name === "TimeoutError")
  )
    return {
      outcome: "timeout",
      protocolStatus: null,
      errorType: "deadline_exceeded",
    };
  if (error instanceof TargetSecurityError)
    return { outcome: "invalid", protocolStatus: null, errorType: error.code };
  if (error instanceof TypeError) return failed(null, "network_error");
  return failed(null, "probe_error");
}

function succeeded(protocolStatus: string): ProbeOutcome {
  return { outcome: "success", protocolStatus, errorType: null };
}

function failed(
  protocolStatus: string | null,
  errorType: string,
): ProbeOutcome {
  return { outcome: "failure", protocolStatus, errorType };
}

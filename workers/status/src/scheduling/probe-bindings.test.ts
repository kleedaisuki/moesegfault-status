import { describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { createProbeBindings } from "./probe-bindings.js";
import { executeProbe, type ProbeDependencies } from "./probes.js";

/** 确定性协议输入。 / Deterministic protocol input. */
const context = {
  correlationId: "0199d0a8-2e12-7a59-a51e-44aa9b6d1001",
  traceparent: "00-11111111111111111111111111111111-2222222222222222-00",
  userAgent: "moesegfault-status-probe/1.0",
};
/** 运维持有的能力注册表。 / Operations-owned capability registry. */
const config = {
  health: {
    kind: "rpc",
    service_binding: "PROBE_SERVICE_HEALTH",
    operations: ["health", "hang", "malformed"],
    timeout_ms: 1000,
  },
  journey: {
    kind: "synthetic",
    service_binding: "PROBE_SERVICE_HEALTH",
    scenarios: ["checkout", "dirty", "wrong_subject"],
    test_subject: "probe:checkout",
    timeout_ms: 1000,
  },
};
const signal = new AbortController().signal;

describe("concrete probe Service bindings", () => {
  it("restricts capabilities and projects pure data without AbortSignal", async () => {
    const probe = vi.fn(async () => ({
      schema_version: "1.0",
      ok: true,
      status: "ready",
    }));
    const bindings = createProbeBindings(
      { PROBE_SERVICE_HEALTH: { probe, run: probe } },
      JSON.stringify(config),
      () => 1_800_000_000_000,
    );
    await expect(
      bindings.rpc.health!.probe("health", signal, context),
    ).resolves.toEqual({ ok: true, status: "ready" });
    expect(probe).toHaveBeenCalledWith({
      schema_version: "1.0",
      operation: "health",
      correlation_id: context.correlationId,
      traceparent: context.traceparent,
      user_agent: context.userAgent,
      deadline_at: "2027-01-15T08:00:01.000Z",
    });
    await expect(
      bindings.rpc.health!.probe("delete", signal, context),
    ).rejects.toMatchObject({ code: "probe_operation_not_allowed" });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(Object.getPrototypeOf(bindings.rpc)).toBeNull();
    expect(createProbeBindings({}, "{}").rpc.toString).toBeUndefined();
  });

  it("rejects arbitrary Env fields, invalid config and absent Service methods", () => {
    const rpc = config.health;
    expect(() =>
      createProbeBindings(
        { DB: {} },
        JSON.stringify({ health: { ...rpc, service_binding: "DB" } }),
      ),
    ).toThrow();
    expect(() =>
      createProbeBindings({}, JSON.stringify({ health: rpc })),
    ).toThrow(
      expect.objectContaining({ code: "probe_service_binding_missing" }),
    );
    expect(() =>
      createProbeBindings(
        { PROBE_SERVICE_HEALTH: {} },
        JSON.stringify({ health: rpc }),
      ),
    ).toThrow(
      expect.objectContaining({ code: "probe_service_method_missing" }),
    );
    expect(() => createProbeBindings({}, " ".repeat(65_537))).toThrow(
      expect.objectContaining({ code: "probe_config_too_large" }),
    );
    expect(() =>
      createProbeBindings(
        {},
        JSON.stringify({ health: { ...rpc, timeout_ms: 0 } }),
      ),
    ).toThrow();
  });

  it("never accepts malformed, secret-bearing or unclean synthetic results as healthy", async () => {
    const run = vi.fn(async () => ({
      schema_version: "1.0",
      ok: true,
      cleanup_completed: false,
      test_subject: "probe:checkout",
    }));
    const bindings = createProbeBindings(
      {
        PROBE_SERVICE_HEALTH: {
          probe: async () => ({
            schema_version: "1.0",
            ok: true,
            secret: "canary",
          }),
          run,
        },
      },
      JSON.stringify(config),
    );
    await expect(
      bindings.rpc.health!.probe("health", signal, context),
    ).rejects.toMatchObject({ code: "invalid_rpc_probe_response" });
    await expect(
      bindings.synthetic.journey!.run("checkout", signal, context),
    ).resolves.toEqual({ ok: false, status: "cleanup_failed" });
    run.mockResolvedValueOnce({
      schema_version: "1.0",
      ok: true,
      cleanup_completed: true,
      test_subject: "probe:another",
    });
    await expect(
      bindings.synthetic.journey!.run("checkout", signal, context),
    ).rejects.toMatchObject({ code: "invalid_synthetic_probe_response" });
  });

  it("bounds unresponsive calls and disposes late results and RPC promises", async () => {
    const release = vi.fn();
    const releasePending = vi.fn();
    let finish!: (value: unknown) => void;
    const pending = Object.assign(
      new Promise((resolve) => {
        finish = resolve;
      }),
      { [Symbol.dispose]: releasePending },
    );
    const bindings = createProbeBindings(
      { PROBE_SERVICE_HEALTH: { probe: () => pending } },
      JSON.stringify({ health: { ...config.health, timeout_ms: 5 } }),
    );
    await expect(
      bindings.rpc.health!.probe("hang", signal, context),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(releasePending).toHaveBeenCalledOnce();
    finish({ schema_version: "1.0", ok: true, [Symbol.dispose]: release });
    await Promise.resolve();
    expect(release).toHaveBeenCalledOnce();
    const abort = new AbortController();
    abort.abort();
    await expect(
      bindings.rpc.health!.probe("health", abort.signal, context),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("honors parent cancellation and releases results rejected by the protocol", async () => {
    const close = vi.fn();
    const pendingClose = vi.fn();
    const probe = vi.fn(() =>
      Object.assign(new Promise(() => undefined), {
        [Symbol.dispose]: pendingClose,
      }),
    );
    const bindings = createProbeBindings(
      { PROBE_SERVICE_HEALTH: { probe } },
      JSON.stringify({ health: config.health }),
    );
    const abort = new AbortController();
    const call = bindings.rpc.health!.probe("health", abort.signal, context);
    abort.abort(new DOMException("Canceled", "AbortError"));
    await expect(call).rejects.toMatchObject({ name: "AbortError" });
    expect(pendingClose).toHaveBeenCalledOnce();
    await expect(
      bindings.rpc.health!.probe("health", abort.signal, context),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(probe).toHaveBeenCalledOnce();
    const invalid = createProbeBindings(
      {
        PROBE_SERVICE_HEALTH: {
          probe: async () => ({ ok: true, [Symbol.dispose]: close }),
        },
      },
      JSON.stringify({ health: config.health }),
    );
    await expect(
      invalid.rpc.health!.probe("health", signal, context),
    ).rejects.toMatchObject({ code: "invalid_rpc_probe_response" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("propagates independent correlation and W3C context on actual HTTP execution", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 204 }),
    );
    const dependencies: ProbeDependencies = {
      fetcher,
      resolver: { resolve: async () => ["1.1.1.1"] },
      targetPolicy: {
        allowedHostnames: new Set(["health.example.com"]),
        allowedTcpPorts: new Set(),
      },
      tcp: { connect: async () => undefined },
      rpcBindings: {},
      syntheticBindings: {},
      userAgent: context.userAgent,
      provenance: { runtime: "cloudflare-worker" },
      now: Date.now,
      id: async () => context.correlationId,
    };
    const result = await executeProbe(
      "monitor",
      { kind: "http", url: "https://health.example.com" },
      context.correlationId,
      dependencies,
      signal,
    );
    expect(result.outcome).toBe("success");
    const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
    expect(headers.get("x-moesegfault-correlation-id")).toBe(
      context.correlationId,
    );
    expect(headers.get("user-agent")).toBe(context.userAgent);
    expect(headers.get("traceparent")).toMatch(
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/,
    );
  });

  it("calls a real workerd named WorkerEntrypoint through an actual Service binding", async () => {
    // 在实际 Worker 内运行适配器；Node getBindings 同步代理不能验证 deadline。
    // Run the adapter inside workerd; Node getBindings proxies cannot test deadlines.
    const bundle = await build({
      stdin: {
        contents: `import {createProbeBindings} from "./probe-bindings.ts";
          export default {async fetch(request,env){
            const input=await request.json();
            const config=${JSON.stringify(config)};
            if(input.timeout_ms) config.health.timeout_ms=input.timeout_ms;
            const bindings=createProbeBindings(env,JSON.stringify(config));
            try {
              const signal=new AbortController().signal;
              const context=${JSON.stringify(context)};
              const result=input.kind==="synthetic"
                ? await bindings.synthetic.journey.run(input.operation,signal,context)
                : await bindings.rpc.health.probe(input.operation,signal,context);
              return Response.json(result);
            } catch(error) {return Response.json({error:typeof error.code==="string"?error.code:error.name},{status:422});}
          }}`,
        resolveDir: fileURLToPath(new URL(".", import.meta.url).href),
        sourcefile: "caller.ts",
        loader: "ts",
      },
      bundle: true,
      format: "esm",
      platform: "browser",
      write: false,
    });
    const mf = new Miniflare({
      workers: [
        {
          config: {
            type: "worker",
            name: "caller",
            compatibilityDate: "2026-09-12",
            manifest: {
              mainModule: "caller.mjs",
              modules: {
                "caller.mjs": {
                  type: "esm",
                  contents: bundle.outputFiles![0]!.text,
                },
              },
            },
            env: {
              PROBE_SERVICE_HEALTH: {
                type: "worker",
                worker: "target",
                exportName: "HealthRpc",
              },
            },
          },
        },
        {
          config: {
            type: "worker",
            name: "target",
            compatibilityDate: "2026-09-12",
            manifest: {
              mainModule: "target.mjs",
              modules: {
                "target.mjs": {
                  type: "esm",
                  contents: `import { WorkerEntrypoint } from "cloudflare:workers";
          export class HealthRpc extends WorkerEntrypoint {
            probe(request) {
              if (request.operation === "malformed") return {ok:true};
              if (request.operation === "hang") return new Promise(resolve => setTimeout(() => resolve({schema_version:"1.0",ok:true}), 1000));
              const valid = request.schema_version === "1.0" && request.correlation_id === "${context.correlationId}"
                && request.traceparent === "${context.traceparent}" && request.user_agent === "${context.userAgent}"
                && Date.parse(request.deadline_at) > Date.now() && !request.signal;
              return {schema_version:"1.0",ok:valid,status:"ready"};
            }
            run(request) {
              return {schema_version:"1.0",ok:true,cleanup_completed:request.scenario!=="dirty",
                test_subject:request.scenario==="wrong_subject"?"probe:other":request.test_subject};
            }
          }
          export default {fetch(){return new Response("private RPC",{status:404})}};`,
                },
              },
            },
          },
        },
      ],
    });
    try {
      /** 向真实 caller Worker 发送测试指令。 / Send test instructions to the actual caller Worker. */
      const call = async (
        operation: string,
        kind = "rpc",
        timeout_ms = 1000,
      ) => {
        const response = await mf.dispatchFetch("https://probe.test", {
          method: "POST",
          body: JSON.stringify({ operation, kind, timeout_ms }),
        });
        return { status: response.status, body: await response.json() };
      };
      await expect(call("health")).resolves.toEqual({
        status: 200,
        body: { ok: true, status: "ready" },
      });
      await expect(call("malformed")).resolves.toEqual({
        status: 422,
        body: { error: "invalid_rpc_probe_response" },
      });
      await expect(call("checkout", "synthetic")).resolves.toEqual({
        status: 200,
        body: { ok: true },
      });
      await expect(call("dirty", "synthetic")).resolves.toEqual({
        status: 200,
        body: { ok: false, status: "cleanup_failed" },
      });
      await expect(call("wrong_subject", "synthetic")).resolves.toEqual({
        status: 422,
        body: { error: "invalid_synthetic_probe_response" },
      });
      await expect(call("hang", "rpc", 20)).resolves.toEqual({
        status: 422,
        body: { error: "TimeoutError" },
      });
    } finally {
      await mf.dispose();
    }
  }, 30_000);
});

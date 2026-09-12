import { describe, it, expect } from "vitest";
import { createRegionalDispatcher } from "./regional-dispatch.js";
import { handleRegionalProbe } from "../../../probe-executor/src/handler.js";
import type { ProbeDependencies } from "./probes.js";
import type { ClaimedMonitor } from "./types.js";
const id = "01991c00-0000-7000-8000-000000000001";
const now = () => Date.parse("2026-09-12T00:00:00.000Z");
const dependencies: ProbeDependencies = {
  fetcher: async () => new Response(null, { status: 200 }),
  resolver: { resolve: async () => ["1.1.1.1"] },
  tcp: { connect: async () => {} },
  targetPolicy: {
    allowedHostnames: new Set(["example.com"]),
    allowedTcpPorts: new Set([443]),
  },
  rpcBindings: {},
  syntheticBindings: {},
  userAgent: "test",
  provenance: { runtime: "cloudflare-worker" },
  now,
  id: async () => id,
};
const body = {
  version: "1",
  executor_id: "asia-v1",
  location: "asia",
  run_id: id,
  monitor_id: id,
  correlation_id: id,
  deadline_at: new Date(now() + 5000).toISOString(),
  scheduled_for: new Date(now()).toISOString(),
  traceparent: "00-11111111111111111111111111111111-1111111111111111-01",
  timeout_ms: 1000,
  probe: { kind: "http", url: "https://example.com" },
};
const identity = {
  executorId: "asia-v1",
  location: "asia",
  allowedKinds: ["http"],
};
const config = JSON.stringify({
  asia: {
    binding: "PROBE_EXECUTOR_ASIA",
    executor_id: "asia-v1",
    allowed_colos: ["SIN"],
    allowed_kinds: ["http"],
  },
});
const monitor = {
  monitorId: id,
  probe: body.probe,
  timeoutMs: 1000,
  scheduledFor: body.scheduled_for,
} as ClaimedMonitor;
function request(placement?: string, payload: unknown = body) {
  return new Request("https://regional.internal/probe", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(placement ? { "cf-placement": placement } : {}),
    },
    body: JSON.stringify(payload),
  });
}
describe("regional execution provenance", () => {
  it("rejects missing placement and invalid identity before probing", async () => {
    expect(
      (await handleRegionalProbe(request(), identity, dependencies)).status,
    ).toBe(503);
    expect(
      (
        await handleRegionalProbe(
          request("remote-SIN", { ...body, executor_id: "other" }),
          identity,
          dependencies,
        )
      ).status,
    ).toBe(403);
  });
  it("revalidates SSRF and returns actual platform colo", async () => {
    const response = await handleRegionalProbe(
      request("remote-SIN", {
        ...body,
        probe: { kind: "http", url: "https://localhost" },
      }),
      identity,
      dependencies,
    );
    const result = (await response.json()) as {
      actual_colo: string;
      observation: { outcome: string };
    };
    expect(result.actual_colo).toBe("SIN");
    expect(result.observation.outcome).toBe("invalid");
  });
  it("accepts only matching identity, run and allowed colo; sends no placement header", async () => {
    const dispatch = createRegionalDispatcher(
      {
        PROBE_EXECUTOR_ASIA: {
          fetch: async (input: Request) => {
            expect(input.headers.has("cf-placement")).toBe(false);
            const incoming = new Request(input);
            incoming.headers.set("cf-placement", "remote-SIN");
            return handleRegionalProbe(incoming, identity, dependencies);
          },
        },
      },
      config,
      now,
    );
    const result = await dispatch.dispatch(
      monitor,
      "asia",
      id,
      id,
      new AbortController().signal,
    );
    expect(result?.execution.actualColo).toBe("SIN");
    expect(result?.outcome).toBe("success");
  });
  it("executor transport failure is absent evidence, not target failure", async () => {
    const dispatch = createRegionalDispatcher(
      {
        PROBE_EXECUTOR_ASIA: {
          fetch: async () => new Response(null, { status: 503 }),
        },
      },
      config,
      now,
    );
    expect(
      await dispatch.dispatch(
        monitor,
        "asia",
        id,
        id,
        new AbortController().signal,
      ),
    ).toBeNull();
  });
  it("rejects a forged colo in the response", async () => {
    const dispatch = createRegionalDispatcher(
      {
        PROBE_EXECUTOR_ASIA: {
          fetch: async () =>
            handleRegionalProbe(request("remote-LHR"), identity, dependencies),
        },
      },
      config,
      now,
    );
    expect(
      await dispatch.dispatch(
        monitor,
        "asia",
        id,
        id,
        new AbortController().signal,
      ),
    ).toBeNull();
  });
});

/** workerd 验证真实默认 fetch 绑定；本地不模拟地理可信证据。 / workerd verifies the real default-fetch binding; local tests do not fabricate trusted geographic evidence. */
it("workerd default fetch fails closed without platform placement", async () => {
  const { Miniflare } = await import("miniflare");
  const { build } = await import("esbuild");
  const bundle = await build({
    entryPoints: ["workers/probe-executor/src/index.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:*"],
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
                contents:
                  "export default {fetch(request,env){return env.EXECUTOR.fetch(request)}}",
              },
            },
          },
          env: { EXECUTOR: { type: "worker", worker: "executor" } },
        },
      },
      {
        config: {
          type: "worker",
          name: "executor",
          compatibilityDate: "2026-09-12",
          manifest: {
            mainModule: "executor.mjs",
            modules: {
              "executor.mjs": {
                type: "esm",
                contents: bundle.outputFiles![0]!.text,
              },
            },
          },
          env: {
            EXECUTOR_ID: { type: "json", value: "asia-v1" },
            EXECUTOR_LOCATION: { type: "json", value: "asia" },
            EXECUTOR_ALLOWED_KINDS: { type: "json", value: '["http"]' },
            PROBE_BINDING_CONFIG: { type: "json", value: "{}" },
            PROBE_ALLOWED_HOSTS: { type: "json", value: "[]" },
            PROBE_ALLOWED_TCP_PORTS: { type: "json", value: "[]" },
          },
        },
      },
    ],
  });
  try {
    const response = await mf.dispatchFetch("https://regional.internal/probe", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(503);
  } finally {
    await mf.dispose();
  }
}, 20000);

it("bounds a hung executor even when transport ignores cancellation", async () => {
  const controller = new AbortController();
  const dispatch = createRegionalDispatcher(
    { PROBE_EXECUTOR_ASIA: { fetch: () => new Promise<Response>(() => {}) } },
    config,
    now,
  );
  const pending = dispatch.dispatch(monitor, "asia", id, id, controller.signal);
  controller.abort();
  expect(await pending).toBeNull();
});
it("bounds a stalled response stream and never counts it", async () => {
  const controller = new AbortController();
  const dispatch = createRegionalDispatcher(
    {
      PROBE_EXECUTOR_ASIA: {
        fetch: async () =>
          new Response(
            new ReadableStream({
              start() {
                setTimeout(() => controller.abort(), 10);
              },
            }),
          ),
      },
    },
    config,
    now,
  );
  expect(
    await dispatch.dispatch(monitor, "asia", id, id, controller.signal),
  ).toBeNull();
});
it("preserves supplied distributed trace identity in target request", async () => {
  let trace: string | null = null;
  const response = await handleRegionalProbe(request("remote-SIN"), identity, {
    ...dependencies,
    fetcher: async (_url, init) => {
      trace = new Headers(init?.headers).get("traceparent");
      return new Response(null, { status: 200 });
    },
  });
  expect(response.status).toBe(200);
  expect(trace).toBe(body.traceparent);
});
it("reports genuine target timeout separately from unavailable executor", async () => {
  const response = await handleRegionalProbe(
    request("remote-SIN", { ...body, timeout_ms: 10 }),
    identity,
    {
      ...dependencies,
      fetcher: async (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener(
            "abort",
            () => reject(init!.signal!.reason),
            { once: true },
          );
        }),
    },
  );
  expect(response.status).toBe(200);
  expect(
    ((await response.json()) as { observation: { outcome: string } })
      .observation.outcome,
  ).toBe("timeout");
});

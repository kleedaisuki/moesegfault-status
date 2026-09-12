import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { readFile } from "node:fs/promises";

/** 本地适配器测试，不证明真实 Cloudflare placement。 / Local adapter tests do not prove real Cloudflare placement. */
let mf: Miniflare;
/** 固定协议 UUIDv7。 / Fixed protocol UUIDv7. */
const id = "01900000-0000-7000-8000-000000000001";
/** 每次请求使用新截止时间。 / Each request receives a fresh deadline. */
function envelope(probe: Record<string, unknown>, overrides = {}) {
  return {
    version: "1",
    executor_id: "probe-asia-v1",
    location: "asia",
    run_id: id,
    monitor_id: id,
    correlation_id: id,
    scheduled_for: new Date().toISOString(),
    deadline_at: new Date(Date.now() + 5000).toISOString(),
    timeout_ms: 2000,
    traceparent: `00-${"1".repeat(32)}-${"2".repeat(16)}-01`,
    probe,
    ...overrides,
  };
}
/** 仅模拟平台元数据以进入 Rust 执行器，不伪造 Rust 结果。 / Simulate platform metadata only, never Rust results. */
function invoke(
  probe: Record<string, unknown>,
  overrides = {},
  placement: string | null = "local-SIN",
) {
  return mf.dispatchFetch("https://probe.test/probe", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(placement === null ? {} : { "cf-placement": placement }),
    },
    body: JSON.stringify(envelope(probe, overrides)),
  });
}
/** workerd 中真实远端服务，记录网络与 RPC 输入。 / Real remote workerd service records network and RPC inputs. */
const fixture = `
import { WorkerEntrypoint } from 'cloudflare:workers';
let calls = [];
export class Capability extends WorkerEntrypoint {
  async probe(r) {
    calls.push({kind:'rpc', ...r});
    if(r.operation === 'slow') await new Promise(resolve => setTimeout(resolve, 200));
    if(r.operation === 'invalid') return {schema_version:'1.0',ok:true,extra:'forbidden'};
    return {schema_version:'1.0',ok:true,status:'ready'};
  }
  run(r) {
    calls.push({kind:'synthetic', ...r});
    return {schema_version:'1.0',ok:true,status:'ready',cleanup_completed:r.scenario !== 'dirty',test_subject:r.scenario === 'forged' ? 'probe:other' : r.test_subject};
  }
}
export default { async fetch(r, env) {
  const u = new URL(r.url);
  if(u.pathname === '/check-rpc') return Response.json(await env.SELF.probe({operation:'ready'}));
  if(u.pathname === '/calls') return Response.json(calls);
  if(u.pathname === '/reset') { calls = []; return new Response('ok'); }
  calls.push({kind:'fetch',url:r.url,method:r.method,headers:Object.fromEntries(r.headers)});
  if(u.hostname === 'cloudflare-dns.com') {
    const name=u.searchParams.get('name'), type=u.searchParams.get('type');
    const data=name === 'mixed.example' ? ['8.8.8.8','127.0.0.1'] : ['8.8.8.8'];
    return Response.json({Status:0,Answer:type === 'A' ? data.map(data => ({type:1,data})) : []});
  }
  if(u.pathname === '/slow') await new Promise(resolve => setTimeout(resolve, 300));
  if(u.pathname === '/redirect') return new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}});
  return new Response(null,{status:u.pathname === '/fail' ? 503 : 204});
}};`;
beforeAll(async () => {
  const vars = {
    ENVIRONMENT: "development",
    STATUS_VERSION: "0.1.0",
    DEPLOYMENT_ID: "",
    GIT_COMMIT: "",
    ARTIFACT_DIGEST: "",
    EXECUTOR_ID: "probe-asia-v1",
    EXECUTOR_LOCATION: "asia",
    EXECUTOR_ALLOWED_KINDS: JSON.stringify([
      "http",
      "dns",
      "tcp",
      "rpc",
      "synthetic",
    ]),
    PROBE_ALLOWED_HOSTS: JSON.stringify([
      "target.example",
      "mixed.example",
      "127.0.0.1",
      "localhost",
    ]),
    PROBE_ALLOWED_TCP_PORTS: "[443]",
    PROBE_BINDING_CONFIG: JSON.stringify({
      rpc: {
        kind: "rpc",
        service_binding: "PROBE_SERVICE_TEST",
        operations: ["ready", "slow", "invalid"],
        timeout_ms: 1000,
      },
      synthetic: {
        kind: "synthetic",
        service_binding: "PROBE_SERVICE_TEST",
        scenarios: ["clean", "dirty", "forged"],
        test_subject: "probe:isolated",
        timeout_ms: 1000,
      },
    }),
  };
  mf = new Miniflare({
    workers: [
      {
        config: {
          type: "worker",
          name: "probe",
          compatibilityDate: "2026-09-12",
          manifest: {
            mainModule: "index.js",
            modules: {
              "index.js": {
                type: "esm",
                contents: await readFile(
                  "crates/probe-worker/build/index.js",
                  "utf8",
                ),
              },
              "index_bg.wasm": {
                type: "wasm",
                contents: await readFile(
                  "crates/probe-worker/build/index_bg.wasm",
                ),
              },
            },
          },
          env: {
            ...Object.fromEntries(
              Object.entries(vars).map(([key, value]) => [
                key,
                { type: "json", value },
              ]),
            ),
            PROBE_SERVICE_TEST: {
              type: "worker",
              worker: "fixture",
              exportName: "Capability",
            },
          },
        },
        dev: { outboundService: { type: "worker", worker: "fixture" } },
      },
      {
        config: {
          type: "worker",
          name: "fixture",
          env: {
            SELF: {
              type: "worker",
              worker: "fixture",
              exportName: "Capability",
            },
          },
          compatibilityDate: "2026-09-12",
          manifest: {
            mainModule: "fixture.js",
            modules: { "fixture.js": { type: "esm", contents: fixture } },
          },
        },
      },
    ],
  });
}, 60_000);
afterAll(async () => {
  await mf?.dispose();
});

/** 验证观察值而非只验证 HTTP 200。 / Assert observations, not merely HTTP 200. */
async function observation(probe: Record<string, unknown>, overrides = {}) {
  const r = await invoke(probe, overrides);
  expect(r.status).toBe(200);
  expect(r.headers.get("cache-control")).toBe("no-store");
  const body: any = await r.json();
  expect(body).toMatchObject({
    executor_id: "probe-asia-v1",
    location: "asia",
    run_id: id,
    actual_colo: "SIN",
  });
  expect(body.observation).toMatchObject({ monitorId: id, correlationId: id });
  return body.observation;
}
describe("compiled Rust probe worker / local workerd adapter (NOT cloud placement evidence)", () => {
  it("checks the real workerd fixture independently", async () => {
    const fixture = await mf.getWorker("fixture");
    expect(
      await (await fixture.fetch("https://fixture/check-rpc")).json(),
    ).toMatchObject({ ok: true, status: "ready" });
    expect((await fixture.fetch("https://target.example/sanity")).status).toBe(
      204,
    );
  });
  it.each([null, "SIN", "remote-sin", "remote-SING"])(
    "fails closed for absent/invalid placement %s",
    async (p) => {
      expect(
        (await invoke({ kind: "http", url: "https://target.example" }, {}, p))
          .status,
      ).toBe(503);
    },
  );
  it("rejects incorrect executor and region identities", async () => {
    for (const overrides of [{ executor_id: "other" }, { location: "other" }])
      expect(
        (
          await invoke(
            { kind: "dns", hostname: "target.example", recordType: "A" },
            overrides,
          )
        ).status,
      ).toBe(403);
  });
  it.each([
    { kind: "http", url: "https://target.example", method: "POST" },
    { kind: "http", url: "https://target.example", headers: {} },
    { kind: "http", url: "https://target.example", maxRedirects: 4 },
    { kind: "tcp", hostname: "target.example", port: 0 },
    { kind: "dns", hostname: "target.example", recordType: "TXT" },
  ])("rejects invalid specs %j", async (probe) => {
    expect((await invoke(probe)).status).toBe(400);
  });
  it("rejects expired deadlines", async () => {
    expect(
      (
        await invoke(
          { kind: "rpc", binding: "rpc", operation: "ready" },
          { deadline_at: new Date(Date.now() - 1000).toISOString() },
        )
      ).status,
    ).toBe(408);
  });
  it.each([
    [{ kind: "http", url: "https://unlisted.example" }, "hostname_not_allowed"],
    [{ kind: "http", url: "http://127.0.0.1" }, "private_or_reserved_address"],
    [{ kind: "http", url: "http://localhost" }, "local_hostname"],
    [
      { kind: "tcp", hostname: "target.example", port: 80 },
      "tcp_port_not_allowed",
    ],
    [
      { kind: "tcp", hostname: "127.0.0.1", port: 443 },
      "private_or_reserved_address",
    ],
    [
      { kind: "dns", hostname: "mixed.example", recordType: "A" },
      "private_or_reserved_address",
    ],
  ])("rejects SSRF target %j", async (probe, errorType) => {
    expect(await observation(probe as Record<string, unknown>)).toMatchObject({
      outcome: "invalid",
      errorType,
    });
  });
  it("executes HTTP and DNS against the workerd outbound fixture", async () => {
    expect(
      await observation({ kind: "http", url: "https://target.example/ok" }),
    ).toMatchObject({ outcome: "success", protocolStatus: "http_204" });
    expect(
      await observation({
        kind: "dns",
        hostname: "target.example",
        recordType: "A",
      }),
    ).toMatchObject({ outcome: "success", protocolStatus: "dns_answer" });
    const service = await mf.getWorker("fixture");
    const calls: any = await (
      await service.fetch("https://fixture/calls")
    ).json();
    const http = calls.find((r: any) => r.url === "https://target.example/ok");
    expect(http.method).toBe("HEAD");
    expect(http.headers["x-moesegfault-correlation-id"]).toBe(id);
    expect(http.headers["cache-control"]).toBe("no-store");
  });
  it("does not follow redirects to private addresses", async () => {
    expect(
      await observation({
        kind: "http",
        url: "https://target.example/redirect",
        maxRedirects: 1,
      }),
    ).toMatchObject({
      outcome: "invalid",
      errorType: "private_or_reserved_address",
    });
    const remote = await mf.getWorker("fixture");
    const calls: any[] = await (
      await remote.fetch("https://fixture/calls")
    ).json();
    expect(calls.some((call) => call.url?.startsWith("http://127.0.0.1"))).toBe(
      false,
    );
  });
  it("distinguishes unexpected status and deadline", async () => {
    expect(
      await observation({ kind: "http", url: "https://target.example/fail" }),
    ).toMatchObject({ outcome: "failure", protocolStatus: "http_503" });
    expect(
      await observation(
        { kind: "http", url: "https://target.example/slow" },
        { timeout_ms: 30 },
      ),
    ).toMatchObject({ outcome: "timeout", errorType: "deadline_exceeded" });
  });
  it("uses actual named RPC capabilities and validates their response", async () => {
    expect(
      await observation({ kind: "rpc", binding: "rpc", operation: "ready" }),
    ).toMatchObject({ outcome: "success", protocolStatus: "ready" });
    expect(
      await observation({ kind: "rpc", binding: "rpc", operation: "invalid" }),
    ).toMatchObject({
      outcome: "invalid",
      errorType: "invalid_rpc_probe_response",
    });
    expect(
      await observation({
        kind: "rpc",
        binding: "rpc",
        operation: "notallowed",
      }),
    ).toMatchObject({
      outcome: "invalid",
      errorType: "probe_operation_not_allowed",
    });
    expect(
      await observation(
        { kind: "rpc", binding: "rpc", operation: "slow" },
        { timeout_ms: 30 },
      ),
    ).toMatchObject({ outcome: "timeout" });
  });
  it("rejects a synthetic response for another test subject", async () => {
    expect(
      await observation({
        kind: "synthetic",
        binding: "synthetic",
        scenario: "forged",
      }),
    ).toMatchObject({
      outcome: "invalid",
      errorType: "invalid_synthetic_probe_response",
    });
  });
  it("requires isolated synthetic subject and completed cleanup", async () => {
    expect(
      await observation({
        kind: "synthetic",
        binding: "synthetic",
        scenario: "clean",
      }),
    ).toMatchObject({ outcome: "success" });
    expect(
      await observation({
        kind: "synthetic",
        binding: "synthetic",
        scenario: "dirty",
      }),
    ).toMatchObject({ outcome: "failure", protocolStatus: "cleanup_failed" });
    const service = await mf.getWorker("fixture");
    const calls: any = await (
      await service.fetch("https://fixture/calls")
    ).json();
    expect(calls.find((r: any) => r.kind === "synthetic")).toMatchObject({
      test_subject: "probe:isolated",
      correlation_id: id,
    });
  });
});

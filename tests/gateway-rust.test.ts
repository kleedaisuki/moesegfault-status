import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { readFile } from "node:fs/promises";
import { generateKeyPairSync, sign } from "node:crypto";

/** 真实签名与 workerd RPC，mock 仅隔离领域服务。 / Real signatures and workerd RPC; mock isolates only domain services. */
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const issuer = "https://gateway-tests.cloudflareaccess.com";
const audience = "a".repeat(64);
let mf: Miniflare;
/** 独立 Node 密码学生成 Access assertion。 / Independent Node cryptography generates Access assertions. */
function token(subject = "admin") {
  const now = Math.floor(Date.now() / 1000);
  const input = [
    { alg: "RS256", kid: "test" },
    {
      iss: issuer,
      aud: [audience],
      sub: subject,
      email: "human@example.com",
      type: "app",
      identity_nonce: "nonce",
      iat: now,
      nbf: now,
      exp: now + 300,
    },
  ]
    .map((v) => Buffer.from(JSON.stringify(v)).toString("base64url"))
    .join(".");
  return `${input}.${sign("sha256", Buffer.from(input), pair.privateKey).toString("base64url")}`;
}
/** 同源 JSON 请求默认值。 / Same-origin JSON request defaults. */
function headers(subject = "admin") {
  return {
    "cf-access-jwt-assertion": token(subject),
    origin: "https://ops.example",
    "content-type": "application/json",
    "x-moesegfault-csrf": "1",
  };
}
/** 固定 echo 能力用于检查网关投影，不执行实际业务。 / Fixed echo capabilities inspect gateway projection without business execution. */
const methods = [
  "checkHealth",
  "getIncident",
  "getServiceCatalog",
  "getComponentCatalog",
  "getServiceRetentionPolicyAssignment",
  "getDeploymentActivationContext",
  "searchIssues",
  "createIncident",
  "updateIncident",
  "acknowledgeIssue",
  "suppressIssue",
  "createMaintenanceWindow",
  "updateMaintenanceWindow",
  "queryDiagnosticContext",
  "queryTelemetryReference",
  "registerService",
  "updateServiceCatalog",
  "createComponent",
  "updateComponentCatalog",
  "registerAndAssignRetentionPolicy",
  "activateDeployment",
  "createMonitor",
  "updateMonitor",
  "registerEvaluationPolicy",
  "assignDiagnosticPolicy",
  "registerBackend",
  "setStatusOverride",
];
beforeAll(async () => {
  const mock = `import {WorkerEntrypoint} from 'cloudflare:workers'; export class AdminRpc extends WorkerEntrypoint { ${methods.map((m) => `${m}(request){if(request.incident_id === "bad-extra")return {data:{},unexpected:true}; if(request.incident_id === "bad-envelope")return {data:{},problem:{}}; if(request.incident_id === "wrong-correlation")return {problem:{type:"https://status.example/problem",title:"Rejected",status:409,correlation_id:"spoofed"}}; if(request.incident_id === "unavailable")throw Error("secret internal failure"); return {data:{method:${JSON.stringify(m)},request,revision:2}}}`).join("\n")} } export default {fetch(){return new Response('Not found',{status:404})}};`;
  const module = (name: string, contents: string) => ({
    mainModule: name,
    modules: { [name]: { type: "esm" as const, contents } },
  });
  mf = new Miniflare({
    workers: [
      {
        config: {
          type: "worker",
          name: "gateway",
          compatibilityDate: "2026-09-12",
          manifest: {
            mainModule: "index.js",
            modules: {
              "index.js": {
                type: "esm",
                contents: await readFile(
                  "crates/ops-gateway-worker/build/index.js",
                  "utf8",
                ),
              },
              "index_bg.wasm": {
                type: "wasm",
                contents: await readFile(
                  "crates/ops-gateway-worker/build/index_bg.wasm",
                ),
              },
            },
          },
          env: {
            ...Object.fromEntries(
              Object.entries({
                OPS_ORIGIN: "https://ops.example",
                ACCESS_ISSUER: issuer,
                ACCESS_AUDIENCE: audience,
                ACCESS_MAX_TOKEN_AGE_SECONDS: "86400",
                ACCESS_ROLE_MAPPING: JSON.stringify({
                  admin: ["admin"],
                  viewer: ["viewer"],
                }),
                ENVIRONMENT: "development",
              }).map(([key, value]) => [key, { type: "json", value }]),
            ),
            STATUS: {
              type: "worker",
              worker: "status",
              exportName: "AdminRpc",
            },
          },
        },
        dev: { outboundService: { type: "worker", worker: "jwks" } },
      },
      {
        config: {
          type: "worker",
          name: "status",
          compatibilityDate: "2026-09-12",
          manifest: module("status.js", mock),
        },
      },
      {
        config: {
          type: "worker",
          name: "jwks",
          compatibilityDate: "2026-09-12",
          manifest: module(
            "jwks.js",
            `export default {fetch(){return Response.json({keys:[${JSON.stringify({ ...pair.publicKey.export({ format: "jwk" }), alg: "RS256", kid: "test", use: "sig" })}]})}}`,
          ),
        },
      },
    ],
  });
}, 60_000);
afterAll(async () => {
  await mf?.dispose();
});
describe("Rust operations gateway on workerd", () => {
  it("fails closed before dispatch without Access", async () => {
    const r = await mf.dispatchFetch("https://ops.example/api/health");
    expect(r.status).toBe(401);
    expect(r.headers.get("content-type")).toContain("application/problem+json");
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
  it("uses named RPC and replaces browser identity and trace", async () => {
    const r = await mf.dispatchFetch("https://ops.example/api/health", {
      headers: {
        ...headers(),
        "x-moesegfault-correlation-id": "spoofed",
        traceparent: "00-" + "a".repeat(32) + "-" + "b".repeat(16) + "-01",
      },
    });
    expect(r.status, await r.clone().text()).toBe(200);
    const body: any = await r.json();
    expect(body.data.method).toBe("checkHealth");
    expect(body.data.request.principal.subject).toBe("admin");
    expect(body.data.request.correlation_id).not.toBe("spoofed");
    expect(body.data.request.trace_context.traceparent).toBe(
      r.headers.get("traceparent"),
    );
    expect(r.headers.get("etag")).toBe('"2"');
  });
  it("returns session without a business call", async () => {
    const r = await mf.dispatchFetch("https://ops.example/api/session", {
      headers: headers("viewer"),
    });
    expect(r.status, await r.clone().text()).toBe(200);
    expect(((await r.json()) as any).data.roles).toEqual(["viewer"]);
  });
  it("enforces role, CSRF, origin, media, compression and hard byte limit", async () => {
    for (const [changes, subject, body, status] of [
      [{}, "viewer", "{}", 403],
      [{ origin: "https://evil.example" }, "admin", "{}", 403],
      [{ "x-moesegfault-csrf": "0" }, "admin", "{}", 403],
      [{ "sec-fetch-site": "cross-site" }, "admin", "{}", 403],
      [{ "content-type": "text/plain" }, "admin", "{}", 415],
      [{ "content-encoding": "gzip" }, "admin", "{}", 415],
      [{}, "admin", JSON.stringify({ x: "a".repeat(32768) }), 413],
    ] as const) {
      const r = await mf.dispatchFetch("https://ops.example/api/incidents", {
        method: "POST",
        headers: { ...headers(subject), ...changes },
        body,
      });
      expect(r.status).toBe(status);
    }
  });
  it("preserves strong preconditions and flat suppression payload", async () => {
    const url =
      "https://ops.example/api/issues/0199d0a8-2e12-7a59-a51e-000000000001/suppress";
    const body = JSON.stringify({
      command_id: "0199d0a8-2e12-7a59-a51e-000000000002",
      until: "2026-09-13T00:00:00Z",
      reason: "maintenance",
    });
    expect(
      (
        await mf.dispatchFetch(url, {
          method: "POST",
          headers: headers(),
          body,
        })
      ).status,
    ).toBe(428);
    const r = await mf.dispatchFetch(url, {
      method: "POST",
      headers: { ...headers(), "if-match": '"7"' },
      body,
    });
    expect(r.status, await r.clone().text()).toBe(200);
    const data: any = await r.json();
    expect(data.data.request.expected_revision).toBe(7);
    expect(data.data.request.until).toBe("2026-09-13T00:00:00Z");
    expect(data.data.request.command).toBeUndefined();
  });
  it("rejects unknown methods, query, path encoding and principal injection", async () => {
    for (const [path, method, status] of [
      ["/api/health?x=1", "GET", 400],
      ["/api/unknown", "GET", 404],
      ["/api/incidents", "OPTIONS", 405],
      ["/api/incidents/%GG", "GET", 400],
    ] as const) {
      expect(
        (
          await mf.dispatchFetch(`https://ops.example${path}`, {
            method,
            headers: headers(),
          })
        ).status,
      ).toBe(status);
    }
    expect(
      (
        await mf.dispatchFetch(
          "https://ops.example/api/issues/id/acknowledge",
          {
            method: "POST",
            headers: { ...headers(), "if-match": '"1"' },
            body: JSON.stringify({
              command_id: "id",
              principal: { roles: ["admin"] },
            }),
          },
        )
      ).status,
    ).toBe(400);
  });
  it("rejects malformed downstream envelopes, correlation confusion and hides exceptions", async () => {
    for (const id of [
      "bad-envelope",
      "bad-extra",
      "wrong-correlation",
      "unavailable",
    ]) {
      const r = await mf.dispatchFetch(
        `https://ops.example/api/incidents/${id}`,
        { headers: headers() },
      );
      expect(r.status).toBe(502);
      expect(await r.text()).not.toContain("secret internal failure");
    }
  });
  it("exposes every frontend HTTP capability through the fixed named RPC surface", async () => {
    const cases = [
      ["GET", "/api/health", "checkHealth", 200],
      [
        "GET",
        "/api/incidents/0199d0a8-2e12-7a59-a51e-000000000001",
        "getIncident",
        200,
      ],
      [
        "GET",
        "/api/evidence/0199d0a8-2e12-7a59-a51e-000000000001",
        "queryTelemetryReference",
        200,
      ],
      [
        "GET",
        "/api/catalog/services/0199d0a8-2e12-7a59-a51e-000000000001",
        "getServiceCatalog",
        200,
      ],
      [
        "GET",
        "/api/catalog/components/0199d0a8-2e12-7a59-a51e-000000000001",
        "getComponentCatalog",
        200,
      ],
      [
        "GET",
        "/api/retention-policy-assignments/0199d0a8-2e12-7a59-a51e-000000000001",
        "getServiceRetentionPolicyAssignment",
        200,
      ],
      [
        "GET",
        "/api/deployments/0199d0a8-2e12-7a59-a51e-000000000001/activation-context",
        "getDeploymentActivationContext",
        200,
      ],
      ["POST", "/api/issues/search", "searchIssues", 200],
      ["POST", "/api/diagnostic-context/query", "queryDiagnosticContext", 200],
      ["POST", "/api/incidents", "createIncident", 201],
      [
        "PATCH",
        "/api/incidents/0199d0a8-2e12-7a59-a51e-000000000001",
        "updateIncident",
        200,
      ],
      [
        "POST",
        "/api/issues/0199d0a8-2e12-7a59-a51e-000000000001/acknowledge",
        "acknowledgeIssue",
        200,
      ],
      [
        "POST",
        "/api/issues/0199d0a8-2e12-7a59-a51e-000000000001/suppress",
        "suppressIssue",
        200,
      ],
      ["POST", "/api/maintenance-windows", "createMaintenanceWindow", 201],
      [
        "PATCH",
        "/api/maintenance-windows/0199d0a8-2e12-7a59-a51e-000000000001",
        "updateMaintenanceWindow",
        200,
      ],
      ["POST", "/api/services", "registerService", 201],
      [
        "PATCH",
        "/api/services/0199d0a8-2e12-7a59-a51e-000000000001",
        "updateServiceCatalog",
        200,
      ],
      ["POST", "/api/components", "createComponent", 201],
      [
        "PATCH",
        "/api/components/0199d0a8-2e12-7a59-a51e-000000000001",
        "updateComponentCatalog",
        200,
      ],
      [
        "POST",
        "/api/retention-policy-assignments",
        "registerAndAssignRetentionPolicy",
        200,
      ],
      [
        "POST",
        "/api/deployments/0199d0a8-2e12-7a59-a51e-000000000001/activate",
        "activateDeployment",
        200,
      ],
      ["POST", "/api/monitors", "createMonitor", 201],
      [
        "PATCH",
        "/api/monitors/0199d0a8-2e12-7a59-a51e-000000000001",
        "updateMonitor",
        200,
      ],
      ["POST", "/api/evaluation-policies", "registerEvaluationPolicy", 201],
      [
        "POST",
        "/api/diagnostic-policy-assignments",
        "assignDiagnosticPolicy",
        201,
      ],
      ["POST", "/api/telemetry-backends", "registerBackend", 201],
      ["POST", "/api/status-overrides", "setStatusOverride", 201],
    ] as const;
    for (const [method, path, rpc, status] of cases) {
      const r = await mf.dispatchFetch(`https://ops.example${path}`, {
        method,
        headers: { ...headers(), "if-match": '"3"' },
        ...(method === "GET"
          ? {}
          : {
              body: JSON.stringify({
                command_id: "0199d0a8-2e12-7a59-a51e-000000000002",
              }),
            }),
      });
      expect(r.status, `${method} ${path}: ${await r.clone().text()}`).toBe(
        status,
      );
      expect(((await r.json()) as any).data.method).toBe(rpc);
    }
  });
});

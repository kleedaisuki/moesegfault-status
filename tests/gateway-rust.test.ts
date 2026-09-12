import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { readFile } from "node:fs/promises";
/** 不透明cookie仅在真实named RPC中校验。 / Opaque cookies are validated through real named RPC. */
const session = "a".repeat(43);
let mf: Miniflare;
/** 同源 JSON 请求默认值。 / Same-origin JSON request defaults. */
function headers() {
  return {
    cookie: `__Host-moe_session=${session}`,
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
  const mock = `import {WorkerEntrypoint} from 'cloudflare:workers'; export class AdminRpc extends WorkerEntrypoint {
    authenticateAdministrator(request){if(request.session_token === "b".repeat(43))return {data:{principal:{...this.identity(),subject:"spoofed"}}}; return request.session_token === ${JSON.stringify(session)} ? {data:{principal:this.identity()}} : this.denied(request)}
    identity(){return {subject:'single-admin',email:'admin@example.com',roles:['admin'],authenticated_at:'2026-09-12T00:00:00Z',access_application:'single-admin-password'}}
    denied(request){return {problem:{type:'https://status.example/problem',title:'Denied',status:401,correlation_id:request.correlation_id}}}
    loginAdministrator(request){return request.password === 'test-password' ? {data:{session_token:${JSON.stringify(session)},expires_at:'2026-09-13T00:00:00Z',principal:this.identity()}} : this.denied(request)}
    logoutAdministrator(request){return request.session_token === ${JSON.stringify(session)} ? {data:{ok:true}} : this.denied(request)}
    ${methods.map((m) => `${m}(request){if(request.incident_id === "bad-extra")return {data:{},unexpected:true}; if(request.incident_id === "bad-envelope")return {data:{},problem:{}}; if(request.incident_id === "wrong-correlation")return {problem:{type:"https://status.example/problem",title:"Rejected",status:409,correlation_id:"spoofed"}}; if(request.incident_id === "unavailable")throw Error("secret internal failure"); return {data:{method:${JSON.stringify(m)},request,revision:2}}}`).join("\n")} } export default {fetch(){return new Response('Not found',{status:404})}};`;
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
      },
      {
        config: {
          type: "worker",
          name: "status",
          compatibilityDate: "2026-09-12",
          manifest: module("status.js", mock),
        },
      },
    ],
  });
}, 60_000);
afterAll(async () => {
  await mf?.dispose();
});
describe("Rust operations gateway on workerd", () => {
  it("fails closed before dispatch without a session", async () => {
    const r = await mf.dispatchFetch("https://ops.example/api/health");
    expect(r.status).toBe(401);
    expect(r.headers.get("content-type")).toContain("application/problem+json");
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
  it("ignores forged Access assertions and rejects malformed or duplicate session cookies", async () => {
    for (const cookie of [
      "",
      "__Host-moe_session=bad",
      `__Host-moe_session=${session}; __Host-moe_session=${session}`,
    ]) {
      const r = await mf.dispatchFetch("https://ops.example/api/session", {
        headers: { cookie, "cf-access-jwt-assertion": "forged" },
      });
      expect(r.status).toBe(401);
    }
  });
  it("rejects noncanonical trusted identity and revalidates each request", async () => {
    const r = await mf.dispatchFetch("https://ops.example/api/session", {
      headers: { cookie: `__Host-moe_session=${"b".repeat(43)}` },
    });
    expect(r.status).toBe(502);
    const valid = await mf.dispatchFetch("https://ops.example/api/session", {
      headers: headers(),
    });
    expect(valid.status).toBe(200);
    const invalid = await mf.dispatchFetch("https://ops.example/api/session", {
      headers: { cookie: `__Host-moe_session=${"c".repeat(43)}` },
    });
    expect(invalid.status).toBe(401);
  });
  it("logs in with a host-only secure HttpOnly cookie, never a JSON session token", async () => {
    const r = await mf.dispatchFetch("https://ops.example/api/auth/login", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ password: "test-password" }),
    });
    expect(r.status).toBe(200);
    const cookie = r.headers.get("set-cookie")!;
    for (const part of [
      `__Host-moe_session=${session}`,
      "Secure",
      "HttpOnly",
      "SameSite=Strict",
      "Path=/",
      "Max-Age=43200",
    ])
      expect(cookie).toContain(part);
    expect(cookie).not.toContain("Domain=");
    const body = await r.text();
    expect(body).not.toContain(session);
    expect(body).not.toContain("session_token");
    const logout = await mf.dispatchFetch(
      "https://ops.example/api/auth/logout",
      { method: "POST", headers: headers(), body: "{}" },
    );
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
  });
  it("protects every auth POST with origin, CSRF, exact fields and 8KiB bounds", async () => {
    for (const [changes, body, status] of [
      [{ origin: "https://evil.example" }, { password: "test-password" }, 403],
      [{ "x-moesegfault-csrf": "0" }, { password: "test-password" }, 403],
      [{ "sec-fetch-site": "cross-site" }, { password: "test-password" }, 403],
      [{ "content-type": "text/plain" }, { password: "test-password" }, 415],
      [{}, { password: "test-password", principal: { roles: ["admin"] } }, 400],
      [{}, { password: "wrong" }, 401],
      [{}, { password: "a".repeat(8192) }, 413],
    ] as const) {
      const r = await mf.dispatchFetch("https://ops.example/api/auth/login", {
        method: "POST",
        headers: { ...headers(), ...changes },
        body: JSON.stringify(body),
      });
      expect(r.status).toBe(status);
      expect(await r.text()).not.toContain("test-password");
    }
    for (const path of ["setup", "password"])
      expect(
        (
          await mf.dispatchFetch(`https://ops.example/api/auth/${path}`, {
            method: "POST",
            headers: headers(),
            body: "{}",
          })
        ).status,
      ).toBe(404);
    expect(
      (
        await mf.dispatchFetch("https://ops.example/api/auth/login?x=1", {
          method: "POST",
          headers: headers(),
          body: "{}",
        })
      ).status,
    ).toBe(400);
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
    expect(body.data.request.principal.subject).toBe("single-admin");
    expect(body.data.request.correlation_id).not.toBe("spoofed");
    expect(body.data.request.trace_context.traceparent).toBe(
      r.headers.get("traceparent"),
    );
    expect(r.headers.get("etag")).toBe('"2"');
  });
  it("returns session without a business call", async () => {
    const r = await mf.dispatchFetch("https://ops.example/api/session", {
      headers: headers(),
    });
    expect(r.status, await r.clone().text()).toBe(200);
    expect(((await r.json()) as any).data.roles).toEqual(["admin"]);
  });
  it("enforces CSRF, origin, media, compression and hard byte limit", async () => {
    for (const [changes, _subject, body, status] of [
      [{ origin: "https://evil.example" }, "admin", "{}", 403],
      [{ "x-moesegfault-csrf": "0" }, "admin", "{}", 403],
      [{ "sec-fetch-site": "cross-site" }, "admin", "{}", 403],
      [{ "content-type": "text/plain" }, "admin", "{}", 415],
      [{ "content-encoding": "gzip" }, "admin", "{}", 415],
      [{}, "admin", JSON.stringify({ x: "a".repeat(32768) }), 413],
    ] as const) {
      const r = await mf.dispatchFetch("https://ops.example/api/incidents", {
        method: "POST",
        headers: { ...headers(), ...changes },
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

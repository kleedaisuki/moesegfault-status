import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { GetServiceCatalogRpcResultSchema } from "../packages/contracts/src/index.js";
import { readFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import {
  CheckHealthRpcResultSchema,
  RegisterServiceRpcResultSchema,
} from "../packages/contracts/src/admin.js";

/** 固定完整能力表，与生产导出逐一对照。 / Complete fixed capability list, checked against production exports. */
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
let mf: Miniflare;
/** 私有可信调用者身份；此测试不把它暴露到生产HTTP。 / Trusted private caller identity, never exposed through production HTTP. */
const context = {
  principal: {
    subject: "rpc-admin",
    email: "admin@example.com",
    roles: ["admin"],
    authenticated_at: "2026-09-12T00:00:00Z",
    access_application: "a".repeat(64),
  },
  correlation_id: "0199d0a8-2e12-7a59-a51e-000000000001",
};
/** 仅测试的服务绑定调用器，没有领域mock。 / Test-only service-binding caller, with no domain mocks. */
async function call(method: string, raw: unknown = context, target = "NAMED") {
  const response = await mf.dispatchFetch(`https://test/${target}/${method}`, {
    method: "POST",
    body: JSON.stringify(raw),
  });
  return { status: response.status, body: (await response.json()) as any };
}

beforeAll(async () => {
  const admin = (
    await readFile("crates/admin-rpc-worker/build/index.js", "utf8")
  ).replaceAll("./index_bg.wasm", "./admin_bg.wasm");
  const normal = (
    await readFile("crates/status-worker/build/index.js", "utf8")
  ).replaceAll("./index_bg.wasm", "./public_bg.wasm");
  const manifest = {
    mainModule: "main.js",
    modules: {
      "main.js": {
        type: "esm" as const,
        contents:
          "export {default} from './public.js'; export {default as AdminRpc} from './admin.js';",
      },
      "public.js": { type: "esm" as const, contents: normal },
      "admin.js": { type: "esm" as const, contents: admin },
      "public_bg.wasm": {
        type: "wasm" as const,
        contents: await readFile("crates/status-worker/build/index_bg.wasm"),
      },
      "admin_bg.wasm": {
        type: "wasm" as const,
        contents: await readFile("crates/admin-rpc-worker/build/index_bg.wasm"),
      },
    },
  };
  const variables = {
    CURSOR_SIGNING_KEY: {
      type: "json" as const,
      value: "integration-cursor-secret",
    },
    STATUS_VERSION: { type: "json" as const, value: "rpc-test" },
    ENVIRONMENT: { type: "json" as const, value: "development" },
  };
  mf = new Miniflare({
    workers: [
      {
        config: {
          type: "worker",
          name: "caller",
          compatibilityDate: "2026-09-12",
          manifest: {
            mainModule: "caller.js",
            modules: {
              "caller.js": {
                type: "esm",
                contents: `export default {async fetch(request,env){const [,target,method]=new URL(request.url).pathname.split('/');try{const data=await env[target][method](await request.json());return Response.json(data)}catch{return Response.json({transport_unavailable:true},{status:404})}}}`,
              },
            },
          },
          env: {
            NAMED: { type: "worker", worker: "status", exportName: "AdminRpc" },
            DEFAULT: { type: "worker", worker: "status" },
            BOOTSTRAP: {
              type: "worker",
              worker: "bootstrap",
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
          manifest,
          env: { ...variables, DB: { type: "d1", id: "admin-rpc-database" } },
        },
      },
      {
        config: {
          type: "worker",
          name: "bootstrap",
          compatibilityDate: "2026-09-12",
          manifest,
          env: {
            ...variables,
            BOOTSTRAP_MODE: { type: "json", value: "true" },
          },
        },
      },
    ],
  });
  const db = await mf.getD1Database("DB", "status");
  for (const name of (await readdir("migrations"))
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    const statements: string[] = JSON.parse(
      execFileSync("python", ["tests/runtime/split_sql.py"], {
        input: await readFile(`migrations/${name}`, "utf8"),
        encoding: "utf8",
        windowsHide: true,
      }),
    );
    await db.batch(statements.map((sql) => db.prepare(sql)));
  }
}, 60_000);
afterAll(async () => {
  await mf?.dispose();
});
describe("Actual Rust named AdminRpc and separate default modules", () => {
  it("exports all 27 named capabilities while default binding exposes none", async () => {
    for (const method of methods) {
      const named = await call(method, {});
      expect(named.status, method).toBe(200);
      expect(named.body.problem?.status, method).toBe(400);
      const normal = await call(method, {}, "DEFAULT");
      expect(normal.status, method).toBe(404);
      expect(normal.body).toEqual({ transport_unavailable: true });
    }
  });
  it("rejects all ordinary RPCs during bootstrap before any database access", async () => {
    for (const method of methods) {
      const r = await call(method, context, "BOOTSTRAP");
      expect(r.status).toBe(200);
      expect(r.body.problem.status, method).toBe(503);
      expect(r.body.problem.title).toContain("bootstrap");
    }
  });
  it("checks authoritative D1 health and produces contract-valid plain JS objects", async () => {
    const r = await call("checkHealth");
    const result = CheckHealthRpcResultSchema.parse(r.body);
    expect(result).toMatchObject({
      data: {
        status: "ok",
        service_name: "status",
        version: "rpc-test",
        dependencies: [{ name: "d1", status: "ok" }],
      },
    });
    const invalid = await call("checkHealth", { ...context, unexpected: true });
    expect(invalid.body.problem.status).toBe(400);
  });
  it("registers a real service transaction then reads its persisted typed catalog", async () => {
    const command = {
      command_id: "0199d0a8-2e12-7a59-a51e-000000000010",
      service_name: "rpc-service",
      display_name: "RPC Service",
      description: "Real private Rust transaction",
      owner: "platform",
      criticality: "critical",
      enabled: true,
      components: [],
      dependencies: [],
    };
    const created = await call("registerService", { ...context, command });
    RegisterServiceRpcResultSchema.parse(created.body);
    expect(created.body.data?.service_name, JSON.stringify(created.body)).toBe(
      "rpc-service",
    );
    const read = await call("getServiceCatalog", {
      ...context,
      service_name: "rpc-service",
    });
    GetServiceCatalogRpcResultSchema.parse(read.body);
    expect(read.body.data).toMatchObject({
      service_name: "rpc-service",
      display_name: "RPC Service",
      revision: 1,
      dependencies: [],
    });
    const db = await mf.getD1Database("DB", "status");
    expect(
      await db
        .prepare(
          "SELECT display_name,revision FROM services WHERE service_name=?",
        )
        .bind("rpc-service")
        .first(),
    ).toEqual({ display_name: "RPC Service", revision: 1 });
  });
  it("revalidates authorization and hides storage internals on missing records", async () => {
    const denied = await call("registerService", {
      ...context,
      principal: { ...context.principal, roles: ["viewer"] },
      command: {},
    });
    expect(denied.body.problem.status).toBe(403);
    for (const [method, field, value] of [
      ["getServiceCatalog", "service_name", "absent"],
      ["getIncident", "incident_id", "0199d0a8-2e12-7a59-a51e-000000000099"],
      [
        "queryTelemetryReference",
        "telemetry_reference_id",
        "0199d0a8-2e12-7a59-a51e-000000000099",
      ],
    ]) {
      const r = await call(method, { ...context, [field]: value });
      expect(r.body.problem.status).toBe(404);
      expect(JSON.stringify(r.body)).not.toContain("SELECT");
    }
  });
  it("keeps public fetch working beside the private module without an HTTP RPC fallback", async () => {
    const normal = await mf.getWorker("status");
    const publicResponse = await normal.fetch(
      "https://status.example/v1/services",
    );
    expect(publicResponse.status, await publicResponse.clone().text()).toBe(
      200,
    );
    for (const path of [
      "/rpc/getServiceCatalog",
      "/api/health",
      "/admin/checkHealth",
    ]) {
      expect((await normal.fetch(`https://status.example${path}`)).status).toBe(
        404,
      );
    }
    expect((await call("checkHealth")).body.data.status).toBe("ok");
  });
});

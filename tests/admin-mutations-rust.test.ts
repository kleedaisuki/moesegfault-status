import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { readFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";

let mf: Miniflare;
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
/** 仅用于测试的规范 UUIDv7。 / Canonical fixture UUIDv7, not production identity generation. */
const id = (n: number) =>
  `0199d0a8-2e12-7a59-a51e-${n.toString(16).padStart(12, "0")}`;
const principal = {
  subject: "mutation-admin",
  email: "admin@example.com",
  roles: ["admin"],
  authenticated_at: "2026-09-12T00:00:00.000Z",
  access_application: "test-admin",
};
/** 通过真正的命名能力调用 Rust，不模拟任何数据库或领域服务。 / Call real named Rust capabilities without database or domain mocks. */
async function rpc(operation: string, args: Record<string, unknown>) {
  const response = await mf.dispatchFetch(`https://caller.test/${operation}`, {
    method: "POST",
    body: JSON.stringify({ principal, correlation_id: id(1), ...args }),
    headers: { "content-type": "application/json" },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as {
    data?: Record<string, unknown>;
    problem?: { status: number; title: string };
  };
}
/** 一条参数化聚合查询用于检查提交边界。 / Parameterized aggregate query inspecting commit boundaries. */
async function count(
  table: "audit_log" | "outbox" | "idempotency_keys" | "maintenance_windows",
  column: string,
  value: string,
) {
  const row = await db
    .prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${column}=?`)
    .bind(value)
    .first<{ n: number }>();
  return row!.n;
}
/** 注册拥有公共 Component 的真实目录。 / Register a real catalog owning a public component. */
async function register(name: string, command: number) {
  const result = await rpc("registerService", {
    command: {
      command_id: id(command),
      service_name: name,
      display_name: name,
      description: "Runtime acceptance",
      owner: "platform",
      criticality: "high",
      enabled: true,
      dependencies: [],
      components: [
        {
          component_id: `${name}-public`,
          display_name: name,
          public: true,
          sort_order: 1,
        },
      ],
    },
  });
  expect(result, JSON.stringify(result)).toHaveProperty("data");
  return result;
}

beforeAll(async () => {
  const admin = (
    await readFile("crates/admin-rpc-worker/build/index.js", "utf8")
  ).replaceAll("./index_bg.wasm", "./admin_bg.wasm");
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
                contents: `export default {async fetch(request,env){const operation=new URL(request.url).pathname.slice(1);return Response.json(await env.STATUS[operation](await request.json()))}}`,
              },
            },
          },
          env: {
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
          manifest: {
            mainModule: "main.js",
            modules: {
              "main.js": {
                type: "esm",
                contents: `export {default as AdminRpc} from './admin.js'; export default {fetch(){return new Response('Not found',{status:404})}};`,
              },
              "admin.js": { type: "esm", contents: admin },
              "admin_bg.wasm": {
                type: "wasm",
                contents: await readFile(
                  "crates/admin-rpc-worker/build/index_bg.wasm",
                ),
              },
            },
          },
          env: {
            DB: { type: "d1", id: "rust-admin-mutations" },
            ENVIRONMENT: { type: "json", value: "development" },
            STATUS_VERSION: { type: "json", value: "integration" },
          },
        },
      },
    ],
  });
  db = await mf.getD1Database("DB", "status");
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
    for (const sql of statements) await db.prepare(sql).run();
  }
}, 60_000);
afterAll(async () => {
  await mf?.dispose();
});

describe("native Rust mutation transactions on real workerd D1", () => {
  it("commits catalog, audit, outbox and exact idempotent result once under concurrent replay", async () => {
    await register("replay", 10);
    const command = { command_id: id(11), display_name: "First revision" };
    const request = { service_name: "replay", expected_revision: 1, command };
    const [first, replay] = await Promise.all([
      rpc("updateServiceCatalog", request),
      rpc("updateServiceCatalog", request),
    ]);
    expect(first, JSON.stringify(first)).toHaveProperty("data");
    expect(replay).toEqual(first);
    expect(await count("idempotency_keys", "idempotency_key", id(11))).toBe(1);
    expect(await count("audit_log", "target_id", "replay")).toBe(2);
    expect(await count("outbox", "aggregate_id", "replay")).toBe(2);
    expect(
      await rpc("updateServiceCatalog", {
        ...request,
        expected_revision: 2,
        command: { command_id: id(12), display_name: "Later revision" },
      }),
    ).toHaveProperty("data");
    expect(await rpc("updateServiceCatalog", request)).toEqual(first);
    expect(
      (
        await rpc("updateServiceCatalog", {
          ...request,
          command: { ...command, display_name: "Different command" },
        })
      ).problem?.status,
    ).toBe(409);
  });
  it("lets exactly one concurrent OCC command win and rejects stale writes without side effects", async () => {
    await register("occ", 20);
    const responses = await Promise.all(
      [21, 22].map((n) =>
        rpc("updateServiceCatalog", {
          service_name: "occ",
          expected_revision: 1,
          command: { command_id: id(n), description: `winner ${n}` },
        }),
      ),
    );
    expect(responses.filter((r) => r.data)).toHaveLength(1);
    expect(responses.filter((r) => r.problem?.status === 409)).toHaveLength(1);
    expect(await count("audit_log", "target_id", "occ")).toBe(2);
    expect(await count("outbox", "aggregate_id", "occ")).toBe(2);
    expect(
      (
        await rpc("updateServiceCatalog", {
          service_name: "occ",
          expected_revision: 1,
          command: { command_id: id(23), enabled: false },
        })
      ).problem?.status,
    ).toBe(409);
    expect(await count("idempotency_keys", "idempotency_key", id(23))).toBe(0);
  });
  it("rolls back the domain update when a later audit constraint fails", async () => {
    await register("rollback", 30);
    await db
      .prepare(
        "CREATE TRIGGER test_reject_audit BEFORE INSERT ON audit_log WHEN NEW.target_id='rollback' AND NEW.action='service.catalog_updated' BEGIN SELECT RAISE(ABORT,'audit invariant'); END",
      )
      .run();
    try {
      const failed = await rpc("updateServiceCatalog", {
        service_name: "rollback",
        expected_revision: 1,
        command: { command_id: id(31), display_name: "Must not commit" },
      });
      expect(failed.problem).toBeDefined();
      expect(
        await db
          .prepare(
            "SELECT revision,display_name FROM services WHERE service_name='rollback'",
          )
          .first(),
      ).toEqual({ revision: 1, display_name: "rollback" });
      expect(await count("audit_log", "target_id", "rollback")).toBe(1);
      expect(await count("outbox", "aggregate_id", "rollback")).toBe(1);
      expect(await count("idempotency_keys", "idempotency_key", id(31))).toBe(
        0,
      );
    } finally {
      await db.prepare("DROP TRIGGER test_reject_audit").run();
    }
  });
  it("commits maintenance and service/component candidate status together, then cancels both", async () => {
    await register("overlay", 40);
    const time = Date.now();
    const created = await rpc("createMaintenanceWindow", {
      command: {
        command_id: id(41),
        title: "Immediate",
        description: "Atomic maintenance",
        starts_at: new Date(time - 60000).toISOString(),
        ends_at: new Date(time + 3600000).toISOString(),
        expected_impact: "degraded",
        target_services: ["overlay"],
        target_components: [],
      },
    });
    expect(created, JSON.stringify(created)).toHaveProperty("data");
    const rows = await db
      .prepare(
        "SELECT target_type,direct_status,effective_impact FROM current_statuses WHERE target_id IN ('overlay','overlay-public') ORDER BY target_type",
      )
      .all();
    expect(rows.results).toHaveLength(2);
    for (const row of rows.results)
      expect(row.direct_status).toBe("maintenance");
    const canceled = await rpc("updateMaintenanceWindow", {
      id: created.data!.maintenance_id,
      expected_revision: 1,
      command: { command_id: id(42), state: "cancelled" },
    });
    expect(canceled, JSON.stringify(canceled)).toHaveProperty("data");
    const after = await db
      .prepare(
        "SELECT direct_status FROM current_statuses WHERE target_id IN ('overlay','overlay-public')",
      )
      .all();
    for (const row of after.results)
      expect(row.direct_status).not.toBe("maintenance");
  });
  it("rolls back maintenance and service status when the component status write fails", async () => {
    await register("atomic", 50);
    await db
      .prepare(
        "CREATE TRIGGER test_reject_component BEFORE INSERT ON current_statuses WHEN NEW.target_id='atomic-public' BEGIN SELECT RAISE(ABORT,'component invariant'); END",
      )
      .run();
    try {
      const time = Date.now();
      const result = await rpc("createMaintenanceWindow", {
        command: {
          command_id: id(51),
          title: "Must rollback",
          description: "Atomic candidate",
          starts_at: new Date(time - 60000).toISOString(),
          ends_at: new Date(time + 3600000).toISOString(),
          expected_impact: "degraded",
          target_services: ["atomic"],
          target_components: [],
        },
      });
      expect(result.problem).toBeDefined();
      expect(await count("maintenance_windows", "title", "Must rollback")).toBe(
        0,
      );
      expect(
        await db
          .prepare(
            "SELECT COUNT(*) n FROM current_statuses WHERE target_id IN ('atomic','atomic-public')",
          )
          .first(),
      ).toEqual({ n: 0 });
      expect(await count("idempotency_keys", "idempotency_key", id(51))).toBe(
        0,
      );
    } finally {
      await db.prepare("DROP TRIGGER test_reject_component").run();
    }
  });
  it("propagates service override candidates to supporting components without reading old service status", async () => {
    await register("provider", 60);
    await register("consumer", 61);
    const linked = await rpc("updateComponentCatalog", {
      component_id: "consumer-public",
      expected_revision: 1,
      command: { command_id: id(62), supporting_services: ["provider"] },
    });
    expect(linked, JSON.stringify(linked)).toHaveProperty("data");
    const changed = await rpc("setStatusOverride", {
      command: {
        command_id: id(63),
        target: { target_type: "service", service_name: "provider" },
        status: "major_outage",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        reason: "Confirmed loss",
      },
    });
    expect(changed, JSON.stringify(changed)).toHaveProperty("data");
    const service = await db
      .prepare(
        "SELECT direct_status FROM current_statuses WHERE target_type='service' AND target_id='provider'",
      )
      .first();
    expect(service).toEqual({ direct_status: "major_outage" });
    const component = await db
      .prepare(
        "SELECT effective_impact FROM current_statuses WHERE target_type='component' AND target_id='consumer-public'",
      )
      .first();
    expect(component).toEqual({ effective_impact: "major_outage" });
    const again = await rpc("setStatusOverride", {
      command: {
        command_id: id(64),
        target: { target_type: "service", service_name: "provider" },
        status: "operational",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        reason: "Cannot silently replace active override",
      },
    });
    expect(again.problem?.status).toBe(409);
  });
  it("keeps incident timeline append-only and rejects stale updates", async () => {
    await register("incident", 70);
    const created = await rpc("createIncident", {
      command: {
        command_id: id(71),
        title: "Runtime incident",
        impact: "degraded",
        started_at: new Date(Date.now() - 60000).toISOString(),
        affected_components: ["incident-public"],
        issue_ids: [],
        initial_message: "Investigating",
      },
    });
    expect(created, JSON.stringify(created)).toHaveProperty("data");
    const request = {
      incident_id: created.data!.incident_id,
      expected_revision: 1,
      command: {
        command_id: id(72),
        title: "Revised title",
        message: "Investigation continues",
      },
    };
    const updated = await rpc("updateIncident", request);
    expect(updated, JSON.stringify(updated)).toHaveProperty("data");
    expect(updated.data!.revision).toBe(2);
    expect(updated.data!.updates as unknown[]).toHaveLength(2);
    const stale = await rpc("updateIncident", {
      ...request,
      command: { command_id: id(73), message: "Stale write" },
    });
    expect(stale.problem?.status).toBe(409);
    const rows = await db
      .prepare(
        "SELECT sequence,title FROM incident_updates WHERE incident_id=? ORDER BY sequence",
      )
      .bind(created.data!.incident_id)
      .all();
    expect(rows.results).toEqual([
      { sequence: 1, title: "Runtime incident" },
      { sequence: 2, title: "Revised title" },
    ]);
  });
  it("atomically registers retention revisions and binds with assignment OCC", async () => {
    await register("retention", 80);
    const policy = {
      policy_id: "runtime-retention",
      revision: 1,
      occurrence_retention_days: 30,
      cleanup_batch_size: 100,
    };
    const created = await rpc("registerAndAssignRetentionPolicy", {
      command: {
        command_id: id(81),
        service_name: "retention",
        policy,
        expected_assignment_revision: null,
      },
    });
    expect(created, JSON.stringify(created)).toHaveProperty("data");
    const stale = await rpc("registerAndAssignRetentionPolicy", {
      command: {
        command_id: id(82),
        service_name: "retention",
        policy: { ...policy, revision: 2 },
        expected_assignment_revision: 9,
      },
    });
    expect(stale.problem?.status).toBe(409);
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) n FROM data_retention_policies WHERE policy_id='runtime-retention' AND revision=2",
        )
        .first(),
    ).toEqual({ n: 0 });
    expect(await count("idempotency_keys", "idempotency_key", id(82))).toBe(0);
  });
});

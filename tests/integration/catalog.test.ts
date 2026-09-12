import { afterEach, describe, expect, it } from "vitest";

import {
  createComponent,
  updateComponentCatalog,
  updateServiceCatalog,
} from "../../workers/status/src/admin/catalog.js";
import { getServiceStatus } from "../../workers/status/src/public/handlers.js";
import { D1TargetReevaluator } from "../../workers/status/src/scheduling/reevaluate.js";
import { createMigratedD1, type TestD1Database } from "./d1.js";

const CREATED = "2026-09-12T12:00:00.000Z";
const PRINCIPAL = {
  subject: "catalog-admin",
  email: "catalog-admin@example.com",
  roles: ["admin" as const],
  authenticated_at: CREATED,
  access_application: "integration-test",
};
const CORRELATION = "018f0000-0000-7000-8000-000000000700";

/** 构造可信私有 RPC 上下文。 / Build a trusted private-RPC context. */
function context() {
  return { principal: PRINCIPAL, correlation_id: CORRELATION };
}

/** 插入最小服务目录行。 / Insert a minimal service-catalog row. */
async function seedService(
  database: TestD1Database,
  serviceName: string,
): Promise<void> {
  await database
    .prepare(
      `INSERT INTO services
       (service_name,display_name,description,owner,criticality,enabled,created_at,updated_at)
       VALUES (?,?,?,?,?,1,?,?)`,
    )
    .bind(
      serviceName,
      serviceName.toUpperCase(),
      "",
      "platform",
      "critical",
      CREATED,
      CREATED,
    )
    .run();
}

describe("catalog mutation commands with real D1", () => {
  const opened: TestD1Database[] = [];
  afterEach(() => {
    for (const database of opened.splice(0)) database.close();
  });

  async function ready(): Promise<TestD1Database> {
    const database = await createMigratedD1();
    opened.push(database);
    return database;
  }

  it("adds a reciprocal dependency after both services exist and preserves cycles", async () => {
    const database = await ready();
    await seedService(database, "api");
    await seedService(database, "database");
    await seedService(database, "cache");
    await database.batch([
      database
        .prepare(
          `INSERT INTO service_dependencies
           (source_service,target_service,capability,kind,criticality,created_at)
           VALUES ('database','api','callback','required','high',?)`,
        )
        .bind(CREATED),
      database
        .prepare(
          `INSERT INTO service_dependencies
           (source_service,target_service,capability,kind,criticality,created_at)
           VALUES ('api','cache','cache','optional','low',?)`,
        )
        .bind(CREATED),
    ]);

    const first = await updateServiceCatalog(databaseEnvironment(database), {
      ...context(),
      service_name: "api",
      expected_revision: 1,
      command: {
        command_id: "018f0000-0000-7000-8000-000000000701",
        display_name: "Public API",
        dependencies: [
          {
            target_service: "database",
            capability: "storage",
            kind: "required",
            criticality: "critical",
          },
        ],
      },
    });

    expect(first).toMatchObject({
      data: {
        service_name: "api",
        display_name: "Public API",
        revision: 2,
        dependencies: [{ target_service: "database", capability: "storage" }],
      },
    });
    await expect(
      database
        .prepare("SELECT COUNT(*) FROM service_dependencies")
        .first<number>("COUNT(*)"),
    ).resolves.toBe(2);

    const replayed = await updateServiceCatalog(databaseEnvironment(database), {
      ...context(),
      service_name: "api",
      expected_revision: 1,
      command: {
        command_id: "018f0000-0000-7000-8000-000000000701",
        display_name: "Public API",
        dependencies: [
          {
            target_service: "database",
            capability: "storage",
            kind: "required",
            criticality: "critical",
          },
        ],
      },
    });
    expect(replayed).toEqual(first);
    await expect(
      database
        .prepare("SELECT COUNT(*) FROM audit_log")
        .first<number>("COUNT(*)"),
    ).resolves.toBe(1);
    await expect(
      database.prepare("SELECT COUNT(*) FROM outbox").first<number>("COUNT(*)"),
    ).resolves.toBe(1);
    const auditDetails = await database
      .prepare("SELECT details_json FROM audit_log")
      .first<string>("details_json");
    expect(JSON.parse(auditDetails ?? "{}")).toMatchObject({
      changed_fields: ["display_name"],
      dependency_diff: {
        added: [{ target_service: "database", capability: "storage" }],
        removed: [{ target_service: "cache", capability: "cache" }],
      },
    });
  });

  it("does not let a stale OCC command mutate dependency edges", async () => {
    const database = await ready();
    await seedService(database, "api");
    await seedService(database, "database");

    const result = await updateServiceCatalog(databaseEnvironment(database), {
      ...context(),
      service_name: "api",
      expected_revision: 2,
      command: {
        command_id: "018f0000-0000-7000-8000-000000000702",
        enabled: false,
        dependencies: [
          {
            target_service: "database",
            capability: "storage",
            kind: "required",
            criticality: "critical",
          },
        ],
      },
    });

    expect(result).toMatchObject({ problem: { status: 409 } });
    await expect(
      database
        .prepare("SELECT enabled FROM services WHERE service_name='api'")
        .first<number>("enabled"),
    ).resolves.toBe(1);
    await expect(
      database
        .prepare("SELECT COUNT(*) FROM service_dependencies")
        .first<number>("COUNT(*)"),
    ).resolves.toBe(0);
    await expect(
      database
        .prepare("SELECT COUNT(*) FROM idempotency_keys")
        .first<number>("COUNT(*)"),
    ).resolves.toBe(0);
  });

  it("reauthorizes catalog mutations inside the private domain boundary", async () => {
    const database = await ready();
    await seedService(database, "api");
    const result = await updateServiceCatalog(databaseEnvironment(database), {
      principal: { ...PRINCIPAL, roles: ["viewer"] },
      correlation_id: CORRELATION,
      service_name: "api",
      expected_revision: 1,
      command: {
        command_id: "018f0000-0000-7000-8000-000000000705",
        enabled: false,
      },
    });

    expect(result).toMatchObject({ problem: { status: 403 } });
    await expect(
      database
        .prepare("SELECT revision FROM services WHERE service_name='api'")
        .first<number>("revision"),
    ).resolves.toBe(1);
  });

  it("creates and evolves a globally identified multi-service component", async () => {
    const database = await ready();
    await seedService(database, "api");
    await seedService(database, "database");
    await seedService(database, "cache");

    const created = await createComponent(databaseEnvironment(database), {
      ...context(),
      command: {
        command_id: "018f0000-0000-7000-8000-000000000703",
        component_id: "public-api",
        owner_service: "api",
        display_name: "Public API",
        description: "Customer request path",
        public: true,
        sort_order: 10,
        enabled: true,
        supporting_services: ["database", "cache"],
      },
    });
    expect(created).toMatchObject({
      data: {
        component_id: "public-api",
        owner_service: "api",
        supporting_services: ["cache", "database"],
        enabled: true,
        revision: 1,
      },
    });
    const supportingServiceView = await getServiceStatus(
      new Request("https://status.example/v1/services/database"),
      {
        DB: database,
        cursorSecret: "integration-test-secret-with-sufficient-entropy",
        dependencyCore: {
          dispatchJson: () =>
            JSON.stringify({ status: "operational", contributors: [] }),
        },
        now: () => new Date(CREATED),
      },
      CORRELATION,
      "database",
    );
    const supportingBody = (await supportingServiceView.json()) as {
      data: { components: Array<{ id: string }> };
    };
    expect(supportingBody.data.components).toEqual([
      expect.objectContaining({ id: "public-api" }),
    ]);

    await database
      .prepare(
        `INSERT INTO current_statuses
         (target_type,target_id,direct_status,dependency_risk,effective_impact,evaluated_at,fresh_until)
         VALUES ('service','database','major_outage','none','major_outage',?,?)`,
      )
      .bind(CREATED, "2026-09-12T13:00:00.000Z")
      .run();
    const reevaluator = new D1TargetReevaluator(
      database,
      { dispatchJson: () => JSON.stringify("operational") },
      () => Date.parse(CREATED),
    );
    await reevaluator.reevaluate(
      { type: "component", id: "public-api" },
      { type: "issue", id: "support-risk-test" },
      new AbortController().signal,
    );
    await expect(
      database
        .prepare(
          "SELECT direct_status,dependency_risk,effective_impact FROM current_statuses WHERE target_type='component' AND target_id='public-api'",
        )
        .first(),
    ).resolves.toEqual({
      direct_status: "operational",
      dependency_risk: "major_outage",
      effective_impact: "major_outage",
    });

    const updated = await updateComponentCatalog(
      databaseEnvironment(database),
      {
        ...context(),
        component_id: "public-api",
        expected_revision: 1,
        command: {
          command_id: "018f0000-0000-7000-8000-000000000704",
          enabled: false,
          supporting_services: ["database"],
        },
      },
    );
    expect(updated).toMatchObject({
      data: {
        component_id: "public-api",
        owner_service: "api",
        supporting_services: ["database"],
        enabled: false,
        revision: 2,
      },
    });
    const links = await database
      .prepare(
        "SELECT service_name,role FROM component_services WHERE component_id=? ORDER BY role,service_name",
      )
      .bind("public-api")
      .all();
    expect(links.results).toEqual([
      { service_name: "api", role: "owner" },
      { service_name: "database", role: "supporting" },
    ]);
    await expect(
      database
        .prepare(
          "SELECT COUNT(*) FROM status_targets WHERE target_id='public-api'",
        )
        .first<number>("COUNT(*)"),
    ).resolves.toBe(1);
  });
});

/** 仅暴露生产命令所需 D1 binding。 / Expose only the D1 binding required by production commands. */
function databaseEnvironment(database: TestD1Database) {
  return { DB: database as unknown as D1Database };
}

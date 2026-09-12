import {
  PlatformStatusResponseSchema,
  PublicServiceListResponseSchema,
  PublicServiceStatusResponseSchema,
} from "../../packages/contracts/src/index.js";
import { afterEach, expect, it } from "vitest";
import {
  getPlatformStatus,
  getServiceStatus,
  listServices,
} from "../../workers/status/src/public/handlers.js";
import { createMigratedD1, type TestD1Database } from "./d1.js";
import { realDomainCore } from "./wasm.js";

const databases: TestD1Database[] = [];
const time = "2026-09-12T12:00:00.000Z";
const fresh = "2026-09-12T13:00:00.000Z";
const correlation = "018f0000-0000-7000-8000-000000000006";
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

/** 故意留下旧 effective 缓存，验证读取只信直接状态。 / Deliberately retain stale effective caches to prove reads derive from direct states. */
async function fixture(kind: string, stale = false) {
  const db = await createMigratedD1();
  databases.push(db);
  const q = (sql: string, ...values: unknown[]) =>
    db.prepare(sql).bind(...values);
  for (const name of ["owner", "api", "database"]) {
    await db.batch([
      q(
        "INSERT INTO services(service_name,display_name,description,owner,criticality,enabled,created_at,updated_at) VALUES(?,?,?,'secret-owner','critical',1,?,?)",
        name,
        name,
        "",
        time,
        time,
      ),
      q(
        "INSERT INTO current_statuses(target_type,target_id,direct_status,dependency_risk,effective_impact,evaluated_at,fresh_until) VALUES('service',?,?,'none',?,?,?)",
        name,
        name === "database" && !stale ? "major_outage" : "operational",
        name === "database" && !stale ? "major_outage" : "operational",
        "2026-09-12T10:00:00.000Z",
        stale && name === "database" ? "2026-09-12T11:00:00.000Z" : fresh,
      ),
    ]);
  }
  await db.batch([
    q(
      "INSERT INTO service_dependencies(source_service,target_service,capability,kind,criticality,created_at) VALUES('api','database','storage',?,'critical',?)",
      kind,
      time,
    ),
    q(
      "INSERT INTO service_dependencies(source_service,target_service,capability,kind,criticality,created_at) VALUES('database','api','callback','required','critical',?)",
      time,
    ),
    q(
      "INSERT INTO components(component_id,service_name,display_name,description,public,sort_order,enabled,created_at,updated_at) VALUES('public','owner','Public','',1,1,1,?,?)",
      time,
      time,
    ),
    q(
      "INSERT INTO component_services(component_id,service_name,role,created_at) VALUES('public','api','supporting',?)",
      time,
    ),
    q(
      "INSERT INTO current_statuses(target_type,target_id,direct_status,dependency_risk,effective_impact,evaluated_at,fresh_until) VALUES('component','public','operational','none','operational',?,?)",
      time,
      fresh,
    ),
  ]);
  return {
    DB: db,
    cursorSecret: "long-integration-test-cursor-secret",
    now: () => new Date(time),
    dependencyCore: realDomainCore(),
  };
}

it.each(["required", "optional", "degraded_fallback"])(
  "projects %s and cycles consistently without changing direct status",
  async (kind) => {
    const ctx = await fixture(kind);
    const detail = PublicServiceStatusResponseSchema.parse(
      await (
        await getServiceStatus(
          new Request("https://status.example/v1/services/api"),
          ctx,
          correlation,
          "api",
        )
      ).json(),
    );
    const list = PublicServiceListResponseSchema.parse(
      await (
        await listServices(
          new Request("https://status.example/v1/services"),
          ctx,
          correlation,
        )
      ).json(),
    );
    const platform = PlatformStatusResponseSchema.parse(
      await (
        await getPlatformStatus(
          new Request("https://status.example/v1/status"),
          ctx,
          correlation,
        )
      ).json(),
    );
    expect(detail.data.direct_status).toBe("operational");
    expect(detail.data.effective_impact).not.toBe("operational");
    expect(list.data.find((row) => row.service_name === "api")?.status).toBe(
      detail.data.effective_impact,
    );
    expect(detail.data.components[0]?.status).toBe(
      detail.data.effective_impact,
    );
    expect(platform.data?.status).toBe(detail.data.effective_impact);
    expect(JSON.stringify([detail, list, platform])).not.toContain(
      "secret-owner",
    );
    expect(
      (
        await ctx.DB.prepare(
          "SELECT direct_status FROM current_statuses WHERE target_type='component'",
        ).first()
      )?.direct_status,
    ).toBe("operational");
  },
);

it("propagates expired healthy dependency proof as unknown into supporting component and platform", async () => {
  const ctx = await fixture("required", true);
  const platform = PlatformStatusResponseSchema.parse(
    await (
      await getPlatformStatus(
        new Request("https://status.example/v1/status"),
        ctx,
        correlation,
      )
    ).json(),
  );
  expect(platform.data.status).toBe("unknown");
});

/** 依赖期限不能延长缓存健康状态；直接状态不继承依赖的过期。 / Dependency deadlines bound cached health without expiring the source direct state. */
it("propagates transitive proof deadlines without reclassifying direct status", async () => {
  const ctx = await fixture("required", true);
  const detail = PublicServiceStatusResponseSchema.parse(
    await (
      await getServiceStatus(
        new Request("https://status.example/v1/services/api"),
        ctx,
        correlation,
        "api",
      )
    ).json(),
  );
  const list = PublicServiceListResponseSchema.parse(
    await (
      await listServices(
        new Request("https://status.example/v1/services"),
        ctx,
        correlation,
      )
    ).json(),
  );
  const platform = PlatformStatusResponseSchema.parse(
    await (
      await getPlatformStatus(
        new Request("https://status.example/v1/status"),
        ctx,
        correlation,
      )
    ).json(),
  );
  expect(detail.data.direct_status).toBe("operational");
  expect(detail.data.fresh_until).toBe("2026-09-12T11:00:00.000Z");
  expect(list.data.find((row) => row.service_name === "api")?.fresh_until).toBe(
    detail.data.fresh_until,
  );
  expect(platform.data.fresh_until).toBe(detail.data.fresh_until);
});

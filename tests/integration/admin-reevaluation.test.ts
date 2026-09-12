import { afterEach, describe, expect, it } from "vitest";

import {
  createMaintenanceWindow,
  registerEvaluationPolicy,
  registerService,
  suppressIssue,
  updateMaintenanceWindow,
  type AdminEnvironment,
} from "../../workers/status/src/admin/index.js";
import { D1TargetReevaluator } from "../../workers/status/src/scheduling/reevaluate.js";
import type { RustDispatcher } from "../../workers/status/src/scheduling/types.js";
import { createMigratedD1, type TestD1Database } from "./d1.js";
import { realDomainCore } from "./wasm.js";

const PRINCIPAL = {
  subject: "operator-reevaluation",
  email: "operator@example.com",
  roles: ["admin"] as ("viewer" | "operator" | "admin")[],
  authenticated_at: "2026-09-12T00:00:00.000Z",
  access_application: "status-ops",
};
const CORRELATION = "018f2000-0000-7000-8000-000000000001";
const POLICY = "018f2000-0000-7000-8000-000000000002";
const ISSUE = "018f2000-0000-7000-8000-000000000003";

/** 构造真实迁移 D1 的管理环境 / Builds an administrative environment over a fully migrated D1. */
function environment(database: TestD1Database): AdminEnvironment {
  return {
    DB: database as unknown as D1Database,
    CURSOR_SIGNING_KEY: "admin-reevaluation-integration-secret",
    STATUS_VERSION: "integration-test",
    DOMAIN_CORE: realDomainCore() as unknown as RustDispatcher,
  };
}

/** 注册拥有直属 Component 的服务 / Registers a service with one owned Component. */
async function register(
  env: AdminEnvironment,
  sequence: number,
  service: string,
  component: string,
): Promise<void> {
  const result = await registerService(env, {
    principal: PRINCIPAL,
    correlation_id: CORRELATION,
    command: {
      command_id: `018f2000-0000-7000-8000-${sequence.toString(16).padStart(12, "0")}`,
      service_name: service,
      display_name: service.toUpperCase(),
      description: `${service} service`,
      owner: "platform",
      criticality: "critical",
      enabled: true,
      components: [
        {
          component_id: component,
          display_name: component,
          public: true,
          sort_order: 1,
        },
      ],
      dependencies: [],
    },
  });
  expect(result).toHaveProperty("data");
}

/** 读取指定来源的标准重评估 payload / Reads standard reevaluation payloads for a source. */
async function reevaluationPayloads(
  database: TestD1Database,
  sourceId: string,
): Promise<
  Array<{
    target_type: "service" | "component";
    target_id: string;
    source_type: string;
    source_id: string;
  }>
> {
  const rows = await database
    .prepare(
      "SELECT payload_json FROM outbox WHERE event_type='status.reevaluation_requested' ORDER BY created_at,outbox_id",
    )
    .all<{ payload_json: string }>();
  return rows.results
    .map((row) => JSON.parse(row.payload_json))
    .filter((payload) => payload.source_id === sourceId);
}

/** 用生产共享重评估器消费测试事件 / Consumes test events through the production shared reevaluator. */
async function evaluate(
  database: TestD1Database,
  payloads: Awaited<ReturnType<typeof reevaluationPayloads>>,
  at: number,
): Promise<void> {
  const reevaluator = new D1TargetReevaluator(
    database,
    realDomainCore() as unknown as RustDispatcher,
    () => at,
  );
  for (const payload of payloads) {
    await reevaluator.reevaluate(
      { type: payload.target_type, id: payload.target_id },
      { type: payload.source_type, id: payload.source_id },
      new AbortController().signal,
    );
  }
}

describe("admin status reevaluation", () => {
  const opened: TestD1Database[] = [];
  afterEach(() => {
    for (const database of opened.splice(0)) database.close();
  });

  /** 准备两个服务与共享策略 / Prepares two services and one shared policy. */
  async function ready() {
    const database = await createMigratedD1();
    opened.push(database);
    const env = environment(database);
    await register(env, 16, "api", "api-public");
    await register(env, 17, "web", "web-public");
    await registerEvaluationPolicy(env, {
      principal: PRINCIPAL,
      correlation_id: CORRELATION,
      command: {
        command_id: "018f2000-0000-7000-8000-000000000012",
        policy: {
          policy_id: POLICY,
          revision: 1,
          window_seconds: 300,
          minimum_samples: 1,
          failure_threshold: { numerator: 1, denominator: 1 },
          recovery_threshold: { numerator: 1, denominator: 1 },
          latency_threshold_ms: null,
          stale_after_seconds: 600,
          quorum: {
            minimum_locations: 1,
            failure_locations: 1,
            recovery_locations: 1,
          },
          issue_fingerprint_template: ["operation"],
          failure_status: "major_outage",
        },
      },
    });
    return { database, env };
  }

  it("为立即生效维护产生可消费的 service/component 重评估 / queues consumable service/component reevaluation for active maintenance", async () => {
    const { database, env } = await ready();
    const timestamp = Date.now();
    const created = await createMaintenanceWindow(env, {
      principal: PRINCIPAL,
      correlation_id: CORRELATION,
      command: {
        command_id: "018f2000-0000-7000-8000-000000000020",
        title: "API maintenance",
        description: "Immediate maintenance",
        starts_at: new Date(timestamp - 60_000).toISOString(),
        ends_at: new Date(timestamp + 3_600_000).toISOString(),
        expected_impact: "degraded",
        target_services: ["api"],
        target_components: [],
      },
    });
    if (!("data" in created)) throw new Error("maintenance creation failed");
    const payloads = await reevaluationPayloads(
      database,
      created.data.maintenance_id,
    );
    expect(payloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target_type: "service",
          target_id: "api",
          source_type: "maintenance",
        }),
        expect.objectContaining({
          target_type: "component",
          target_id: "api-public",
          source_type: "maintenance",
        }),
      ]),
    );
    await expect(
      database
        .prepare(
          "SELECT direct_status FROM current_statuses WHERE target_type='service' AND target_id='api'",
        )
        .first<string>("direct_status"),
    ).resolves.toBe("maintenance");
    await expect(
      database
        .prepare(
          "SELECT direct_status FROM current_statuses WHERE target_type='component' AND target_id='api-public'",
        )
        .first<string>("direct_status"),
    ).resolves.toBe("maintenance");
    await evaluate(database, payloads, timestamp);
    await expect(
      database
        .prepare(
          "SELECT direct_status FROM current_statuses WHERE target_type='service' AND target_id='api'",
        )
        .first<string>("direct_status"),
    ).resolves.toBe("maintenance");
    await expect(
      database
        .prepare(
          "SELECT direct_status FROM current_statuses WHERE target_type='component' AND target_id='api-public'",
        )
        .first<string>("direct_status"),
    ).resolves.toBe("maintenance");
  });

  it("目标编辑与取消覆盖旧、新继承目标 / target edits and cancellation cover old and new inherited targets", async () => {
    const { database, env } = await ready();
    const timestamp = Date.now();
    const created = await createMaintenanceWindow(env, {
      principal: PRINCIPAL,
      correlation_id: CORRELATION,
      command: {
        command_id: "018f2000-0000-7000-8000-000000000021",
        title: "Moving maintenance",
        description: "Initial API target",
        starts_at: new Date(timestamp - 60_000).toISOString(),
        ends_at: new Date(timestamp + 3_600_000).toISOString(),
        expected_impact: "degraded",
        target_services: ["api"],
        target_components: [],
      },
    });
    if (!("data" in created)) throw new Error("maintenance creation failed");
    const moved = await updateMaintenanceWindow(env, {
      principal: PRINCIPAL,
      correlation_id: CORRELATION,
      id: created.data.maintenance_id,
      expected_revision: 1,
      command: {
        command_id: "018f2000-0000-7000-8000-000000000022",
        target_services: ["web"],
        target_components: [],
        description: "Moved to Web",
      },
    });
    expect(moved).toMatchObject({
      data: { revision: 2, target_services: ["web"] },
    });
    const movedPayloads = await reevaluationPayloads(
      database,
      created.data.maintenance_id,
    );
    expect(
      new Set(
        movedPayloads.map(
          (payload) => `${payload.target_type}:${payload.target_id}`,
        ),
      ),
    ).toEqual(
      new Set([
        "service:api",
        "component:api-public",
        "service:web",
        "component:web-public",
      ]),
    );
    await expect(
      database
        .prepare(
          "SELECT direct_status FROM current_statuses WHERE target_type='service' AND target_id='api'",
        )
        .first<string>("direct_status"),
    ).resolves.toBe("operational");
    await expect(
      database
        .prepare(
          "SELECT direct_status FROM current_statuses WHERE target_type='service' AND target_id='web'",
        )
        .first<string>("direct_status"),
    ).resolves.toBe("maintenance");

    const cancelled = await updateMaintenanceWindow(env, {
      principal: PRINCIPAL,
      correlation_id: CORRELATION,
      id: created.data.maintenance_id,
      expected_revision: 2,
      command: {
        command_id: "018f2000-0000-7000-8000-000000000023",
        state: "cancelled",
      },
    });
    expect(cancelled).toMatchObject({
      data: { revision: 3, state: "cancelled" },
    });
    await expect(
      database
        .prepare(
          "SELECT direct_status FROM current_statuses WHERE target_type='service' AND target_id='web'",
        )
        .first<string>("direct_status"),
    ).resolves.toBe("operational");
    await expect(
      database
        .prepare(
          "SELECT direct_status FROM current_statuses WHERE target_type='component' AND target_id='web-public'",
        )
        .first<string>("direct_status"),
    ).resolves.toBe("operational");
  });

  it("抑制 Issue 时保留维护并重算继承组件 / suppression preserves maintenance and reevaluates inherited components", async () => {
    const { database, env } = await ready();
    const timestamp = Date.now();
    const maintenance = await createMaintenanceWindow(env, {
      principal: PRINCIPAL,
      correlation_id: CORRELATION,
      command: {
        command_id: "018f2000-0000-7000-8000-000000000024",
        title: "Protected maintenance",
        description: "Must survive Issue suppression",
        starts_at: new Date(timestamp - 60_000).toISOString(),
        ends_at: new Date(timestamp + 3_600_000).toISOString(),
        expected_impact: "degraded",
        target_services: ["api"],
        target_components: [],
      },
    });
    if (!("data" in maintenance))
      throw new Error("maintenance creation failed");
    await database
      .prepare(
        `INSERT INTO issues(issue_id,fingerprint_hash,service_name,kind,severity,state,first_seen_at,last_seen_at,
       occurrence_count,affected_instance_count,policy_id,policy_revision,revision)
       VALUES(?,?,'api','dependency.unavailable','critical','observed',?,?,1,0,?,1,1)`,
      )
      .bind(
        ISSUE,
        "c".repeat(64),
        new Date(timestamp - 120_000).toISOString(),
        new Date(timestamp - 60_000).toISOString(),
        POLICY,
      )
      .run();
    await database
      .prepare(
        "UPDATE issues SET state='active',revision=2 WHERE issue_id=? AND revision=1",
      )
      .bind(ISSUE)
      .run();

    const suppressed = await suppressIssue(env, {
      principal: { ...PRINCIPAL, roles: ["operator"] },
      correlation_id: CORRELATION,
      issue_id: ISSUE,
      expected_revision: 2,
      command_id: "018f2000-0000-7000-8000-000000000025",
      until: new Date(timestamp + 1_800_000).toISOString(),
      reason: "Covered by approved maintenance",
    });
    expect(suppressed).toMatchObject({
      data: { state: "suppressed", revision: 3 },
    });
    const payloads = await reevaluationPayloads(database, ISSUE);
    expect(payloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target_type: "service",
          target_id: "api",
          source_type: "issue",
        }),
        expect.objectContaining({
          target_type: "component",
          target_id: "api-public",
          source_type: "issue",
        }),
      ]),
    );
    await expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM outbox WHERE event_type='suppression.expired' AND json_extract(payload_json,'$.target_type')='component' AND json_extract(payload_json,'$.target_id')='api-public'",
        )
        .first<number>("count"),
    ).resolves.toBe(1);
    await expect(
      database
        .prepare(
          "SELECT direct_status FROM current_statuses WHERE target_type='service' AND target_id='api'",
        )
        .first<string>("direct_status"),
    ).resolves.toBe("maintenance");
    await expect(
      database
        .prepare(
          "SELECT direct_status FROM current_statuses WHERE target_type='component' AND target_id='api-public'",
        )
        .first<string>("direct_status"),
    ).resolves.toBe("maintenance");
  });
});

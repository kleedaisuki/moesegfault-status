import { describe, expect, it } from "vitest";
import {
  assignDiagnosticPolicy,
  checkHealth,
  createMaintenanceWindow,
  createMonitor,
  registerBackend,
  registerEvaluationPolicy,
  registerService,
  uuidv7,
  type AdminEnvironment,
} from "./index.js";
import { createMigratedD1 } from "../../../../tests/integration/d1.js";

const correlationId = "0199d0a7-d771-7435-a388-bb6fa5d533fc";
const principal = {
  subject: "access|klee",
  email: "klee@example.com",
  roles: ["viewer"] as const,
  authenticated_at: "2026-09-12T00:00:00.000Z",
  access_application: "ops.moesegfault.dev",
};

function environment(database: Partial<D1Database>): AdminEnvironment {
  return {
    DB: database as D1Database,
    CURSOR_SIGNING_KEY: "a-test-key-that-is-never-used-in-production",
    STATUS_VERSION: "test",
  };
}

describe("admin domain boundary", () => {
  it("生成 UUIDv7，避免把数据库序列暴露为身份 / generates UUIDv7 identities", () => {
    expect(uuidv7(1_789_171_200_000)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("健康检查实际访问 D1 / probes D1 rather than returning a stub", async () => {
    let queried = false;
    const env = environment({
      prepare: () =>
        ({
          first: async () => {
            queried = true;
            return { ok: 1 };
          },
        }) as unknown as D1PreparedStatement,
    });
    const result = await checkHealth(env, {
      principal: { ...principal, roles: ["viewer"] },
      correlation_id: correlationId,
    });
    expect(queried).toBe(true);
    expect(result).toMatchObject({
      data: { status: "ok", service_name: "status", version: "test" },
    });
  });

  it("D1 不可用时不得伪报健康 / never reports healthy when D1 is unavailable", async () => {
    const env = environment({
      prepare: () =>
        ({
          first: async () => {
            throw new Error("D1 unavailable");
          },
        }) as unknown as D1PreparedStatement,
    });
    const result = await checkHealth(env, {
      principal: { ...principal, roles: ["viewer"] },
      correlation_id: correlationId,
    });
    expect(result).toMatchObject({
      data: {
        status: "degraded",
        dependencies: [{ name: "d1", status: "unavailable" }],
      },
    });
  });

  it("在领域层拒绝 viewer 写目录 / rejects viewer catalog writes in the domain layer", async () => {
    const result = await registerService(environment({}), {
      principal: { ...principal, roles: ["viewer"] },
      correlation_id: correlationId,
      command: {
        command_id: "0199d0a8-2e12-7a59-a51e-44aa9b6d1001",
        service_name: "identity",
        display_name: "Identity",
        description: "Authentication service",
        owner: "platform",
        criticality: "critical",
        enabled: true,
        components: [],
        dependencies: [],
      },
    });
    expect(result).toMatchObject({
      problem: { status: 403, correlation_id: correlationId },
    });
  });

  it("缺少完整核心时原子状态 mutation 失败关闭 / fails closed without the full core", async () => {
    const timestamp = Date.now();
    const result = await createMaintenanceWindow(environment({}), {
      principal: { ...principal, roles: ["operator"] },
      correlation_id: correlationId,
      command: {
        command_id: "0199d0a8-2e12-7a59-a51e-44aa9b6d1010",
        title: "Unavailable core",
        description: "Must not weaken atomic semantics",
        starts_at: new Date(timestamp - 1_000).toISOString(),
        ends_at: new Date(timestamp + 60_000).toISOString(),
        expected_impact: "degraded",
        target_services: ["status"],
        target_components: [],
      },
    });
    expect(result).toMatchObject({
      problem: { status: 503, correlation_id: correlationId },
    });
  });

  it("原子登记 policy、monitor、selector 与 backend / atomically registers control-plane records", async () => {
    const database = await createMigratedD1();
    const env = environment(database as unknown as D1Database);
    const admin = {
      ...principal,
      roles: ["admin"] as ("viewer" | "operator" | "admin")[],
    };
    try {
      await registerService(env, {
        principal: admin,
        correlation_id: correlationId,
        command: {
          command_id: "0199d0a8-2e12-7a59-a51e-44aa9b6d1101",
          service_name: "status",
          display_name: "Status",
          description: "Status service",
          owner: "platform",
          criticality: "critical",
          enabled: true,
          components: [],
          dependencies: [],
        },
      });
      const policy = {
        policy_id: "0199d0a8-2e12-7a59-a51e-44aa9b6d1102",
        revision: 1,
        window_seconds: 300,
        minimum_samples: 3,
        failure_threshold: { numerator: 2, denominator: 3 },
        recovery_threshold: { numerator: 1, denominator: 3 },
        latency_threshold_ms: 1_000,
        stale_after_seconds: 600,
        quorum: {
          minimum_locations: 1,
          failure_locations: 1,
          recovery_locations: 1,
        },
        issue_fingerprint_template: ["operation" as const],
        failure_status: "degraded" as const,
      };
      expect(
        await registerEvaluationPolicy(env, {
          principal: admin,
          correlation_id: correlationId,
          command: {
            command_id: "0199d0a8-2e12-7a59-a51e-44aa9b6d1103",
            policy,
          },
        }),
      ).toEqual({ data: policy });
      const monitorId = "0199d0a8-2e12-7a59-a51e-44aa9b6d1104";
      expect(
        await createMonitor(env, {
          principal: admin,
          correlation_id: correlationId,
          command: {
            command_id: "0199d0a8-2e12-7a59-a51e-44aa9b6d1105",
            monitor_id: monitorId,
            service_name: "status",
            target_type: "service",
            target_id: "status",
            probe_kind: "http",
            probe_config: {
              kind: "http",
              url: "https://status.example.com/health",
              method: "HEAD",
              expected_statuses: [200],
              max_redirects: 0,
            },
            schedule_kind: "interval",
            schedule_expression: null,
            interval_seconds: 60,
            timeout_ms: 5_000,
            locations: ["sin"],
            policy_id: policy.policy_id,
            policy_revision: 1,
            enabled: true,
          },
        }),
      ).toMatchObject({ data: { monitor_id: monitorId, revision: 1 } });
      expect(
        await assignDiagnosticPolicy(env, {
          principal: admin,
          correlation_id: correlationId,
          command: {
            command_id: "0199d0a8-2e12-7a59-a51e-44aa9b6d1106",
            selector: { kind: "monitor", monitor_id: monitorId },
            policy_id: policy.policy_id,
            policy_revision: 1,
          },
        }),
      ).toMatchObject({
        data: {
          selector: { kind: "monitor", monitor_id: monitorId },
          revision: 1,
        },
      });
      expect(
        await registerBackend(env, {
          principal: admin,
          correlation_id: correlationId,
          command: {
            command_id: "0199d0a8-2e12-7a59-a51e-44aa9b6d1107",
            backend: {
              name: "grafana",
              capabilities: ["trace"],
              query_adapter: "tempo",
              ui_url_template: "https://grafana.example.com/explore",
              retention_class: "standard",
              auth_reference: "GRAFANA_TOKEN",
            },
          },
        }),
      ).toMatchObject({ data: { name: "grafana" } });
      const auditCount = database.first(
        "SELECT COUNT(*) AS count FROM audit_log",
        [],
      ) as { count: number };
      const outboxCount = database.first(
        "SELECT COUNT(*) AS count FROM outbox",
        [],
      ) as { count: number };
      expect(auditCount.count).toBeGreaterThanOrEqual(5);
      expect(outboxCount.count).toBeGreaterThanOrEqual(5);
      expect(
        database.first("SELECT COUNT(*) AS count FROM idempotency_keys", []),
      ).toEqual({ count: 5 });
    } finally {
      database.close();
    }
  });
});

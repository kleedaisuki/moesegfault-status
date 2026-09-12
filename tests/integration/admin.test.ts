import { afterEach, describe, expect, it } from "vitest";

import {
  createIncident,
  getIncident,
  registerService,
  updateIncident,
  type AdminEnvironment,
} from "../../workers/status/src/admin/index.js";
import { createMigratedD1, type TestD1Database } from "./d1.js";

const CORRELATION = "018f0000-0000-7000-8000-000000000101";
const REGISTER_COMMAND = "018f0000-0000-7000-8000-000000000102";
const CREATE_COMMAND = "018f0000-0000-7000-8000-000000000103";
const UPDATE_COMMAND = "018f0000-0000-7000-8000-000000000104";
const STALE_COMMAND = "018f0000-0000-7000-8000-000000000105";
const PIN_COMMAND = "018f0000-0000-7000-8000-000000000106";
const POLICY = "018f0000-0000-7000-8000-000000000107";
const RETENTION = "018f0000-0000-7000-8000-000000000108";
const DEPLOYMENT = "018f0000-0000-7000-8000-000000000109";
const ISSUE = "018f0000-0000-7000-8000-00000000010a";
const OCCURRENCE = "018f0000-0000-7000-8000-00000000010b";
const STARTED = "2026-09-12T00:00:00.000Z";
const DIGEST = `sha256:${"a".repeat(64)}`;

const principal = {
  subject: "operator-1",
  email: "operator@example.com",
  roles: ["admin"] as const,
  authenticated_at: "2026-09-12T00:00:00.000Z",
  access_application: "status-ops",
};

/** 构造使用真实 D1 的管理环境。 / Build an administrative environment backed by real D1. */
function environment(database: TestD1Database): AdminEnvironment {
  return {
    DB: database as unknown as D1Database,
    CURSOR_SIGNING_KEY: "admin-cursor-signing-key-with-enough-entropy",
    STATUS_VERSION: "integration-test",
  };
}

/** 通过真正的管理 RPC 注册测试服务。 / Register the fixture service through the real administrative RPC. */
async function registerFixtureService(env: AdminEnvironment) {
  return registerService(env, {
    principal: { ...principal, roles: [...principal.roles] },
    correlation_id: CORRELATION,
    command: {
      command_id: REGISTER_COMMAND,
      service_name: "api",
      display_name: "API",
      description: "Public API",
      owner: "platform",
      criticality: "critical",
      enabled: true,
      components: [
        {
          component_id: "api-public",
          display_name: "Public API",
          public: true,
          sort_order: 1,
        },
      ],
      dependencies: [],
    },
  });
}

describe("administrative commands with real D1", () => {
  const opened: TestD1Database[] = [];
  afterEach(() => {
    for (const database of opened.splice(0)) database.close();
  });

  async function ready(): Promise<{
    database: TestD1Database;
    env: AdminEnvironment;
  }> {
    const database = await createMigratedD1();
    opened.push(database);
    return { database, env: environment(database) };
  }

  it("replays identical commands without duplicating transactional side effects", async () => {
    const { database, env } = await ready();

    const first = await registerFixtureService(env);
    const replay = await registerFixtureService(env);
    const services = await database
      .prepare("SELECT COUNT(*) AS count FROM services")
      .first<{ count: number }>();
    const audit = await database
      .prepare(
        "SELECT COUNT(*) AS count FROM audit_log WHERE action='service.registered'",
      )
      .first<{ count: number }>();
    const outbox = await database
      .prepare(
        "SELECT COUNT(*) AS count FROM outbox WHERE event_type='catalog.changed'",
      )
      .first<{ count: number }>();

    expect(first).toHaveProperty("data.service_name", "api");
    expect(replay).toEqual(first);
    expect(services?.count).toBe(1);
    expect(audit?.count).toBe(1);
    expect(outbox?.count).toBe(1);
  });

  it("rejects reuse of an idempotency key with different content", async () => {
    const { env } = await ready();
    await registerFixtureService(env);

    const conflict = await registerService(env, {
      principal: { ...principal, roles: [...principal.roles] },
      correlation_id: CORRELATION,
      command: {
        command_id: REGISTER_COMMAND,
        service_name: "api",
        display_name: "Changed API",
        description: "Public API",
        owner: "platform",
        criticality: "critical",
        enabled: true,
        components: [],
        dependencies: [],
      },
    });

    expect(conflict).toMatchObject({
      problem: { status: 409, title: "Idempotency key conflict" },
    });
  });

  it("enforces optimistic concurrency while preserving an immutable incident timeline", async () => {
    const { database, env } = await ready();
    await registerFixtureService(env);
    const created = await createIncident(env, {
      principal: { ...principal, roles: [...principal.roles] },
      correlation_id: CORRELATION,
      command: {
        command_id: CREATE_COMMAND,
        title: "Elevated errors",
        impact: "degraded",
        started_at: STARTED,
        affected_components: ["api-public"],
        issue_ids: [],
        initial_message: "Investigating elevated errors.",
      },
    });
    if (!("data" in created)) throw new Error(JSON.stringify(created));

    const updated = await updateIncident(env, {
      principal: { ...principal, roles: [...principal.roles] },
      correlation_id: CORRELATION,
      incident_id: created.data.incident_id,
      expected_revision: 1,
      command: {
        command_id: UPDATE_COMMAND,
        message: "Cause identified.",
        state: "identified",
        cause: "database saturation",
      },
    });
    const stale = await updateIncident(env, {
      principal: { ...principal, roles: [...principal.roles] },
      correlation_id: CORRELATION,
      incident_id: created.data.incident_id,
      expected_revision: 1,
      command: {
        command_id: STALE_COMMAND,
        message: "Stale writer must lose.",
        impact: "major_outage",
      },
    });
    const fetched = await getIncident(env, {
      principal: { ...principal, roles: [...principal.roles] },
      correlation_id: CORRELATION,
      incident_id: created.data.incident_id,
    });

    expect(updated).toMatchObject({
      data: { revision: 2, state: "identified" },
    });
    expect(stale).toMatchObject({
      problem: { status: 409, title: "Incident revision conflict" },
    });
    expect(fetched).toMatchObject({
      data: {
        revision: 2,
        updates: [
          { sequence: 1, message: "Investigating elevated errors." },
          { sequence: 2, message: "Cause identified." },
        ],
      },
    });
    await expect(
      database
        .prepare(
          "UPDATE incident_updates SET public_message='rewritten' WHERE incident_id=? AND sequence=1",
        )
        .bind(created.data.incident_id)
        .run(),
    ).rejects.toThrow(/immutable/u);
    await expect(
      database
        .prepare("SELECT COUNT(*) FROM incident_updates WHERE incident_id=?")
        .bind(created.data.incident_id)
        .first<number>("COUNT(*)"),
    ).resolves.toBe(2);
  });

  it("pins existing issue occurrences when an incident adopts the issue", async () => {
    const { database, env } = await ready();
    await registerFixtureService(env);
    const statement = (sql: string, ...values: unknown[]) =>
      database.prepare(sql).bind(...values);
    await database.batch([
      statement(
        `INSERT INTO evaluation_policies(policy_id,revision,schema_version,name,observation_window_seconds,minimum_samples,
          failure_threshold,recovery_threshold,latency_threshold_ms,stale_after_seconds,location_quorum,
          fingerprint_template_json,status_mapping_json,diagnostic_rules_json,created_by,created_at)
          VALUES(?,1,'1.0','default',300,1,0.5,0.2,NULL,300,1,?,?,?,'test',?)`,
        POLICY,
        '{"fields":["operation"]}',
        '{"error":"degraded"}',
        "{}",
        STARTED,
      ),
      statement(
        "INSERT INTO data_retention_policies(policy_id,revision,occurrence_retention_days,cleanup_batch_size,created_by,created_at) VALUES(?,1,30,100,'test',?)",
        RETENTION,
        STARTED,
      ),
      statement(
        "INSERT INTO deployments(deployment_id,service_name,environment,service_version,repository_url,git_commit,git_ref,artifact_digest,ci_provider,ci_run_id,deployed_at,manifest_object_key,manifest_digest,manifest_schema_version,registered_at,registered_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        DEPLOYMENT,
        "api",
        "production",
        "1.0.0",
        "https://example.com/repo",
        "a".repeat(40),
        "refs/heads/main",
        DIGEST,
        "github",
        "1",
        STARTED,
        "manifests/pin.json",
        DIGEST,
        "1.0",
        STARTED,
        "ci",
      ),
      statement(
        `INSERT INTO issues(issue_id,fingerprint_hash,service_name,kind,severity,state,first_seen_at,last_seen_at,
          occurrence_count,affected_instance_count,policy_id,policy_revision,revision)
          VALUES(?,?,'api','http.request','error','observed',?,?,1,0,?,1,1)`,
        ISSUE,
        "b".repeat(64),
        STARTED,
        STARTED,
        POLICY,
      ),
      statement(
        `INSERT INTO issue_occurrences(occurrence_id,issue_id,event_id,service_name,deployment_id,occurred_at,
          observed_at,instance_id,summary,correlation_id,evidence_count,retention_policy_id,retention_policy_revision,purge_after)
          VALUES(?,?,NULL,'api',?,?,?,?,?,?,0,?,1,?)`,
        OCCURRENCE,
        ISSUE,
        DEPLOYMENT,
        STARTED,
        STARTED,
        null,
        "Elevated errors",
        CORRELATION,
        RETENTION,
        "2026-10-12T00:00:00.000Z",
      ),
    ]);

    const created = await createIncident(env, {
      principal: { ...principal, roles: [...principal.roles] },
      correlation_id: CORRELATION,
      command: {
        command_id: PIN_COMMAND,
        title: "Pinned evidence",
        impact: "degraded",
        started_at: STARTED,
        affected_components: ["api-public"],
        issue_ids: [ISSUE],
        initial_message: "Investigating with retained evidence.",
      },
    });
    if (!("data" in created)) throw new Error(JSON.stringify(created));

    await expect(
      database
        .prepare(
          "SELECT update_sequence FROM incident_occurrences WHERE incident_id=? AND occurrence_id=?",
        )
        .bind(created.data.incident_id, OCCURRENCE)
        .first<number>("update_sequence"),
    ).resolves.toBe(1);
    await expect(
      database
        .prepare("DELETE FROM issue_occurrences WHERE occurrence_id=?")
        .bind(OCCURRENCE)
        .run(),
    ).rejects.toThrow(/incident-referenced occurrence/u);
  });
});

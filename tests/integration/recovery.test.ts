import { afterEach, describe, expect, it } from "vitest";

import { processDiagnosticEnvelope } from "../../workers/status/src/diagnostics/consumer.js";
import type { DiagnosticConsumerEnv } from "../../workers/status/src/diagnostics/types.js";
import { D1TargetReevaluator } from "../../workers/status/src/scheduling/reevaluate.js";
import type { D1DatabaseLike as SchedulerDatabase } from "../../workers/status/src/scheduling/store.js";
import type { RustDispatcher } from "../../workers/status/src/scheduling/types.js";
import { createMigratedD1, type TestD1Database } from "./d1.js";
import { realDomainCore } from "./wasm.js";

const NOW = new Date("2026-09-12T12:00:00.000Z");
const DEPLOYMENT = "018f0000-0000-7000-8000-000000000301";
const POLICY = "018f0000-0000-7000-8000-000000000302";
const RETENTION = "018f0000-0000-7000-8000-000000000303";
const ASSIGNMENT = "018f0000-0000-7000-8000-000000000304";
const MAINTENANCE = "018f0000-0000-7000-8000-000000000305";
const MONITOR = "018f0000-0000-7000-8000-000000000306";
const OVERRIDE = "018f0000-0000-7000-8000-000000000307";
const DIGEST = `sha256:${"a".repeat(64)}`;

/** 填充恢复聚合所需的最小不可变目录。 / Seed the minimal immutable catalog required by recovery aggregation. */
async function seed(database: TestD1Database): Promise<void> {
  const sql = (text: string, ...values: unknown[]) =>
    database.prepare(text).bind(...values);
  await database.batch([
    sql(
      "INSERT INTO services(service_name,display_name,description,owner,criticality,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
      "api",
      "API",
      "",
      "platform",
      "critical",
      1,
      "2026-09-12T11:00:00.000Z",
      "2026-09-12T11:00:00.000Z",
    ),
    sql(
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
      "2026-09-12T11:00:00.000Z",
      "manifests/api.json",
      DIGEST,
      "1.0",
      "2026-09-12T11:00:00.000Z",
      "ci",
    ),
    sql(
      `INSERT INTO evaluation_policies(policy_id,revision,schema_version,name,observation_window_seconds,minimum_samples,
      failure_threshold,recovery_threshold,latency_threshold_ms,stale_after_seconds,location_quorum,
      fingerprint_template_json,status_mapping_json,diagnostic_rules_json,created_by,created_at)
      VALUES(?,1,'1.0','default',300,1,0.5,0.2,NULL,300,1,?,?,?,'test',?)`,
      POLICY,
      '{"fields":["operation"]}',
      '{"error":"degraded"}',
      '{"minimum_occurrences":1,"recovery_min_occurrences":2,"status_by_severity":{"info":"operational","warning":"degraded","error":"degraded","critical":"major_outage"}}',
      "2026-09-12T11:00:00.000Z",
    ),
    sql(
      "INSERT INTO service_diagnostic_policies(assignment_id,selector_kind,service_name,policy_id,policy_revision,assigned_by,assigned_at) VALUES(?,'service_default',?,?,1,'test',?)",
      ASSIGNMENT,
      "api",
      POLICY,
      "2026-09-12T11:00:00.000Z",
    ),
    sql(
      "INSERT INTO data_retention_policies(policy_id,revision,occurrence_retention_days,cleanup_batch_size,created_by,created_at) VALUES(?,1,30,100,'test',?)",
      RETENTION,
      "2026-09-12T11:00:00.000Z",
    ),
    sql(
      "INSERT INTO service_retention_policies(service_name,policy_id,policy_revision,assigned_by,assigned_at) VALUES(?,?,1,'test',?)",
      "api",
      RETENTION,
      "2026-09-12T11:00:00.000Z",
    ),
  ]);
}

/** 构造同 kind/fingerprint 的故障或因果恢复信封。 / Build fault or causally linked recovery envelopes with one kind/fingerprint. */
function envelope(
  sequence: number,
  signal: "fault" | "recovery",
  occurredAt: string,
  recoveryOf?: string,
) {
  const suffix = sequence.toString(16).padStart(12, "0");
  const eventId = `018f0000-0000-7000-8000-${suffix}`;
  return {
    schema_version: "1.0" as const,
    message_id: `018f0000-0001-7000-8000-${suffix}`,
    event: {
      event_id: eventId,
      schema_version: "1.0" as const,
      kind: "http.request",
      signal,
      ...(recoveryOf === undefined ? {} : { recovery_of_event_id: recoveryOf }),
      severity: "error" as const,
      service_name: "api",
      environment: "production" as const,
      deployment_id: DEPLOYMENT,
      occurred_at: occurredAt,
      correlation_id: `018f0000-0002-7000-8000-${suffix}`,
      trace_id: "1".repeat(32),
      summary: signal === "fault" ? "HTTP errors" : "HTTP errors cleared",
      fingerprint: { operation: "GET /v1/items", protocol: "http" as const },
      evidence: [],
      attributes: { "operation.name": "GET /v1/items" },
    },
    received_at: occurredAt,
    producer: {
      subject: "workload:api",
      service_name: "api",
      environment: "production" as const,
      deployment_id: DEPLOYMENT,
      scopes: ["diagnostics:write"],
      token_id: "token-1",
      auth_method: "jwt" as const,
    },
    trace_context: {
      correlation_id: `018f0000-0002-7000-8000-${suffix}`,
    },
  };
}

/** 构造使用真实 Wasm 核心的 consumer 环境。 / Build a consumer environment using the real Wasm core. */
function environment(database: TestD1Database): DiagnosticConsumerEnv {
  return {
    DB: database as unknown as DiagnosticConsumerEnv["DB"],
    DIAGNOSTIC_CORE: realDomainCore(),
    now: () => NOW,
  };
}

describe("explicit diagnostic recovery with real D1 and Wasm", () => {
  const opened: TestD1Database[] = [];
  afterEach(() => {
    for (const database of opened.splice(0)) database.close();
  });

  it("rejects recovery without an explicit causal fault reference", async () => {
    const database = await createMigratedD1();
    opened.push(database);
    await seed(database);
    const invalid = envelope(0x30e, "recovery", "2026-09-12T11:48:00.000Z");
    await expect(
      processDiagnosticEnvelope(invalid, environment(database)),
    ).rejects.toThrow("invalid-diagnostic-envelope");
    await expect(
      database
        .prepare("SELECT COUNT(*) FROM diagnostic_event_dedup")
        .first<number>("COUNT(*)"),
    ).resolves.toBe(0);
  });

  it("deduplicates unmatched recovery as an audited no-op", async () => {
    const database = await createMigratedD1();
    opened.push(database);
    await seed(database);
    const clear = envelope(
      0x310,
      "recovery",
      "2026-09-12T11:49:00.000Z",
      "018f0000-0000-7000-8000-00000000030f",
    );
    const env = environment(database);
    await expect(processDiagnosticEnvelope(clear, env)).resolves.toBe(
      "processed",
    );
    await expect(processDiagnosticEnvelope(clear, env)).resolves.toBe(
      "duplicate",
    );
    await expect(
      database.prepare("SELECT COUNT(*) FROM issues").first<number>("COUNT(*)"),
    ).resolves.toBe(0);
    await expect(
      database
        .prepare("SELECT COUNT(*) FROM issue_occurrences")
        .first<number>("COUNT(*)"),
    ).resolves.toBe(0);
    await expect(
      database
        .prepare(
          "SELECT COUNT(*) FROM audit_log WHERE action='diagnostic.recovery_unmatched'",
        )
        .first<number>("COUNT(*)"),
    ).resolves.toBe(1);
    await expect(
      database
        .prepare(
          "SELECT COUNT(*) FROM outbox WHERE event_type='diagnostic.recovery.unmatched'",
        )
        .first<number>("COUNT(*)"),
    ).resolves.toBe(1);
  });

  it("requires the current fault head, preserves occurrence counts, and dispatches full status reevaluation", async () => {
    const database = await createMigratedD1();
    opened.push(database);
    await seed(database);
    const env = environment(database);
    const firstFault = envelope(0x311, "fault", "2026-09-12T11:50:00.000Z");
    await processDiagnosticEnvelope(firstFault, env);
    await processDiagnosticEnvelope(
      envelope(
        0x312,
        "recovery",
        "2026-09-12T11:51:00.000Z",
        firstFault.event.event_id,
      ),
      env,
    );

    const secondFault = envelope(0x313, "fault", "2026-09-12T11:52:00.000Z");
    await processDiagnosticEnvelope(secondFault, env);
    await processDiagnosticEnvelope(
      envelope(
        0x314,
        "recovery",
        "2026-09-12T11:53:00.000Z",
        firstFault.event.event_id,
      ),
      env,
    );
    await expect(
      database
        .prepare(
          "SELECT state,occurrence_count,recovery_count,last_fault_event_id FROM issues WHERE state<>'resolved'",
        )
        .first(),
    ).resolves.toEqual({
      state: "active",
      occurrence_count: 2,
      recovery_count: 0,
      last_fault_event_id: secondFault.event.event_id,
    });

    await processDiagnosticEnvelope(
      envelope(
        0x315,
        "recovery",
        "2026-09-12T11:54:00.000Z",
        secondFault.event.event_id,
      ),
      env,
    );
    await processDiagnosticEnvelope(
      envelope(
        0x316,
        "recovery",
        "2026-09-12T11:55:00.000Z",
        secondFault.event.event_id,
      ),
      env,
    );
    const issue = await database
      .prepare(
        "SELECT issue_id,state,occurrence_count,recovery_count,last_fault_event_id FROM issues",
      )
      .first<{
        issue_id: string;
        state: string;
        occurrence_count: number;
        recovery_count: number;
        last_fault_event_id: string;
      }>();
    expect(issue).toMatchObject({
      state: "resolved",
      occurrence_count: 2,
      recovery_count: 2,
      last_fault_event_id: secondFault.event.event_id,
    });
    await expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM issue_occurrences")
        .first<number>("count"),
    ).resolves.toBe(2);

    await database.batch([
      database
        .prepare(
          `INSERT INTO maintenance_windows(maintenance_id,title,description,expected_impact,starts_at,ends_at,state,
          created_by,created_at,updated_at) VALUES(?,?,?,'degraded',?,?,'active','operator',?,?)`,
        )
        .bind(
          MAINTENANCE,
          "Maintenance",
          "Planned work",
          "2026-09-12T11:30:00.000Z",
          "2026-09-12T12:30:00.000Z",
          "2026-09-12T11:00:00.000Z",
          "2026-09-12T11:00:00.000Z",
        ),
      database
        .prepare(
          "INSERT INTO maintenance_targets(maintenance_id,target_type,target_id) VALUES(?,'service','api')",
        )
        .bind(MAINTENANCE),
    ]);
    await expect(
      database
        .prepare(
          "SELECT COUNT(*) FROM outbox WHERE event_type='status.reevaluation_requested'",
        )
        .first<number>("COUNT(*)"),
    ).resolves.toBe(0);
    if (issue === null) throw new Error("resolved issue missing");
    const core = realDomainCore();
    const reevaluator = new D1TargetReevaluator(
      database as unknown as SchedulerDatabase,
      core as unknown as RustDispatcher,
      () => NOW.getTime(),
    );
    await reevaluator.reevaluate(
      { type: "service", id: "api" },
      { type: "issue", id: issue.issue_id },
      new AbortController().signal,
    );
    await expect(
      database
        .prepare(
          "SELECT direct_status FROM current_statuses WHERE target_type='service' AND target_id='api'",
        )
        .first<string>("direct_status"),
    ).resolves.toBe("maintenance");

    await database.batch([
      database
        .prepare(
          "UPDATE maintenance_windows SET state='completed',updated_at=?,revision=revision+1 WHERE maintenance_id=?",
        )
        .bind(NOW.toISOString(), MAINTENANCE),
      database
        .prepare(
          `INSERT INTO monitors(monitor_id,target_type,target_id,probe_kind,environment,schedule_kind,interval_seconds,
          timeout_ms,probe_config_json,policy_id,policy_revision,next_run_at,critical,enabled,created_at,updated_at)
          VALUES(?,'service','api','http','production','interval',60,1000,'{}',?,1,?,1,1,?,?)`,
        )
        .bind(
          MONITOR,
          POLICY,
          NOW.toISOString(),
          NOW.toISOString(),
          NOW.toISOString(),
        ),
      database
        .prepare(
          "INSERT INTO monitor_locations(monitor_id,location,enabled) VALUES(?,'global',1)",
        )
        .bind(MONITOR),
      database
        .prepare(
          `INSERT INTO monitor_checkpoints(monitor_id,location,last_observed_at,consecutive_successes,consecutive_failures,
          window_samples,window_unhealthy_samples,window_started_at,window_latency_p95_ms,evaluation_status,evaluated_at,
          fresh_until,policy_id,policy_revision)
          VALUES(?,'global',?,0,2,2,2,?,100,'degraded',?,?,?,1)`,
        )
        .bind(
          MONITOR,
          "2026-09-12T11:59:00.000Z",
          "2026-09-12T11:55:00.000Z",
          "2026-09-12T11:59:00.000Z",
          "2026-09-12T12:04:00.000Z",
          POLICY,
        ),
    ]);
    await reevaluator.reevaluate(
      { type: "service", id: "api" },
      { type: "issue", id: issue.issue_id },
      new AbortController().signal,
    );
    await expect(
      database
        .prepare(
          "SELECT direct_status FROM current_statuses WHERE target_type='service' AND target_id='api'",
        )
        .first<string>("direct_status"),
    ).resolves.toBe("unknown");

    await database
      .prepare(
        `INSERT INTO status_overrides(override_id,target_type,target_id,status,reason,starts_at,expires_at,
        actor_subject,correlation_id,created_at)
        VALUES(?,'service','api','partial_outage','operator evidence',?,?,'operator',?,?)`,
      )
      .bind(
        OVERRIDE,
        "2026-09-12T11:58:00.000Z",
        "2026-09-12T12:30:00.000Z",
        "018f0000-0000-7000-8000-000000000308",
        "2026-09-12T11:58:00.000Z",
      )
      .run();
    await reevaluator.reevaluate(
      { type: "service", id: "api" },
      { type: "issue", id: issue.issue_id },
      new AbortController().signal,
    );
    await expect(
      database
        .prepare(
          "SELECT direct_status FROM current_statuses WHERE target_type='service' AND target_id='api'",
        )
        .first<string>("direct_status"),
    ).resolves.toBe("partial_outage");
  });
});

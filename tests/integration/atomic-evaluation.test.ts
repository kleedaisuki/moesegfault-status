import { afterEach, describe, expect, it } from "vitest";

import { processDiagnosticEnvelope } from "../../workers/status/src/diagnostics/consumer.js";
import type {
  D1DatabaseLike as ConsumerDatabase,
  D1ResultLike as ConsumerResult,
  D1StatementLike as ConsumerStatement,
  DiagnosticConsumerEnv,
} from "../../workers/status/src/diagnostics/types.js";
import { D1TargetReevaluator } from "../../workers/status/src/scheduling/reevaluate.js";
import type { D1DatabaseLike as SchedulerDatabase } from "../../workers/status/src/scheduling/store.js";
import type { RustDispatcher } from "../../workers/status/src/scheduling/types.js";
import {
  createMigratedD1,
  type TestD1Database,
  type TestD1PreparedStatement,
} from "./d1.js";
import { realDomainCore } from "./wasm.js";

const NOW = new Date("2026-09-12T12:00:00.000Z");
const DEPLOYMENT = "018f1000-0000-7000-8000-000000000001";
const POLICY = "018f1000-0000-7000-8000-000000000002";
const RETENTION = "018f1000-0000-7000-8000-000000000003";
const ASSIGNMENT = "018f1000-0000-7000-8000-000000000004";
const MONITOR = "018f1000-0000-7000-8000-000000000005";
const MAINTENANCE = "018f1000-0000-7000-8000-000000000006";
const OVERRIDE = "018f1000-0000-7000-8000-000000000007";
const RACING_OVERRIDE = "018f1000-0000-7000-8000-000000000008";
const DIGEST = `sha256:${"a".repeat(64)}`;

/** 填充原子恢复测试所需的最小权威目录。 / Seed the minimal authoritative catalog for atomic-recovery tests. */
async function seed(database: TestD1Database): Promise<void> {
  const sql = (text: string, ...values: unknown[]) =>
    database.prepare(text).bind(...values);
  await database.batch([
    sql(
      "INSERT INTO services(service_name,display_name,description,owner,criticality,enabled,created_at,updated_at) VALUES('api','API','','platform','critical',1,?,?)",
      "2026-09-12T11:00:00.000Z",
      "2026-09-12T11:00:00.000Z",
    ),
    sql(
      "INSERT INTO deployments(deployment_id,service_name,environment,service_version,repository_url,git_commit,git_ref,artifact_digest,ci_provider,ci_run_id,deployed_at,manifest_object_key,manifest_digest,manifest_schema_version,registered_at,registered_by) VALUES(?,'api','production','1.0.0','https://example.com/repo',?,'refs/heads/main',?,'github','1',?,'manifests/api.json',?,'1.0',?,'ci')",
      DEPLOYMENT,
      "a".repeat(40),
      DIGEST,
      "2026-09-12T11:00:00.000Z",
      DIGEST,
      "2026-09-12T11:00:00.000Z",
    ),
    sql(
      `INSERT INTO evaluation_policies(policy_id,revision,schema_version,name,observation_window_seconds,minimum_samples,
      failure_threshold,recovery_threshold,latency_threshold_ms,stale_after_seconds,location_quorum,
      fingerprint_template_json,status_mapping_json,diagnostic_rules_json,created_by,created_at)
      VALUES(?,1,'1.0','atomic',300,1,0.5,0.2,NULL,300,1,'{}','{}',?,'test',?)`,
      POLICY,
      '{"minimum_occurrences":1,"recovery_min_occurrences":2,"status_by_severity":{"info":"degraded","warning":"degraded","error":"degraded","critical":"major_outage"}}',
      "2026-09-12T11:00:00.000Z",
    ),
    sql(
      "INSERT INTO service_diagnostic_policies(assignment_id,selector_kind,service_name,policy_id,policy_revision,assigned_by,assigned_at) VALUES(?,'service_default','api',?,1,'test',?)",
      ASSIGNMENT,
      POLICY,
      "2026-09-12T11:00:00.000Z",
    ),
    sql(
      "INSERT INTO data_retention_policies(policy_id,revision,occurrence_retention_days,cleanup_batch_size,created_by,created_at) VALUES(?,1,30,100,'test',?)",
      RETENTION,
      "2026-09-12T11:00:00.000Z",
    ),
    sql(
      "INSERT INTO service_retention_policies(service_name,policy_id,policy_revision,assigned_by,assigned_at) VALUES('api',?,1,'test',?)",
      RETENTION,
      "2026-09-12T11:00:00.000Z",
    ),
  ]);
}

/** 构造唯一但可复现的故障/恢复信封。 / Build a unique, reproducible fault/recovery envelope. */
function envelope(
  sequence: number,
  signal: "fault" | "recovery",
  operation: string,
  severity: "error" | "critical" = "error",
  recoveryOf?: string,
) {
  const suffix = sequence.toString(16).padStart(12, "0");
  const eventId = `018f1000-0001-7000-8000-${suffix}`;
  return {
    schema_version: "1.0" as const,
    message_id: `018f1000-0002-7000-8000-${suffix}`,
    event: {
      event_id: eventId,
      schema_version: "1.0" as const,
      kind: "http.request",
      signal,
      ...(recoveryOf === undefined ? {} : { recovery_of_event_id: recoveryOf }),
      severity,
      service_name: "api",
      environment: "production" as const,
      deployment_id: DEPLOYMENT,
      occurred_at: `2026-09-12T11:${String(sequence).padStart(2, "0")}:00.000Z`,
      correlation_id: `018f1000-0003-7000-8000-${suffix}`,
      trace_id: "1".repeat(32),
      summary: signal === "fault" ? "request failed" : "request recovered",
      fingerprint: { operation, protocol: "http" as const },
      evidence: [],
      attributes: { "operation.name": operation },
    },
    received_at: NOW.toISOString(),
    producer: {
      subject: "workload:api",
      service_name: "api",
      environment: "production" as const,
      deployment_id: DEPLOYMENT,
      scopes: ["diagnostics:write"],
      token_id: "token-atomic",
      auth_method: "jwt" as const,
    },
    trace_context: { correlation_id: `018f1000-0003-7000-8000-${suffix}` },
  };
}

/** 构造真实 Wasm 领域核心环境。 / Build an environment backed by the real Wasm domain core. */
function environment(database: ConsumerDatabase): DiagnosticConsumerEnv {
  return { DB: database, DIAGNOSTIC_CORE: realDomainCore(), now: () => NOW };
}

/**
 * 在全信号规划快照返回后提交一个独立输入变更。
 * Commit an independent input change after the full-signal planning snapshot returns.
 */
class PlanCommitInterleavingDatabase implements ConsumerDatabase {
  readonly #database: TestD1Database;
  #batchCount = 0;

  constructor(database: TestD1Database) {
    this.#database = database;
  }

  /** 委托 prepared statement 创建。 / Delegate prepared-statement creation. */
  prepare(sql: string): ConsumerStatement {
    return this.#database.prepare(sql) as unknown as ConsumerStatement;
  }

  /** 第二个 batch 是共享规划快照；其后插入 override 推进 generation。 / The second batch is the shared planning snapshot; insert an override afterwards to advance generation. */
  async batch(statements: ConsumerStatement[]): Promise<ConsumerResult[]> {
    this.#batchCount += 1;
    const results = await this.#database.batch(
      statements as unknown as TestD1PreparedStatement[],
    );
    if (this.#batchCount === 2) {
      await insertOverride(this.#database, RACING_OVERRIDE, "partial_outage");
    }
    return results as unknown as ConsumerResult[];
  }
}

/** 插入一个有效且有期限的人工覆盖。 / Insert a valid expiring operator override. */
async function insertOverride(
  database: TestD1Database,
  id: string,
  status: "degraded" | "partial_outage",
): Promise<void> {
  await database
    .prepare(
      `INSERT INTO status_overrides(override_id,target_type,target_id,status,reason,starts_at,expires_at,
      actor_subject,correlation_id,created_at) VALUES(?,'service','api',?,'operator evidence',?,?,'operator',?,?)`,
    )
    .bind(
      id,
      status,
      "2026-09-12T11:30:00.000Z",
      "2026-09-12T12:30:00.000Z",
      id,
      "2026-09-12T11:30:00.000Z",
    )
    .run();
}

/** 读取单列计数。 / Read a scalar count. */
async function count(database: TestD1Database, sql: string): Promise<number> {
  return (await database.prepare(sql).first<number>("count")) ?? 0;
}

describe("atomic full-signal status evaluation", () => {
  const opened: TestD1Database[] = [];
  afterEach(() => {
    for (const database of opened.splice(0)) database.close();
  });

  it("rolls back dedup, Issue recovery, audit, outbox and status when an input changes after planning", async () => {
    const database = await createMigratedD1();
    opened.push(database);
    await seed(database);
    const fault = envelope(1, "fault", "GET /race");
    await processDiagnosticEnvelope(
      fault,
      environment(database as unknown as ConsumerDatabase),
    );
    const issueBefore = await database
      .prepare("SELECT issue_id,state,recovery_count,revision FROM issues")
      .first<{
        issue_id: string;
        state: string;
        recovery_count: number;
        revision: number;
      }>();
    const statusBefore = await database
      .prepare(
        "SELECT direct_status,revision FROM current_statuses WHERE target_type='service' AND target_id='api'",
      )
      .first<{ direct_status: string; revision: number }>();
    const transitionsBefore = await count(
      database,
      "SELECT COUNT(*) AS count FROM status_transitions",
    );
    const recovery = envelope(
      2,
      "recovery",
      "GET /race",
      "error",
      fault.event.event_id,
    );
    const interleaved = new PlanCommitInterleavingDatabase(database);

    await expect(
      processDiagnosticEnvelope(recovery, environment(interleaved)),
    ).rejects.toThrow("diagnostic-transaction-failed");

    await expect(
      database
        .prepare("SELECT issue_id,state,recovery_count,revision FROM issues")
        .first(),
    ).resolves.toEqual(issueBefore);
    await expect(
      database
        .prepare(
          "SELECT direct_status,revision FROM current_statuses WHERE target_type='service' AND target_id='api'",
        )
        .first(),
    ).resolves.toEqual(statusBefore);
    expect(
      await count(
        database,
        `SELECT COUNT(*) AS count FROM diagnostic_event_dedup WHERE event_id='${recovery.event.event_id}'`,
      ),
    ).toBe(0);
    expect(
      await count(
        database,
        `SELECT COUNT(*) AS count FROM audit_log WHERE details_json LIKE '%${recovery.event.event_id}%'`,
      ),
    ).toBe(0);
    expect(
      await count(
        database,
        `SELECT COUNT(*) AS count FROM outbox WHERE payload_json LIKE '%${recovery.event.event_id}%'`,
      ),
    ).toBe(0);
    expect(
      await count(database, "SELECT COUNT(*) AS count FROM status_transitions"),
    ).toBe(transitionsBefore);
    expect(
      await count(
        database,
        "SELECT COUNT(*) AS count FROM status_overrides WHERE override_id='018f1000-0000-7000-8000-000000000008'",
      ),
    ).toBe(1);
  });

  it("uses monitors, maintenance, overrides and other Issues in the shared recovery plan", async () => {
    const database = await createMigratedD1();
    opened.push(database);
    await seed(database);
    const env = environment(database as unknown as ConsumerDatabase);
    const recoveringFault = envelope(3, "fault", "GET /recovering");
    const otherFault = envelope(4, "fault", "GET /critical", "critical");
    await processDiagnosticEnvelope(recoveringFault, env);
    await processDiagnosticEnvelope(otherFault, env);
    await processDiagnosticEnvelope(
      envelope(
        5,
        "recovery",
        "GET /recovering",
        "error",
        recoveringFault.event.event_id,
      ),
      env,
    );

    await database.batch([
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
      database
        .prepare(
          `INSERT INTO maintenance_windows(maintenance_id,title,description,expected_impact,starts_at,ends_at,state,
          created_by,created_at,updated_at) VALUES(?,'Maintenance','Planned','degraded',?,?,'active','operator',?,?)`,
        )
        .bind(
          MAINTENANCE,
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
    await insertOverride(database, OVERRIDE, "partial_outage");

    // 故障写入也必须走同一个全信号规划器，不能用 severity 直接覆盖人工判断。
    // Fault writes must use the same full-signal planner rather than replacing operator judgment from severity alone.
    await processDiagnosticEnvelope(
      envelope(6, "fault", "GET /third", "critical"),
      env,
    );
    await expect(
      database
        .prepare(
          "SELECT direct_status FROM current_statuses WHERE target_type='service' AND target_id='api'",
        )
        .first<string>("direct_status"),
    ).resolves.toBe("partial_outage");

    const recovery = envelope(
      7,
      "recovery",
      "GET /recovering",
      "error",
      recoveringFault.event.event_id,
    );
    await expect(processDiagnosticEnvelope(recovery, env)).resolves.toBe(
      "processed",
    );

    await expect(
      database
        .prepare(
          "SELECT state FROM issues WHERE fingerprint_hash=(SELECT fingerprint_hash FROM diagnostic_event_dedup WHERE event_id=?)",
        )
        .bind(recoveringFault.event.event_id)
        .first<string>("state"),
    ).resolves.toBe("resolved");
    await expect(
      database
        .prepare(
          "SELECT direct_status FROM current_statuses WHERE target_type='service' AND target_id='api'",
        )
        .first<string>("direct_status"),
    ).resolves.toBe("partial_outage");
    expect(
      await count(
        database,
        "SELECT COUNT(*) AS count FROM monitors m JOIN monitor_checkpoints c USING(monitor_id) WHERE m.monitor_id='018f1000-0000-7000-8000-000000000005'",
      ),
    ).toBe(1);
    expect(
      await count(
        database,
        "SELECT COUNT(*) AS count FROM maintenance_targets WHERE maintenance_id='018f1000-0000-7000-8000-000000000006'",
      ),
    ).toBe(1);
    expect(
      await count(
        database,
        "SELECT COUNT(*) AS count FROM issues WHERE state='active'",
      ),
    ).toBe(2);
    expect(
      await count(
        database,
        "SELECT COUNT(*) AS count FROM outbox WHERE event_type='status.reevaluation_requested'",
      ),
    ).toBe(0);

    const reevaluator = new D1TargetReevaluator(
      database as unknown as SchedulerDatabase,
      realDomainCore() as unknown as RustDispatcher,
      () => NOW.getTime(),
    );
    await database
      .prepare(
        "UPDATE status_overrides SET revoked_at=?,revoked_by='operator',revision=revision+1 WHERE override_id=?",
      )
      .bind(NOW.toISOString(), OVERRIDE)
      .run();
    await reevaluator.reevaluate(
      { type: "service", id: "api" },
      { type: "override", id: OVERRIDE },
      new AbortController().signal,
    );
    await expect(
      database
        .prepare(
          "SELECT direct_status FROM current_statuses WHERE target_type='service' AND target_id='api'",
        )
        .first<string>("direct_status"),
    ).resolves.toBe("maintenance");

    await database
      .prepare(
        "UPDATE maintenance_windows SET state='completed',updated_at=?,revision=revision+1 WHERE maintenance_id=?",
      )
      .bind(NOW.toISOString(), MAINTENANCE)
      .run();
    await reevaluator.reevaluate(
      { type: "service", id: "api" },
      { type: "maintenance", id: MAINTENANCE },
      new AbortController().signal,
    );
    await expect(
      database
        .prepare(
          "SELECT direct_status FROM current_statuses WHERE target_type='service' AND target_id='api'",
        )
        .first<string>("direct_status"),
    ).resolves.toBe("major_outage");
  });
});

import * as instrumentation from "../../workers/status/src/platform/instrumentation.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { processDiagnosticEnvelope } from "../../workers/status/src/diagnostics/consumer.js";
import type { DiagnosticConsumerEnv } from "../../workers/status/src/diagnostics/types.js";
import { createMigratedD1, type TestD1Database } from "./d1.js";
import { realDomainCore } from "./wasm.js";

const NOW = new Date("2026-09-12T12:00:00.000Z");
const AT = "2026-09-12T11:59:00.000Z";
const EVENT = "018f0000-0000-7000-8000-000000000201";
const MESSAGE = "018f0000-0000-7000-8000-000000000202";
const DEPLOYMENT = "018f0000-0000-7000-8000-000000000203";
const CORRELATION = "018f0000-0000-7000-8000-000000000204";
const POLICY = "018f0000-0000-7000-8000-000000000205";
const RETENTION = "018f0000-0000-7000-8000-000000000206";
const ASSIGNMENT = "018f0000-0000-7000-8000-000000000207";
const INCIDENT = "018f0000-0000-7000-8000-000000000208";
const INCIDENT_UPDATE_1 = "018f0000-0000-7000-8000-000000000209";
const INCIDENT_UPDATE_2 = "018f0000-0000-7000-8000-00000000020a";
const INCIDENT_UPDATE_3 = "018f0000-0000-7000-8000-00000000020b";
const DIGEST = `sha256:${"a".repeat(64)}`;

/** 写入 consumer 所需的服务、部署与显式 policy revisions。 / Seed the service, deployment, and explicit policy revisions required by the consumer. */
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
      AT,
      AT,
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
      AT,
      "manifests/api.json",
      DIGEST,
      "1.0",
      AT,
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
      '{"minimum_occurrences":1,"status_by_severity":{"info":"operational","warning":"degraded","error":"degraded","critical":"major_outage"}}',
      AT,
    ),
    sql(
      "INSERT INTO service_diagnostic_policies(assignment_id,selector_kind,service_name,policy_id,policy_revision,assigned_by,assigned_at) VALUES(?,'service_default',?,?,1,'test',?)",
      ASSIGNMENT,
      "api",
      POLICY,
      AT,
    ),
    sql(
      "INSERT INTO data_retention_policies(policy_id,revision,occurrence_retention_days,cleanup_batch_size,created_by,created_at) VALUES(?,1,30,100,'test',?)",
      RETENTION,
      AT,
    ),
    sql(
      "INSERT INTO service_retention_policies(service_name,policy_id,policy_revision,assigned_by,assigned_at) VALUES(?,?,1,'test',?)",
      "api",
      RETENTION,
      AT,
    ),
  ]);
}

/** 创建完整、可由共享 schema 重新校验的 Queue 信封。 / Create a complete queue envelope revalidated by the shared schema. */
function envelope(evidence: unknown[] = []) {
  return {
    schema_version: "1.0",
    message_id: MESSAGE,
    event: {
      event_id: EVENT,
      schema_version: "1.0",
      kind: "http.request",
      severity: "error",
      service_name: "api",
      environment: "production",
      deployment_id: DEPLOYMENT,
      occurred_at: AT,
      correlation_id: CORRELATION,
      trace_id: "1".repeat(32),
      span_id: "2".repeat(16),
      summary: "Elevated HTTP errors",
      fingerprint: { operation: "GET /v1/items", protocol: "http" },
      evidence,
      attributes: { "operation.name": "GET /v1/items" },
    },
    received_at: AT,
    producer: {
      subject: "workload:api",
      service_name: "api",
      environment: "production",
      deployment_id: DEPLOYMENT,
      scopes: ["diagnostics:write"],
      token_id: "token-1",
      auth_method: "jwt",
    },
    trace_context: { correlation_id: CORRELATION },
  };
}

/** 构造以真实 SQL adapter 为事务边界的 consumer 环境。 / Build a consumer environment whose transaction boundary is the real SQL adapter. */
function environment(database: TestD1Database): DiagnosticConsumerEnv {
  return {
    DB: database as unknown as DiagnosticConsumerEnv["DB"],
    DIAGNOSTIC_CORE: realDomainCore(),
    now: () => NOW,
  };
}

describe("diagnostic consumer with real D1", () => {
  it("records planning but no committed lifecycle counters on transaction failure", async () => {
    const database = await ready();
    const base = environment(database);
    let planned = false;
    const env: DiagnosticConsumerEnv = {
      ...base,
      DB: {
        prepare: (sql) => database.prepare(sql),
        batch: async (statements) => {
          if (planned) throw new Error("transaction unavailable");
          return base.DB.batch(statements);
        },
      },
    };
    const original = instrumentation.measurement;
    const spy = vi
      .spyOn(instrumentation, "measurement")
      .mockImplementation((...args) => {
        if (args[1] === "status.evaluation.duration") planned = true;
        return original(...args);
      });
    try {
      await expect(
        processDiagnosticEnvelope(envelope(), env),
      ).rejects.toThrow();
      expect(
        spy.mock.calls.filter(
          (call) => call[1] === "status.evaluation.duration",
        ),
      ).toHaveLength(1);
      expect(
        spy.mock.calls.filter((call) =>
          ["status.transition.count", "issue.creation.count"].includes(call[1]),
        ),
      ).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("records committed lifecycle metrics once and never on duplicate replay", async () => {
    const database = await ready();
    const spy = vi.spyOn(instrumentation, "measurement");
    try {
      await processDiagnosticEnvelope(envelope(), environment(database));
      await processDiagnosticEnvelope(envelope(), environment(database));
      expect(
        spy.mock.calls
          .filter((call) => call[1] === "issue.creation.count")
          .map((call) => call[2]),
      ).toEqual([1]);
      expect(
        spy.mock.calls
          .filter((call) => call[1] === "status.transition.count")
          .map((call) => call[2]),
      ).toEqual([1]);
      expect(
        spy.mock.calls.filter(
          (call) => call[1] === "status.evaluation.duration",
        ),
      ).toHaveLength(2);
    } finally {
      spy.mockRestore();
    }
  });

  const opened: TestD1Database[] = [];
  afterEach(() => {
    for (const database of opened.splice(0)) database.close();
  });

  async function ready(): Promise<TestD1Database> {
    const database = await createMigratedD1();
    opened.push(database);
    await seed(database);
    return database;
  }

  it("deduplicates the same immutable event without secondary side effects", async () => {
    const database = await ready();

    await expect(
      processDiagnosticEnvelope(envelope(), environment(database)),
    ).resolves.toBe("processed");
    await expect(
      processDiagnosticEnvelope(envelope(), environment(database)),
    ).resolves.toBe("duplicate");

    for (const table of [
      "diagnostic_event_dedup",
      "issues",
      "issue_occurrences",
      "status_transitions",
    ]) {
      await expect(
        database
          .prepare(`SELECT COUNT(*) FROM ${table}`)
          .first<number>("COUNT(*)"),
        table,
      ).resolves.toBe(1);
    }
    await expect(
      database
        .prepare("SELECT COUNT(*) FROM audit_log")
        .first<number>("COUNT(*)"),
    ).resolves.toBe(2);
    await expect(
      database.prepare("SELECT COUNT(*) FROM outbox").first<number>("COUNT(*)"),
    ).resolves.toBe(2);
  });

  it("rejects reuse of an event ID with different immutable payload", async () => {
    const database = await ready();
    await processDiagnosticEnvelope(envelope(), environment(database));
    const conflict = envelope();
    conflict.event.summary = "Same event identity, changed payload";

    await expect(
      processDiagnosticEnvelope(conflict, environment(database)),
    ).rejects.toThrow("diagnostic-event-id-conflict");
    for (const table of [
      "diagnostic_event_dedup",
      "issues",
      "issue_occurrences",
      "status_transitions",
    ]) {
      await expect(
        database
          .prepare(`SELECT COUNT(*) FROM ${table}`)
          .first<number>("COUNT(*)"),
        table,
      ).resolves.toBe(1);
    }
    await expect(
      database
        .prepare("SELECT COUNT(*) FROM audit_log")
        .first<number>("COUNT(*)"),
    ).resolves.toBe(2);
    await expect(
      database.prepare("SELECT COUNT(*) FROM outbox").first<number>("COUNT(*)"),
    ).resolves.toBe(2);
  });

  it("rolls back the dedup claim and all domain writes when evidence persistence fails", async () => {
    const database = await ready();
    const invalidEvidence = [
      {
        kind: "trace",
        backend: "unregistered-backend",
        locator: { trace_id: "1".repeat(32), span_id: "2".repeat(16) },
      },
    ];

    await expect(
      processDiagnosticEnvelope(
        envelope(invalidEvidence),
        environment(database),
      ),
    ).rejects.toThrow("diagnostic-transaction-failed");
    for (const table of [
      "diagnostic_event_dedup",
      "issues",
      "issue_occurrences",
      "current_statuses",
      "audit_log",
      "outbox",
    ]) {
      await expect(
        database
          .prepare(`SELECT COUNT(*) FROM ${table}`)
          .first<number>("COUNT(*)"),
        table,
      ).resolves.toBe(0);
    }
  });

  it("pins new occurrences and evidence only while a linked incident is open", async () => {
    const database = await ready();
    await processDiagnosticEnvelope(envelope(), environment(database));
    const issue = await database
      .prepare("SELECT issue_id FROM issues LIMIT 1")
      .first<{ issue_id: string }>();
    if (issue === null) throw new Error("consumer did not create an issue");
    const statement = (sql: string, ...values: unknown[]) =>
      database.prepare(sql).bind(...values);
    await database.batch([
      statement(
        "INSERT INTO telemetry_backends(backend_name,capabilities_json,query_adapter,ui_url_template,retention_class,auth_reference,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
        "tempo",
        '["trace"]',
        "tempo",
        "https://telemetry.example/trace/{trace_id}",
        "standard",
        "TEMPO_TOKEN",
        AT,
        AT,
      ),
      statement(
        "INSERT INTO incidents(incident_id,started_at,detected_at,created_at,created_by) VALUES(?,?,?,?,?)",
        INCIDENT,
        AT,
        AT,
        AT,
        "operator",
      ),
      statement(
        `INSERT INTO incident_updates(update_id,incident_id,sequence,title,state,impact,cause,public_message,
          resolved_at,actor_subject,correlation_id,occurred_at)
          VALUES(?,?,1,'Diagnostic incident','investigating','degraded',NULL,'Investigating',NULL,'operator',?,?)`,
        INCIDENT_UPDATE_1,
        INCIDENT,
        CORRELATION,
        AT,
      ),
      statement(
        "INSERT INTO incident_issue_relations(incident_id,issue_id,update_sequence,action) VALUES(?,?,1,'added')",
        INCIDENT,
        issue.issue_id,
      ),
    ]);

    const openEvent = envelope([
      {
        kind: "trace",
        backend: "tempo",
        locator: { trace_id: "1".repeat(32), span_id: "2".repeat(16) },
      },
    ]);
    openEvent.event.event_id = "018f0000-0000-7000-8000-00000000020c";
    openEvent.message_id = "018f0000-0000-7000-8000-00000000020d";
    await processDiagnosticEnvelope(openEvent, environment(database));

    const openOccurrence = await database
      .prepare("SELECT occurrence_id FROM issue_occurrences WHERE event_id=?")
      .bind(openEvent.event.event_id)
      .first<{ occurrence_id: string }>();
    if (openOccurrence === null)
      throw new Error("second occurrence is missing");
    await expect(
      database
        .prepare(
          "SELECT COUNT(*) FROM incident_occurrences WHERE incident_id=? AND occurrence_id=?",
        )
        .bind(INCIDENT, openOccurrence.occurrence_id)
        .first<number>("COUNT(*)"),
    ).resolves.toBe(1);
    await expect(
      database
        .prepare(
          "SELECT COUNT(*) FROM incident_telemetry_references WHERE incident_id=?",
        )
        .bind(INCIDENT)
        .first<number>("COUNT(*)"),
    ).resolves.toBe(1);
    await expect(
      database
        .prepare("DELETE FROM issue_occurrences WHERE occurrence_id=?")
        .bind(openOccurrence.occurrence_id)
        .run(),
    ).rejects.toThrow(/incident-referenced occurrence/u);

    const resolvedAt = NOW.toISOString();
    await database.batch([
      statement(
        `INSERT INTO incident_updates(update_id,incident_id,sequence,title,state,impact,cause,public_message,
          resolved_at,actor_subject,correlation_id,occurred_at)
          VALUES(?,?,2,'Diagnostic incident','identified','degraded',NULL,'Cause identified',NULL,'operator',?,?)`,
        INCIDENT_UPDATE_2,
        INCIDENT,
        CORRELATION,
        resolvedAt,
      ),
      statement(
        `INSERT INTO incident_updates(update_id,incident_id,sequence,title,state,impact,cause,public_message,
          resolved_at,actor_subject,correlation_id,occurred_at)
          VALUES(?,?,3,'Diagnostic incident','resolved','degraded','fixed','Resolved',?,'operator',?,?)`,
        INCIDENT_UPDATE_3,
        INCIDENT,
        resolvedAt,
        CORRELATION,
        resolvedAt,
      ),
    ]);
    const resolvedEvent = envelope();
    resolvedEvent.event.event_id = "018f0000-0000-7000-8000-00000000020e";
    resolvedEvent.message_id = "018f0000-0000-7000-8000-00000000020f";
    await processDiagnosticEnvelope(resolvedEvent, environment(database));
    const resolvedOccurrence = await database
      .prepare("SELECT occurrence_id FROM issue_occurrences WHERE event_id=?")
      .bind(resolvedEvent.event.event_id)
      .first<{ occurrence_id: string }>();
    if (resolvedOccurrence === null)
      throw new Error("third occurrence is missing");

    await expect(
      database
        .prepare(
          "SELECT COUNT(*) FROM incident_occurrences WHERE occurrence_id=?",
        )
        .bind(resolvedOccurrence.occurrence_id)
        .first<number>("COUNT(*)"),
    ).resolves.toBe(0);
  });

  it("derives status freshness from the selected immutable policy", async () => {
    const database = await ready();
    await processDiagnosticEnvelope(envelope(), environment(database));

    const status = await database
      .prepare(
        "SELECT evaluated_at,fresh_until,policy_id,policy_revision FROM current_statuses WHERE target_type='service' AND target_id='api'",
      )
      .first<{
        evaluated_at: string;
        fresh_until: string;
        policy_id: string;
        policy_revision: number;
      }>();

    expect(status).toEqual({
      evaluated_at: NOW.toISOString(),
      fresh_until: "2026-09-12T12:05:00.000Z",
      policy_id: POLICY,
      policy_revision: 1,
    });
  });
});

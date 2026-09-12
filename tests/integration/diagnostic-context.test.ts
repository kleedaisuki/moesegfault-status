import { afterEach, describe, expect, it } from "vitest";

import {
  queryDiagnosticContext,
  type AdminEnvironment,
} from "../../workers/status/src/admin/index.js";
import { createMigratedD1, type TestD1Database } from "./d1.js";

const START = "2026-09-12T00:00:00.000Z";
const INSIDE = "2026-09-12T00:10:00.000Z";
const END = "2026-09-12T01:00:00.000Z";
const AFTER = "2026-09-12T02:00:00.000Z";
const DEPLOYMENT = "018f0000-0000-7000-8000-000000000031";
const REFERENCE = "018f0000-0000-7000-8000-000000000032";
const TRANSITION_IN = "018f0000-0000-7000-8000-000000000033";
const TRANSITION_OUT = "018f0000-0000-7000-8000-000000000034";
const AUDIT_IN = "018f0000-0000-7000-8000-000000000035";
const AUDIT_OUT = "018f0000-0000-7000-8000-000000000036";
const CORRELATION = "018f0000-0000-7000-8000-000000000037";
const DIGEST = `sha256:${"c".repeat(64)}`;
const COMMIT = "d".repeat(40);

const principal = {
  subject: "viewer-subject",
  email: "viewer@example.com",
  roles: ["viewer"] as const,
  authenticated_at: START,
  access_application: "ops",
};

function environment(database: TestD1Database): AdminEnvironment {
  return {
    DB: database as unknown as D1Database,
    CURSOR_SIGNING_KEY: "diagnostic-context-test-key-with-enough-entropy",
    STATUS_VERSION: "test",
  };
}

async function seed(database: TestD1Database): Promise<void> {
  const statement = (sql: string, ...values: unknown[]) =>
    database.prepare(sql).bind(...values);
  const service = (name: string) =>
    statement(
      "INSERT INTO services(service_name,display_name,description,owner,criticality,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
      name,
      name.toUpperCase(),
      "",
      "platform",
      "critical",
      1,
      START,
      START,
    );
  await database.batch([
    service("api"),
    service("database"),
    statement(
      "INSERT INTO service_dependencies(source_service,target_service,capability,kind,criticality,created_at) VALUES(?,?,?,?,?,?)",
      "api",
      "database",
      "sql",
      "required",
      "critical",
      START,
    ),
    statement(
      `INSERT INTO deployments(deployment_id,service_name,environment,service_version,repository_url,
       git_commit,git_ref,artifact_digest,ci_provider,ci_run_id,deployed_at,manifest_object_key,
       manifest_digest,manifest_schema_version,registered_at,registered_by)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      DEPLOYMENT,
      "api",
      "production",
      "1.0.0",
      "https://github.com/moesegfault/status.git",
      COMMIT,
      "refs/heads/main",
      DIGEST,
      "github-actions",
      "1",
      START,
      "manifests/api.json",
      DIGEST,
      "1",
      START,
      "ci",
    ),
    statement(
      "INSERT INTO deployment_regions(deployment_id,region) VALUES(?,?)",
      DEPLOYMENT,
      "global",
    ),
    statement(
      `INSERT INTO deployment_artifact_requirements(deployment_id,kind,file_name,media_type,
       size_bytes,artifact_digest,created_at) VALUES(?,?,?,?,?,?,?)`,
      DEPLOYMENT,
      "other",
      "status-worker.wasm",
      "application/wasm",
      42,
      DIGEST,
      START,
    ),
    statement(
      "INSERT INTO telemetry_backends(backend_name,capabilities_json,query_adapter,ui_url_template,retention_class,auth_reference,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
      "source",
      '["source"]',
      "source-commit",
      "https://github.com/moesegfault/status",
      "permanent",
      "SOURCE_TOKEN",
      START,
      START,
    ),
    statement(
      `INSERT INTO telemetry_references(telemetry_reference_id,kind,backend_name,locator_json,
       service_name,deployment_id,correlation_id,created_at) VALUES(?,?,?,?,?,?,?,?)`,
      REFERENCE,
      "source",
      "source",
      JSON.stringify({
        repository_url: "https://github.com/moesegfault/status",
        git_commit: COMMIT,
        path: "workers/status/src/index.ts",
        line: 42,
      }),
      "api",
      DEPLOYMENT,
      CORRELATION,
      INSIDE,
    ),
    statement(
      `INSERT INTO current_statuses(target_type,target_id,direct_status,dependency_risk,
       effective_impact,evaluated_at,fresh_until,revision) VALUES(?,?,?,?,?,?,?,?)`,
      "service",
      "api",
      "degraded",
      "none",
      "degraded",
      INSIDE,
      END,
      2,
    ),
    statement(
      `INSERT INTO status_transitions(transition_id,target_type,target_id,sequence,from_status,
       to_status,source_type,source_id,correlation_id,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      TRANSITION_IN,
      "service",
      "api",
      1,
      null,
      "degraded",
      "diagnostic_event",
      "event-1",
      CORRELATION,
      INSIDE,
    ),
    statement(
      `INSERT INTO status_transitions(transition_id,target_type,target_id,sequence,from_status,
       to_status,source_type,source_id,correlation_id,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      TRANSITION_OUT,
      "service",
      "api",
      2,
      "degraded",
      "operational",
      "freshness",
      "freshness-1",
      CORRELATION,
      AFTER,
    ),
    statement(
      `INSERT INTO audit_log(audit_id,actor_type,actor_subject,action,target_type,target_id,
       correlation_id,occurred_at) VALUES(?,?,?,?,?,?,?,?)`,
      AUDIT_IN,
      "human",
      "admin-subject",
      "service.updated",
      "service",
      "api",
      CORRELATION,
      INSIDE,
    ),
    statement(
      `INSERT INTO audit_log(audit_id,actor_type,actor_subject,action,target_type,target_id,
       correlation_id,occurred_at) VALUES(?,?,?,?,?,?,?,?)`,
      AUDIT_OUT,
      "system",
      "scheduler",
      "status.refreshed",
      "service",
      "api",
      CORRELATION,
      AFTER,
    ),
  ]);
}

describe("complete DiagnosticContext graph", () => {
  const opened: TestD1Database[] = [];
  afterEach(() => {
    for (const database of opened.splice(0)) database.close();
  });

  it("returns typed relations, provenance, freshness, and time-bounded facts", async () => {
    const database = await createMigratedD1();
    opened.push(database);
    await seed(database);
    const result = await queryDiagnosticContext(environment(database), {
      principal,
      correlation_id: CORRELATION,
      locator: { kind: "service", service_name: "api", start: START, end: END },
    });
    if (!("data" in result)) throw new Error(JSON.stringify(result));

    expect(result.data.affected_services).toEqual([
      {
        service_name: "api",
        relations: [
          { kind: "deployment", deployment_id: DEPLOYMENT },
          { kind: "evidence", telemetry_reference_id: REFERENCE },
          { kind: "locator" },
        ],
        current_status: {
          direct_status: "degraded",
          dependency_risk: "none",
          effective_impact: "degraded",
          evaluated_at: INSIDE,
          fresh_until: END,
          revision: 2,
        },
      },
    ]);
    expect(result.data.dependency_paths).toEqual([
      {
        root_service: "api",
        leaf_service: "database",
        edges: [
          {
            source_service: "api",
            target_service: "database",
            capability: "sql",
            kind: "required",
            criticality: "critical",
          },
        ],
      },
    ]);
    expect(result.data.source_locations).toEqual([
      {
        telemetry_reference_id: REFERENCE,
        deployment_id: DEPLOYMENT,
        repository_url: "https://github.com/moesegfault/status",
        git_commit: COMMIT,
        path: "workers/status/src/index.ts",
        line: 42,
        provenance_verified: true,
      },
    ]);
    expect(
      result.data.status_transitions.map((item) => item.transition_id),
    ).toEqual([TRANSITION_IN]);
    expect(result.data.audit_summary).toEqual({
      event_count: 1,
      first_occurred_at: INSIDE,
      last_occurred_at: INSIDE,
      actions: [{ action: "service.updated", count: 1 }],
      actors: [
        {
          actor_type: "human",
          actor_subject: "admin-subject",
          event_count: 1,
        },
      ],
    });
    expect(result.data.truncated).toBe(false);
  });
});

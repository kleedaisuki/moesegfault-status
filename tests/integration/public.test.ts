import * as instrumentation from "../../workers/status/src/platform/instrumentation.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getIncident,
  getPlatformStatus,
  getServiceStatus,
  listMaintenanceWindows,
  listServices,
} from "../../workers/status/src/public/handlers.js";
import type { PublicApiContext } from "../../workers/status/src/public/types.js";
import { createMigratedD1, type TestD1Database } from "./d1.js";
import { realDomainCore } from "./wasm.js";

const NOW = new Date("2026-09-12T12:00:00.000Z");
const CREATED = "2026-09-12T00:00:00.000Z";
const FRESH = "2026-09-12T13:00:00.000Z";
const STALE = "2026-09-12T11:59:59.000Z";
const INCIDENT = "018f0000-0000-7000-8000-000000000001";
const UPDATE = "018f0000-0000-7000-8000-000000000002";
const MAINTENANCE = "018f0000-0000-7000-8000-000000000003";
const DEPLOYMENT = "018f0000-0000-7000-8000-000000000004";
const EVIDENCE = "018f0000-0000-7000-8000-000000000005";
const CORRELATION = "018f0000-0000-7000-8000-000000000006";
const DIGEST = `sha256:${"a".repeat(64)}`;

/** 构造只用真实 D1 读取的公共 API 上下文。 / Build a public API context whose persistence reads use only real D1 SQL. */
function context(database: TestD1Database): PublicApiContext {
  return {
    DB: database,
    cursorSecret: "integration-test-secret-with-sufficient-entropy",
    now: () => NOW,
    dependencyCore: realDomainCore(),
  };
}

/** 写入公开、私有、过期与遥测来源数据。 / Seed public, private, stale, and telemetry-provenance rows. */
async function seed(database: TestD1Database): Promise<void> {
  const statement = (sql: string, ...values: unknown[]) =>
    database.prepare(sql).bind(...values);
  await database.batch([
    statement(
      "INSERT INTO services(service_name,display_name,description,owner,criticality,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
      "api",
      "API",
      "Public API",
      "platform",
      "critical",
      1,
      CREATED,
      CREATED,
    ),
    statement(
      "INSERT INTO components(component_id,service_name,display_name,description,public,sort_order,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
      "api-public",
      "api",
      "Public component",
      "",
      1,
      1,
      1,
      CREATED,
      CREATED,
    ),
    statement(
      "INSERT INTO components(component_id,service_name,display_name,description,public,sort_order,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
      "api-private",
      "api",
      "Private component",
      "",
      0,
      2,
      1,
      CREATED,
      CREATED,
    ),
    statement(
      "INSERT INTO current_statuses(target_type,target_id,direct_status,dependency_risk,effective_impact,evaluated_at,fresh_until) VALUES('service',?,?,?,?,?,?)",
      "api",
      "operational",
      "none",
      "operational",
      CREATED,
      STALE,
    ),
    statement(
      "INSERT INTO current_statuses(target_type,target_id,direct_status,dependency_risk,effective_impact,evaluated_at,fresh_until) VALUES('component',?,?,?,?,?,?)",
      "api-public",
      "operational",
      "none",
      "operational",
      CREATED,
      FRESH,
    ),
    statement(
      "INSERT INTO incidents(incident_id,started_at,detected_at,created_at,created_by) VALUES(?,?,?,?,?)",
      INCIDENT,
      CREATED,
      CREATED,
      CREATED,
      "operator@example.com",
    ),
    statement(
      "INSERT INTO incident_updates(update_id,incident_id,sequence,title,state,impact,cause,public_message,resolved_at,actor_subject,correlation_id,occurred_at) VALUES(?,?,1,?,'investigating','degraded',?,?,NULL,?,?,?)",
      UPDATE,
      INCIDENT,
      "Latency",
      "internal root cause",
      "We are investigating.",
      "operator@example.com",
      CORRELATION,
      CREATED,
    ),
    statement(
      "INSERT INTO incident_component_relations(incident_id,component_id,update_sequence,action) VALUES(?,?,1,'added')",
      INCIDENT,
      "api-public",
    ),
    statement(
      "INSERT INTO incident_component_relations(incident_id,component_id,update_sequence,action) VALUES(?,?,1,'added')",
      INCIDENT,
      "api-private",
    ),
    statement(
      "INSERT INTO incident_service_relations(incident_id,service_name,update_sequence,action) VALUES(?,?,1,'added')",
      INCIDENT,
      "api",
    ),
    statement(
      "INSERT INTO maintenance_windows(maintenance_id,title,description,expected_impact,starts_at,ends_at,state,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      MAINTENANCE,
      "Upgrade",
      "Database upgrade",
      "degraded",
      "2026-09-12T12:30:00.000Z",
      "2026-09-12T13:30:00.000Z",
      "scheduled",
      "operator@example.com",
      CREATED,
      CREATED,
    ),
    statement(
      "INSERT INTO maintenance_targets(maintenance_id,target_type,target_id) VALUES(?,'component',?)",
      MAINTENANCE,
      "api-public",
    ),
    statement(
      "INSERT INTO maintenance_targets(maintenance_id,target_type,target_id) VALUES(?,'component',?)",
      MAINTENANCE,
      "api-private",
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
      CREATED,
      "manifests/api.json",
      DIGEST,
      "1.0",
      CREATED,
      "ci",
    ),
    statement(
      "INSERT INTO telemetry_backends(backend_name,capabilities_json,query_adapter,ui_url_template,retention_class,auth_reference,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
      "tempo",
      '["trace"]',
      "tempo",
      "https://telemetry.example/trace/{trace_id}",
      "standard",
      "TEMPO_TOKEN",
      CREATED,
      CREATED,
    ),
    statement(
      "INSERT INTO telemetry_references(telemetry_reference_id,kind,backend_name,locator_json,service_name,deployment_id,correlation_id,trace_id,span_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      EVIDENCE,
      "trace",
      "tempo",
      '{"trace_id":"secret-locator"}',
      "api",
      DEPLOYMENT,
      CORRELATION,
      "1".repeat(32),
      "2".repeat(16),
      CREATED,
    ),
    statement(
      "INSERT INTO incident_telemetry_references(incident_id,telemetry_reference_id,update_sequence) VALUES(?,?,1)",
      INCIDENT,
      EVIDENCE,
    ),
  ]);
}

describe("public handlers with real D1", () => {
  it("feeds original database freshness into metrics, not fallback catalog dates", async () => {
    const database = await ready();
    const spy = vi.spyOn(instrumentation, "recordPublicFreshness");
    try {
      await getPlatformStatus(
        new Request("https://status.moesegfault.dev/v1/status"),
        context(database),
        CORRELATION,
      );
      expect(spy).toHaveBeenCalledWith(
        undefined,
        expect.arrayContaining([
          expect.objectContaining({
            fresh_until: FRESH,
            evaluated_at: CREATED,
          }),
        ]),
        NOW,
        "platform",
      );
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

  it("maps stale service evidence to unknown without hiding fresh components", async () => {
    const database = await ready();
    const response = await listServices(
      new Request("https://status.example/v1/services"),
      context(database),
      CORRELATION,
    );
    const body = (await response.json()) as {
      data: Array<{
        status: string;
        components: Array<{ id: string; status: string }>;
      }>;
    };

    expect(response.status).toBe(200);
    expect(body.data).toEqual([
      expect.objectContaining({
        status: "unknown",
        components: [
          {
            id: "api-public",
            display_name: "Public component",
            status: "operational",
          },
        ],
      }),
    ]);
  });

  it("aggregates platform freshness conservatively", async () => {
    const database = await ready();
    const response = await getPlatformStatus(
      new Request("https://status.example/v1/status"),
      context(database),
      CORRELATION,
    );
    const body = (await response.json()) as {
      data: {
        status: string;
        active_incident_count: number;
        components: unknown[];
      };
    };

    expect(body.data).toMatchObject({
      status: "operational",
      active_incident_count: 1,
    });
    expect(body.data.components).toHaveLength(1);
  });

  it("redacts private components and raw telemetry locators from public incidents", async () => {
    const database = await ready();
    const response = await getIncident(
      new Request(`https://status.example/v1/incidents/${INCIDENT}`),
      context(database),
      CORRELATION,
      INCIDENT,
    );
    const text = await response.text();
    const body = JSON.parse(text) as {
      data: {
        affected_components: string[];
        evidence: Array<Record<string, unknown>>;
      };
    };

    expect(body.data.affected_components).toEqual(["api-public"]);
    expect(body.data.evidence).toEqual([
      {
        kind: "trace",
        count: 1,
        first_observed_at: CREATED,
        last_observed_at: CREATED,
      },
    ]);
    expect(text).not.toContain("api-private");
    expect(text).not.toContain("secret-locator");
    expect(text).not.toContain(DEPLOYMENT);
  });

  it("does not expose a private component through maintenance targets", async () => {
    const database = await ready();
    const request = new Request(
      "https://status.example/v1/maintenance-windows?from=2026-09-12T12%3A00%3A00.000Z",
    );
    const response = await listMaintenanceWindows(
      request,
      context(database),
      CORRELATION,
    );
    const body = (await response.json()) as {
      data: Array<{ target_components: string[] }>;
    };

    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.target_components).toEqual(["api-public"]);
  });

  it("keeps direct health separate from dependency risk", async () => {
    const database = await ready();
    const response = await getServiceStatus(
      new Request("https://status.example/v1/services/api"),
      context(database),
      CORRELATION,
      "api",
    );
    const body = (await response.json()) as {
      data: {
        direct_status: string;
        dependency_risk: { status: string };
        effective_impact: string;
      };
    };

    expect(body.data).toMatchObject({
      direct_status: "unknown",
      dependency_risk: { status: "none" },
      effective_impact: "unknown",
    });
  });

  it("computes dependency risk through the real cycle-safe Rust/Wasm core", async () => {
    const database = await ready();
    const statement = (sql: string, ...values: unknown[]) =>
      database.prepare(sql).bind(...values);
    await database.batch([
      statement(
        "INSERT INTO services(service_name,display_name,description,owner,criticality,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
        "database",
        "Database",
        "",
        "platform",
        "critical",
        1,
        CREATED,
        CREATED,
      ),
      statement(
        "INSERT INTO current_statuses(target_type,target_id,direct_status,dependency_risk,effective_impact,evaluated_at,fresh_until) VALUES('service',?,?,?,?,?,?)",
        "database",
        "major_outage",
        "none",
        "major_outage",
        CREATED,
        FRESH,
      ),
      statement(
        "INSERT INTO service_dependencies(source_service,target_service,capability,kind,criticality,created_at) VALUES(?,?,?,?,?,?)",
        "api",
        "database",
        "storage",
        "required",
        "critical",
        CREATED,
      ),
      statement(
        "INSERT INTO service_dependencies(source_service,target_service,capability,kind,criticality,created_at) VALUES(?,?,?,?,?,?)",
        "database",
        "api",
        "callback",
        "required",
        "critical",
        CREATED,
      ),
    ]);

    const response = await getServiceStatus(
      new Request("https://status.example/v1/services/api"),
      context(database),
      CORRELATION,
      "api",
    );
    const body = (await response.json()) as {
      data: {
        dependency_risk: {
          status: string;
          affected_capabilities: string[];
          dependency_count: number;
        };
        effective_impact: string;
      };
    };

    expect(body.data).toMatchObject({
      dependency_risk: {
        status: "major_outage",
        affected_capabilities: ["storage"],
        dependency_count: 1,
      },
      effective_impact: "major_outage",
    });
  });
});

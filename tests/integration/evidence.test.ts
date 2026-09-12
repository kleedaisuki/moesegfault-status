import { afterEach, describe, expect, it, vi } from "vitest";

import { queryTelemetryReference } from "../../workers/status/src/evidence/service.js";
import { createMigratedD1, type TestD1Database } from "./d1.js";

const CREATED = "2026-09-12T00:00:00.000Z";
const END = "2026-09-12T00:10:00.000Z";
const REFERENCE = "018f0000-0000-7000-8000-000000000001";
const DEPLOYMENT = "018f0000-0000-7000-8000-000000000002";
const CORRELATION = "018f0000-0000-7000-8000-000000000003";
const DIGEST = `sha256:${"a".repeat(64)}`;

/** 通过真实迁移模式写入一个可查询的 Loki reference / Seed one queryable Loki reference through the real migrated schema. */
async function seed(database: TestD1Database): Promise<void> {
  const statement = (sql: string, ...values: unknown[]) =>
    database.prepare(sql).bind(...values);
  await database.batch([
    statement(
      "INSERT INTO services(service_name,display_name,description,owner,criticality,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
      "api",
      "API",
      "API service",
      "platform",
      "critical",
      1,
      CREATED,
      CREATED,
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
      "a".repeat(40),
      "refs/heads/main",
      DIGEST,
      "github-actions",
      "1",
      CREATED,
      "manifests/api.json",
      DIGEST,
      "1",
      CREATED,
      "ci",
    ),
    statement(
      `INSERT INTO telemetry_backends(backend_name,capabilities_json,query_adapter,ui_url_template,
       retention_class,auth_reference,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`,
      "logs",
      '["log_query"]',
      "loki",
      "https://grafana.example/explore",
      "thirty-days",
      "LOKI_TOKEN",
      CREATED,
      CREATED,
    ),
    statement(
      `INSERT INTO telemetry_references(telemetry_reference_id,kind,backend_name,locator_json,
       range_start,range_end,service_name,deployment_id,correlation_id,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
      REFERENCE,
      "log_query",
      "logs",
      JSON.stringify({
        query: { service: "api", deployment_id: DEPLOYMENT },
      }),
      CREATED,
      END,
      "api",
      DEPLOYMENT,
      CORRELATION,
      CREATED,
    ),
  ]);
}

const principal = {
  subject: "viewer@example.com",
  email: "viewer@example.com",
  roles: ["viewer"] as const,
  authenticated_at: CREATED,
  access_application: "ops",
};

describe("evidence query D1 integration", () => {
  const opened: TestD1Database[] = [];
  afterEach(() => {
    for (const database of opened.splice(0)) database.close();
  });

  it("resolves only a registered ID, selects its capability and uses symbolic auth", async () => {
    const database = await createMigratedD1();
    opened.push(database);
    await seed(database);
    const outbound = vi.fn<typeof fetch>(async (input, init) => {
      expect(new URL(String(input)).hostname).toBe("loki.example");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer super-secret",
      );
      return Response.json({
        data: {
          result: [
            {
              stream: { service: "api" },
              values: [["1789171200000000000", "database unavailable"]],
            },
          ],
        },
      });
    });
    const result = await queryTelemetryReference(
      {
        DB: database as unknown as D1Database,
        TELEMETRY_BACKEND_CONFIG_JSON: JSON.stringify({
          logs: {
            endpoint: "https://loki.example",
            allowed_hosts: ["loki.example", "grafana.example"],
            auth_scheme: "bearer",
            timeout_ms: 500,
            max_response_bytes: 32_000,
          },
        }),
        TELEMETRY_AUTH_JSON: JSON.stringify({ LOKI_TOKEN: "super-secret" }),
      },
      {
        principal,
        correlation_id: CORRELATION,
        telemetry_reference_id: REFERENCE,
      },
      { fetch: outbound, now: () => new Date("2026-09-12T00:20:00.000Z") },
    );
    expect("data" in result && result.data.status).toBe("ok");
    expect("data" in result && result.data.records[0]?.title).toBe(
      "database unavailable",
    );
    expect(JSON.stringify(result)).not.toContain("super-secret");
  });

  it("rejects arbitrary locator URLs at the RPC schema boundary without outbound HTTP", async () => {
    const database = await createMigratedD1();
    opened.push(database);
    await seed(database);
    const outbound = vi.fn<typeof fetch>();
    const result = await queryTelemetryReference(
      { DB: database as unknown as D1Database },
      {
        principal,
        correlation_id: CORRELATION,
        telemetry_reference_id: REFERENCE,
        url: "https://169.254.169.254/latest/meta-data",
      },
      { fetch: outbound },
    );
    expect("problem" in result && result.problem.status).toBe(400);
    expect(outbound).not.toHaveBeenCalled();
  });

  it("returns not-found for an unknown UUID rather than treating it as a URL", async () => {
    const database = await createMigratedD1();
    opened.push(database);
    const result = await queryTelemetryReference(
      { DB: database as unknown as D1Database },
      {
        principal,
        correlation_id: CORRELATION,
        telemetry_reference_id: "018f0000-0000-7000-8000-000000000099",
      },
    );
    expect("problem" in result && result.problem.status).toBe(404);
  });

  it("reports expiry before configuration or HTTP access", async () => {
    const database = await createMigratedD1();
    opened.push(database);
    await seed(database);
    await database
      .prepare(
        `INSERT INTO telemetry_references(telemetry_reference_id,kind,backend_name,locator_json,
         range_start,range_end,service_name,deployment_id,expires_at,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        "018f0000-0000-7000-8000-000000000004",
        "log_query",
        "logs",
        JSON.stringify({
          query: { service: "api", deployment_id: DEPLOYMENT },
        }),
        CREATED,
        END,
        "api",
        DEPLOYMENT,
        END,
        CREATED,
      )
      .run();
    const outbound = vi.fn<typeof fetch>();
    const result = await queryTelemetryReference(
      { DB: database as unknown as D1Database },
      {
        principal,
        correlation_id: CORRELATION,
        telemetry_reference_id: "018f0000-0000-7000-8000-000000000004",
      },
      { fetch: outbound, now: () => new Date("2026-09-12T00:20:00.000Z") },
    );
    expect("data" in result && result.data.status).toBe("expired");
    expect(outbound).not.toHaveBeenCalled();
  });
});

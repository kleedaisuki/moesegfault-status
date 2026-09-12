import { describe, expect, it } from "vitest";
import { signCursor, verifyCursor } from "./cursor.js";
import { freshStatus } from "./data.js";
import { publicSelfLink } from "./http.js";
import {
  handlePublic,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  type D1QueryResult,
} from "./index.js";

const NOW = new Date("2026-09-12T12:00:00.000Z");
const INCIDENT_ID = "0199d0a8-2e12-7a59-a51e-44aa9b6d1001";
const MAINTENANCE_ID = "0199d0a8-2e12-7a59-a51e-44aa9b6d1002";
const CORRELATION_ID = "0199d0a8-2e12-7a59-a51e-44aa9b6d1003";

class FixtureStatement implements D1PreparedStatementLike {
  public constructor(
    private readonly database: FixtureDatabase,
    private readonly sql: string,
    private readonly values: readonly unknown[] = [],
  ) {}

  /** 记录位置绑定。 / Record positional bindings. */
  public bind(...values: unknown[]): D1PreparedStatementLike {
    return new FixtureStatement(this.database, this.sql, values);
  }

  /** 返回 fixture 行。 / Return fixture rows. */
  public async all<Row>(): Promise<D1QueryResult<Row>> {
    return {
      success: true,
      results: this.database.rows(this.sql, this.values) as Row[],
    };
  }

  /** 返回首行 fixture。 / Return the first fixture row. */
  public async first<Row>(): Promise<Row | null> {
    return (
      (this.database.rows(this.sql, this.values)[0] as Row | undefined) ?? null
    );
  }
}

class FixtureDatabase implements D1DatabaseLike {
  /** 保留 SQL，便于证明使用 keyset 且未投影隐私列。 / Retain SQL to prove keyset use and privacy-safe projections. */
  public readonly queries: string[] = [];

  /** 创建 fixture statement。 / Create a fixture statement. */
  public prepare(sql: string): D1PreparedStatementLike {
    this.queries.push(sql);
    return new FixtureStatement(this, sql);
  }

  /** 为六个路由提供最小可公开数据。 / Supply the minimum public data for all six routes. */
  public rows(sql: string, values: readonly unknown[]): unknown[] {
    if (sql.includes("SELECT 'service' AS kind")) {
      const services = [
        {
          service_name: "identity",
          target_id: "identity",
          display_name: "Identity",
          description: "Authentication",
          direct_status: "operational",
          effective_impact: "operational",
          evaluated_at: "2026-09-12T11:59:00.000Z",
          fresh_until: "2026-09-12T12:01:00.000Z",
          fallback_at: "2026-09-12T09:00:00.000Z",
        },
        {
          service_name: "database",
          target_id: "database",
          display_name: "Database",
          description: "",
          direct_status: "major_outage",
          effective_impact: "major_outage",
          evaluated_at: "2026-09-12T11:59:00.000Z",
          fresh_until: "2026-09-12T12:01:00.000Z",
          fallback_at: "2026-09-12T09:00:00.000Z",
        },
      ];
      return [
        ...services.map((value) => ({
          kind: "service",
          payload: JSON.stringify(value),
        })),
        {
          kind: "component",
          payload: JSON.stringify({
            service_name: "identity",
            target_id: "login",
            display_name: "Login",
            sort_order: 0,
            direct_status: "operational",
            effective_impact: "operational",
            evaluated_at: "2026-09-12T10:00:00.000Z",
            fresh_until: "2026-09-12T10:02:00.000Z",
            fallback_at: "2026-09-12T09:00:00.000Z",
          }),
        },
        {
          kind: "dependency",
          payload: JSON.stringify({
            source_service: "identity",
            target_service: "database",
            capability: "login",
            kind: "required",
            criticality: "high",
          }),
        },
        {
          kind: "dependency",
          payload: JSON.stringify({
            source_service: "database",
            target_service: "identity",
            capability: "storage",
            kind: "required",
            criticality: "critical",
          }),
        },
      ];
    }
    if (sql.includes("COUNT(*) AS count")) return [{ count: 1 }];
    if (
      sql.includes("FROM components AS c") &&
      !sql.includes("c.service_name IN")
    ) {
      return [
        {
          target_id: "login",
          display_name: "Login",
          direct_status: "operational",
          effective_impact: "operational",
          evaluated_at: "2026-09-12T10:00:00.000Z",
          fresh_until: "2026-09-12T10:02:00.000Z",
          fallback_at: "2026-09-12T09:00:00.000Z",
        },
      ];
    }
    if (
      sql.includes("FROM services AS s") &&
      sql.includes("s.description AS description")
    ) {
      return [
        {
          service_name: "identity",
          target_id: "identity",
          display_name: "Identity",
          description: "Authentication",
          direct_status: "operational",
          effective_impact: "operational",
          evaluated_at: "2026-09-12T11:59:00.000Z",
          fresh_until: "2026-09-12T12:01:00.000Z",
          fallback_at: "2026-09-12T09:00:00.000Z",
        },
      ];
    }
    if (sql.includes("c.service_name IN")) {
      return [
        {
          service_name: "identity",
          target_id: "login",
          display_name: "Login",
          direct_status: "operational",
          effective_impact: "operational",
          evaluated_at: "2026-09-12T11:59:00.000Z",
          fresh_until: "2026-09-12T12:01:00.000Z",
          fallback_at: "2026-09-12T09:00:00.000Z",
        },
      ];
    }
    if (sql.includes("FROM incident_services AS relation"))
      return [{ incident_id: INCIDENT_ID }];
    if (
      sql.includes("cs.direct_status AS direct_status") &&
      sql.includes("ORDER BY s.service_name")
    ) {
      return [
        {
          service_name: "identity",
          direct_status: "operational",
          fresh_until: "2026-09-12T12:01:00.000Z",
        },
        {
          service_name: "database",
          direct_status: "major_outage",
          fresh_until: "2026-09-12T12:01:00.000Z",
        },
      ];
    }
    if (sql.includes("FROM service_dependencies AS dependency")) {
      return [
        {
          source_service: "identity",
          target_service: "database",
          capability: "login",
          kind: "required",
          criticality: "high",
        },
        {
          source_service: "database",
          target_service: "identity",
          capability: "storage",
          kind: "data",
          criticality: "critical",
        },
      ];
    }
    if (sql.includes("FROM incident_current AS ic")) {
      return [
        {
          incident_id: INCIDENT_ID,
          title: "Login failures",
          state: "investigating",
          impact: "partial_outage",
          started_at: "2026-09-12T11:30:00.000Z",
          detected_at: "2026-09-12T11:31:00.000Z",
          resolved_at: null,
          revision: 1,
          public_message: "We are investigating.",
          updated_at: "2026-09-12T11:32:00.000Z",
          cause: null,
        },
      ];
    }
    if (sql.includes("FROM incident_components AS relation"))
      return [{ incident_id: INCIDENT_ID, component_id: "login" }];
    if (sql.includes("FROM incident_updates")) {
      return [
        {
          sequence: 1,
          state: "investigating",
          impact: "partial_outage",
          public_message: "We are investigating.",
          occurred_at: "2026-09-12T11:32:00.000Z",
        },
      ];
    }
    if (sql.includes("FROM incident_telemetry_references AS link")) {
      return [
        {
          kind: "trace",
          evidence_count: 2,
          first_observed_at: "2026-09-12T11:30:00.000Z",
          last_observed_at: "2026-09-12T11:31:00.000Z",
        },
      ];
    }
    if (sql.includes("FROM maintenance_windows AS mw")) {
      return [
        {
          maintenance_id: MAINTENANCE_ID,
          title: "Database migration",
          description: "Planned migration",
          expected_impact: "degraded",
          starts_at: "2026-09-12T13:00:00.000Z",
          ends_at: "2026-09-12T14:00:00.000Z",
          state: "scheduled",
        },
      ];
    }
    if (sql.includes("FROM maintenance_targets AS mt")) {
      expect(values).toContain(MAINTENANCE_ID);
      return [
        {
          maintenance_id: MAINTENANCE_ID,
          target_type: "service",
          target_id: "identity",
        },
        {
          maintenance_id: MAINTENANCE_ID,
          target_type: "component",
          target_id: "login",
        },
      ];
    }
    return [];
  }
}

function context(database: FixtureDatabase) {
  return {
    DB: database,
    cursorSecret: "unit-test-cursor-secret",
    correlationId: CORRELATION_ID,
    now: () => NOW,
    dependencyCore: {
      dispatchJson(requestJson: string): string {
        const request = JSON.parse(requestJson) as {
          payload: {
            source_service: string;
            graph: { dependencies: unknown[] };
          };
        };
        expect(request.payload.graph.dependencies).toHaveLength(2);
        if (request.payload.source_service === "database")
          return JSON.stringify({
            source_service: "database",
            status: "operational",
            contributors: [],
          });
        return JSON.stringify({
          source_service: "identity",
          status: "partial_outage",
          contributors: [
            {
              root_capability: "login",
              service_name: "database",
              direct_status: "major_outage",
              risk_status: "partial_outage",
              path: ["identity", "database"],
            },
          ],
        });
      },
    },
  } as const;
}

describe("public GET API", () => {
  it("routes all six reads, marks stale platform evidence unknown, and redacts private material", async () => {
    const database = new FixtureDatabase();
    const paths = [
      "/v1/status",
      "/v1/services",
      "/v1/services/identity",
      "/v1/incidents",
      `/v1/incidents/${INCIDENT_ID}`,
      "/v1/maintenance-windows",
    ];
    const responses = await Promise.all(
      paths.map((path) =>
        handlePublic(
          new Request(`https://status.moesegfault.dev${path}`),
          context(database),
        ),
      ),
    );
    expect(responses.every((response) => response?.status === 200)).toBe(true);
    const payloads = await Promise.all(
      responses.map((response) => response!.text()),
    );
    expect(JSON.parse(payloads[0]!).data.status).toBe("unknown");
    expect(JSON.parse(payloads[2]!).data).toMatchObject({
      direct_status: "operational",
      dependency_risk: {
        status: "partial_outage",
        affected_capabilities: ["login"],
        dependency_count: 1,
      },
      effective_impact: "partial_outage",
    });
    expect(JSON.parse(payloads[4]!).data.evidence).toEqual([
      {
        kind: "trace",
        count: 2,
        first_observed_at: "2026-09-12T11:30:00.000Z",
        last_observed_at: "2026-09-12T11:31:00.000Z",
      },
    ]);
    expect(JSON.parse(payloads[5]!).data[0]).toMatchObject({
      target_services: ["identity"],
      target_components: ["login"],
    });
    const serialized = payloads.join("\n");
    for (const forbidden of [
      "instance_id",
      "locator_json",
      "backend_name",
      "created_by",
      "actor_subject",
      "repository_url",
      "object_key",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("returns undefined for non-public or non-GET routes", async () => {
    const database = new FixtureDatabase();
    await expect(
      handlePublic(
        new Request("https://status.moesegfault.dev/v1/status", {
          method: "POST",
        }),
        context(database),
      ),
    ).resolves.toBeUndefined();
    await expect(
      handlePublic(
        new Request("https://status.moesegfault.dev/private"),
        context(database),
      ),
    ).resolves.toBeUndefined();
  });

  it("builds self links from the trusted canonical origin rather than local workerd or Host", async () => {
    const database = new FixtureDatabase();
    const response = await handlePublic(
      new Request("http://127.0.0.1:8787/v1/status", {
        headers: { host: "attacker.invalid" },
      }),
      context(database),
    );
    expect(response?.status).toBe(200);
    const body = (await response!.json()) as { links: { self: string } };
    expect(body.links.self).toBe("https://status.moesegfault.dev/v1/status");
    expect(
      publicSelfLink(
        new Request(
          "http://127.0.0.1:8787//attacker.invalid/status?view=public",
        ),
      ),
    ).toBe(
      "https://status.moesegfault.dev//attacker.invalid/status?view=public",
    );
  });

  it("rejects unknown query parameters with RFC 9457 and a generated ingress-independent correlation id", async () => {
    const database = new FixtureDatabase();
    const configured = context(database);
    const response = await handlePublic(
      new Request("https://status.moesegfault.dev/v1/services?offset=10", {
        headers: { "x-moesegfault-correlation-id": INCIDENT_ID },
      }),
      {
        DB: configured.DB,
        cursorSecret: configured.cursorSecret,
        now: configured.now,
        dependencyCore: configured.dependencyCore,
      },
    );
    expect(response?.status).toBe(400);
    const body = (await response!.json()) as { correlation_id: string };
    expect(body.correlation_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/u);
    expect(body.correlation_id).not.toBe(INCIDENT_ID);
  });
});

describe("opaque keyset cursor", () => {
  it("authenticates route/filter/sort and expires", async () => {
    const secret = "unit-test-cursor-secret";
    const binding = {
      route: "/v1/incidents",
      query: "states=resolved",
      sort: "started_at:desc,incident_id:desc",
    };
    const cursor = await signCursor(
      {
        ...binding,
        key: { started_at: NOW.toISOString(), incident_id: INCIDENT_ID },
      },
      secret,
      NOW,
    );
    await expect(
      verifyCursor(cursor, binding, secret, new Date(NOW.getTime() + 60_000)),
    ).resolves.toEqual({
      started_at: NOW.toISOString(),
      incident_id: INCIDENT_ID,
    });
    await expect(
      verifyCursor(
        cursor,
        { ...binding, query: "states=monitoring" },
        secret,
        NOW,
      ),
    ).rejects.toThrow("Invalid");
    await expect(
      verifyCursor(
        cursor,
        binding,
        secret,
        new Date(NOW.getTime() + 16 * 60_000),
      ),
    ).rejects.toThrow("expired");
  });
});

describe("freshness semantics", () => {
  it("turns stale green evidence unknown but retains a stronger demonstrated failure", () => {
    expect(freshStatus("operational", "2026-09-12T11:59:59.000Z", NOW)).toBe(
      "unknown",
    );
    expect(freshStatus("major_outage", "2026-09-12T11:59:59.000Z", NOW)).toBe(
      "major_outage",
    );
    expect(freshStatus("operational", null, NOW)).toBe("unknown");
  });
});

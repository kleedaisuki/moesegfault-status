import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { readFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import {
  PublicIncidentListResponseSchema,
  PublicIncidentResponseSchema,
  PublicMaintenanceWindowListResponseSchema,
  PlatformStatusResponseSchema,
  PublicServiceListResponseSchema,
  PublicServiceStatusResponseSchema,
} from "../../packages/contracts/src/public.js";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

const issuer = "https://rust-runtime.cloudflareaccess.com";
const audience = "a".repeat(64);
const maintenanceClock = Date.parse("2026-09-12T08:00:00.123Z");
let mf: Miniflare;
const privateKeys = new Map<string, KeyObject>();

/** 用独立 Node 密码学实现生成真实签名。 / Produce real signatures using independent Node cryptography. */
function token(
  changes: Record<string, unknown> = {},
  access = false,
  alg = "RS256",
  kid = alg,
) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: issuer,
    aud: audience,
    sub: access ? "runtime-human" : "runtime-ci",
    iat: now,
    exp: now + 300,
    jti: "runtime-id",
    service_name: "identity",
    environment: "production",
    deployment_id: "0199d0a8-2e12-7a59-a51e-000000000001",
    scope: "diagnostics:write",
    nbf: now,
    email: "human@example.com",
    type: "app",
    identity_nonce: "nonce",
    ...changes,
  };
  const input = [{ alg, kid }, claims]
    .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
    .join(".");
  return `${input}.${sign(alg === "EdDSA" ? null : "sha256", Buffer.from(input), { key: privateKeys.get(alg)!, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

beforeAll(async () => {
  const jwks = ["RS256", "ES256", "EdDSA"].map((alg) => {
    const pair =
      alg === "RS256"
        ? generateKeyPairSync("rsa", { modulusLength: 2048 })
        : alg === "ES256"
          ? generateKeyPairSync("ec", { namedCurve: "P-256" })
          : generateKeyPairSync("ed25519");
    privateKeys.set(alg, pair.privateKey);
    return {
      ...pair.publicKey.export({ format: "jwk" }),
      kid: alg,
      alg,
      use: "sig",
    };
  });
  mf = new Miniflare({
    workers: [
      {
        config: {
          type: "worker",
          name: "rust",
          compatibilityDate: "2026-09-12",
          manifest: {
            mainModule: "index.js",
            modules: {
              "index.js": {
                type: "esm",
                contents: await readFile(
                  "tests/rust-runtime/build/index.js",
                  "utf8",
                ),
              },
              "index_bg.wasm": {
                type: "wasm",
                contents: await readFile(
                  "tests/rust-runtime/build/index_bg.wasm",
                ),
              },
            },
          },
          env: {
            ISSUER: { type: "json", value: issuer },
            AUDIENCE: { type: "json", value: audience },
            DB: { type: "d1", id: "rust-backend-runtime" },
          },
        },
        dev: { outboundService: { type: "worker", worker: "jwks" } },
      },
      {
        config: {
          type: "worker",
          name: "jwks",
          compatibilityDate: "2026-09-12",
          manifest: {
            mainModule: "jwks.mjs",
            modules: {
              "jwks.mjs": {
                type: "esm",
                contents: `let count=0; export default {fetch(r){const u=new URL(r.url);if(u.pathname==='/count')return Response.json({count});if(u.origin!==${JSON.stringify(issuer)}||!['/jwks','/cdn-cgi/access/certs'].includes(u.pathname))return new Response('denied',{status:403});count++;return Response.json({keys:${JSON.stringify(jwks)}});}}`,
              },
            },
          },
        },
      },
    ],
  });
  await seedIncidents();
}, 60_000);
afterAll(async () => {
  await mf?.dispose();
});

describe("Rust backend in actual workerd", () => {
  it("does not manufacture health from missing service evidence", async () => {
    const response = await mf.dispatchFetch(
      "https://status.example/v1/services/api",
      { headers: { "x-runtime-now": String(maintenanceClock) } },
    );
    expect(response.status).toBe(200);
    const body = PublicServiceStatusResponseSchema.parse(await response.json());
    expect(body.data.direct_status).toBe("unknown");
    expect(body.data.effective_impact).toBe("unknown");
    expect(body.data.components.map((c) => c.id)).toEqual(["public-api"]);
  });
  it("recomputes cyclic dependency and support impact directly in Rust", async () => {
    const db = await mf.getD1Database("DB", "rust");
    const now = new Date(maintenanceClock).toISOString();
    const later = new Date(maintenanceClock + 300_000).toISOString();
    const dependencyDeadline = new Date(
      maintenanceClock + 120_000,
    ).toISOString();
    await db
      .prepare(
        "INSERT INTO services(service_name,display_name,owner,criticality,created_at,updated_at) VALUES('upstream','Upstream','private-actor','critical',?,?)",
      )
      .bind(now, now)
      .run();
    for (const [kind, id, state, deadline] of [
      ["service", "api", "operational", later],
      ["service", "upstream", "major_outage", dependencyDeadline],
      ["component", "public-api", "operational", later],
    ]) {
      await db
        .prepare(
          "INSERT INTO current_statuses(target_type,target_id,direct_status,effective_impact,evaluated_at,fresh_until) VALUES(?,?,?,'operational',?,?)",
        )
        .bind(kind, id, state, now, deadline)
        .run();
    }
    await db
      .prepare(
        "INSERT INTO service_dependencies(source_service,target_service,capability,kind,criticality,created_at) VALUES('api','upstream','requests','required','critical',?),('upstream','api','reverse','required','critical',?)",
      )
      .bind(now, now)
      .run();
    await db
      .prepare(
        "INSERT INTO component_services(component_id,service_name,role,created_at) VALUES('public-api','upstream','supporting',?)",
      )
      .bind(now)
      .run();
    const headers = { "x-runtime-now": String(maintenanceClock) };
    const response = await mf.dispatchFetch(
      "https://status.example/v1/services/api",
      { headers },
    );
    const body = PublicServiceStatusResponseSchema.parse(await response.json());
    expect(body.data.direct_status).toBe("operational");
    expect(body.data.dependency_risk).toEqual({
      status: "major_outage",
      affected_capabilities: ["requests"],
      dependency_count: 1,
    });
    expect(body.data.effective_impact).toBe("major_outage");
    expect(body.data.fresh_until).toBe(dependencyDeadline);
    expect(body.data.components[0].status).toBe("major_outage");
    const platform = PlatformStatusResponseSchema.parse(
      await (
        await mf.dispatchFetch("https://status.example/v1/status", { headers })
      ).json(),
    );
    expect(platform.data.status).toBe("major_outage");
    expect(platform.data.active_incident_count).toBe(2);
    const first = PublicServiceListResponseSchema.parse(
      await (
        await mf.dispatchFetch("https://status.example/v1/services?limit=1", {
          headers,
        })
      ).json(),
    );
    expect(first.data[0].service_name).toBe("api");
    const next = PublicServiceListResponseSchema.parse(
      await (
        await mf.dispatchFetch(
          `https://status.example/v1/services?limit=1&cursor=${encodeURIComponent(first.page.next_cursor!)}`,
          { headers },
        )
      ).json(),
    );
    expect(next.data[0].service_name).toBe("upstream");
    expect(next.page.next_cursor).toBeNull();
    const stale = PublicServiceStatusResponseSchema.parse(
      await (
        await mf.dispatchFetch("https://status.example/v1/services/api", {
          headers: { "x-runtime-now": String(maintenanceClock + 400_000) },
        })
      ).json(),
    );
    expect(stale.data.direct_status).toBe("unknown");
    expect(stale.data.effective_impact).toBe("major_outage");
  });
  it("preserves locale-sensitive public component ordering", async () => {
    const db = await mf.getD1Database("DB", "rust");
    const now = new Date(maintenanceClock).toISOString();
    for (const id of ["component-B", "component-ä", "component-a"]) {
      await db
        .prepare(
          "INSERT INTO components(component_id,service_name,display_name,created_at,updated_at) VALUES(?,'api',?,?,?)",
        )
        .bind(id, id, now, now)
        .run();
    }
    const response = await mf.dispatchFetch(
      "https://status.example/v1/services/api",
      { headers: { "x-runtime-now": String(maintenanceClock) } },
    );
    const body = PublicServiceStatusResponseSchema.parse(await response.json());
    expect(body.data.components.map((c) => c.id)).toEqual([
      "component-a",
      "component-ä",
      "component-B",
      "public-api",
    ]);
  });
  it("pins maintenance scan time across pages and filters private targets", async () => {
    const path = "https://status.example/v1/maintenance-windows";
    const first = await mf.dispatchFetch(`${path}?limit=1`, {
      headers: { "x-runtime-now": String(maintenanceClock) },
    });
    expect(first.status).toBe(200);
    const body = PublicMaintenanceWindowListResponseSchema.parse(
      await first.json(),
    );
    expect(body.data).toHaveLength(1);
    expect(body.data[0].target_services).toEqual(["api"]);
    expect(body.data[0].target_components).toEqual(["public-api"]);
    const next = await mf.dispatchFetch(
      `${path}?limit=1&cursor=${encodeURIComponent(body.page.next_cursor!)}`,
      { headers: { "x-runtime-now": String(maintenanceClock + 60_000) } },
    );
    const page = PublicMaintenanceWindowListResponseSchema.parse(
      await next.json(),
    );
    expect(page.data).toHaveLength(1);
    expect(page.data[0].maintenance_id).not.toBe(body.data[0].maintenance_id);
    expect(page.page.next_cursor).toBeNull();
    const fresh = await mf.dispatchFetch(path, {
      headers: { "x-runtime-now": String(maintenanceClock + 60_000) },
    });
    expect(
      PublicMaintenanceWindowListResponseSchema.parse(await fresh.json()).data,
    ).toEqual([]);
    const replay = await mf.dispatchFetch(
      `${path}?from=2026-09-12T08:00:00.123Z&cursor=${encodeURIComponent(body.page.next_cursor!)}`,
      { headers: { "x-runtime-now": String(maintenanceClock) } },
    );
    expect(replay.status).toBe(400);
  });
  it("rejects invalid maintenance ranges and repeated parameters", async () => {
    for (const query of [
      "from=bad",
      "from=2026-09-12T08:00:00%2B00:00",
      "from=2026-09-13T08:00:00Z&to=2026-09-12T08:00:00Z",
      "limit=1&limit=2",
      "unknown=1",
    ]) {
      expect(
        (
          await mf.dispatchFetch(
            `https://status.example/v1/maintenance-windows?${query}`,
          )
        ).status,
      ).toBe(400);
    }
  });
  it("serves public incidents with existing schemas, redaction and signed pagination", async () => {
    const first = await mf.dispatchFetch(
      "https://untrusted.example/v1/incidents?limit=1",
    );
    expect(first.status).toBe(200);
    const body = PublicIncidentListResponseSchema.parse(await first.json());
    expect(body.data).toHaveLength(1);
    expect(body.links.self).toBe(
      "https://status.moesegfault.dev/v1/incidents?limit=1",
    );
    expect(body.page.next_cursor).not.toBeNull();
    const next = await mf.dispatchFetch(
      `https://status.example/v1/incidents?limit=1&cursor=${encodeURIComponent(body.page.next_cursor!)}`,
    );
    const second = PublicIncidentListResponseSchema.parse(await next.json());
    expect(second.data[0].incident_id).not.toBe(body.data[0].incident_id);
    expect(second.page.next_cursor).toBeNull();
    const detail = await mf.dispatchFetch(
      `https://status.example/v1/incidents/${body.data[0].incident_id}`,
    );
    const incident = PublicIncidentResponseSchema.parse(await detail.json());
    expect(incident.data.affected_components).toEqual(["public-api"]);
    expect(incident.data.updates).toHaveLength(1);
    expect(JSON.stringify(incident)).not.toContain("private-actor");
    expect(JSON.stringify(incident)).not.toContain("private-api");
    const replay = await mf.dispatchFetch(
      `https://status.example/v1/incidents?states=resolved&cursor=${encodeURIComponent(body.page.next_cursor!)}`,
    );
    expect(replay.status).toBe(400);
  });
  it("rejects invalid incident queries and returns safe missing-record problems", async () => {
    for (const path of [
      "/v1/incidents?limit=01",
      "/v1/incidents?limit=1&limit=2",
      "/v1/incidents?states=unknown",
      "/v1/incidents?private=true",
      "/v1/incidents/not-a-uuid",
    ]) {
      const response = await mf.dispatchFetch(`https://status.example${path}`);
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    const missing = await mf.dispatchFetch(
      "https://status.example/v1/incidents/0199d0a8-2e12-7a59-a51e-000000009999",
    );
    expect(missing.status).toBe(404);
  });
  it("rolls back every write when a Rust D1 batch fails", async () => {
    const response = await mf.dispatchFetch(
      "https://status.example/database/rollback",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ failed: true, row: { count: 0 } });
  });
  it("returns row decode errors without poisoning the Rust isolate", async () => {
    const response = await mf.dispatchFetch(
      "https://status.example/database/row-error",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ failed: true, count: 7 });
  });
  it("binds null, text, safe integers and blobs without interpolation", async () => {
    const response = await mf.dispatchFetch(
      "https://status.example/database/values",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      rows: [
        {
          missing: null,
          text: "'; DROP TABLE services; --",
          integer: Number.MAX_SAFE_INTEGER,
          boolean: 1,
          blob: "00FF",
        },
      ],
    });
  });
  it("fetches pinned keys and reuses cache for machine requests", async () => {
    for (const alg of ["RS256", "ES256", "EdDSA", "RS256"]) {
      const response = await mf.dispatchFetch(
        "https://status.example/machine",
        { headers: { authorization: `Bearer ${token({}, false, alg)}` } },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ subject: "runtime-ci" });
    }
    const keyWorker = await mf.getWorker("jwks");
    expect(await (await keyWorker.fetch(`${issuer}/count`)).json()).toEqual({
      count: 1,
    });
  });
  it("does not refetch for an attacker-controlled unknown kid during cooldown", async () => {
    const response = await mf.dispatchFetch("https://status.example/machine", {
      headers: {
        authorization: `Bearer ${token({}, false, "RS256", "unknown")}`,
      },
    });
    expect(response.status).toBe(401);
    const keyWorker = await mf.getWorker("jwks");
    expect(await (await keyWorker.fetch(`${issuer}/count`)).json()).toEqual({
      count: 1,
    });
  });
  it("rejects bad audience, expired tokens, missing tokens, and missing scopes", async () => {
    for (const [changes, expected] of [
      [{ aud: "other" }, 401],
      [{ exp: 1 }, 401],
      [{ scope: "other:scope" }, 403],
    ] as const) {
      const response = await mf.dispatchFetch(
        "https://status.example/machine",
        { headers: { authorization: `Bearer ${token(changes)}` } },
      );
      expect(response.status).toBe(expected);
    }
    expect(
      (await mf.dispatchFetch("https://status.example/machine")).status,
    ).toBe(401);
  });
  it("verifies Access and maps roles from trusted configuration", async () => {
    const response = await mf.dispatchFetch("https://status.example/access", {
      headers: { "cf-access-jwt-assertion": token({}, true) },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      subject: "runtime-human",
      roles: ["operator"],
      access_application: audience,
    });
  });
  it("reads bounded JSON through the Rust SDK stream", async () => {
    const options = {
      method: "POST",
      headers: { "content-type": "application/json" },
    };
    expect(
      (
        await mf.dispatchFetch("https://status.example/json", {
          ...options,
          body: '{"x":1}',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await mf.dispatchFetch("https://status.example/json", {
          ...options,
          body: JSON.stringify({ x: "x".repeat(17) }),
        })
      ).status,
    ).toBe(413);
  });
});

/** 在真实 D1 中应用全部迁移及公开/私有组件夹具。 / Apply all migrations and public/private component fixtures in real D1. */
async function seedIncidents() {
  const db = await mf.getD1Database("DB", "rust");
  for (const name of (await readdir("migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    const statements: string[] = JSON.parse(
      execFileSync("python", ["tests/runtime/split_sql.py"], {
        input: await readFile(`migrations/${name}`, "utf8"),
        encoding: "utf8",
        windowsHide: true,
      }),
    );
    await db.batch(statements.map((sql) => db.prepare(sql)));
  }
  const now = "2026-09-12T08:00:00.000Z";
  await db
    .prepare(
      "INSERT INTO services(service_name,display_name,owner,criticality,created_at,updated_at) VALUES('api','API','private-actor','high',?,?)",
    )
    .bind(now, now)
    .run();
  for (const [id, visibility] of [
    ["public-api", 1],
    ["private-api", 0],
  ] as const) {
    await db
      .prepare(
        "INSERT INTO components(component_id,service_name,display_name,public,created_at,updated_at) VALUES(?,'api',?,?,?,?)",
      )
      .bind(id, id, visibility, now, now)
      .run();
  }
  for (let index = 1; index <= 2; index++) {
    const id = `0199d0a8-2e12-7a59-a51e-${String(index).padStart(12, "0")}`;
    const update = `0199d0a8-2e12-7a59-a51e-${String(index + 10).padStart(12, "0")}`;
    await db
      .prepare(
        "INSERT INTO incidents(incident_id,started_at,detected_at,created_at,created_by) VALUES(?,?,?,?,?)",
      )
      .bind(id, now, now, now, "private-actor")
      .run();
    await db
      .prepare(
        "INSERT INTO incident_updates(update_id,incident_id,sequence,title,state,impact,public_message,actor_subject,occurred_at) VALUES(?,?,1,'Example incident','investigating','degraded','Investigating','private-actor',?)",
      )
      .bind(update, id, now)
      .run();
    for (const component of ["public-api", "private-api"]) {
      await db
        .prepare(
          "INSERT INTO incident_component_relations(incident_id,component_id,update_sequence,action) VALUES(?,?,1,'added')",
        )
        .bind(id, component)
        .run();
    }
  }
  for (let index = 1; index <= 2; index++) {
    const id = `0199d0a8-2e12-7a59-a51e-${String(index + 100).padStart(12, "0")}`;
    await db
      .prepare(
        "INSERT INTO maintenance_windows(maintenance_id,title,description,expected_impact,starts_at,ends_at,created_by,created_at,updated_at) VALUES(?,'Maintenance','Planned work','degraded',?,?,'private-actor',?,?)",
      )
      .bind(
        id,
        new Date(maintenanceClock - 60_000).toISOString(),
        new Date(maintenanceClock + 30_000).toISOString(),
        now,
        now,
      )
      .run();
    for (const [kind, target] of [
      ["service", "api"],
      ["component", "public-api"],
      ["component", "private-api"],
    ]) {
      await db
        .prepare(
          "INSERT INTO maintenance_targets(maintenance_id,target_type,target_id) VALUES(?,?,?)",
        )
        .bind(id, kind, target)
        .run();
    }
  }
}

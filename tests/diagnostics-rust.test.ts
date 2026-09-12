import { beforeAll, afterAll, it, expect } from "vitest";
import { Miniflare } from "miniflare";
import { readFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
let mf: Miniflare;
const time = "2026-09-12T08:00:00.000Z";
/** 测试UUID，无生产身份生成。 / Fixture UUID, not production identity generation. */
const id = (n: number) =>
  `0199d0a8-2e12-7a59-a51e-${n.toString(16).padStart(12, "0")}`;
/** 构造可信Queue信封。 / Construct a trusted Queue envelope fixture. */
function envelope(n: number, signal = "fault", recovery?: number) {
  return {
    schema_version: "1.0",
    message_id: id(n + 1000),
    received_at: time,
    producer: {
      subject: "test-ci",
      service_name: "api",
      environment: "production",
      deployment_id: id(1),
      scopes: ["diagnostics:write"],
      token_id: "ci-token",
      auth_method: "jwt",
    },
    trace_context: { correlation_id: id(2) },
    event: {
      schema_version: "1.0",
      event_id: id(n),
      service_name: "api",
      environment: "production",
      deployment_id: id(1),
      kind: "dependency.failure",
      signal,
      ...(recovery ? { recovery_of_event_id: id(recovery) } : {}),
      severity: "error",
      occurred_at: new Date(Date.parse(time) + n * 1000).toISOString(),
      correlation_id: id(2),
      summary: "Dependency failed",
      fingerprint: { dependency: "database" },
      evidence: [
        {
          kind: "trace",
          backend: "tempo",
          locator: { trace_id: "1".repeat(32) },
        },
      ],
      attributes: {},
    },
  };
}
/** 仅调用真实Rust驱动，不模拟业务逻辑。 / Invoke the actual Rust driver, never mock business logic. */
async function submit(value: unknown) {
  return mf.dispatchFetch("https://status.test/__test/diagnostics", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
}
beforeAll(async () => {
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
            DB: { type: "d1", id: "rust-diagnostics" },
            ENVIRONMENT: { type: "json", value: "development" },
          },
        },
      },
    ],
  });
  const db = await mf.getD1Database("DB", "rust");
  for (const name of (await readdir("migrations"))
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    const statements: string[] = JSON.parse(
      execFileSync("python", ["tests/runtime/split_sql.py"], {
        input: await readFile(`migrations/${name}`, "utf8"),
        encoding: "utf8",
        windowsHide: true,
      }),
    );
    for (const statement of statements) await db.prepare(statement).run();
  }
  const statements = [
    db
      .prepare(
        "INSERT INTO services(service_name,display_name,owner,criticality,created_at,updated_at) VALUES('api','API','platform','high',?,?)",
      )
      .bind(time, time),
    db
      .prepare(
        "INSERT INTO evaluation_policies(policy_id,revision,schema_version,name,observation_window_seconds,minimum_samples,failure_threshold,recovery_threshold,stale_after_seconds,location_quorum,fingerprint_template_json,status_mapping_json,diagnostic_rules_json,created_by,created_at) VALUES('diagnostic',1,'1.0','Diagnostic',300,1,0.5,0.9,120,1,'{}','{}',?,'system',?)",
      )
      .bind(
        JSON.stringify({
          minimum_occurrences: 1,
          recovery_min_occurrences: 2,
          status_by_severity: {
            info: "degraded",
            warning: "degraded",
            error: "degraded",
            critical: "major_outage",
          },
        }),
        time,
      ),
    db
      .prepare(
        "INSERT INTO data_retention_policies(policy_id,revision,occurrence_retention_days,cleanup_batch_size,created_by,created_at) VALUES('standard',1,30,100,'system',?)",
      )
      .bind(time),
    db
      .prepare(
        "INSERT INTO service_diagnostic_policies(assignment_id,selector_kind,service_name,policy_id,policy_revision,assigned_by,assigned_at) VALUES(?,'service_default','api','diagnostic',1,'system',?)",
      )
      .bind(id(3), time),
    db
      .prepare(
        "INSERT INTO service_retention_policies(service_name,policy_id,policy_revision,assigned_by,assigned_at) VALUES('api','standard',1,'system',?)",
      )
      .bind(time),
    db
      .prepare(
        "INSERT INTO deployments(deployment_id,service_name,environment,service_version,repository_url,git_commit,git_ref,artifact_digest,ci_provider,ci_run_id,deployed_at,manifest_object_key,manifest_digest,manifest_schema_version,registered_at,registered_by) VALUES(?,'api','production','1.0','https://github.com/example/repo',?,'main',?,'github','1',?,'manifest',?,'1.0',?,'ci')",
      )
      .bind(
        id(1),
        "c".repeat(40),
        "sha256:" + "a".repeat(64),
        time,
        "sha256:" + "b".repeat(64),
        time,
      ),
  ];
  await db.batch(statements);
  await db
    .prepare(
      "INSERT INTO telemetry_backends(backend_name,capabilities_json,query_adapter,ui_url_template,retention_class,auth_reference,created_at,updated_at) VALUES('tempo','[\"trace\"]','tempo','https://tempo.example','standard','tempo',?,?)",
    )
    .bind(time, time)
    .run();
}, 60000);
afterAll(async () => {
  await mf?.dispose();
});
it("atomically aggregates faults, deduplicates, rejects conflicts, and resolves only causal recovery", async () => {
  const db = await mf.getD1Database("DB", "rust");
  const first = await submit(envelope(10));
  expect(first.status, await first.clone().text()).toBe(200);
  expect(await first.json()).toEqual({ processed: true });
  let issue = await db.prepare("SELECT * FROM issues").first();
  expect(issue?.state).toBe("active");
  expect(issue?.occurrence_count).toBe(1);
  const before = await db
    .prepare(
      "SELECT (SELECT COUNT(*) FROM audit_log) AS audit,(SELECT COUNT(*) FROM outbox) AS outbox,(SELECT revision FROM current_statuses WHERE target_type='service') AS revision",
    )
    .first();
  expect(await (await submit(envelope(10))).json()).toEqual({
    processed: false,
  });
  const after = await db
    .prepare(
      "SELECT (SELECT COUNT(*) FROM audit_log) AS audit,(SELECT COUNT(*) FROM outbox) AS outbox,(SELECT revision FROM current_statuses WHERE target_type='service') AS revision",
    )
    .first();
  expect(after).toEqual(before);
  const conflict = envelope(10);
  conflict.event.summary = "Different";
  expect((await submit(conflict)).status).toBeGreaterThanOrEqual(400);
  const stale = envelope(11, "recovery", 9);
  expect((await submit(stale)).status).toBe(200);
  expect((await db.prepare("SELECT state FROM issues").first())?.state).toBe(
    "active",
  );
  expect((await submit(envelope(12, "recovery", 10))).status).toBe(200);
  expect((await db.prepare("SELECT state FROM issues").first())?.state).toBe(
    "recovering",
  );
  expect((await submit(envelope(13, "recovery", 10))).status).toBe(200);
  issue = await db.prepare("SELECT * FROM issues").first();
  expect(issue?.state).toBe("resolved");
  expect(issue?.occurrence_count).toBe(1);
  expect(issue?.recovery_count).toBe(2);
  expect(
    (
      await db
        .prepare("SELECT COUNT(*) AS count FROM issue_occurrences")
        .first()
    )?.count,
  ).toBe(1);
  expect((await submit(envelope(14))).status).toBe(200);
  expect(
    (await db.prepare("SELECT COUNT(*) AS count FROM issues").first())?.count,
  ).toBe(2);
}, 30000);
it("rejects forged provenance and unsafe query locators before D1 writes", async () => {
  const value = envelope(20);
  value.producer.service_name = "forged";
  expect((await submit(value)).status).toBeGreaterThanOrEqual(400);
  const db = await mf.getD1Database("DB", "rust");
  expect(
    await db
      .prepare("SELECT event_id FROM diagnostic_event_dedup WHERE event_id=?")
      .bind(id(20))
      .first(),
  ).toBeNull();
});
it("rolls back the dedup claim when deployment foreign keys reject a transaction", async () => {
  const value = envelope(30);
  value.event.deployment_id = id(999);
  value.producer.deployment_id = id(999);
  expect((await submit(value)).status).toBeGreaterThanOrEqual(400);
  const db = await mf.getD1Database("DB", "rust");
  expect(
    await db
      .prepare("SELECT event_id FROM diagnostic_event_dedup WHERE event_id=?")
      .bind(id(30))
      .first(),
  ).toBeNull();
});
it("concurrent duplicate claims produce only one occurrence", async () => {
  const value = envelope(40);
  const responses = await Promise.all([submit(value), submit(value)]);
  expect(responses.map((r) => r.status)).toEqual([200, 200]);
  const bodies = await Promise.all(
    responses.map((r) => r.json() as Promise<{ processed: boolean }>),
  );
  expect(bodies.map((b) => b.processed).sort()).toEqual([false, true]);
  const db = await mf.getD1Database("DB", "rust");
  expect(
    (
      await db
        .prepare(
          "SELECT COUNT(*) AS count FROM issue_occurrences WHERE event_id=?",
        )
        .bind(id(40))
        .first()
    )?.count,
  ).toBe(1);
});

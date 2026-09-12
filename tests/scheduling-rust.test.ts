import { afterAll, beforeAll, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { readFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";

/** 测试边界仅替换区域网络，不替换 Rust 状态或 SQL。 / Replace only regional network fixtures, never Rust state or SQL. */
let mf: Miniflare;
/** 本次测试的源时间。 / Source timestamp for this test run. */
const at = new Date(Date.now() - 60_000).toISOString();
/** 固定协议 UUIDv7。 / Fixed fixture protocol UUIDv7. */
const id = (n: number) =>
  `0199d0a8-2e12-7a59-a51e-${n.toString(16).padStart(12, "0")}`;
/** 真实 workerd 服务提供可控网络结果及调用计数，不实现领域判断。 / Real workerd service supplies controlled network results and counts, without domain evaluation. */
const regional = `let calls=[];
export default {async fetch(request) {
 const r=await request.json(); calls.push(r.monitor_id);
 await new Promise(resolve=>setTimeout(resolve,30));
 return Response.json({version:'1',executor_id:r.executor_id,location:r.location,run_id:r.run_id,
 scheduled_for:r.scheduled_for,actual_colo:'SIN',observation:{observationId:r.run_id,monitorId:r.monitor_id,
 observedAt:new Date().toISOString(),outcome:'success',latencyMs:12,protocolStatus:'204',errorType:null,correlationId:r.correlation_id}});
}};`;

/** 使用真实 D1 执行一个测试准备语句。 / Execute one fixture statement through real D1. */
async function sql(statement: string, ...values: (string | number | null)[]) {
  const db = await mf.getD1Database("DB", "scheduler");
  return db
    .prepare(statement)
    .bind(...values)
    .all<Record<string, unknown>>();
}
/** 直接调用生产 scheduled 函数并等待完成。 / Directly invoke and await the production scheduled function. */
async function tick() {
  const response = await mf.dispatchFetch("https://scheduler.test/tick", {
    method: "POST",
  });
  expect(await response.text()).toBe('{"completed":true}');
  expect(response.status).toBe(200);
}
/** 独立 monitor 夹具。 / Independent monitor fixture. */
async function monitor(n: number, service: string, enabled = 1) {
  await sql(
    "INSERT INTO monitors(monitor_id,target_type,target_id,probe_kind,schedule_kind,interval_seconds,timeout_ms,probe_config_json,policy_id,policy_revision,next_run_at,created_at,updated_at,enabled) VALUES(?,'service',?,'http','interval',300,1000,?, 'default',1,?,?,?,?)",
    id(n),
    service,
    JSON.stringify({ url: "https://fixture.example/health" }),
    at,
    at,
    at,
    enabled,
  );
  await sql(
    "INSERT INTO monitor_locations(monitor_id,location) VALUES(?,'asia')",
    id(n),
  );
}
beforeAll(async () => {
  mf = new Miniflare({
    workers: [
      {
        config: {
          type: "worker",
          name: "scheduler",
          compatibilityDate: "2026-09-12",
          manifest: {
            mainModule: "index.js",
            modules: {
              "index.js": {
                type: "esm",
                contents: await readFile(
                  "tests/scheduling-runtime/build/index.js",
                  "utf8",
                ),
              },
              "index_bg.wasm": {
                type: "wasm",
                contents: await readFile(
                  "tests/scheduling-runtime/build/index_bg.wasm",
                ),
              },
            },
          },
          env: {
            DB: { type: "d1", id: "rust-scheduling-runtime" },
            ENVIRONMENT: { type: "json", value: "development" },
            SCHEDULER_GLOBAL_CONCURRENCY: { type: "json", value: "2" },
            SCHEDULER_PER_TARGET_CONCURRENCY: { type: "json", value: "1" },
            PROBE_REGIONAL_CONFIG: {
              type: "json",
              value: JSON.stringify({
                asia: {
                  binding: "PROBE_EXECUTOR_ASIA",
                  executor_id: "fixture-asia",
                  allowed_colos: ["SIN"],
                  allowed_kinds: ["http"],
                },
              }),
            },
            PROBE_EXECUTOR_ASIA: { type: "worker", worker: "regional" },
          },
        },
      },
      ...(await Promise.all(
        ["enabled", "invalid"].map(async (mode) => ({
          config: {
            type: "worker" as const,
            name: mode,
            compatibilityDate: "2026-09-12",
            manifest: {
              mainModule: "index.js",
              modules: {
                "index.js": {
                  type: "esm" as const,
                  contents: await readFile(
                    "tests/scheduling-runtime/build/index.js",
                    "utf8",
                  ),
                },
                "index_bg.wasm": {
                  type: "wasm" as const,
                  contents: await readFile(
                    "tests/scheduling-runtime/build/index_bg.wasm",
                  ),
                },
              },
            },
            env: {
              DB: { type: "d1" as const, id: "rust-scheduling-runtime" },
              NOTIFICATIONS_ENABLED: {
                type: "json" as const,
                value: mode === "enabled" ? "true" : "invalid",
              },
              NOTIFICATION_WEBHOOK_URL: {
                type: "json" as const,
                value: "https://notifications.example/hook",
              },
              NOTIFICATION_AUTHORIZATION: {
                type: "json" as const,
                value: "Bearer fixture-only",
              },
            },
          },
        })),
      )),
      {
        config: {
          type: "worker",
          name: "regional",
          compatibilityDate: "2026-09-12",
          manifest: {
            mainModule: "index.js",
            modules: { "index.js": { type: "esm", contents: regional } },
          },
        },
      },
    ],
  });
  const db = await mf.getD1Database("DB", "scheduler");
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
  for (const service of ["api", "guarded", "valid-guard", "retention"])
    await sql(
      "INSERT INTO services(service_name,display_name,owner,criticality,created_at,updated_at) VALUES(?,?, 'ops','high',?,?)",
      service,
      service,
      at,
      at,
    );
  await sql(
    "INSERT INTO evaluation_policies(policy_id,revision,schema_version,name,observation_window_seconds,minimum_samples,failure_threshold,recovery_threshold,stale_after_seconds,location_quorum,fingerprint_template_json,status_mapping_json,diagnostic_rules_json,created_by,created_at) VALUES('default',1,'1.0','Runtime',300,1,0.5,0.1,120,1,'{}',?,?,'system',?)",
    JSON.stringify({ failure_status: "degraded" }),
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
    at,
  );
  await sql(
    "INSERT INTO data_retention_policies(policy_id,revision,occurrence_retention_days,cleanup_batch_size,created_by,created_at) VALUES('standard',1,30,100,'system',?)",
    at,
  );
  for (const [n, service] of [
    [1, "guarded"],
    [2, "valid-guard"],
    [3, "retention"],
  ] as const) {
    await sql(
      "INSERT INTO deployments(deployment_id,service_name,environment,service_version,repository_url,git_commit,git_ref,artifact_digest,ci_provider,ci_run_id,deployed_at,manifest_object_key,manifest_digest,manifest_schema_version,registered_at,registered_by) VALUES(?,?,'production','1.0','https://github.com/example/repo',?,'main',?,'github','1',?, ?,?,'1.0',?,'ci')",
      id(n),
      service,
      "c".repeat(40),
      "sha256:" + "a".repeat(64),
      at,
      `manifest-${n}`,
      "sha256:" + "b".repeat(64),
      at,
    );
    await sql(
      "INSERT INTO service_diagnostic_policies(assignment_id,selector_kind,service_name,policy_id,policy_revision,assigned_by,assigned_at) VALUES(?,'service_default',?,'default',1,'system',?)",
      id(n + 20),
      service,
      at,
    );
    await sql(
      "INSERT INTO service_retention_policies(service_name,policy_id,policy_revision,assigned_by,assigned_at) VALUES(?,'standard',1,'system',?)",
      service,
      at,
    );
  }
}, 60_000);
afterAll(async () => {
  await mf?.dispose();
});

it("runs overlapping cron invocations with one authoritative checkpoint and persistent outbox", async () => {
  await monitor(100, "api");
  await Promise.all([tick(), tick()]);
  const checkpoints = (
    await sql("SELECT * FROM monitor_checkpoints WHERE monitor_id=?", id(100))
  ).results;
  expect(checkpoints).toHaveLength(1);
  expect(checkpoints[0]).toMatchObject({
    window_samples: 1,
    evaluation_status: "operational",
    actual_colo: "SIN",
  });
  const rows = (
    await sql(
      "SELECT lease_owner,next_run_at,last_run_at FROM monitors WHERE monitor_id=?",
      id(100),
    )
  ).results;
  expect(rows[0].lease_owner).toBeNull();
  expect(Date.parse(rows[0].next_run_at as string)).toBeGreaterThan(Date.now());
  expect(rows[0].last_run_at).toBe(at);
  expect(
    (
      await sql(
        "SELECT direct_status,effective_impact FROM current_statuses WHERE target_type='service' AND target_id='api'",
      )
    ).results[0],
  ).toMatchObject({
    direct_status: "operational",
    effective_impact: "operational",
  });
  const outbox = (
    await sql(
      "SELECT state,attempt_count FROM outbox WHERE event_type='status.reevaluation_requested' AND aggregate_id='api'",
    )
  ).results;
  expect(outbox).toHaveLength(1);
  expect(outbox[0]).toMatchObject({ state: "delivered", attempt_count: 1 });
  // 禁用外部通知不领取、不消耗重试，也不虚假确认。 / Disabled notifications are neither claimed, retried, nor falsely acknowledged.
  expect(
    (
      await sql(
        "SELECT state,attempt_count FROM outbox WHERE event_type='status.changed' AND aggregate_id='service:api'",
      )
    ).results[0],
  ).toMatchObject({ state: "pending", attempt_count: 0 });
});

/** 健康诊断夹具仍经生产严格验证和领域评估。 / Health fixture still passes production strict validation and domain evaluation. */
function health(
  n: number,
  service: string,
  deployment: number,
  monitorId: number,
) {
  const now = new Date().toISOString();
  return {
    schema_version: "1.0",
    message_id: id(n + 1000),
    received_at: now,
    origin: { kind: "monitor", monitor_id: id(monitorId) },
    producer: {
      subject: "status-scheduler",
      service_name: service,
      environment: "production",
      deployment_id: id(deployment),
      scopes: ["diagnostics:write"],
      token_id: "scheduler-test",
      auth_method: "service_binding",
    },
    trace_context: { correlation_id: id(n + 2000) },
    event: {
      schema_version: "1.0",
      event_id: id(n),
      service_name: service,
      environment: "production",
      deployment_id: id(deployment),
      kind: "health.probe_failed",
      signal: "fault",
      severity: "error",
      occurred_at: now,
      correlation_id: id(n + 2000),
      summary: "Runtime probe failed",
      trace_id: "1".repeat(32),
      fingerprint: {
        operation: "active-health-probe",
        capability: service,
        protocol: "http",
      },
      evidence: [],
      attributes: {},
    },
  };
}
it("rejects a disabled old monitor run inside the diagnostic transaction, with a positive valid-lease control", async () => {
  await monitor(101, "guarded");
  await monitor(102, "valid-guard");
  for (const [mid, service, deployment, disable] of [
    [101, "guarded", 1, true],
    [102, "valid-guard", 2, false],
  ] as const) {
    const response = await mf.dispatchFetch(
      "https://scheduler.test/diagnostic-lease-race",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          monitor_id: id(mid),
          disable,
          envelope: health(mid + 100, service, deployment, mid),
        }),
      },
    );
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result, JSON.stringify(result)).toMatchObject({
      accepted: !disable,
    });
    if (disable) {
      expect(result).toMatchObject({
        error: "d1_transaction:diagnostic-transaction-failed",
      });
    }
  }
  expect(
    (await sql("SELECT * FROM issues WHERE service_name='guarded'")).results,
  ).toHaveLength(0);
  expect(
    (
      await sql(
        "SELECT * FROM diagnostic_event_dedup WHERE event_id=?",
        id(201),
      )
    ).results,
  ).toHaveLength(0);
  expect(
    (await sql("SELECT state FROM issues WHERE service_name='valid-guard'"))
      .results,
  ).toEqual([{ state: "active" }]);
});

it("purges expired occurrence through the real retention path while preserving incident pins", async () => {
  await sql(
    "INSERT INTO issues(issue_id,fingerprint_hash,service_name,kind,severity,state,first_seen_at,last_seen_at,policy_id,policy_revision) VALUES(?,?,'retention','dependency.unavailable','error','observed',?,?,'default',1)",
    id(300),
    "d".repeat(64),
    at,
    at,
  );
  for (const n of [301, 302])
    await sql(
      "INSERT INTO issue_occurrences(occurrence_id,issue_id,service_name,deployment_id,occurred_at,observed_at,summary,retention_policy_id,retention_policy_revision,purge_after) VALUES(?,?,'retention',?,?,?,'expired','standard',1,?)",
      id(n),
      id(300),
      id(3),
      at,
      at,
      at,
    );
  await sql(
    "INSERT INTO incidents(incident_id,started_at,detected_at,created_at,created_by) VALUES(?,?,?,?,'ops')",
    id(303),
    at,
    at,
    at,
  );
  await sql(
    "INSERT INTO incident_updates(update_id,incident_id,sequence,title,state,impact,public_message,actor_subject,occurred_at) VALUES(?,?,1,'pin','investigating','degraded','pin','ops',?)",
    id(304),
    id(303),
    at,
  );
  await sql("INSERT INTO incident_occurrences VALUES(?,?,1)", id(303), id(302));
  await tick();
  expect(
    (
      await sql(
        "SELECT occurrence_id FROM issue_occurrences WHERE issue_id=? ORDER BY occurrence_id",
        id(300),
      )
    ).results,
  ).toEqual([{ occurrence_id: id(302) }]);
});

/** 关闭出口不损失事件；恢复配置后同一 D1 行可再次领取。 / Disabled sinks retain events; re-enabling claims the same D1 row. */
it("retains external events without attempts and makes them claimable after enabling", async () => {
  const before = (
    await sql(
      "SELECT outbox_id,state,attempt_count FROM outbox WHERE event_type='status.changed' AND aggregate_id='service:api'",
    )
  ).results[0];
  expect(before).toMatchObject({ state: "pending", attempt_count: 0 });
  const disabled = await mf.dispatchFetch(
    "https://scheduler.test/claim-outbox",
    { method: "POST" },
  );
  expect(disabled.status).toBe(200);
  expect(await disabled.json()).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ outbox_id: before.outbox_id }),
    ]),
  );
  const invalid = await (
    await mf.getWorker("invalid")
  ).fetch("https://scheduler.test/claim-outbox", { method: "POST" });
  expect(invalid.status).toBe(500);
  expect(
    (
      await sql(
        "SELECT state,attempt_count FROM outbox WHERE outbox_id=?",
        before.outbox_id as string,
      )
    ).results[0],
  ).toMatchObject({ state: "pending", attempt_count: 0 });
  const enabled = await (
    await mf.getWorker("enabled")
  ).fetch("https://scheduler.test/claim-outbox", { method: "POST" });
  expect(enabled.status).toBe(200);
  expect(await enabled.json()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        outbox_id: before.outbox_id,
        attempt_count: 1,
      }),
    ]),
  );
});

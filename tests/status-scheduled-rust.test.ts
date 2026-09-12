import { afterAll, beforeAll, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { readFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";

/** 最终发布模块图，不重建入口，也不添加测试 HTTP 路由。 / Final release module graph, without rebuilding entrypoints or adding test HTTP routes. */
let runtime: Miniflare;
/** workerd 原生日志，仅用于验证预期清理失败。 / Native workerd logs used only to verify expected cleanup failure. */
const logs: string[] = [];
/** 规范测试身份。 / Canonical fixture identity. */
const id = (n: number) =>
  `0199d0a8-2e12-7a59-a51e-${n.toString(16).padStart(12, "0")}`;
/** 真实数据库上的参数化测试准备。 / Parameterized fixture setup against the real database. */
async function sql(statement: string, ...values: (string | number)[]) {
  const db = await runtime.getD1Database("DB", "status");
  return db
    .prepare(statement)
    .bind(...values)
    .all<Record<string, unknown>>();
}
beforeAll(async () => {
  const modules: Record<
    string,
    { type: "esm"; contents: string } | { type: "wasm"; contents: Buffer }
  > = {};
  for (const filename of await readdir("dist/rust/status", {
    recursive: true,
  })) {
    const name = filename.replaceAll("\\", "/");
    if (name.endsWith(".wasm"))
      modules[name] = {
        type: "wasm",
        contents: await readFile(`dist/rust/status/${name}`),
      };
    else if (name.endsWith(".js"))
      modules[name] = {
        type: "esm",
        contents: await readFile(`dist/rust/status/${name}`, "utf8"),
      };
  }
  expect(Object.keys(modules)).toContain("status.js");
  const manifest = { mainModule: "status.js", modules };
  runtime = new Miniflare({
    handleStructuredLogs: (log) => logs.push(log.message),
    workers: ["status", "bootstrap"].map((name) => ({
      config: {
        type: "worker" as const,
        name,
        compatibilityDate: "2026-09-12",
        manifest,
        env: {
          ENVIRONMENT: { type: "json" as const, value: "development" },
          BOOTSTRAP_MODE: {
            type: "json" as const,
            value: name === "bootstrap" ? "true" : "false",
          },
          DB: { type: "d1" as const, id: "production-scheduled-smoke" },
          // 故意不提供 ARTIFACTS，候选存在时真实 cleanup 将失败。 / Intentionally omit ARTIFACTS so real cleanup fails when a candidate exists.
        },
      },
    })),
  });
  const db = await runtime.getD1Database("DB", "status");
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
    await db.batch(statements.map((statement) => db.prepare(statement)));
  }
}, 60_000);
afterAll(async () => {
  await runtime?.dispose();
});

it("dispatches an actual scheduled event to the final production default export", async () => {
  // 官方 Miniflare Fetcher scheduled 方法触发真实事件，不调用导入的 handler。
  // Official Miniflare Fetcher scheduled dispatches a real event, never an imported handler.
  // https://developers.cloudflare.com/workers/testing/miniflare/core/scheduled/
  const worker = await runtime.getWorker("status");
  const result = await worker.scheduled({
    scheduledTime: new Date(),
    cron: "* * * * *",
  });
  expect(result).toMatchObject({ outcome: "ok" });
  expect(
    (await sql("SELECT COUNT(*) AS count FROM services")).results[0],
  ).toEqual({ count: 0 });
});

it("continues the production scheduler after real artifact cleanup fails", async () => {
  const old = new Date(Date.now() - 120_000).toISOString();
  const expired = new Date(Date.now() - 60_000).toISOString();
  await sql(
    "INSERT INTO services(service_name,display_name,owner,criticality,created_at,updated_at) VALUES('cleanup-fixture','Cleanup','ops','low',?,?)",
    old,
    old,
  );
  await sql(
    "INSERT INTO deployments(deployment_id,service_name,environment,service_version,repository_url,git_commit,git_ref,artifact_digest,ci_provider,ci_run_id,deployed_at,manifest_object_key,manifest_digest,manifest_schema_version,registered_at,registered_by) VALUES(?,'cleanup-fixture','production','1.0','https://github.com/example/repo',?,'main',?,'github','1',?,'manifest-cleanup',?,'1.0',?,'ci')",
    id(1),
    "c".repeat(40),
    "sha256:" + "a".repeat(64),
    old,
    "sha256:" + "b".repeat(64),
    old,
  );
  await sql(
    "INSERT INTO artifact_upload_sessions(upload_id,deployment_id,idempotency_key,request_digest,object_key,kind,file_name,media_type,size_bytes,artifact_digest,expires_at,created_at,created_by,content_md5) VALUES(?,?,'cleanup',?,?,'binary','fixture.bin','application/octet-stream',16,?,?,?,'ci','QUFBQUFBQUFBQUFBQUFBQQ==')",
    id(2),
    id(1),
    "sha256:" + "3".repeat(64),
    "observability/artifacts/sha256/" + "4".repeat(64),
    "sha256:" + "4".repeat(64),
    expired,
    old,
  );
  await sql(
    "INSERT INTO deployment_status_history(deployment_id,sequence,state,actor_subject,occurred_at) VALUES(?,1,'registered','ops',?)",
    id(1),
    old,
  );
  await sql(
    "INSERT INTO deployment_status_history(deployment_id,sequence,state,actor_subject,occurred_at) VALUES(?,2,'retired','ops',?)",
    id(1),
    old,
  );
  await sql(
    "INSERT INTO outbox(outbox_id,aggregate_type,aggregate_id,event_type,schema_version,payload_json,state,attempt_count,available_at,next_attempt_at,created_at) VALUES(?,'service','cleanup-fixture','service.changed','1.0','{}','pending',0,?,?,?)",
    id(3),
    old,
    old,
    old,
  );
  expect(
    (
      await sql(
        "SELECT d.state FROM artifact_upload_sessions s JOIN deployment_current_status d USING(deployment_id) WHERE s.upload_id=?",
        id(2),
      )
    ).results,
  ).toEqual([{ state: "retired" }]);
  const result = await (
    await runtime.getWorker("status")
  ).scheduled({ scheduledTime: new Date(), cron: "* * * * *" });
  expect(result).toMatchObject({ outcome: "ok" });
  // 通知队列也未配置：attempt 增长证明 scheduler 实际执行，而不是入口吞掉所有工作。
  // Notifications are also unconfigured: the increment proves the scheduler ran rather than swallowing all work.
  expect(
    (
      await sql(
        "SELECT attempt_count,state FROM outbox WHERE outbox_id=?",
        id(3),
      )
    ).results,
  ).toEqual([{ attempt_count: 1, state: "pending" }]);
  expect(logs.join("\n")).toContain("artifact.cleanup.failed");
});

it("rejects the actual scheduled event in bootstrap mode without advancing outbox work", async () => {
  const old = new Date(Date.now() - 60_000).toISOString();
  await sql(
    "INSERT INTO outbox(outbox_id,aggregate_type,aggregate_id,event_type,schema_version,payload_json,state,attempt_count,available_at,next_attempt_at,created_at) VALUES(?,'service','bootstrap-fixture','service.changed','1.0','{}','pending',0,?,?,?)",
    id(4),
    old,
    old,
    old,
  );
  const result = await (
    await runtime.getWorker("bootstrap")
  ).scheduled({ scheduledTime: new Date(), cron: "* * * * *" });
  expect(result).toMatchObject({ outcome: "exception" });
  expect(
    (
      await sql(
        "SELECT attempt_count,state FROM outbox WHERE outbox_id=?",
        id(4),
      )
    ).results,
  ).toEqual([{ attempt_count: 0, state: "pending" }]);
});

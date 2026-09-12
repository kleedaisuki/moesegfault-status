import { beforeAll, afterAll, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { readFile } from "node:fs/promises";

/** 已验证部署及事件fixture，不用作生产身份。 / Validated deployment/event fixtures, never production identities. */
const id = "0199d09a-b692-7ce0-a1c0-5138a43d7402";
const parent = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01";
let mf: Miniflare;
/** 构造只含领域标识的版本化消息。 / Construct a versioned domain-ID-only message. */
function notification(mode = "ok") {
  return {
    schema_version: "1.0",
    event_id: id,
    event_type: "status.changed",
    aggregate_type: "service",
    aggregate_id: mode,
    correlation_id: id,
    traceparent: parent,
  };
}
/** 故障只在外部webhook注入；被测消费和发送都是Rust。 / Inject failures only at the external webhook; consumption and delivery under test are Rust. */
const webhook = `const history=[]; export default {async fetch(r){if(new URL(r.url).pathname==='/history')return Response.json(history);const body=await r.json();history.push({body,headers:Object.fromEntries(r.headers)});if(body.aggregate_id==='timeout')await new Promise(resolve=>setTimeout(resolve,10000));if(body.aggregate_id==='redirect')return Response.redirect('https://other.test/',302);return new Response(null,{status:body.aggregate_id==='fail'?503:204});},async queue(batch){for(const message of batch.messages){history.push({dlq:message.body});message.ack();}}};`;
beforeAll(async () => {
  mf = new Miniflare({
    workers: [
      {
        config: {
          type: "worker",
          name: "telemetry",
          compatibilityDate: "2026-09-12",
          manifest: {
            mainModule: "index.js",
            modules: {
              "index.js": {
                type: "esm",
                contents: await readFile(
                  "tests/telemetry-runtime/build/index.js",
                  "utf8",
                ),
              },
              "index_bg.wasm": {
                type: "wasm",
                contents: await readFile(
                  "tests/telemetry-runtime/build/index_bg.wasm",
                ),
              },
            },
          },
          env: {
            ANALYTICS: {
              type: "analytics-engine-dataset",
              name: "telemetry-test",
            },
            ...Object.fromEntries(
              Object.entries({
                ENVIRONMENT: "test",
                STATUS_VERSION: "1",
                DEPLOYMENT_ID: id,
                GIT_COMMIT: "a".repeat(40),
                ARTIFACT_DIGEST: `sha256:${"b".repeat(64)}`,
                NOTIFICATIONS_ENABLED: "true",
                NOTIFICATION_WEBHOOK_URL: "https://webhook.test/send",
                NOTIFICATION_AUTHORIZATION: "Bearer test-only-credential",
                NOTIFICATION_MAX_ATTEMPTS: "3",
              }).map(([key, value]) => [key, { type: "json", value }]),
            ),
            NOTIFICATION_DLQ: { type: "queue", name: "notification-test-dlq" },
          },
        },
        dev: { outboundService: { type: "worker", worker: "webhook" } },
      },
      {
        config: {
          type: "worker",
          name: "webhook",
          compatibilityDate: "2026-09-12",
          manifest: {
            mainModule: "mock.js",
            modules: { "mock.js": { type: "esm", contents: webhook } },
          },
          triggers: [
            {
              type: "queue",
              name: "notification-test-dlq",
              maxBatchTimeout: 0,
              maxBatchSize: 1,
            },
          ],
        },
      },
    ],
  });
}, 60_000);
afterAll(async () => {
  await mf?.dispose();
});
/** 调用真实Wasm消费器，返回每条消息确认动作。 / Invoke the actual Wasm consumer and return per-message dispositions. */
async function consume(body: unknown, attempts = 1, remove_binding?: string) {
  const r = await mf.dispatchFetch("https://test/consume", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body, attempts, remove_binding }),
  });
  expect(r.status).toBe(200);
  return r.json();
}
/** 从外部fixture读取发送历史。 / Read delivery history from the external fixture. */
async function history(): Promise<
  Array<{
    body?: ReturnType<typeof notification>;
    headers?: Record<string, string>;
    dlq?: Record<string, unknown>;
  }>
> {
  return (await mf.dispatchFetch("https://test/history")).json();
}

it("executes native custom spans and writes to the real Analytics Engine binding", async () => {
  const trace = await (await mf.dispatchFetch("https://test/trace")).json();
  expect(trace).toMatchObject({
    trace: { Ok: expect.any(String) },
    endpoint: { Ok: true },
  });
  const r = await mf.dispatchFetch("https://test/span");
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ result: 42, dropped: 0 });
});
it("isolates missing Analytics binding without changing the result", async () => {
  const r = await mf.dispatchFetch("https://test/span", {
    headers: { "x-test-metrics-disabled": "1" },
  });
  expect(await r.json()).toEqual({ result: 42, dropped: 1 });
});
it("acks successful delivery and propagates fresh child trace with stable idempotency", async () => {
  expect(await consume(notification())).toEqual([{ action: "ack" }]);
  const h = (await history()).find((h) => h.body?.aggregate_id === "ok")!;
  expect(h.headers?.["idempotency-key"]).toBe(id);
  expect(h.headers?.["x-moesegfault-correlation-id"]).toBe(id);
  expect(h.headers?.traceparent).not.toBe(parent);
  expect(h.headers?.traceparent.slice(3, 35)).toBe(parent.slice(3, 35));
});
it("retries failures with native plain-object delay options", async () => {
  expect(await consume(notification("fail"), 2)).toEqual([
    { action: "retry", delay: 4 },
  ]);
});
it("rejects redirects rather than leaking the credential", async () => {
  expect(await consume(notification("redirect"))).toEqual([
    { action: "retry", delay: 2 },
  ]);
});
it("rejects malformed payload without sending private fields", async () => {
  const before = (await history()).length;
  expect(
    await consume({ ...notification(), authorization: "do-not-export" }),
  ).toEqual([{ action: "retry", delay: 2 }]);
  expect((await history()).length).toBe(before);
});
it("fails closed when webhook authorization is missing", async () => {
  const before = (await history()).length;
  expect(
    await consume(notification(), 1, "NOTIFICATION_AUTHORIZATION"),
  ).toEqual([{ action: "retry", delay: 2 }]);
  expect((await history()).length).toBe(before);
});
it("does not deliver or acknowledge when notifications are not explicitly enabled", async () => {
  const before = (await history()).length;
  expect(await consume(notification(), 1, "NOTIFICATIONS_ENABLED")).toEqual([
    { action: "retry", delay: 2 },
  ]);
  expect((await history()).length).toBe(before);
});
it("does not ack exhausted messages while the DLQ binding is unavailable", async () => {
  expect(await consume(notification("fail"), 3, "NOTIFICATION_DLQ")).toEqual([
    { action: "retry", delay: 8 },
  ]);
});
it("moves exhausted delivery to durable DLQ preserving event and problem identity", async () => {
  expect(await consume(notification("fail"), 3)).toEqual([{ action: "ack" }]);
  let dead;
  for (let n = 0; n < 30; n++) {
    dead = (await history()).find((h) => h.dlq);
    if (dead) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(dead?.dlq?.event_id).toBe(id);
  expect(dead?.dlq?.last_problem_type).toBe(
    "https://status.moesegfault.dev/problems/notification-delivery-failed",
  );
  expect(dead?.dlq?.original_event).toEqual(notification("fail"));
});
it("aborts slow webhook at the five-second deadline", async () => {
  const start = Date.now();
  expect(await consume(notification("timeout"))).toEqual([
    { action: "retry", delay: 2 },
  ]);
  expect(Date.now() - start).toBeGreaterThanOrEqual(4500);
  expect(Date.now() - start).toBeLessThan(8000);
  expect(
    (await history()).some((h) => h.body?.aggregate_id === "timeout"),
  ).toBe(true);
}, 12_000);

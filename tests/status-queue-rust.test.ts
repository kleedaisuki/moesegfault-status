import { beforeAll, afterAll, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/** 不修改最终构建产物；测试只加载发布目录的真实模块。 / Load real release modules without modifying final artifacts. */
async function releaseModules() {
  const root = "dist/rust/status";
  const modules: Record<
    string,
    { type: "esm"; contents: string } | { type: "wasm"; contents: Buffer }
  > = {};
  for (const name of await readdir(root, { recursive: true })) {
    const normalized = name.replaceAll("\\", "/");
    if (name.endsWith(".js"))
      modules[normalized] = {
        type: "esm",
        contents: await readFile(join(root, name), "utf8"),
      };
    if (name.endsWith(".wasm"))
      modules[normalized] = {
        type: "wasm",
        contents: await readFile(join(root, name)),
      };
  }
  return modules;
}
/** JS仅提供外部队列生产者和收件方fixture，不实现任何业务消费。 / JS provides external queue producer and recipient fixtures only, never business consumption. */
const producer = `export default {async fetch(r,env){if(new URL(r.url).pathname==='/history')return env.SINK.fetch('https://sink/history');const value=await r.json();await env[value.queue].send(value.body);return new Response(null,{status:202});}};`;
const sink = `const history=[];export default {async fetch(r){if(new URL(r.url).pathname==='/history')return Response.json(history);const body=await r.json();history.push({webhook:body,correlation:r.headers.get('x-moesegfault-correlation-id'),traceparent:r.headers.get('traceparent')});return new Response(null,{status:body.aggregate_id==='fail'?503:204});},async queue(batch){for(const message of batch.messages){history.push({queue:batch.queue,body:message.body});message.ack();}}};`;
const id = "0199d09a-b692-7ce0-a1c0-5138a43d7402";
let mf: Miniflare;
/** 通知协议fixture。 / Notification protocol fixture. */
function notification(target: string) {
  return {
    schema_version: "1.0",
    event_id: id,
    event_type: "status.changed",
    aggregate_type: "service",
    aggregate_id: target,
    correlation_id: id,
    traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
  };
}
beforeAll(async () => {
  const manifest = await releaseModules();
  expect(Object.keys(manifest).filter((n) => n.endsWith(".wasm"))).toHaveLength(
    2,
  );
  mf = new Miniflare({
    workers: [
      {
        config: {
          type: "worker",
          name: "producer",
          compatibilityDate: "2026-09-12",
          manifest: {
            mainModule: "producer.js",
            modules: { "producer.js": { type: "esm", contents: producer } },
          },
          env: {
            NOTIFICATIONS: { type: "queue", name: "real-notifications" },
            DIAGNOSTICS: { type: "queue", name: "real-diagnostics" },
            SINK: { type: "worker", worker: "sink" },
          },
        },
      },
      {
        config: {
          type: "worker",
          name: "status",
          compatibilityDate: "2026-09-12",
          manifest: { mainModule: "status.js", modules: manifest },
          env: {
            ...Object.fromEntries(
              Object.entries({
                ENVIRONMENT: "test",
                STATUS_VERSION: "1",
                DEPLOYMENT_ID: id,
                GIT_COMMIT: "a".repeat(40),
                ARTIFACT_DIGEST: `sha256:${"b".repeat(64)}`,
                NOTIFICATION_WEBHOOK_URL: "https://sink/send",
                NOTIFICATION_AUTHORIZATION: "Bearer test-only",
                NOTIFICATION_QUEUE_NAME: "real-notifications",
                DIAGNOSTIC_QUEUE_NAME: "real-diagnostics",
                NOTIFICATION_MAX_ATTEMPTS: "1",
                DIAGNOSTIC_MAX_ATTEMPTS: "1",
              }).map(([key, value]) => [key, { type: "json", value }]),
            ),
            ANALYTICS: {
              type: "analytics-engine-dataset",
              name: "release-queue-test",
            },
            NOTIFICATION_DLQ: { type: "queue", name: "real-notifications-dlq" },
            DIAGNOSTIC_DLQ: { type: "queue", name: "real-diagnostics-dlq" },
          },
          triggers: [
            {
              type: "queue",
              name: "real-notifications",
              maxBatchSize: 1,
              maxBatchTimeout: 0,
              maxRetries: 1,
            },
            {
              type: "queue",
              name: "real-diagnostics",
              maxBatchSize: 1,
              maxBatchTimeout: 0,
              maxRetries: 1,
            },
          ],
        },
        dev: { outboundService: { type: "worker", worker: "sink" } },
      },
      {
        config: {
          type: "worker",
          name: "sink",
          compatibilityDate: "2026-09-12",
          manifest: {
            mainModule: "sink.js",
            modules: { "sink.js": { type: "esm", contents: sink } },
          },
          triggers: [
            {
              type: "queue",
              name: "real-notifications-dlq",
              maxBatchTimeout: 0,
              maxBatchSize: 1,
            },
            {
              type: "queue",
              name: "real-diagnostics-dlq",
              maxBatchTimeout: 0,
              maxBatchSize: 1,
            },
          ],
        },
      },
    ],
  });
}, 60000);
afterAll(async () => {
  await mf?.dispose();
});
/** 通过原生Producer binding入队，不直接调用消费函数。 / Enqueue through native producer bindings, never invoking consumer functions directly. */
async function enqueue(queue: string, body: unknown) {
  expect(
    (
      await mf.dispatchFetch("https://producer/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ queue, body }),
      })
    ).status,
  ).toBe(202);
}
/** 等待真实异步Queue传播完成，带明确上限。 / Await actual asynchronous Queue propagation with an explicit bound. */
async function waitFor(
  predicate: (items: Array<Record<string, unknown>>) => boolean,
) {
  let items: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 100; i++) {
    items = await (await mf.dispatchFetch("https://producer/history")).json();
    if (predicate(items)) return items;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Queue observation deadline exceeded: ${JSON.stringify(items)}`,
  );
}
it("routes real published notifications through final status Worker to webhook", async () => {
  await enqueue("NOTIFICATIONS", notification("service:api"));
  const items = await waitFor((items) => items.some((i) => i.webhook));
  const delivered = items.find((i) => i.webhook)!;
  expect(delivered.webhook).toEqual(notification("service:api"));
  expect(delivered.correlation).toBe(id);
  expect(delivered.traceparent).not.toBe(
    notification("service:api").traceparent,
  );
});
it("routes exhausted notification delivery to the real notification DLQ", async () => {
  await enqueue("NOTIFICATIONS", notification("fail"));
  const items = await waitFor((items) =>
    items.some((i) => i.queue === "real-notifications-dlq"),
  );
  expect(
    items.find((i) => i.queue === "real-notifications-dlq")?.body,
  ).toMatchObject({
    event_id: id,
    original_event: notification("fail"),
    failure_stage: "notification.delivery",
  });
});
it("never misroutes the diagnostic alias to notification delivery", async () => {
  await enqueue("DIAGNOSTICS", notification("must-not-deliver"));
  const items = await waitFor((items) =>
    items.some((i) => i.queue === "real-diagnostics-dlq"),
  );
  expect(
    items.find((i) => i.queue === "real-diagnostics-dlq")?.body,
  ).toMatchObject({
    original: notification("must-not-deliver"),
    failure: { stage: "envelope_validation" },
  });
  expect(
    items.some(
      (i) =>
        (i.webhook as { aggregate_id?: string } | undefined)?.aggregate_id ===
        "must-not-deliver",
    ),
  ).toBe(false);
});

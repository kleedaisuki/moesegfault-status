import { beforeAll, afterAll, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { readFile } from "node:fs/promises";

let mf: Miniflare;
/** 只模拟外部 HTTP 接收者，SDK、重试和认证均运行 Rust。 / Mock only the external HTTP receiver; SDK, retries and authorization run in Rust. */
const receiver = `
const history = [];
export default { async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === '/history') return Response.json(history);
  const text = await request.text();
  const body = text ? JSON.parse(text) : {};
  history.push({url: request.url, text, body, headers: Object.fromEntries(request.headers)});
  if (url.hostname === 'redirected.test') return new Response(null, {status: 500});
  if (body.summary === 'redirect') return Response.redirect('https://redirected.test/leak', 302);
  if (body.summary === 'timeout') await new Promise(resolve => setTimeout(resolve, 300));
  if (body.summary === 'body-timeout') return new Response(new ReadableStream({async start(c) {
    c.enqueue(new TextEncoder().encode('{"accepted":'));
    await new Promise(resolve => setTimeout(resolve, 300));
    try { c.enqueue(new TextEncoder().encode('true}')); c.close(); } catch {}
  }}), {status:202});
  if (body.summary === 'retry' && history.filter(h => h.body.event_id === body.event_id).length === 1)
    return new Response(null, {status:503});
  return Response.json({accepted:true, event_id:body.summary === 'wrong-receipt' ? 'wrong' : body.event_id}, {status:202});
}};`;

beforeAll(async () => {
  mf = new Miniflare({
    workers: [
      {
        config: {
          type: "worker",
          name: "client",
          compatibilityDate: "2026-09-12",
          manifest: {
            mainModule: "index.js",
            modules: {
              "index.js": {
                type: "esm",
                contents: await readFile(
                  "tests/diagnostic-client-runtime/build/index.js",
                  "utf8",
                ),
              },
              "index_bg.wasm": {
                type: "wasm",
                contents: await readFile(
                  "tests/diagnostic-client-runtime/build/index_bg.wasm",
                ),
              },
            },
          },
        },
        dev: { outboundService: { type: "worker", worker: "receiver" } },
      },
      {
        config: {
          type: "worker",
          name: "receiver",
          compatibilityDate: "2026-09-12",
          manifest: {
            mainModule: "mock.js",
            modules: { "mock.js": { type: "esm", contents: receiver } },
          },
        },
      },
    ],
  });
}, 60_000);
afterAll(async () => {
  await mf?.dispose();
});

/** 调用真实 SDK 并返回安全统计。 / Invoke the real SDK and return safe statistics. */
async function publish(mode: string) {
  const response = await mf.dispatchFetch("https://client.test/publish", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    stats: {
      depth: number;
      published: number;
      failedAttempts: number;
      timeouts: number;
      dropped: number;
    };
    authCalls: number;
    event: {
      event_id: string;
      correlation_id: string;
      trace_id: string;
      span_id: string;
    };
  }>;
}
/** 远端观测完整线路字节，避免客户端自证。 / Observe complete wire bytes remotely instead of trusting client self-report. */
async function history() {
  return (
    await mf.dispatchFetch("https://client.test/history")
  ).json() as Promise<
    Array<{
      url: string;
      text: string;
      body: { event_id: string };
      headers: Record<string, string>;
    }>
  >;
}

it("Rust retries preserve exact bytes, event identity and trace while refreshing authorization", async () => {
  const result = await publish("retry");
  expect(result.stats).toMatchObject({
    depth: 0,
    published: 1,
    failedAttempts: 1,
  });
  expect(result.authCalls).toBe(2);
  const sent = (await history()).filter(
    (h) => h.body.event_id === result.event.event_id,
  );
  expect(sent).toHaveLength(2);
  expect(sent[0].text).toBe(sent[1].text);
  expect(sent.map((h) => h.headers.authorization)).toEqual([
    "Bearer fixture-secret-1",
    "Bearer fixture-secret-2",
  ]);
  for (const attempt of sent) {
    expect(attempt.headers["x-moesegfault-correlation-id"]).toBe(
      result.event.correlation_id,
    );
    expect(attempt.headers.traceparent).toBe(
      `00-${result.event.trace_id}-${result.event.span_id}-00`,
    );
  }
});

it("Rust never follows redirects or forwards credentials to the redirect target", async () => {
  const result = await publish("redirect");
  expect(result.stats.published).toBe(0);
  expect(
    (await history()).filter((h) => h.url.includes("redirected.test")),
  ).toHaveLength(0);
  expect(result.authCalls).toBe(1);
});

it.each(["timeout", "body-timeout", "auth-timeout"])(
  "Rust %s deadline leaves unacknowledged events queued",
  async (mode) => {
    const result = await publish(mode);
    expect(result.stats).toMatchObject({ depth: 1, published: 0, timeouts: 1 });
    expect(result.authCalls).toBe(1);
    if (mode === "auth-timeout")
      expect(
        (await history()).filter(
          (h) => h.body.event_id === result.event.event_id,
        ),
      ).toHaveLength(0);
  },
);

it("Rust rejects a mismatched 202 receipt without losing the queued event", async () => {
  const result = await publish("wrong-receipt");
  expect(result.stats).toMatchObject({
    depth: 1,
    published: 0,
    failedAttempts: 1,
  });
});

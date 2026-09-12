import { recordSchedulingMetrics } from "../scheduling/metrics.js";
import { describe, expect, it, vi } from "vitest";
import {
  createTelemetry,
  defineResource,
  type AnalyticsEngineDataPoint,
} from "@moesegfault/telemetry";
import {
  instrumentDatabase,
  observed,
  observeQueue,
  recordSchedule,
  recordPublicFreshness,
} from "./instrumentation.js";
import { recordHttp } from "./telemetry.js";

/** 真实 exporter 的隔离测试资源。 / Isolated resource for the real exporter. */
function fixture(fail = false) {
  const points: AnalyticsEngineDataPoint[] = [];
  const telemetry = createTelemetry({
    resource: defineResource({
      "service.namespace": "moeSegFault",
      "service.name": "status",
      "service.version": "1.0.0",
      "deployment.environment.name": "test",
      "moesegfault.deployment.id": "0199d0a8-2e12-7a59-a51e-44aa9b6d1001",
      "moesegfault.build.revision": "a".repeat(40),
      "moesegfault.artifact.digest": `sha256:${"a".repeat(64)}`,
    }),
    instrumentation: { name: "test", version: "1" },
    attributePolicy: { allowed: new Set() },
    console: { debug() {}, info() {}, warn() {}, error() {} },
    metricsDataset: {
      writeDataPoint(point = {}) {
        if (fail) throw new Error("export unavailable");
        points.push(point);
      },
    },
  });
  return {
    telemetry,
    points,
    values: (name: string) =>
      points.filter((p) => p.blobs?.[0] === name).map((p) => p.doubles?.[0]),
  };
}

describe("runtime self-observability", () => {
  it("failed scheduling metric reads remain fail-open without publishing false zero gauges", async () => {
    const f = fixture();
    await expect(
      recordSchedulingMetrics(
        {
          prepare() {
            throw new Error("database unavailable");
          },
        },
        f.telemetry,
      ),
    ).resolves.toBeUndefined();
    expect(f.values("scheduler.metrics.unavailable")).toEqual([1]);
    expect(f.values("probe.due")).toEqual([]);
    expect(f.values("outbox.backlog")).toEqual([]);
  });
  it("counts stale and missing observations separately without catalog fallback ages", () => {
    const f = fixture();
    const now = new Date("2026-09-12T12:00:00Z");
    recordPublicFreshness(
      f.telemetry,
      [
        {
          evaluated_at: "2026-09-12T11:59:00Z",
          fresh_until: "2026-09-12T12:01:00Z",
        },
        {
          evaluated_at: "2026-09-12T11:58:00Z",
          fresh_until: "2026-09-12T11:59:00Z",
        },
        { evaluated_at: null, fresh_until: null },
      ],
      now,
      "platform",
    );
    expect(f.values("public.status.observed")).toEqual([3]);
    expect(f.values("public.status.stale")).toEqual([1]);
    expect(f.values("public.status.missing")).toEqual([1]);
    expect(f.values("public.status.age.sum")).toEqual([180000]);
    expect(f.values("public.status.age.count")).toEqual([2]);
  });

  it("records HTTP counts and failure without request URL or body", () => {
    const f = fixture();
    recordHttp(
      f.telemetry,
      new Response("secret", { status: 503 }),
      Date.now(),
      "0199d0a8-2e12-7a59-a51e-44aa9b6d1001",
    );
    expect(f.values("http.server.request.count")).toEqual([1]);
    expect(f.values("http.server.request.failure")).toEqual([1]);
    expect(JSON.stringify(f.points)).not.toContain("secret");
  });
  it("exporter failure preserves successful results and original thrown errors", async () => {
    const { telemetry } = fixture(true);
    const value = {};
    expect(await observed(telemetry, "d1.query", async () => value)).toBe(
      value,
    );
    const error = new Error("business");
    await expect(
      observed(telemetry, "d1.query", async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(telemetry.metrics.dropped).toBe(3);
  });
  it("measures real acknowledgements, first disposition and lag without reading payload fields", async () => {
    const f = fixture();
    const ack = vi.fn(),
      retry = vi.fn();
    await observeQueue(
      f.telemetry,
      {
        messages: [
          {
            id: "secret-id",
            body: { password: "secret" },
            attempts: 2,
            timestamp: new Date(Date.now() - 1000),
            ack,
            retry,
          },
        ],
      },
      "diagnostic",
      async (batch) => {
        batch.messages[0]!.retry();
        batch.messages[0]!.ack();
      },
    );
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledOnce();
    expect(f.values("queue.message.retry_requested")).toEqual([1]);
    expect(f.values("queue.message.acknowledged")).toEqual([0]);
    expect(f.values("queue.consumer.lag.count")).toEqual([1]);
    expect(f.values("queue.consumer.lag.sum")[0]).toBeGreaterThanOrEqual(1000);
    expect(JSON.stringify(f.points)).not.toContain("secret");
  });
  it("does not invent consumer lag when timestamps are unavailable", async () => {
    const f = fixture();
    await observeQueue(
      f.telemetry,
      {
        messages: [{ id: "x", body: null, attempts: 1, ack() {}, retry() {} }],
      },
      "notification",
      async () => {},
    );
    expect(f.values("queue.consumer.lag.sum")).toEqual([]);
  });
  it("keeps D1 batch atomic, native receivers and native statement identity", async () => {
    const f = fixture();
    const native = {
      bind() {
        expect(this).toBe(native);
        return native;
      },
      async first() {
        expect(this).toBe(native);
        return 42;
      },
    };
    const db = {
      prepare(_sql: string) {
        expect(this).toBe(db);
        return native;
      },
      batch: vi.fn(async function (this: unknown, statements: object[]) {
        expect(this).toBe(db);
        expect(statements).toEqual([native, native]);
        return [1, 2];
      }),
    };
    const wrapped = instrumentDatabase(db, f.telemetry);
    const stmt = wrapped.prepare("SECRET SQL").bind();
    expect(await stmt.first()).toBe(42);
    expect(await wrapped.batch([stmt, native])).toEqual([1, 2]);
    expect(db.batch).toHaveBeenCalledOnce();
    expect(f.values("d1.transaction.duration")).toHaveLength(1);
    expect(JSON.stringify(f.points)).not.toContain("SECRET");
  });
  it("shares the single 250-point budget across query and queue wrappers", async () => {
    const f = fixture();
    for (let i = 0; i < 260; i++)
      await observed(f.telemetry, "d1.query", async () => 1);
    await observeQueue(
      f.telemetry,
      { messages: [] },
      "diagnostic",
      async () => {},
    );
    expect(f.points).toHaveLength(250);
    expect(f.telemetry.metrics.dropped).toBeGreaterThan(10);
  });
  it("does not replace a D1 transaction failure when the exporter also fails", async () => {
    const f = fixture(true);
    const error = new Error("transaction rolled back");
    const db = {
      async batch(_statements: object[]) {
        throw error;
      },
    };
    await expect(instrumentDatabase(db, f.telemetry).batch([])).rejects.toBe(
      error,
    );
    expect(f.telemetry.metrics.dropped).toBe(2);
    expect(() =>
      recordHttp(
        f.telemetry,
        new Response(null, { status: 500 }),
        Date.now(),
        "0199d0a8-2e12-7a59-a51e-44aa9b6d1001",
      ),
    ).not.toThrow();
  });
  it("exports actual scheduler counts without pretending claimed is due", () => {
    const f = fixture();
    recordSchedule(f.telemetry, {
      claimed: 5,
      probed: 3,
      failed: 1,
      timedOut: 2,
      diagnostics: 1,
      outboxDelivered: 2,
      outboxRetried: 4,
      occurrencesPurged: 8,
      invocationTimedOut: true,
    });
    expect(f.values("scheduler.claimed")).toEqual([5]);
    expect(f.values("scheduler.executed")).toEqual([3]);
    expect(f.values("scheduler.due")).toEqual([]);
  });
});

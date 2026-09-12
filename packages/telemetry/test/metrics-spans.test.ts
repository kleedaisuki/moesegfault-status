import { describe, expect, it, vi } from "vitest";
import { createAnalyticsMetrics, withWorkerSpan } from "../src/index.js";

describe("Analytics Engine adapter", () => {
  it("is structurally compatible with generated Cloudflare bindings", () => {
    const compileOnly = (dataset: AnalyticsEngineDataset): void => {
      createAnalyticsMetrics(dataset, {
        serviceName: "status-api",
        environment: "test",
        deploymentId: "0199d09a-b692-7ce0-a1c0-5138a43d7402",
      });
    };
    expect(compileOnly).toBeTypeOf("function");
  });

  it("accepts the generated Cloudflare binding type without casts", () => {
    const compileOnly = (dataset: AnalyticsEngineDataset): void => {
      createAnalyticsMetrics(dataset, {
        serviceName: "status-api",
        environment: "test",
        deploymentId: "0199d09a-b692-7ce0-a1c0-5138a43d7402",
      });
    };
    expect(compileOnly).toBeTypeOf("function");
  });

  it("uses a fixed schema, denies high-cardinality labels, and isolates binding errors", () => {
    const writeDataPoint = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("analytics unavailable");
      });
    const metrics = createAnalyticsMetrics(
      { writeDataPoint },
      {
        serviceName: "status-api",
        environment: "test",
        deploymentId: "0199d09a-b692-7ce0-a1c0-5138a43d7402",
        dimensionPolicy: { allowed: new Set(["operation", "trace.id"]) },
      },
    );
    expect(
      metrics.write({
        name: "http.server.duration",
        kind: "histogram",
        unit: "ms",
        value: 12,
        attributes: {
          operation: "status.read",
          "trace.id": "secret-high-cardinality",
        },
      }),
    ).toBe(true);
    expect(JSON.stringify(writeDataPoint.mock.calls[0])).not.toContain(
      "secret-high-cardinality",
    );
    expect(
      metrics.write({
        name: "http.server.duration",
        kind: "histogram",
        unit: "ms",
        value: 13,
      }),
    ).toBe(false);
    expect(metrics.dropped).toBe(1);
  });
});

describe("official Workers custom span adapter", () => {
  it("sets only admitted scalar attributes and keeps fallback behavior", () => {
    const setAttribute = vi.fn();
    const span = { isTraced: true, setAttribute, end: vi.fn() };
    const tracing = {
      enterSpan<T, A extends unknown[]>(
        _: string,
        callback: (value: typeof span, ...args: A) => T,
        ...args: A
      ): T {
        return callback(span, ...args);
      },
    };
    const result = withWorkerSpan(
      tracing,
      "status.read",
      { operation: "read", secret: "canary", values: [1, 2] },
      { allowed: new Set(["operation", "values"]) },
      () => 42,
    );
    expect(result).toBe(42);
    expect(setAttribute).toHaveBeenCalledWith("operation", "read");
    expect(JSON.stringify(setAttribute.mock.calls)).not.toContain("canary");
    expect(
      withWorkerSpan(
        undefined,
        "status.read",
        {},
        { allowed: new Set() },
        () => 7,
      ),
    ).toBe(7);
  });
});

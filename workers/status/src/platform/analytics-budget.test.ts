import { describe, expect, it, vi } from "vitest";
import {
  createAnalyticsMetrics,
  createTelemetry,
  defineResource,
} from "@moesegfault/telemetry";
import { createAnalyticsBudget } from "./analytics-budget.js";

/** 用真实 metrics exporter 验证独立子预算不会绕过共享上限。 / Use the real metrics exporter to prove child budgets cannot bypass the shared limit. */
function exporter(dataset: AnalyticsEngineDataset) {
  return createAnalyticsMetrics(dataset, {
    serviceName: "status",
    environment: "test",
    deploymentId: "0199d0a8-2e12-7a59-a51e-44aa9b6d1001",
  });
}

describe("invocation-shared Analytics budget", () => {
  it("reports dropped samples through logs without recursively writing Analytics", () => {
    const writeDataPoint = vi.fn();
    const warn = vi.fn();
    const budget = createAnalyticsBudget({ writeDataPoint });
    const telemetry = createTelemetry({
      resource: defineResource({
        "service.namespace": "moeSegFault",
        "service.name": "status",
        "service.version": "1",
        "deployment.environment.name": "test",
        "moesegfault.deployment.id": "0199d0a8-2e12-7a59-a51e-44aa9b6d1001",
        "moesegfault.build.revision": "a".repeat(40),
        "moesegfault.artifact.digest": `sha256:${"a".repeat(64)}`,
      }),
      instrumentation: { name: "budget", version: "1" },
      attributePolicy: { allowed: new Set(["analytics.sample.dropped"]) },
      console: { debug() {}, info() {}, error() {}, warn },
    });
    for (let i = 0; i < 252; i++) budget.dataset.writeDataPoint();
    budget.report(telemetry);
    budget.report(telemetry);
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(warn.mock.calls)).toContain(
      "analytics.sample.dropped",
    );
    budget.dataset.writeDataPoint();
    budget.report(telemetry);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(writeDataPoint).toHaveBeenCalledTimes(250);
  });

  it("caps interleaved raw observations and multiple exporters at 250 native calls", () => {
    const writeDataPoint = vi.fn();
    const budget = createAnalyticsBudget({ writeDataPoint });
    const first = exporter(budget.dataset),
      second = exporter(budget.dataset);
    for (let index = 0; index < 200; index++) {
      budget.dataset.writeDataPoint({ doubles: [index] });
      first.write({
        name: "query.count",
        kind: "counter",
        unit: "1",
        value: 1,
      });
      second.write({
        name: "status.count",
        kind: "counter",
        unit: "1",
        value: 1,
      });
    }
    expect(writeDataPoint).toHaveBeenCalledTimes(250);
    expect(budget.attempted).toBe(250);
    expect(budget.dropped).toBe(350);
  });
  it("counts throwing native calls against the budget and remains fail-open", () => {
    const writeDataPoint = vi.fn(() => {
      throw new Error("binding unavailable");
    });
    const budget = createAnalyticsBudget({ writeDataPoint });
    expect(() => {
      for (let i = 0; i < 300; i++) budget.dataset.writeDataPoint();
    }).not.toThrow();
    expect(writeDataPoint).toHaveBeenCalledTimes(250);
    expect(budget.dropped).toBe(300);
  });
  it("keeps native receiver and unchanged point identity", () => {
    const point = { blobs: ["probe"], doubles: [1] };
    const native = {
      writeDataPoint(value?: AnalyticsEngineDataPoint) {
        expect(this).toBe(native);
        expect(value).toBe(point);
      },
    };
    createAnalyticsBudget(native).dataset.writeDataPoint(point);
  });
  it("does not share mutable budget across separate invocations", () => {
    const writeDataPoint = vi.fn();
    const first = createAnalyticsBudget({ writeDataPoint });
    for (let i = 0; i < 250; i++) first.dataset.writeDataPoint();
    const second = createAnalyticsBudget({ writeDataPoint });
    second.dataset.writeDataPoint();
    expect(writeDataPoint).toHaveBeenCalledTimes(251);
    expect(second.attempted).toBe(1);
    expect(second.dropped).toBe(0);
  });
});

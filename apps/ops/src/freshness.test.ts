import { describe, expect, it } from "vitest";
import { aggregateHealth, evaluateFreshness } from "./freshness";

describe("evaluateFreshness", () => {
  const now = Date.parse("2026-09-12T08:00:00.000Z");

  it("accepts evidence strictly before the deadline", () => {
    expect(evaluateFreshness("2026-09-12T08:00:01.000Z", now)).toEqual({
      kind: "fresh",
      remainingMs: 1000,
    });
  });

  it("treats the exact deadline as stale", () => {
    expect(evaluateFreshness("2026-09-12T08:00:00.000Z", now)).toEqual({
      kind: "stale",
      overdueMs: 0,
    });
  });

  it("fails closed for malformed timestamps", () => {
    expect(evaluateFreshness("not-a-date", now).kind).toBe("invalid");
  });
});

describe("aggregateHealth", () => {
  it("is healthy only when every check is healthy", () => {
    expect(aggregateHealth([{ state: "healthy" }, { state: "healthy" }])).toBe(
      "healthy",
    );
    expect(
      aggregateHealth([{ state: "healthy" }, { state: "checking" }]),
    ).not.toBe("healthy");
    expect(
      aggregateHealth([{ state: "healthy" }, { state: "warning" }]),
    ).not.toBe("healthy");
    expect(
      aggregateHealth([{ state: "healthy" }, { state: "failed" }]),
    ).not.toBe("healthy");
  });
});

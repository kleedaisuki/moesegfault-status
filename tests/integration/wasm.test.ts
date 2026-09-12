import { describe, expect, it } from "vitest";

import { createRustMonitorEvaluator } from "../../workers/status/src/scheduling/rust.js";
import type { MonitorEvaluationInput } from "../../workers/status/src/scheduling/types.js";
import { realDomainCore } from "./wasm.js";

const OBSERVED_AT = "2026-09-12T12:00:00.000Z";

/** 构造单次失败即可达到 quorum 的监控输入。 / Build a monitor input where one failed sample satisfies quorum. */
function failedProbe(): MonitorEvaluationInput {
  return {
    monitor: {
      monitorId: "018f0000-0000-7000-8000-000000000401",
      target: { type: "service", id: "api", serviceName: "api" },
      probe: {
        kind: "http",
        url: "https://api.example/health",
        method: "HEAD",
        expectedStatuses: [200],
      },
      timeoutMs: 5_000,
      intervalMs: 60_000,
      scheduledFor: OBSERVED_AT,
      nextRunAt: "2026-09-12T12:01:00.000Z",
      critical: true,
      policy: {
        policyId: "018f0000-0000-7000-8000-000000000402",
        revision: 3,
        observationWindowMs: 300_000,
        minimumSamples: 1,
        failureThreshold: 1,
        recoveryThreshold: 0,
        latencyThresholdMs: 500,
        staleAfterMs: 120_000,
        locationQuorum: 1,
        fingerprintTemplate: { fields: ["operation"] },
        statusMapping: {
          failure_status: "degraded",
          diagnostic_severity: "error",
        },
      },
      deploymentId: "018f0000-0000-7000-8000-000000000403",
      environment: "production",
    },
    previous: null,
    peerCheckpoints: [],
    observation: {
      observationId: "018f0000-0000-7000-8000-000000000404",
      monitorId: "018f0000-0000-7000-8000-000000000401",
      observedAt: OBSERVED_AT,
      execution: { runtime: "cloudflare-worker", location: "sin" },
      outcome: "failure",
      latencyMs: 25,
      protocolStatus: "503",
      errorType: "http.status",
      correlationId: "018f0000-0000-7000-8000-000000000405",
    },
  };
}

describe("real Rust/Wasm adapters", () => {
  it("evaluates scheduler hysteresis and freshness through the compiled core", async () => {
    const evaluator = createRustMonitorEvaluator(realDomainCore());

    const result = await evaluator.evaluate(failedProbe());

    expect(result).toMatchObject({
      checkpoint: {
        location: "sin",
        windowSamples: 1,
        windowUnhealthySamples: 1,
        evaluationStatus: "degraded",
        policyRevision: 3,
        revision: 1,
      },
      diagnosticSeverity: "error",
      diagnosticKind: "health.probe_failed",
    });
    expect(
      Date.parse(result.checkpoint.freshUntil) - Date.parse(OBSERVED_AT),
    ).toBe(120_000);
  });
});

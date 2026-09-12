import { describe, expect, it, vi } from "vitest";
import { createRustMonitorEvaluator } from "./rust.js";
import type { ClaimedMonitor, Observation } from "./types.js";

describe("Rust monitor adapter", () => {
  it("folds one aggregate sample and calls the exact evaluate_monitor operation", async () => {
    const dispatchJson = vi.fn((json: string) => {
      const request = JSON.parse(json) as {
        payload: { policy: { revision: string } };
      };
      return JSON.stringify({
        policy_revision: request.payload.policy.revision,
        state: "failing",
        status: "degraded",
        reason: "failure_quorum_met",
        eligible_locations: 1,
        failing_locations: 1,
        recovering_locations: 0,
        fresh_until: "2026-09-12T00:02:00.000Z",
      });
    });
    const monitor = monitorFixture();
    const observation: Observation = {
      observationId: "o",
      monitorId: monitor.monitorId,
      observedAt: "2026-09-12T00:00:00.000Z",
      execution: { runtime: "cloudflare-worker" },
      outcome: "success",
      latencyMs: 600,
      protocolStatus: "http_200",
      errorType: null,
      correlationId: "c",
    };
    const result = await createRustMonitorEvaluator({ dispatchJson }).evaluate({
      monitor,
      previous: null,
      peerCheckpoints: [],
      observation,
    });
    const request = JSON.parse(dispatchJson.mock.calls[0]![0]) as Record<
      string,
      unknown
    >;
    expect(request.operation).toBe("evaluate_monitor");
    expect(request).not.toHaveProperty("raw_history");
    expect(result.checkpoint.windowSamples).toBe(1);
    expect(result.checkpoint.windowUnhealthySamples).toBe(1);
    expect(result.diagnosticKind).toBe("health.probe_failed");
  });

  it("persists warm-up aggregates until minimum_samples is reached", async () => {
    let call = 0;
    const evaluator = createRustMonitorEvaluator({
      dispatchJson(request): string {
        call += 1;
        const input = JSON.parse(request) as {
          payload: {
            policy: { revision: string };
            locations: { sample_count: number }[];
          };
        };
        const warmed = input.payload.locations[0]!.sample_count >= 2;
        return JSON.stringify({
          policy_revision: input.payload.policy.revision,
          state: warmed ? "healthy" : "unknown",
          status: warmed ? "operational" : "unknown",
          reason: warmed ? "recovery_quorum_met" : "insufficient_samples",
          eligible_locations: warmed ? 1 : 0,
          failing_locations: 0,
          recovering_locations: warmed ? 1 : 0,
          fresh_until: "2026-09-12T00:02:00.000Z",
        });
      },
    });
    const monitor = {
      ...monitorFixture(),
      policy: { ...monitorFixture().policy, minimumSamples: 2 },
    };
    const observation: Observation = {
      observationId: "o1",
      monitorId: monitor.monitorId,
      observedAt: "2026-09-12T00:00:00.000Z",
      execution: { runtime: "cloudflare-worker" },
      outcome: "success",
      latencyMs: 10,
      protocolStatus: "http_200",
      errorType: null,
      correlationId: "c1",
    };
    const first = await evaluator.evaluate({
      monitor,
      previous: null,
      peerCheckpoints: [],
      observation,
    });
    const second = await evaluator.evaluate({
      monitor,
      previous: first.checkpoint,
      peerCheckpoints: [first.checkpoint],
      observation: {
        ...observation,
        observationId: "o2",
        observedAt: "2026-09-12T00:01:00.000Z",
        correlationId: "c2",
      },
    });
    expect(first.checkpoint.windowSamples).toBe(1);
    expect(first.checkpoint.evaluationStatus).toBe("unknown");
    expect(second.checkpoint.windowSamples).toBe(2);
    expect(second.checkpoint.evaluationStatus).toBe("operational");
    expect(call).toBe(2);
  });
});

function monitorFixture(): ClaimedMonitor {
  return {
    locations: ["cloudflare-worker"],
    monitorId: "0199d0a8-2e12-7a59-a51e-44aa9b6d1001",
    target: { type: "service", id: "identity", serviceName: "identity" },
    probe: { kind: "http", url: "https://health.example.com" },
    timeoutMs: 1_000,
    intervalMs: 60_000,
    scheduledFor: "2026-09-12T00:00:00.000Z",
    nextRunAt: "2026-09-12T00:01:00.000Z",
    critical: true,
    policy: {
      policyId: "health",
      revision: 2,
      observationWindowMs: 300_000,
      minimumSamples: 1,
      failureThreshold: 0.5,
      recoveryThreshold: 0.1,
      latencyThresholdMs: 500,
      staleAfterMs: 120_000,
      locationQuorum: 1,
      fingerprintTemplate: {},
      statusMapping: { failure_status: "degraded" },
    },
  };
}

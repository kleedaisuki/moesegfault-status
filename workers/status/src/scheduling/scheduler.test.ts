import { describe, expect, it, vi } from "vitest";
import { DiagnosticQueueEnvelopeSchema } from "@moesegfault/contracts";
import { runSchedulerTick, type SchedulerDependencies } from "./scheduler.js";
import type {
  ClaimedMonitor,
  MonitorCheckpoint,
  MonitorEvaluationResult,
  Observation,
} from "./types.js";

describe("scheduler failure isolation", () => {
  it("accepts a target timeout returned during transport grace despite Analytics Engine failure", async () => {
    const monitor = monitorFixture();
    const commitEvaluation = vi.fn(async () => undefined);
    const observations: Observation[] = [];
    const dependencies: SchedulerDependencies = {
      monitors: {
        claimDue: async () => [monitor],
        readCheckpoint: async () => null,
        readCheckpoints: async () => [],
        ownsLease: async () => true,
        writeCheckpoint: async () => undefined,
        commitEvaluation,
        complete: async () => undefined,
        release: async () => undefined,
      },
      expiry: { enqueueExpiredReevaluations: async () => 0 },
      outbox: {
        claimOutbox: async () => [],
        markOutboxDelivered: async () => undefined,
        markOutboxFailed: async () => undefined,
      },
      retention: {
        selectRetentionCandidates: async () => [],
        purgeRetentionCandidates: async () => 0,
      },
      regionalDispatcher: {
        dispatch: async (monitor, location, _run, correlationId) => {
          await new Promise((resolve) =>
            setTimeout(resolve, monitor.timeoutMs + 25),
          );
          return {
            observationId: correlationId,
            monitorId: monitor.monitorId,
            observedAt: new Date().toISOString(),
            execution: {
              runtime: "cloudflare-worker",
              location,
              executorId: "test-executor",
              actualColo: "SIN",
            },
            outcome: "timeout",
            latencyMs: 10,
            protocolStatus: null,
            errorType: "target_timeout",
            correlationId,
          };
        },
      },
      evaluator: {
        async evaluateBatch(_monitor, _previous, samples) {
          return Promise.all(
            samples.map((observation) =>
              this.evaluate({
                monitor,
                previous: null,
                peerCheckpoints: [],
                observation,
              }),
            ),
          );
        },
        async evaluate({ observation }): Promise<MonitorEvaluationResult> {
          observations.push(observation);
          return {
            checkpoint: checkpointFixture(observation),
            diagnosticSeverity: "error",
            diagnosticKind: "health.probe_failed",
            diagnosticSummary: "Probe timed out",
          };
        },
      },
      diagnostics: {
        process: async (envelope) => {
          DiagnosticQueueEnvelopeSchema.parse(envelope);
          return "processed";
        },
      },
      observations: {
        write: async () => {
          throw new Error("ae down");
        },
      },
      issueLifecycle: { apply: async () => undefined },
      reevaluator: { reevaluate: async () => undefined },
      outboxDeliverers: {},
      outboxPolicy: {
        maxAttempts: 3,
        baseBackoffMs: 10,
        maxBackoffMs: 100,
        deliveryDeadlineMs: 20,
        concurrency: 1,
      },
      now: Date.now,
      id: async () => "0199d0a8-2e12-7a59-a51e-44aa9b6d1001",
    };
    const summary = await runSchedulerTick(dependencies, {
      globalConcurrency: 1,
      perTargetConcurrency: 1,
      monitorBatchSize: 1,
      outboxBatchSize: 1,
      invocationDeadlineMs: 500,
      leaseMs: 6_000,
    });
    expect(observations[0]?.outcome).toBe("timeout");
    expect(commitEvaluation).toHaveBeenCalledOnce();
    expect(summary.timedOut).toBe(1);
  });
});

function monitorFixture(): ClaimedMonitor {
  return {
    locations: ["cloudflare-worker"],
    monitorId: "0199d0a8-2e12-7a59-a51e-44aa9b6d1001",
    target: { type: "service", id: "identity", serviceName: "identity" },
    probe: { kind: "http", url: "https://health.example.com" },
    timeoutMs: 10,
    intervalMs: 60_000,
    scheduledFor: new Date().toISOString(),
    nextRunAt: new Date(Date.now() + 60_000).toISOString(),
    critical: true,
    deploymentId: "0199d0a8-2e12-7a59-a51e-44aa9b6d1002",
    environment: "production",
    policy: {
      policyId: "health",
      revision: 1,
      observationWindowMs: 60_000,
      minimumSamples: 1,
      failureThreshold: 1,
      recoveryThreshold: 0,
      latencyThresholdMs: null,
      staleAfterMs: 120_000,
      locationQuorum: 1,
      fingerprintTemplate: {},
      statusMapping: { failure_status: "degraded" },
    },
  };
}

function checkpointFixture(observation: Observation): MonitorCheckpoint {
  return {
    monitorId: observation.monitorId,
    location: "cloudflare-worker",
    windowStartedAt: observation.observedAt,
    lastObservedAt: observation.observedAt,
    consecutiveSuccesses: 0,
    consecutiveFailures: 1,
    windowSamples: 1,
    windowUnhealthySamples: 1,
    windowLatencyP95Ms: null,
    evaluationStatus: "unknown",
    evaluatedAt: observation.observedAt,
    freshUntil: observation.observedAt,
    policyId: "health",
    policyRevision: 1,
    revision: 1,
  };
}

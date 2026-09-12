import type {
  MonitorCheckpoint,
  MonitorEvaluationInput,
  MonitorEvaluationResult,
  MonitorEvaluator,
  RustDispatcher,
} from "./types.js";

type EvaluatorState = "healthy" | "failing" | "unknown";
type FailureStatus = "degraded" | "partial_outage" | "major_outage";

interface RustEvaluationResult {
  readonly policy_revision: string;
  readonly state: EvaluatorState;
  readonly status: MonitorCheckpoint["evaluationStatus"];
  readonly reason:
    | "failure_quorum_met"
    | "recovery_quorum_met"
    | "hysteresis_held"
    | "insufficient_fresh_locations"
    | "insufficient_samples";
  readonly eligible_locations: number;
  readonly failing_locations: number;
  readonly recovering_locations: number;
  readonly fresh_until: string;
}

/** 创建严格调用 Rust `evaluate_monitor` 的 adapter。 / Create an adapter that strictly invokes Rust `evaluate_monitor`. */
export function createRustMonitorEvaluator(
  dispatcher: RustDispatcher,
): MonitorEvaluator {
  return {
    async evaluateBatch(monitor, previous, observations) {
      observations = observations.filter(
        (value) =>
          value.execution.executorId &&
          value.execution.actualColo &&
          value.execution.location &&
          monitor.locations.includes(value.execution.location),
      );
      if (!observations.length) return [];
      const inputs = observations.map((observation) => ({
        monitor,
        observation,
        previous:
          previous.find(
            (value) => value.location === observation.execution.location,
          ) ?? null,
        peerCheckpoints: [],
      }));
      const aggregates = inputs.map(foldObservation);
      const now = observations.reduce(
        (latest, value) =>
          value.observedAt > latest ? value.observedAt : latest,
        observations[0]!.observedAt,
      );
      const windows = [
        ...aggregates,
        ...previous.filter(
          (value) =>
            value.policyId === monitor.policy.policyId &&
            value.policyRevision === monitor.policy.revision &&
            !aggregates.some((next) => next.location === value.location),
        ),
      ];
      const seen = new Set<string>();
      const eligible = windows.filter((value) => {
        if (
          !value.executorId ||
          !value.actualColo ||
          !monitor.locations.includes(value.location) ||
          Date.parse(now) - Date.parse(value.lastObservedAt) >
            monitor.policy.staleAfterMs ||
          Date.parse(value.lastObservedAt) > Date.parse(now) ||
          seen.has(value.actualColo)
        )
          return false;
        seen.add(value.actualColo);
        return true;
      });
      const revision = `${monitor.policy.policyId}:${monitor.policy.revision}`;
      const result = parseRustResult(
        dispatcher.dispatchJson(
          JSON.stringify({
            operation: "evaluate_monitor",
            payload: {
              policy: rustPolicy(inputs[0]!, revision),
              previous_state: previousState(inputs[0]!.previous),
              locations: eligible.map((value) => ({
                location: value.actualColo,
                window_started_at: value.windowStartedAt,
                sample_count: value.windowSamples,
                unhealthy_count: value.windowUnhealthySamples,
                last_observed_at: value.lastObservedAt,
              })),
              now,
            },
          }),
        ),
      );
      if (result.policy_revision !== revision)
        throw new Error("evaluator_policy_revision_mismatch");
      return aggregates.map((aggregate, index) => ({
        checkpoint: {
          ...aggregate,
          evaluationStatus: result.status,
          evaluatedAt: now,
          freshUntil: result.fresh_until,
          policyId: monitor.policy.policyId,
          policyRevision: monitor.policy.revision,
          revision: (inputs[index]!.previous?.revision ?? 0) + 1,
        },
        ...(result.state === "failing" && isUnhealthy(inputs[index]!)
          ? {
              diagnosticSeverity: diagnosticSeverity(
                inputs[index]!,
                result.status,
              ),
              diagnosticKind: "health.probe_failed",
              diagnosticSummary: `Active ${monitor.probe.kind} health probe failed`,
            }
          : {}),
      }));
    },
    async evaluate(input): Promise<MonitorEvaluationResult> {
      const aggregate = foldObservation(input);
      const revision = `${input.monitor.policy.policyId}:${input.monitor.policy.revision}`;
      const request = {
        operation: "evaluate_monitor",
        payload: {
          policy: rustPolicy(input, revision),
          previous_state: previousState(input.previous),
          locations: [
            {
              location: aggregate.location,
              window_started_at: aggregate.windowStartedAt,
              sample_count: aggregate.windowSamples,
              unhealthy_count: aggregate.windowUnhealthySamples,
              last_observed_at: aggregate.lastObservedAt,
            },
            ...input.peerCheckpoints
              .filter(
                (checkpoint) => checkpoint.location !== aggregate.location,
              )
              .map((checkpoint) => ({
                location: checkpoint.location,
                window_started_at: checkpoint.windowStartedAt,
                sample_count: checkpoint.windowSamples,
                unhealthy_count: checkpoint.windowUnhealthySamples,
                last_observed_at: checkpoint.lastObservedAt,
              })),
          ],
          now: input.observation.observedAt,
        },
      } as const;
      const result = parseRustResult(
        dispatcher.dispatchJson(JSON.stringify(request)),
      );
      if (result.policy_revision !== revision)
        throw new Error("evaluator_policy_revision_mismatch");
      const checkpoint: MonitorCheckpoint = {
        ...aggregate,
        evaluationStatus: result.status,
        evaluatedAt: input.observation.observedAt,
        freshUntil: result.fresh_until,
        policyId: input.monitor.policy.policyId,
        policyRevision: input.monitor.policy.revision,
        revision: (input.previous?.revision ?? 0) + 1,
      };
      const unhealthy = isUnhealthy(input);
      return {
        checkpoint,
        ...(result.state === "failing" && unhealthy
          ? {
              diagnosticSeverity: diagnosticSeverity(input, result.status),
              diagnosticKind: "health.probe_failed",
              diagnosticSummary: `Active ${input.monitor.probe.kind} health probe failed`,
            }
          : {}),
      };
    },
  };
}

function foldObservation(
  input: MonitorEvaluationInput,
): Omit<
  MonitorCheckpoint,
  | "evaluationStatus"
  | "evaluatedAt"
  | "freshUntil"
  | "policyId"
  | "policyRevision"
  | "revision"
> {
  const observedMs = Date.parse(input.observation.observedAt);
  const previous = input.previous;
  const reset =
    previous === null ||
    previous.executorId !== input.observation.execution.executorId ||
    previous.actualColo !== input.observation.execution.actualColo ||
    previous.policyId !== input.monitor.policy.policyId ||
    previous.policyRevision !== input.monitor.policy.revision ||
    observedMs - Date.parse(previous.windowStartedAt) >=
      input.monitor.policy.observationWindowMs;
  const unhealthy = isUnhealthy(input);
  const success = !unhealthy;
  return {
    monitorId: input.monitor.monitorId,
    ...(input.observation.execution.executorId
      ? { executorId: input.observation.execution.executorId }
      : {}),
    ...(input.observation.execution.actualColo
      ? { actualColo: input.observation.execution.actualColo }
      : {}),
    location:
      input.observation.execution.location ??
      input.observation.execution.runtime,
    windowStartedAt: reset
      ? input.observation.observedAt
      : previous.windowStartedAt,
    lastObservedAt: input.observation.observedAt,
    consecutiveSuccesses: success
      ? reset
        ? 1
        : previous.consecutiveSuccesses + 1
      : 0,
    consecutiveFailures: success
      ? 0
      : reset
        ? 1
        : previous.consecutiveFailures + 1,
    windowSamples: (reset ? 0 : previous.windowSamples) + 1,
    windowUnhealthySamples:
      (reset ? 0 : previous.windowUnhealthySamples) + (unhealthy ? 1 : 0),
    // The Rust evaluator consumes the exact unhealthy counter. A scalar prior p95 is
    // insufficient to update an exact sliding p95, so do not fabricate one.
    windowLatencyP95Ms: null,
  };
}

function isUnhealthy(input: MonitorEvaluationInput): boolean {
  const latencyLimit = input.monitor.policy.latencyThresholdMs;
  return (
    input.observation.outcome !== "success" ||
    (latencyLimit !== null && input.observation.latencyMs > latencyLimit)
  );
}

function rustPolicy(
  input: MonitorEvaluationInput,
  revision: string,
): Readonly<Record<string, unknown>> {
  const policy = input.monitor.policy;
  return {
    revision,
    window_seconds: Math.ceil(policy.observationWindowMs / 1_000),
    minimum_samples: policy.minimumSamples,
    failure_threshold: fraction(policy.failureThreshold),
    recovery_threshold: fraction(policy.recoveryThreshold),
    latency_threshold_ms: policy.latencyThresholdMs,
    stale_after_seconds: Math.ceil(policy.staleAfterMs / 1_000),
    quorum: {
      minimum_locations: policy.locationQuorum,
      failure_locations: policy.locationQuorum,
      recovery_locations: policy.locationQuorum,
    },
    failure_status: failureStatus(policy.statusMapping),
  };
}

function previousState(previous: MonitorCheckpoint | null): EvaluatorState {
  if (previous === null || previous.evaluationStatus === "unknown")
    return "unknown";
  return previous.evaluationStatus === "operational" ? "healthy" : "failing";
}

function fraction(value: number): { numerator: number; denominator: number } {
  if (!Number.isFinite(value) || value < 0 || value > 1)
    throw new Error("invalid_policy_threshold");
  const denominator = 1_000_000;
  return { numerator: Math.round(value * denominator), denominator };
}

function failureStatus(
  mapping: Readonly<Record<string, unknown>>,
): FailureStatus {
  const value = mapping.failure_status;
  if (
    value === "degraded" ||
    value === "partial_outage" ||
    value === "major_outage"
  )
    return value;
  throw new Error("missing_policy_failure_status");
}

function diagnosticSeverity(
  input: MonitorEvaluationInput,
  status: MonitorCheckpoint["evaluationStatus"],
): "warning" | "error" | "critical" {
  const configured = input.monitor.policy.statusMapping.diagnostic_severity;
  if (
    configured === "warning" ||
    configured === "error" ||
    configured === "critical"
  )
    return configured;
  if (status === "major_outage") return "critical";
  if (status === "partial_outage") return "error";
  return "warning";
}

function parseRustResult(json: string): RustEvaluationResult {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error("invalid_evaluator_json");
  }
  if (!isObject(value)) throw new Error("invalid_evaluator_result");
  const candidate = (isObject(value.result) ? value.result : value) as Record<
    string,
    unknown
  >;
  const states = new Set(["healthy", "failing", "unknown"]);
  const statuses = new Set([
    "operational",
    "degraded",
    "partial_outage",
    "major_outage",
    "unknown",
  ]);
  const reasons = new Set([
    "failure_quorum_met",
    "recovery_quorum_met",
    "hysteresis_held",
    "insufficient_fresh_locations",
    "insufficient_samples",
  ]);
  if (
    typeof candidate.policy_revision !== "string" ||
    typeof candidate.state !== "string" ||
    !states.has(candidate.state) ||
    typeof candidate.status !== "string" ||
    !statuses.has(candidate.status) ||
    typeof candidate.reason !== "string" ||
    !reasons.has(candidate.reason) ||
    typeof candidate.eligible_locations !== "number" ||
    typeof candidate.failing_locations !== "number" ||
    typeof candidate.recovering_locations !== "number" ||
    typeof candidate.fresh_until !== "string" ||
    !Number.isFinite(Date.parse(candidate.fresh_until))
  ) {
    throw new Error("invalid_evaluator_result");
  }
  return candidate as unknown as RustEvaluationResult;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

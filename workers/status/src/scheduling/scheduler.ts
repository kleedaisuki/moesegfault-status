import { mapWithKeyConcurrency, withDeadline } from "./concurrency.js";
import { deterministicUuidV7, randomUuidV7 } from "./identity.js";
import {
  deliverOutboxBatch,
  runRetentionBatch,
  type OutboxDeliverer,
  type OutboxPolicy,
} from "./jobs.js";
import type { TargetReevaluator } from "./jobs.js";
import type { ProbeIssueLifecycle } from "./reevaluate.js";
import type {
  ExpiryStore,
  MonitorStore,
  OutboxStore,
  RetentionStore,
} from "./store.js";
import type {
  ClaimedMonitor,
  DiagnosticAggregator,
  HealthDiagnosticEnvelope,
  MonitorEvaluator,
  ObservationSink,
  Observation,
  SchedulerLimits,
  SchedulerSummary,
} from "./types.js";

/** 完整调度依赖；根 Env 只需适配到这些窄接口。 / Complete scheduling dependencies; the root Env adapts only to these narrow interfaces. */
export interface SchedulerDependencies {
  readonly monitors: MonitorStore;
  readonly expiry: ExpiryStore;
  readonly outbox: OutboxStore;
  readonly retention: RetentionStore;
  readonly evaluator: MonitorEvaluator;
  readonly diagnostics: DiagnosticAggregator;
  readonly observations: ObservationSink;
  readonly issueLifecycle: ProbeIssueLifecycle;
  readonly reevaluator: TargetReevaluator;
  /** 可信区域执行器；不可达返回空样本。 / Trusted regional executor; unreachable means no sample. */
  readonly regionalDispatcher?: {
    dispatch(
      monitor: ClaimedMonitor,
      location: string,
      runId: string,
      correlationId: string,
      signal: AbortSignal,
    ): Promise<Observation | null>;
  };
  readonly outboxDeliverers: Readonly<Record<string, OutboxDeliverer>>;
  readonly outboxPolicy: OutboxPolicy;
  readonly now: () => number;
  readonly id?: (timeMs: number, seed: string) => Promise<string>;
  /** 有界结构化错误钩子；不得记录目标 URL 或异常正文。 / Bounded structured error hook; target URLs and exception bodies must not be logged. */
  readonly reportError?: (
    stage: "monitor" | "observation_sink",
    monitorId: string,
    errorType: string,
  ) => void;
}

/**
 * 运行一次 Cloudflare Cron tick。
 * Run one Cloudflare Cron tick.
 *
 * @example
 * `await runSchedulerTick(dependencies, limits)` can be returned directly by a
 * Module Worker `scheduled()` handler; no fabricated region list is accepted.
 */
export async function runSchedulerTick(
  dependencies: SchedulerDependencies,
  limits: SchedulerLimits,
): Promise<SchedulerSummary> {
  validateLimits(limits);
  const started = dependencies.now();
  const id = dependencies.id ?? deterministicUuidV7;
  const owner = `scheduler:${randomUuidV7(started)}`;
  const invocation = new AbortController();
  const invocationTimer = setTimeout(
    () => invocation.abort(new Error("invocation_deadline")),
    limits.invocationDeadlineMs,
  );
  const counters = {
    claimed: 0,
    probed: 0,
    failed: 0,
    timedOut: 0,
    diagnostics: 0,
  };
  let outboxDelivered = 0;
  let outboxRetried = 0;
  let occurrencesPurged = 0;
  try {
    await dependencies.expiry.enqueueExpiredReevaluations(
      new Date(dependencies.now()),
      limits.outboxBatchSize,
      id,
    );
    const monitors = await dependencies.monitors.claimDue(
      new Date(dependencies.now()),
      owner,
      limits.leaseMs,
      limits.monitorBatchSize,
    );
    counters.claimed = monitors.length;
    await mapWithKeyConcurrency(
      monitors,
      (monitor) => `${monitor.target.type}:${monitor.target.id}`,
      limits.globalConcurrency,
      limits.perTargetConcurrency,
      async (monitor) => {
        try {
          await processMonitor(
            monitor,
            dependencies,
            owner,
            id,
            counters,
            invocation.signal,
            started + limits.invocationDeadlineMs,
          );
        } catch {
          dependencies.reportError?.(
            "monitor",
            monitor.monitorId,
            "monitor_processing_failed",
          );
        }
      },
    );
    if (!invocation.signal.aborted) {
      const events = await dependencies.outbox.claimOutbox(
        new Date(dependencies.now()),
        owner,
        limits.leaseMs,
        limits.outboxBatchSize,
      );
      const outbox = await deliverOutboxBatch(
        events,
        dependencies.outbox,
        owner,
        dependencies.outboxDeliverers,
        dependencies.outboxPolicy,
        dependencies.now,
        invocation.signal,
      );
      outboxDelivered = outbox.delivered;
      outboxRetried = outbox.retried;
    }
    if (!invocation.signal.aborted) {
      occurrencesPurged = await runRetentionBatch(
        dependencies.retention,
        new Date(dependencies.now()),
        limits.outboxBatchSize,
      );
    }
  } finally {
    clearTimeout(invocationTimer);
  }
  return {
    ...counters,
    outboxDelivered,
    outboxRetried,
    occurrencesPurged,
    invocationTimedOut: invocation.signal.aborted,
  };
}

async function processMonitor(
  monitor: ClaimedMonitor,
  dependencies: SchedulerDependencies,
  owner: string,
  id: (timeMs: number, seed: string) => Promise<string>,
  counters: {
    claimed: number;
    probed: number;
    failed: number;
    timedOut: number;
    diagnostics: number;
  },
  invocationSignal: AbortSignal,
  invocationDeadlineAt: number,
): Promise<void> {
  let completed = false;
  try {
    const correlationId = await id(
      Date.parse(monitor.scheduledFor),
      `${monitor.monitorId}:${monitor.scheduledFor}:correlation`,
    );
    if (
      !dependencies.regionalDispatcher ||
      !dependencies.evaluator.evaluateBatch
    )
      throw new Error("regional_executor_not_configured");
    const runId = await id(
      Date.parse(monitor.scheduledFor),
      `${monitor.monitorId}:${monitor.scheduledFor}:run`,
    );
    const observations: Observation[] = [];
    // 每个 monitor 串行区域请求，外层限制保证全局及每目标并发不膨胀。 / Serial regional fanout preserves the outer global and per-target concurrency caps.
    await mapWithKeyConcurrency(
      monitor.locations,
      (location) => location,
      1,
      1,
      async (location) => {
        try {
          const observation = await withDeadline(
            // 目标超时后仍需传回结果；传输宽限不扩大整个 invocation。 / Transport grace lets target timeouts return without extending the invocation.
            Math.max(
              1,
              Math.min(
                monitor.timeoutMs + 2_000,
                invocationDeadlineAt - dependencies.now(),
              ),
            ),
            invocationSignal,
            (signal) =>
              dependencies.regionalDispatcher!.dispatch(
                monitor,
                location,
                runId,
                correlationId,
                signal,
              ),
          );
          if (
            !observation ||
            observation.monitorId !== monitor.monitorId ||
            observation.execution.location !== location ||
            !observation.execution.executorId ||
            !observation.execution.actualColo ||
            observation.correlationId !== correlationId ||
            !Number.isFinite(Date.parse(observation.observedAt)) ||
            Date.parse(observation.observedAt) > dependencies.now() + 5_000 ||
            dependencies.now() - Date.parse(observation.observedAt) >
              monitor.policy.staleAfterMs
          )
            return;
          observations.push(observation);
          counters.probed += 1;
          if (observation.outcome !== "success") counters.failed += 1;
          if (observation.outcome === "timeout") counters.timedOut += 1;
          try {
            await dependencies.observations.write(observation);
          } catch {
            dependencies.reportError?.(
              "observation_sink",
              monitor.monitorId,
              "observation_sink_failed",
            );
          }
        } catch {
          // 执行器不可达不等于目标故障。 / Executor unavailability is not target failure.
        }
      },
    );
    observations.sort((left, right) =>
      left.execution.location!.localeCompare(right.execution.location!),
    );
    const checkpoints = await dependencies.monitors.readCheckpoints(
      monitor.monitorId,
    );
    const evaluations = await dependencies.evaluator.evaluateBatch(
      monitor,
      checkpoints,
      observations,
    );
    const diagnosticIndex = evaluations.findIndex(
      (value) => value.diagnosticSeverity !== undefined,
    );
    const evaluation = evaluations[diagnosticIndex < 0 ? 0 : diagnosticIndex];
    const observation = observations[diagnosticIndex < 0 ? 0 : diagnosticIndex];
    if (
      evaluation &&
      observation &&
      evaluation.diagnosticSeverity &&
      monitor.deploymentId &&
      monitor.environment
    ) {
      if (
        !(await dependencies.monitors.ownsLease(
          monitor,
          owner,
          new Date(dependencies.now()),
        ))
      ) {
        throw new Error("monitor_lease_lost");
      }
      const envelope = await healthDiagnosticEnvelope(
        {
          ...monitor,
          deploymentId: monitor.deploymentId,
          environment: monitor.environment,
        },
        observation,
        evaluation,
        id,
      );
      await dependencies.diagnostics.process(envelope);
      counters.diagnostics += 1;
    }
    await dependencies.monitors.commitEvaluation(
      monitor,
      evaluations.map((value) => value.checkpoint),
      owner,
      new Date(dependencies.now()),
    );
    completed = true;
    try {
      if (observation && evaluation)
        await dependencies.issueLifecycle.apply(
          monitor,
          observation,
          evaluation,
        );
      await dependencies.reevaluator.reevaluate(
        monitor.target,
        { type: "observation", id: observation?.observationId ?? runId },
        invocationSignal,
      );
    } catch {
      // The authoritative checkpoint/schedule commit already succeeded. The next
      // probe or an expiry outbox item retries derived status; never double-count.
      dependencies.reportError?.(
        "monitor",
        monitor.monitorId,
        "derived_state_reevaluation_failed",
      );
    }
  } finally {
    if (!completed)
      await dependencies.monitors.release(
        monitor.monitorId,
        owner,
        new Date(dependencies.now()),
      );
  }
}

async function healthDiagnosticEnvelope(
  monitor: ClaimedMonitor & {
    readonly deploymentId: string;
    readonly environment: NonNullable<ClaimedMonitor["environment"]>;
  },
  observation: Parameters<ObservationSink["write"]>[0],
  evaluation: Awaited<ReturnType<MonitorEvaluator["evaluate"]>>,
  id: (timeMs: number, seed: string) => Promise<string>,
): Promise<HealthDiagnosticEnvelope> {
  const time = Date.parse(monitor.scheduledFor);
  const eventId = await id(
    time,
    `${monitor.monitorId}:${monitor.scheduledFor}:health-diagnostic`,
  );
  const messageId = await id(time, `${eventId}:message`);
  const protocol =
    monitor.probe.kind === "synthetic"
      ? undefined
      : monitor.probe.kind === "rpc"
        ? "rpc"
        : monitor.probe.kind;
  const fingerprint = {
    operation: "active-health-probe",
    capability: monitor.target.id,
    ...(monitor.target.type === "component"
      ? { component: monitor.target.id }
      : {}),
    ...(protocol === undefined ? {} : { protocol }),
  };
  return {
    schema_version: "1.0",
    message_id: messageId,
    event: {
      event_id: eventId,
      schema_version: "1.0",
      kind: evaluation.diagnosticKind ?? "health.probe_failed",
      severity: evaluation.diagnosticSeverity!,
      service_name: monitor.target.serviceName,
      environment: monitor.environment,
      deployment_id: monitor.deploymentId,
      occurred_at: observation.observedAt,
      correlation_id: observation.correlationId,
      summary: evaluation.diagnosticSummary ?? "Active health probe failed",
      fingerprint,
      evidence: [
        {
          kind: "metric_query",
          backend: "cloudflare-analytics-engine",
          locator: {
            metric_name: "status.probe.outcome",
            query: { monitor_id: monitor.monitorId },
          },
          time_range: {
            start: observation.observedAt,
            end: observation.observedAt,
          },
        },
      ],
      attributes: {
        "operation.name": "active-health-probe",
        "deployment.environment.name": monitor.environment,
        ...(monitor.target.type === "component"
          ? { "component.id": monitor.target.id }
          : {}),
      },
    },
    received_at: observation.observedAt,
    origin: { kind: "monitor", monitor_id: monitor.monitorId },
    producer: {
      subject: "status-scheduler",
      service_name: monitor.target.serviceName,
      environment: monitor.environment,
      deployment_id: monitor.deploymentId,
      scopes: ["diagnostics:write"],
      token_id: `scheduler:${monitor.monitorId}`,
      auth_method: "service_binding",
    },
    trace_context: { correlation_id: observation.correlationId },
  };
}

function validateLimits(limits: SchedulerLimits): void {
  const values = Object.values(limits);
  if (values.some((value) => !Number.isInteger(value) || value < 1))
    throw new RangeError("scheduler limits must be positive integers");
  if (limits.perTargetConcurrency > limits.globalConcurrency)
    throw new RangeError(
      "per-target concurrency cannot exceed global concurrency",
    );
  if (limits.leaseMs < limits.invocationDeadlineMs + 5_000)
    throw new RangeError(
      "monitor lease must outlive the invocation deadline by at least 5 seconds",
    );
}

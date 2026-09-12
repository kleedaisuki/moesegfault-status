import { processDiagnosticEnvelope } from "../diagnostics/consumer.js";
import type { DiagnosticConsumerEnv } from "../diagnostics/types.js";
import { createExpiryDeliverers } from "./jobs.js";
import { createRegionalDispatcher } from "./regional-dispatch.js";
import { D1ProbeIssueLifecycle, D1TargetReevaluator } from "./reevaluate.js";
import { createRustMonitorEvaluator } from "./rust.js";
import { runSchedulerTick } from "./scheduler.js";
export { createCloudflareDohResolver } from "./doh.js";
import { D1SchedulerStore } from "./store.js";
import type { Telemetry } from "@moesegfault/telemetry";
import { recordSchedulingMetrics } from "./metrics.js";
import { evaluationObserver } from "../platform/instrumentation.js";
import type {
  RustDispatcher,
  SchedulerLimits,
  SchedulerSummary,
} from "./types.js";
import {
  queueNotifications,
  type NotificationQueue,
} from "../platform/notifications.js";

/** 生产调度 Env；Wrangler 应生成其 D1/AE 部分，字符串 vars 保持显式。 / Production scheduler Env; Wrangler should generate D1/AE bindings while string vars remain explicit. */
export interface SchedulerProductionEnv {
  /** 真实持久通知队列。 / Actual durable notification queue. */
  readonly NOTIFICATION_QUEUE: NotificationQueue;
  /** 权威 D1 数据库。 / Authoritative D1 database. */
  readonly DB: D1Database;
  /** 高频原始探针样本目标。 / Destination for high-frequency raw probe samples. */
  readonly ANALYTICS: AnalyticsEngineDataset;
  /** 全局并发字符串配置。 / String-valued global concurrency configuration. */
  readonly SCHEDULER_GLOBAL_CONCURRENCY?: string;
  /** 每目标并发字符串配置。 / String-valued per-target concurrency configuration. */
  readonly SCHEDULER_PER_TARGET_CONCURRENCY?: string;
  /** 单轮 monitor 领取上限。 / Per-tick monitor claim limit. */
  readonly SCHEDULER_MONITOR_BATCH_SIZE?: string;
  /** 单轮 outbox/retention batch 上限。 / Per-tick outbox and retention batch limit. */
  readonly SCHEDULER_OUTBOX_BATCH_SIZE?: string;
  /** 整次 Cron 调用 deadline。 / Deadline for the complete Cron invocation. */
  readonly SCHEDULER_INVOCATION_DEADLINE_MS?: string;
  /** D1 租约时长，必须大于调用 deadline。 / D1 lease duration, which must exceed the invocation deadline. */
  readonly SCHEDULER_LEASE_MS?: string;
  /** 配置位置到真实默认 fetch 执行器的受控映射。 / Controlled mapping from configured locations to real default-fetch executors. */
  readonly PROBE_REGIONAL_CONFIG?: string;
}

/**
 * 从 Cloudflare Module Worker `scheduled()` 调用生产调度器。
 * Invoke the production scheduler from a Cloudflare Module Worker `scheduled()` handler.
 *
 * Cron 不伪装区域探针；仅分派到具有平台来源证明的默认 fetch 执行器。
 * Cron never impersonates regional probes; it dispatches only to default-fetch
 * executors with validated platform execution provenance.
 */
export async function runScheduled(
  env: SchedulerProductionEnv,
  core: RustDispatcher,
  telemetry?: Telemetry,
): Promise<SchedulerSummary> {
  const now = Date.now;
  const store = new D1SchedulerStore(env.DB);
  await recordSchedulingMetrics(env.DB, telemetry, new Date(now()));
  const reevaluator = new D1TargetReevaluator(
    env.DB,
    core,
    now,
    evaluationObserver(telemetry),
  );
  const regionalDispatcher = createRegionalDispatcher(
    env,
    env.PROBE_REGIONAL_CONFIG ?? "{}",
    now,
  );
  const diagnosticEnv: DiagnosticConsumerEnv = {
    DB: env.DB,
    DIAGNOSTIC_CORE: core,
    ...(telemetry ? { TELEMETRY: telemetry } : {}),
    now: () => new Date(now()),
  };
  return runSchedulerTick(
    {
      monitors: store,
      expiry: store,
      outbox: store,
      retention: store,
      evaluator: createRustMonitorEvaluator(core),
      regionalDispatcher,
      diagnostics: {
        process: (envelope) =>
          processDiagnosticEnvelope(envelope, diagnosticEnv),
      },
      observations: {
        write(observation): void {
          env.ANALYTICS.writeDataPoint({
            indexes: [observation.monitorId],
            blobs: [
              observation.outcome,
              observation.errorType ?? "",
              observation.execution.runtime,
              observation.execution.location ?? "",
            ],
            doubles: [observation.latencyMs],
          });
        },
      },
      issueLifecycle: new D1ProbeIssueLifecycle(env.DB, core),
      reevaluator,
      outboxDeliverers: {
        "*": queueNotifications(env.NOTIFICATION_QUEUE),
        ...createExpiryDeliverers(reevaluator),
      },
      outboxPolicy: {
        maxAttempts: 8,
        baseBackoffMs: 1_000,
        maxBackoffMs: 15 * 60_000,
        deliveryDeadlineMs: 10_000,
        concurrency: 4,
      },
      now,
      reportError(stage, monitorId, errorType): void {
        console.error(
          JSON.stringify({
            event: "status.scheduler.error",
            stage,
            monitor_id: monitorId,
            error_type: errorType,
          }),
        );
      },
    },
    limitsFromEnv(env),
  );
}

function limitsFromEnv(env: SchedulerProductionEnv): SchedulerLimits {
  return {
    globalConcurrency: integerVar(env.SCHEDULER_GLOBAL_CONCURRENCY, 8, 1, 32),
    perTargetConcurrency: integerVar(
      env.SCHEDULER_PER_TARGET_CONCURRENCY,
      2,
      1,
      8,
    ),
    monitorBatchSize: integerVar(env.SCHEDULER_MONITOR_BATCH_SIZE, 64, 1, 500),
    outboxBatchSize: integerVar(env.SCHEDULER_OUTBOX_BATCH_SIZE, 64, 1, 500),
    invocationDeadlineMs: integerVar(
      env.SCHEDULER_INVOCATION_DEADLINE_MS,
      50_000,
      1_000,
      14 * 60_000,
    ),
    leaseMs: integerVar(env.SCHEDULER_LEASE_MS, 90_000, 5_000, 15 * 60_000),
  };
}

function integerVar(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum)
    throw new Error("invalid_scheduler_limit");
  return parsed;
}

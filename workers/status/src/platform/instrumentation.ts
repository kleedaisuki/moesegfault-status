import type { Telemetry, WorkersTracing } from "@moesegfault/telemetry";
import type { QueueBatchLike } from "../diagnostics/types.js";
import type { SchedulerSummary } from "../scheduling/types.js";
import type { StatusEvaluationObserver } from "../scheduling/reevaluate.js";

/** 纯领域 observer 的运行时适配，提交计数仅在成功 batch 后发出。 / Runtime adapter for domain observers; count commits only after successful batches. */
export function evaluationObserver(
  telemetry: Telemetry | undefined,
): StatusEvaluationObserver {
  return {
    planned(_target, metrics) {
      measurement(
        telemetry,
        "status.evaluation.duration",
        metrics.durationMs,
        "scheduler",
        true,
      );
    },
    committed(_target, metrics) {
      measurement(
        telemetry,
        "status.transition.count",
        metrics.transitionCount,
        "scheduler",
      );
      if (metrics.issueCreationCount)
        measurement(
          telemetry,
          "issue.creation.count",
          metrics.issueCreationCount,
          "scheduler",
        );
    },
  };
}

/** 公开投影读取的新鲜度；缺失评估不使用 catalog 时间冒充。 / Freshness of public reads; missing evaluations never borrow catalog timestamps. */
export function recordPublicFreshness(
  telemetry: Telemetry | undefined,
  rows: readonly {
    readonly evaluated_at: string | null;
    readonly fresh_until: string | null;
  }[],
  now: Date,
  operation: "platform" | "services" | "service" | "components",
): void {
  let stale = 0,
    missing = 0,
    ageSum = 0,
    ageCount = 0;
  for (const row of rows) {
    const deadline =
      row.fresh_until === null ? NaN : Date.parse(row.fresh_until);
    const evaluated =
      row.evaluated_at === null ? NaN : Date.parse(row.evaluated_at);
    if (
      !Number.isFinite(deadline) ||
      !Number.isFinite(evaluated) ||
      evaluated > now.getTime()
    ) {
      missing++;
      continue;
    }
    if (deadline < now.getTime()) stale++;
    ageSum += now.getTime() - evaluated;
    ageCount++;
  }
  measurement(telemetry, "public.status.observed", rows.length, operation);
  measurement(telemetry, "public.status.stale", stale, operation);
  measurement(telemetry, "public.status.missing", missing, operation);
  if (ageCount) {
    measurement(telemetry, "public.status.age.sum", ageSum, operation, true);
    measurement(telemetry, "public.status.age.count", ageCount, operation);
  }
}

/** 共享 invocation 预算；不创建子 exporter。 / Share the invocation budget without creating child exporters. */
export function measurement(
  telemetry: Telemetry | undefined,
  name: string,
  value: number,
  operation: string,
  histogram = false,
): void {
  try {
    telemetry?.metrics.write({
      name,
      value,
      unit: histogram ? "ms" : "1",
      kind: histogram ? "histogram" : "counter",
      attributes: { "operation.name": operation },
    });
  } catch {
    /* 遥测失败不改变业务结果。 / Telemetry failure never changes business results. */
  }
}

/** 记录一次异步操作；保留原始返回值和异常身份。 / Measure an async operation preserving its result and error identity. */
export async function observed<T>(
  telemetry: Telemetry | undefined,
  operation: string,
  run: () => Promise<T>,
  tracing?: WorkersTracing,
): Promise<T> {
  const started = Date.now();
  try {
    return await (telemetry && tracing
      ? telemetry.withSpan(
          tracing,
          operation,
          { "operation.name": operation },
          run,
        )
      : run());
  } catch (error) {
    measurement(telemetry, `${operation}.failure`, 1, operation);
    throw error;
  } finally {
    measurement(
      telemetry,
      `${operation}.duration`,
      Math.max(0, Date.now() - started),
      operation,
      true,
    );
  }
}

/** 只采集平台时间和确认动作，不读取正文；批量汇总控制点数。 / Observe platform timestamps and dispositions only, aggregating to bound point count. */
export async function observeQueue<T>(
  telemetry: Telemetry | undefined,
  batch: {
    readonly messages: readonly (QueueBatchLike<T>["messages"][number] & {
      readonly timestamp?: Date;
    })[];
  },
  kind: "diagnostic" | "notification",
  consume: (batch: QueueBatchLike<T>) => Promise<void>,
): Promise<void> {
  let acknowledged = 0;
  let retried = 0;
  let redelivered = 0;
  let lagCount = 0;
  let lagSum = 0;
  const now = Date.now();
  const messages = batch.messages.map((message) => {
    if (message.attempts > 1) redelivered += 1;
    const timestamp = message.timestamp?.getTime();
    if (
      timestamp !== undefined &&
      Number.isFinite(timestamp) &&
      timestamp <= now
    ) {
      lagSum += now - timestamp;
      lagCount += 1;
    }
    let disposition: "ack" | "retry" | undefined;
    return {
      id: message.id,
      attempts: message.attempts,
      body: message.body,
      ack() {
        message.ack();
        if (!disposition) {
          disposition = "ack";
          acknowledged += 1;
        }
      },
      retry(options?: { delaySeconds?: number }) {
        message.retry(options);
        if (!disposition) {
          disposition = "retry";
          retried += 1;
        }
      },
    };
  });
  try {
    await observed(telemetry, `queue.${kind}.batch`, () =>
      consume({ messages }),
    );
  } finally {
    measurement(telemetry, "queue.batch.count", 1, kind);
    measurement(telemetry, "queue.message.received", messages.length, kind);
    measurement(telemetry, "queue.message.acknowledged", acknowledged, kind);
    measurement(telemetry, "queue.message.retry_requested", retried, kind);
    measurement(telemetry, "queue.message.redelivered", redelivered, kind);
    // sum/count 支持准确加权均值；缺失时间不能伪装成零延迟。 / Sum/count support a weighted mean; absent timestamps are not zero latency.
    if (lagCount) {
      measurement(telemetry, "queue.consumer.lag.sum", lagSum, kind, true);
      measurement(telemetry, "queue.consumer.lag.count", lagCount, kind);
    }
  }
}

/** 仅导出调度器真实返回的计数，不把 claimed 命名为 due。 / Export actual scheduler counts; claimed is not due. */
export function recordSchedule(
  telemetry: Telemetry | undefined,
  summary: SchedulerSummary,
): void {
  const counts = {
    claimed: summary.claimed,
    executed: summary.probed,
    failed: summary.failed,
    timeout: summary.timedOut,
    diagnostics: summary.diagnostics,
    outbox_delivered: summary.outboxDelivered,
    outbox_retried: summary.outboxRetried,
    occurrences_purged: summary.occurrencesPurged,
  };
  for (const [name, value] of Object.entries(counts))
    measurement(telemetry, `scheduler.${name}`, value, "cron");
  measurement(
    telemetry,
    "scheduler.invocation.count",
    1,
    summary.invocationTimedOut ? "timeout" : "completed",
  );
}

/** 透明包装原生 D1：batch 保持单次调用及原始 statement 身份。 / Transparent D1 wrapper preserving a single batch call and native statement identities. */
export function instrumentDatabase<T extends object>(
  database: T,
  telemetry: Telemetry | undefined,
  tracing?: WorkersTracing,
): T {
  if (!telemetry) return database;
  const originals = new WeakMap<object, object>();
  const statement = (native: object): object => {
    const wrapped = new Proxy(native, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        if (key === "bind")
          return (...args: unknown[]) =>
            statement(Reflect.apply(value, target, args));
        if (["first", "all", "raw", "run"].includes(String(key)))
          return (...args: unknown[]) =>
            observed(
              telemetry,
              "d1.query",
              async () => Reflect.apply(value, target, args),
              tracing,
            );
        return value.bind(target);
      },
    });
    originals.set(wrapped, native);
    return wrapped;
  };
  return new Proxy(database, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      if (key === "prepare")
        return (...args: unknown[]) =>
          statement(Reflect.apply(value, target, args));
      if (key === "batch")
        return (statements: object[]) =>
          observed(
            telemetry,
            "d1.transaction",
            async () =>
              Reflect.apply(value, target, [
                statements.map((item) => originals.get(item) ?? item),
              ]),
            tracing,
          );
      return value.bind(target);
    },
  });
}

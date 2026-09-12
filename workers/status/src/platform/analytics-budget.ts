import type { Telemetry } from "@moesegfault/telemetry";

/** 一个 invocation 中所有 Analytics 写入路径共享的预算。 / Budget shared by every Analytics write path within one invocation. */
export interface AnalyticsBudget {
  /** 同时传给 telemetry exporter 与 probe observations 的 binding。 / Binding passed to both the telemetry exporter and probe observations. */
  readonly dataset: AnalyticsEngineDataset;
  /** 已调用原生 binding 的次数，包含原生抛错。 / Native binding calls, including calls that threw. */
  readonly attempted: number;
  /** 超额或原生抛错导致的丢弃总数。 / Samples dropped due to exhaustion or native errors. */
  readonly dropped: number;
  /** 使用日志报告新增丢弃，不再写入 Analytics。 / Report newly dropped samples through logs, never Analytics. */
  report(telemetry: Telemetry | undefined): void;
}

/**
 * 每次入口调用只创建一次；不能缓存到 isolate 全局。
 * Create exactly once per entry invocation; never cache in isolate globals.
 *
 * 原生调用在调用前消耗预算，即使抛错也不归还；确保混合 exporter 与原始 observation 总计不超过 250。
 * Consume budget before native calls, even if they throw, keeping mixed exporters and raw observations at or below 250.
 *
 * @example
 * const budget = createAnalyticsBudget(env.ANALYTICS);
 * const scopedEnv = { ...env, ANALYTICS: budget.dataset };
 * const telemetry = telemetryForInvocation(scopedEnv);
 * try { await runScheduled(scopedEnv, core, telemetry); }
 * finally { budget.report(telemetry); }
 */
export function createAnalyticsBudget(
  native: AnalyticsEngineDataset,
): AnalyticsBudget {
  let attempted = 0;
  let dropped = 0;
  let reported = 0;
  const dataset: AnalyticsEngineDataset = Object.freeze({
    writeDataPoint(point?: AnalyticsEngineDataPoint): void {
      if (attempted >= 250) {
        dropped++;
        return;
      }
      attempted++;
      try {
        native.writeDataPoint(point);
      } catch {
        dropped++;
      }
    },
  });
  return Object.freeze({
    dataset,
    get attempted() {
      return attempted;
    },
    get dropped() {
      return dropped;
    },
    report(telemetry: Telemetry | undefined): void {
      const delta = dropped - reported;
      if (!telemetry || delta === 0) return;
      try {
        telemetry.logger.emit({
          eventName: "status.analytics.shared-budget-dropped",
          severity: "WARN",
          body: "Shared Analytics binding dropped samples",
          attributes: { "analytics.sample.dropped": delta },
        });
        reported = dropped;
      } catch {
        /* 报告失败不能影响业务结果。 / Reporting failures cannot affect business results. */
      }
    },
  });
}

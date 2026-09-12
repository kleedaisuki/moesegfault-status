import type { Telemetry } from "@moesegfault/telemetry";
import type { D1DatabaseLike } from "../public/types.js";
import { measurement } from "../platform/instrumentation.js";

/** 同一 SQL 快照中的真实队列/监测规模。 / Actual monitor and outbox sizes in one SQL snapshot. */
export interface SchedulingMetricsSnapshot {
  /** 到期且没有有效租约的启用 monitor。 / Enabled due monitors without a live lease. */
  readonly due: number;
  /** 至少一个启用位置检查点已过期的 monitor。 / Monitors with at least one expired enabled-location checkpoint. */
  readonly stale: number;
  /** 至少一个启用位置还没有检查点的 monitor。 / Monitors missing a checkpoint for an enabled location. */
  readonly missing: number;
  /** 未交付、未终止的 outbox 行，包括处理中的行。 / Nonterminal undelivered outbox rows, including processing rows. */
  readonly backlog: number;
}

/** 单次只读快照；调用方应在 tick 前采样，不能以 claimed 代替 due。 / One read-only snapshot; sample before the tick rather than substituting claimed for due. */
export async function readSchedulingMetrics(
  db: D1DatabaseLike,
  now: Date,
): Promise<SchedulingMetricsSnapshot> {
  const instant = now.toISOString();
  const result = await db
    .prepare(
      `SELECT
    (SELECT COUNT(*) FROM monitors WHERE enabled=1 AND next_run_at<=? AND (lease_expires_at IS NULL OR lease_expires_at<=?)) AS due,
    (SELECT COUNT(*) FROM monitors AS m WHERE m.enabled=1 AND EXISTS (
      SELECT 1 FROM monitor_locations AS l JOIN monitor_checkpoints AS c ON c.monitor_id=l.monitor_id AND c.location=l.location
      WHERE l.monitor_id=m.monitor_id AND l.enabled=1 AND c.fresh_until<?)) AS stale,
    (SELECT COUNT(*) FROM monitors AS m WHERE m.enabled=1 AND EXISTS (
      SELECT 1 FROM monitor_locations AS l LEFT JOIN monitor_checkpoints AS c ON c.monitor_id=l.monitor_id AND c.location=l.location
      WHERE l.monitor_id=m.monitor_id AND l.enabled=1 AND c.monitor_id IS NULL)) AS missing,
    (SELECT COUNT(*) FROM outbox WHERE state IN ('pending','processing')) AS backlog`,
    )
    .bind(instant, instant, instant)
    .first<SchedulingMetricsSnapshot>();
  if (
    !result ||
    Object.values(result).some(
      (value) => !Number.isSafeInteger(value) || value < 0,
    )
  )
    throw new Error("invalid_scheduler_metrics_snapshot");
  return result;
}

/** 观测故障不阻止调度；失败时不发出伪零 gauge。 / Observation failures do not block scheduling or emit fabricated zero gauges. */
export async function recordSchedulingMetrics(
  db: D1DatabaseLike,
  telemetry: Telemetry | undefined,
  now = new Date(),
): Promise<void> {
  if (!telemetry) return;
  try {
    const snapshot = await readSchedulingMetrics(db, now);
    for (const [name, value] of Object.entries(snapshot)) {
      telemetry.metrics.write({
        name: name === "backlog" ? "outbox.backlog" : `probe.${name}`,
        value,
        unit: "1",
        kind: "gauge",
      });
    }
  } catch {
    measurement(telemetry, "scheduler.metrics.unavailable", 1, "cron");
  }
}

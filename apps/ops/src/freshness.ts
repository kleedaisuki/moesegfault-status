/** 状态数据的新鲜度判断。Freshness result for public status evidence. */
export type Freshness =
  | { kind: "fresh"; remainingMs: number }
  | { kind: "stale"; overdueMs: number }
  | { kind: "invalid"; reason: string };

/**
 * 判断服务端证据是否仍在其 freshness deadline 内。
 * Determine whether server evidence remains within its freshness deadline.
 */
export function evaluateFreshness(
  freshUntil: string,
  nowMs = Date.now(),
): Freshness {
  const deadline = Date.parse(freshUntil);
  if (!Number.isFinite(deadline))
    return { kind: "invalid", reason: "fresh_until 不是有效时间" };
  if (deadline <= nowMs) return { kind: "stale", overdueMs: nowMs - deadline };
  return { kind: "fresh", remainingMs: deadline - nowMs };
}

/** 单项基础设施检查。A single infrastructure check. */
export interface HealthCheck {
  readonly state: "healthy" | "warning" | "failed" | "checking";
}

/**
 * 总健康状态只在所有检查明确健康时为绿色；错误、陈旧和未知都不可乐观推断。
 * Overall health is green only when every check is explicitly healthy.
 */
export function aggregateHealth(
  checks: readonly HealthCheck[],
): HealthCheck["state"] {
  if (checks.some((check) => check.state === "failed")) return "failed";
  if (checks.some((check) => check.state === "warning")) return "warning";
  if (checks.length === 0 || checks.some((check) => check.state === "checking"))
    return "checking";
  return "healthy";
}

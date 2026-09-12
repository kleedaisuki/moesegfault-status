import type { D1DatabaseLike } from "./types.js";

/** 领域公开状态。 / Public domain status. */
export type PublicStatus =
  | "operational"
  | "degraded"
  | "partial_outage"
  | "major_outage"
  | "maintenance"
  | "unknown";

/** D1 查询全部行并将缺失 results 视为空集。 / Query all D1 rows, treating absent results as an empty set. */
export async function allRows<Row>(
  db: D1DatabaseLike,
  sql: string,
  values: readonly unknown[] = [],
): Promise<Row[]> {
  const statement =
    values.length === 0 ? db.prepare(sql) : db.prepare(sql).bind(...values);
  const result = await statement.all<Row>();
  if (result.success === false) throw new Error("D1 public read failed");
  return result.results ?? [];
}

/** D1 查询单行。 / Query one D1 row. */
export async function firstRow<Row>(
  db: D1DatabaseLike,
  sql: string,
  values: readonly unknown[] = [],
): Promise<Row | null> {
  const statement =
    values.length === 0 ? db.prepare(sql) : db.prepare(sql).bind(...values);
  return statement.first<Row>();
}

/**
 * 过期或缺失的健康证明映射为 unknown，但保留更强的已证实直接故障。
 * Map stale or missing proof of health to unknown while retaining stronger,
 * demonstrated direct failures.
 */
export function freshStatus(
  status: unknown,
  freshUntil: unknown,
  now: Date,
): PublicStatus {
  if (!isStatus(status) || typeof freshUntil !== "string") return "unknown";
  const deadline = Date.parse(freshUntil);
  if (!Number.isFinite(deadline)) return "unknown";
  if (deadline < now.getTime() && !isDemonstratedFailure(status)) {
    return "unknown";
  }
  return status;
}

/** 按领域规则聚合：已证实故障优先于 unknown，unknown 不得被当作绿色。 / Aggregate statuses: demonstrated failure outranks unknown, which must never become green. */
export function aggregateStatus(
  statuses: readonly PublicStatus[],
): PublicStatus {
  if (statuses.includes("major_outage")) return "major_outage";
  if (statuses.includes("partial_outage")) return "partial_outage";
  if (statuses.includes("degraded")) return "degraded";
  if (statuses.includes("unknown") || statuses.length === 0) return "unknown";
  if (statuses.includes("maintenance")) return "maintenance";
  return "operational";
}

/** direct status 与 dependency risk 保持分离后的 capability impact。 / Capability impact while preserving the direct/dependency distinction. */
export function effectiveImpact(
  direct: PublicStatus,
  risk: "none" | "degraded" | "partial_outage" | "major_outage" | "unknown",
): PublicStatus {
  const dependency = risk === "none" ? "operational" : risk;
  return aggregateStatus([direct, dependency]);
}

/** 规范化可空公开文本。 / Normalize nullable public text. */
export function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** 从候选时间中取最早值。 / Return the earliest candidate timestamp. */
export function earliest(values: readonly string[], fallback: string): string {
  return values.length === 0 ? fallback : [...values].sort()[0]!;
}

function isStatus(value: unknown): value is PublicStatus {
  return (
    value === "operational" ||
    value === "degraded" ||
    value === "partial_outage" ||
    value === "major_outage" ||
    value === "maintenance" ||
    value === "unknown"
  );
}

function isDemonstratedFailure(status: PublicStatus): boolean {
  return (
    status === "degraded" ||
    status === "partial_outage" ||
    status === "major_outage"
  );
}

/** Monitor 调度描述。 / Monitor schedule descriptor. */
export interface MonitorSchedule {
  readonly kind: "interval" | "cron";
  readonly intervalMs: number | null;
  readonly expression: string | null;
}

/** 计算严格晚于上一到期时间的下一次执行。 / Compute the next execution strictly after the prior due time. */
export function nextRunAt(
  schedule: MonitorSchedule,
  previousDueMs: number,
): number {
  if (schedule.kind === "interval") {
    if (schedule.intervalMs === null || schedule.intervalMs < 1)
      throw new Error("invalid_interval_schedule");
    return previousDueMs + schedule.intervalMs;
  }
  if (schedule.expression === null) throw new Error("missing_cron_expression");
  return nextStandardCron(schedule.expression, previousDueMs);
}

/**
 * 计算标准五字段 UTC cron；故意拒绝 L/W/# 等扩展，避免静默误调度。
 * Compute standard five-field UTC cron; L/W/# extensions are deliberately rejected
 * rather than silently mis-scheduled.
 */
export function nextStandardCron(
  expression: string,
  previousDueMs: number,
): number {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("unsupported_cron_expression");
  const minute = parseField(fields[0]!, 0, 59);
  const hour = parseField(fields[1]!, 0, 23);
  const day = parseField(fields[2]!, 1, 31);
  const month = parseField(fields[3]!, 1, 12, MONTHS);
  const weekday = parseField(fields[4]!, 1, 7, WEEKDAYS);
  let candidate = Math.floor(previousDueMs / 60_000) * 60_000 + 60_000;
  const limit = candidate + 366 * 24 * 60 * 60_000 * 2;
  for (; candidate <= limit; candidate += 60_000) {
    const date = new Date(candidate);
    const dow = date.getUTCDay() + 1;
    if (
      minute.has(date.getUTCMinutes()) &&
      hour.has(date.getUTCHours()) &&
      day.has(date.getUTCDate()) &&
      month.has(date.getUTCMonth() + 1) &&
      weekday.has(dow)
    ) {
      return candidate;
    }
  }
  throw new Error("cron_has_no_near_occurrence");
}

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};
const WEEKDAYS: Readonly<Record<string, number>> = {
  sun: 1,
  mon: 2,
  tue: 3,
  wed: 4,
  thu: 5,
  fri: 6,
  sat: 7,
};

function parseField(
  source: string,
  minimum: number,
  maximum: number,
  names: Readonly<Record<string, number>> = {},
): ReadonlySet<number> {
  if (/[LW#?]/i.test(source)) throw new Error("unsupported_cron_extension");
  const values = new Set<number>();
  for (const segment of source.toLowerCase().split(",")) {
    const [rangeSource = "", stepSource] = segment.split("/");
    if (stepSource !== undefined && !/^\d+$/.test(stepSource))
      throw new Error("invalid_cron_step");
    const step = stepSource === undefined ? 1 : Number(stepSource);
    if (step < 1) throw new Error("invalid_cron_step");
    let start: number;
    let end: number;
    if (rangeSource === "*") {
      start = minimum;
      end = maximum;
    } else if (rangeSource.includes("-")) {
      const pieces = rangeSource.split("-");
      if (pieces.length !== 2) throw new Error("invalid_cron_range");
      start = cronNumber(pieces[0]!, names);
      end = cronNumber(pieces[1]!, names);
    } else {
      start = cronNumber(rangeSource, names);
      end = stepSource === undefined ? start : maximum;
    }
    if (start < minimum || end > maximum || end < start)
      throw new Error("cron_value_out_of_range");
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

function cronNumber(
  source: string,
  names: Readonly<Record<string, number>>,
): number {
  const named = names[source];
  if (named !== undefined) return named;
  if (!/^\d+$/.test(source)) throw new Error("invalid_cron_value");
  return Number(source);
}

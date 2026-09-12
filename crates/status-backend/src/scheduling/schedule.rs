//! UTC 五字段 cron，保留 Sunday=1 与日期 AND 语义。 / UTC five-field cron preserving Sunday=1 and day conjunction.
use chrono::{DateTime, Datelike, Timelike, Utc};
use std::collections::HashSet;

/// 从原计划时间计算下一 cadence，不从完成时间漂移。 / Advance the original cadence without completion-time drift.
pub fn next_run_at(
    kind: &str,
    interval_ms: Option<i64>,
    expression: Option<&str>,
    previous_due_ms: i64,
) -> Result<i64, String> {
    match kind {
        "interval" => previous_due_ms
            .checked_add(
                interval_ms
                    .filter(|v| *v > 0)
                    .ok_or("invalid_interval_schedule")?,
            )
            .ok_or("schedule_overflow".into()),
        "cron" => next_standard_cron(
            expression.ok_or("missing_cron_expression")?,
            previous_due_ms,
        ),
        _ => Err("invalid_schedule_kind".into()),
    }
}
fn number(source: &str, names: &[&str]) -> Result<u32, String> {
    if let Some(index) = names.iter().position(|v| *v == source) {
        return Ok(index as u32 + 1);
    }
    if source.is_empty() || !source.bytes().all(|b| b.is_ascii_digit()) {
        return Err("invalid_cron_value".into());
    }
    source.parse().map_err(|_| "invalid_cron_value".into())
}
fn field(source: &str, min: u32, max: u32, names: &[&str]) -> Result<HashSet<u32>, String> {
    let mut result = HashSet::new();
    for segment in source.to_ascii_lowercase().split(',') {
        let parts: Vec<_> = segment.split('/').collect();
        if parts.len() > 2 {
            return Err("invalid_cron_step".into());
        }
        let step = if parts.len() == 2 {
            number(parts[1], &[])?
        } else {
            1
        };
        if step == 0 {
            return Err("invalid_cron_step".into());
        }
        let bounds: Vec<_> = parts[0].split('-').collect();
        let (start, end) = match bounds.as_slice() {
            ["*"] => (min, max),
            [single] => {
                let value = number(single, names)?;
                (value, if parts.len() == 2 { max } else { value })
            }
            [a, b] => (number(a, names)?, number(b, names)?),
            _ => return Err("invalid_cron_range".into()),
        };
        if start < min || end > max || end < start {
            return Err("cron_value_out_of_range".into());
        }
        result.extend((start..=end).step_by(step as usize));
    }
    Ok(result)
}
/// 仅验证五字段语法与范围，不搜索可执行日期。 / Validate five-field syntax and ranges without searching dates.
pub fn validate_cron(expression: &str) -> Result<(), String> {
    parse_cron(expression).map(|_| ())
}

/// 共享解析器确保写入校验与运行调度采用同一语义。 / Shared parsing keeps write validation and execution semantics identical.
fn parse_cron(expression: &str) -> Result<[HashSet<u32>; 5], String> {
    let fields: Vec<_> = expression.split_whitespace().collect();
    if fields.len() != 5 {
        return Err("unsupported_cron_expression".into());
    }
    let minute = field(fields[0], 0, 59, &[])?;
    let hour = field(fields[1], 0, 23, &[])?;
    let day = field(fields[2], 1, 31, &[])?;
    let month = field(
        fields[3],
        1,
        12,
        &[
            "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
        ],
    )?;
    let weekday = field(
        fields[4],
        1,
        7,
        &["sun", "mon", "tue", "wed", "thu", "fri", "sat"],
    )?;
    Ok([minute, hour, day, month, weekday])
}

/// 五字段 UTC，严格晚于输入；拒绝扩展语法。 / Five-field UTC strictly after input, rejecting extensions.
pub fn next_standard_cron(expression: &str, previous_due_ms: i64) -> Result<i64, String> {
    let [minute, hour, day, month, weekday] = parse_cron(expression)?;
    let mut candidate = previous_due_ms
        .div_euclid(60_000)
        .checked_add(1)
        .and_then(|v| v.checked_mul(60_000))
        .ok_or("schedule_overflow")?;
    for _ in 0..=366 * 24 * 60 * 2 {
        let date = DateTime::<Utc>::from_timestamp_millis(candidate).ok_or("schedule_overflow")?;
        if minute.contains(&date.minute())
            && hour.contains(&date.hour())
            && day.contains(&date.day())
            && month.contains(&date.month())
            && weekday.contains(&(date.weekday().num_days_from_sunday() + 1))
        {
            return Ok(candidate);
        }
        candidate = candidate.checked_add(60_000).ok_or("schedule_overflow")?;
    }
    Err("cron_has_no_near_occurrence".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn ms(s: &str) -> i64 {
        DateTime::parse_from_rfc3339(s).unwrap().timestamp_millis()
    }
    #[test]
    fn validation_checks_syntax_not_calendar_satisfiability() {
        assert!(validate_cron("0 0 30 feb *").is_ok());
        assert!(validate_cron("*/5 1-3 * sep mon,wed").is_ok());
        for expression in ["* * * * 0", "*/0 * * * *", "* * * * mon#2", "* * * * * *"] {
            assert!(validate_cron(expression).is_err(), "{expression}");
        }
    }
    #[test]
    fn cadence_and_weekday_contract() {
        assert_eq!(
            next_run_at("interval", Some(500), None, 1000).unwrap(),
            1500
        );
        assert_eq!(
            next_standard_cron("*/15 * * * *", ms("2026-09-12T00:00:00Z")).unwrap(),
            ms("2026-09-12T00:15:00Z")
        );
        assert_eq!(
            next_standard_cron("0 0 * * 1", ms("2026-09-12T00:00:00Z")).unwrap(),
            ms("2026-09-13T00:00:00Z")
        );
        assert_eq!(
            next_standard_cron("0 0 * sep sun", ms("2026-09-12T00:00:00Z")).unwrap(),
            ms("2026-09-13T00:00:00Z")
        );
    }
    #[test]
    fn rejects_invalid_and_impossible() {
        for value in [
            "* * * * 0",
            "*/0 * * * *",
            "* * * * mon#2",
            "* * * * * *",
            "* * * * */2/3",
            "0 0 30 feb *",
        ] {
            assert!(next_standard_cron(value, 0).is_err(), "{value}");
        }
        assert!(next_run_at("interval", Some(0), None, 0).is_err());
        assert!(next_run_at("interval", Some(1), None, i64::MAX).is_err());
    }
}

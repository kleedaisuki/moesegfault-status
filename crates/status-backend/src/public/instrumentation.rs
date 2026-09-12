//! 公开读自观测只发聚合数值与固定字段名，不导出行、SQL 或 URL。
//! Public read observability exports aggregates and fixed field names, never rows, SQL, or URLs.
//! Metrics use Analytics Engine through the invocation facade; Workers OTLP exports logs/traces only.
//! https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/
use crate::telemetry::Telemetry;
use serde_json::json;

/// 新鲜度摘要；目录 fallback 永远不是评估证据。 / Freshness summary; catalog fallback is never evaluation evidence.
#[derive(Default, Debug, PartialEq)]
struct Freshness {
    /// 读取行数。 / Rows observed.
    observed: u64,
    /// 证据已过期。 / Expired evidence.
    stale: u64,
    /// 缺失、非法或来自未来的评估。 / Missing, invalid, or future evaluations.
    missing: u64,
    /// 合法评估年龄总毫秒数。 / Sum of valid evaluation ages in milliseconds.
    age_sum: f64,
    /// 合法年龄数量。 / Number of valid ages.
    age_count: u64,
}
/// 只比较时间，不借用业务字段。 / Compare timestamps without borrowing business fields.
fn summarize<'a>(
    rows: impl IntoIterator<Item = (Option<&'a str>, Option<&'a str>)>,
    now: i64,
) -> Freshness {
    let mut result = Freshness::default();
    for (evaluated, deadline) in rows {
        result.observed += 1;
        let parse = |s: Option<&str>| {
            s.and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|v| v.timestamp_millis())
        };
        match (parse(evaluated), parse(deadline)) {
            (Some(evaluated), Some(deadline)) if evaluated <= now => {
                result.stale += u64::from(deadline < now);
                result.age_sum += now as f64 - evaluated as f64;
                result.age_count += 1;
            }
            _ => result.missing += 1,
        }
    }
    result
}
/// 复用调用预算；每次集合投影最多五个点，绝不按行发送。 / Reuse invocation budget; at most five points per projection, never per-row writes.
pub(super) fn freshness<'a>(
    telemetry: Option<&Telemetry>,
    rows: impl IntoIterator<Item = (Option<&'a str>, Option<&'a str>)>,
    now: i64,
    operation: &'static str,
) {
    let Some(telemetry) = telemetry else { return };
    let summary = summarize(rows, now);
    for (name, value) in [
        ("public.status.observed", summary.observed),
        ("public.status.stale", summary.stale),
        ("public.status.missing", summary.missing),
    ] {
        telemetry.metric(name, value as f64, operation, false);
    }
    if summary.age_count > 0 {
        telemetry.metric("public.status.age.sum", summary.age_sum, operation, true);
        telemetry.metric(
            "public.status.age.count",
            summary.age_count as f64,
            operation,
            false,
        );
    }
}
/// 固定字段分类，不接受异常正文或数据库值。 / Fixed field classification; no exception bodies or database values.
pub(super) fn invalid_field(telemetry: Option<&Telemetry>, field: &'static str, correlation: &str) {
    if let Some(telemetry) = telemetry {
        telemetry.metric("public.status.invalid_field", 1.0, "snapshot", false);
        telemetry.event("status.public.invalid_field",true,json!({"operation.name":"public.status","error.type":field,"failure.stage":"snapshot_validation"}),Some(correlation),None);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::telemetry::{Resource, Sink};
    use std::{cell::RefCell, rc::Rc};
    /// 内存出口仍使用真实共享 Telemetry 预算。 / In-memory sink uses the real shared Telemetry budget.
    fn capture() -> (Telemetry, Rc<RefCell<Vec<serde_json::Value>>>) {
        let points = Rc::new(RefCell::new(vec![]));
        let sink = points.clone();
        let sink: Sink = Rc::new(move |v| {
            sink.borrow_mut().push(v.clone());
            true
        });
        (
            Telemetry::new(
                Resource {
                    service: "status".into(),
                    environment: "test".into(),
                    version: "1".into(),
                    deployment: "0199d0a8-2e12-7a59-a51e-000000000099".into(),
                    revision: "a".repeat(40),
                    digest: format!("sha256:{}", "b".repeat(64)),
                },
                sink.clone(),
                sink,
            )
            .unwrap(),
            points,
        )
    }
    #[test]
    fn counts_missing_future_and_stale_without_catalog_fallback() {
        let result = summarize(
            [
                (Some("2026-09-12T00:00:00Z"), Some("2026-09-12T00:00:01Z")),
                (None, Some("2026-09-12T00:00:10Z")),
                (Some("invalid"), None),
                (Some("2026-09-12T00:00:10Z"), Some("2026-09-12T00:00:11Z")),
            ],
            1789171202000,
        );
        assert_eq!(
            result,
            Freshness {
                observed: 4,
                stale: 1,
                missing: 3,
                age_sum: 2000.0,
                age_count: 1
            }
        );
    }
    #[test]
    fn empty_projection_emits_zero_counts_but_no_age() {
        let (t, p) = capture();
        freshness(Some(&t), [], 0, "platform");
        assert_eq!(p.borrow().len(), 3);
        assert!(p.borrow().iter().all(|p| p["doubles"][0] == 0.0));
    }
    #[test]
    fn shared_budget_is_not_reset_by_public_projection() {
        let (t, p) = capture();
        for _ in 0..249 {
            t.metric("test.used", 1.0, "http", false);
        }
        freshness(Some(&t.clone()), [], 0, "services");
        assert_eq!(p.borrow().len(), 250);
        assert_eq!(t.dropped(), 2);
    }
    #[test]
    fn invalid_field_exports_only_fixed_class_and_correlation() {
        let (t, p) = capture();
        invalid_field(
            Some(&t),
            "display_name",
            "0199d0a8-2e12-7a59-a51e-000000000099",
        );
        let p = p.borrow();
        assert_eq!(p.len(), 2);
        assert_eq!(p[1]["Body"], "status.public.invalid_field");
        assert_eq!(p[1]["Attributes"]["error.type"], "display_name");
        assert_eq!(p[1]["Attributes"].as_object().unwrap().len(), 4);
    }
}

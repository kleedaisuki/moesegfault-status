//! 身份限定的有限查询语言；不执行任意表达式。 / Identity-scoped finite query language; never executes arbitrary expressions.
use serde_json::Value;

/// 将固定键编译为部署限定选择器。 / Compile fixed keys into a deployment-scoped selector.
pub fn compile(reference: &Value) -> Option<String> {
    let kind = reference["kind"].as_str()?;
    let locator = &reference["locator"];
    let keys: &[&str] = match kind {
        "log_query" => &[
            "service",
            "environment",
            "deployment_id",
            "trace_id",
            "span_id",
            "severity",
            "operation",
            "component",
            "error_type",
        ],
        "metric_query" => &[
            "service",
            "environment",
            "deployment_id",
            "region",
            "operation",
            "component",
            "dependency",
        ],
        "profile" => &[
            "service",
            "environment",
            "deployment_id",
            "region",
            "instance_id",
        ],
        _ => return None,
    };
    let query = locator["query"].as_object()?;
    if query.is_empty() || query.keys().any(|k| !keys.contains(&k.as_str())) {
        return None;
    }
    let service = reference["service_name"].as_str()?;
    let deployment = reference["deployment_id"].as_str()?;
    for (key, expected) in [("service", service), ("deployment_id", deployment)] {
        if query.get(key).is_some_and(|v| v.as_str() != Some(expected)) {
            return None;
        }
    }
    let mut labels = vec![
        format!("service_name={}", quote(service)),
        format!("deployment_id={}", quote(deployment)),
    ];
    for key in keys
        .iter()
        .filter(|k| !["service", "deployment_id"].contains(k))
    {
        if let Some(v) = query.get(*key) {
            let text = match v {
                Value::String(s) => s.clone(),
                Value::Bool(_) | Value::Number(_) => v.to_string(),
                _ => return None,
            };
            labels.push(format!("{key}={}", quote(&text)));
        }
    }
    let prefix = match kind {
        "metric_query" => {
            let metric = locator["metric_name"].as_str()?;
            if metric.is_empty()
                || ["bool", "on", "ignoring", "group_left", "group_right"].contains(&metric)
                || !metric.bytes().enumerate().all(|(i, b)| {
                    b.is_ascii_alphabetic() || b"_:".contains(&b) || (i > 0 && b.is_ascii_digit())
                })
            {
                return None;
            }
            metric
        }
        "profile" => {
            if locator.get("profile_id").is_some() {
                return None;
            }
            match locator["profile_type"].as_str()? {
                "cpu" => "process_cpu:cpu:nanoseconds:cpu:nanoseconds",
                "memory" => "memory:inuse_space:bytes:space:bytes",
                "allocations" => "memory:alloc_space:bytes:space:bytes",
                "mutex" => "mutex:delay:nanoseconds:contentions:count",
                "goroutine" => "goroutine:goroutine:count:goroutine:count",
                "wall" => "wall:wall:nanoseconds:cpu:nanoseconds",
                _ => return None,
            }
        }
        _ => "",
    };
    let result = format!("{prefix}{{{}}}", labels.join(","));
    (result.encode_utf16().count() <= 4096).then_some(result)
}
/// Go 标签字符串转义。 / Go label-string escaping.
fn quote(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c < ' ' || c == '\u{7f}' => out.push_str(&format!("\\x{:02x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn identity_and_injection_boundaries() {
        let mut r = json!({"kind":"log_query","service_name":"api","deployment_id":"deploy","locator":{"query":{"severity":"error\"}"}}});
        assert_eq!(
            compile(&r).unwrap(),
            "{service_name=\"api\",deployment_id=\"deploy\",severity=\"error\\\"}\"}"
        );
        r["locator"]["query"]["expression"] = json!("{}");
        assert!(compile(&r).is_none());
        r["locator"]["query"] = json!({"service":"other"});
        assert!(compile(&r).is_none());
    }
}

#[cfg(test)]
mod security_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn accepts_only_finite_scoped_queries() {
        let mut r = json!({"kind":"metric_query","service_name":"api","deployment_id":"d","locator":{"metric_name":"requests_total","query":{"region":"eu","operation":"checkout"}}});
        assert_eq!(compile(&r).unwrap(),"requests_total{service_name=\"api\",deployment_id=\"d\",region=\"eu\",operation=\"checkout\"}");
        r["locator"]["metric_name"] = json!("requests_total or up");
        assert!(compile(&r).is_none());
        r["locator"]["metric_name"] = json!("on");
        assert!(compile(&r).is_none());
        r["kind"] = json!("profile");
        r["locator"] =
            json!({"profile_type":"cpu","profile_id":"arbitrary","query":{"service":"api"}});
        assert!(compile(&r).is_none());
        r["locator"].as_object_mut().unwrap().remove("profile_id");
        assert!(compile(&r)
            .unwrap()
            .starts_with("process_cpu:cpu:nanoseconds:cpu:nanoseconds{"));
        r["locator"]["query"] = json!({});
        assert!(compile(&r).is_none());
    }
    #[test]
    fn rejects_oversize_selectors() {
        let r = json!({"kind":"log_query","service_name":"api","deployment_id":"d","locator":{"query":{"operation":"x".repeat(4096)}}});
        assert!(compile(&r).is_none());
    }
}

//! 严格诊断 wire 边界；领域校验不代替传输契约。 / Strict diagnostic wire boundary preceding domain validation.
use crate::http::HttpError;
use serde_json::{Map, Value};
use status_domain::DiagnosticEvent;

/// 不回显生产者输入。 / Never echo producer input.
const INVALID: HttpError = HttpError::new(400, "invalid-diagnostic", "Invalid diagnostic payload");
/// 要求谓词成立。 / Require a boundary invariant.
fn require(ok: bool) -> Result<(), HttpError> {
    if ok {
        Ok(())
    } else {
        Err(INVALID)
    }
}
/// 严格对象并拒绝 null 可选值。 / Strict object rejecting explicit null optional values.
fn object<'a>(v: &'a Value, keys: &[&str]) -> Result<&'a Map<String, Value>, HttpError> {
    let o = v.as_object().ok_or(INVALID)?;
    require(
        o.iter()
            .all(|(k, v)| keys.contains(&k.as_str()) && !v.is_null()),
    )?;
    Ok(o)
}
/// 使用 JavaScript UTF-16 长度。 / Match JavaScript UTF-16 string length.
fn string(v: &Value, max: usize) -> Result<&str, HttpError> {
    let s = v.as_str().ok_or(INVALID)?;
    require(!s.is_empty() && s.encode_utf16().count() <= max)?;
    Ok(s)
}
/// 小写十六进制。 / Lowercase hexadecimal.
fn hex(s: &str, len: usize) -> bool {
    s.len() == len
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
/// 非零执行身份。 / Nonzero execution identity.
fn id(s: &str, len: usize) -> bool {
    hex(s, len) && s.bytes().any(|b| b != b'0')
}
/// UUIDv7 规范身份。 / Canonical UUIDv7 identity.
fn uuid(v: &Value) -> Result<(), HttpError> {
    status_domain::validate_uuid_v7(v.as_str().ok_or(INVALID)?, "id").map_err(|_| INVALID)
}
/// 严格 UTC 文本及有效日期。 / Strict UTC spelling and valid calendar date.
fn utc(v: &Value) -> Result<chrono::DateTime<chrono::FixedOffset>, HttpError> {
    let s = string(v, 30)?;
    let b = s.as_bytes();
    require(
        b.len() >= 20
            && b[4] == b'-'
            && b[7] == b'-'
            && b[10] == b'T'
            && b[13] == b':'
            && b[16] == b':'
            && b.last() == Some(&b'Z'),
    )?;
    require(
        b[..19]
            .iter()
            .enumerate()
            .all(|(i, b)| [4, 7, 10, 13, 16].contains(&i) || b.is_ascii_digit()),
    )?;
    require(
        b.len() == 20
            || (b.len() >= 22
                && b[19] == b'.'
                && b[20..b.len() - 1].iter().all(u8::is_ascii_digit)),
    )?;
    require(&s[17..19] < "60")?;
    chrono::DateTime::parse_from_rfc3339(s).map_err(|_| INVALID)
}
/// 分隔符之间必须存在名称段。 / Require nonempty alphanumeric name segments.
fn name(s: &str, separators: &[char]) -> bool {
    s.split(separators).all(|p| {
        !p.is_empty()
            && p.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
    })
}
/// 结构化查询限制。 / Structured query bounds.
fn query(v: &Value) -> Result<(), HttpError> {
    let o = v.as_object().ok_or(INVALID)?;
    require(o.len() <= 16)?;
    for (k, v) in o {
        require(
            !k.is_empty()
                && k.len() <= 64
                && k.as_bytes()[0].is_ascii_lowercase()
                && k.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"_.-".contains(&b)),
        )?;
        match v {
            Value::String(_) => {
                string(v, 512)?;
            }
            Value::Bool(_) => {}
            Value::Number(n) => {
                require(n.as_f64().is_some_and(f64::is_finite))?;
            }
            _ => return Err(INVALID),
        }
    }
    Ok(())
}
/// 证据变体的封闭 locator 契约。 / Closed locator contract for evidence variants.
fn evidence(v: &Value) -> Result<(), HttpError> {
    let kind = v["kind"].as_str().ok_or(INVALID)?;
    let ranged = matches!(kind, "log_query" | "profile" | "metric_query");
    object(
        v,
        if ranged {
            &["kind", "backend", "locator", "time_range"]
        } else {
            &["kind", "backend", "locator"]
        },
    )?;
    require(name(string(&v["backend"], 64)?, &['.', '_', '-']))?;
    if ranged {
        let r = &v["time_range"];
        object(r, &["start", "end"])?;
        require(utc(&r["start"])? <= utc(&r["end"])?)?;
    }
    let l = &v["locator"];
    match kind {
        "trace" => {
            object(l, &["trace_id", "span_id"])?;
            require(id(l["trace_id"].as_str().ok_or(INVALID)?, 32))?;
            if let Some(s) = l.get("span_id") {
                require(id(s.as_str().ok_or(INVALID)?, 16))?;
            }
        }
        "log_query" => {
            object(l, &["query"])?;
            query(&l["query"])?;
        }
        "metric_query" => {
            object(l, &["metric_name", "query"])?;
            string(&l["metric_name"], 255)?;
            query(&l["query"])?;
        }
        "profile" => {
            object(l, &["profile_type", "profile_id", "query"])?;
            require(
                ["cpu", "memory", "allocations", "mutex", "goroutine", "wall"]
                    .contains(&l["profile_type"].as_str().ok_or(INVALID)?),
            )?;
            require(l.get("profile_id").is_some() || l.get("query").is_some())?;
            if let Some(v) = l.get("profile_id") {
                string(v, 256)?;
            }
            if let Some(v) = l.get("query") {
                query(v)?;
            }
        }
        "source" => {
            object(
                l,
                &["repository_url", "git_commit", "path", "line", "column"],
            )?;
            let url = url::Url::parse(string(&l["repository_url"], 2048)?).map_err(|_| INVALID)?;
            require(url.scheme() == "https" && url.host_str().is_some())?;
            let commit = l["git_commit"].as_str().ok_or(INVALID)?;
            require(hex(commit, 40) || hex(commit, 64))?;
            let path = string(&l["path"], 1024)?;
            require(
                !path.starts_with('/')
                    && !path.split('/').any(|s| s == "..")
                    && !path.contains(['\n', '\r', '\u{2028}', '\u{2029}']),
            )?;
            for k in ["line", "column"] {
                if let Some(v) = l.get(k) {
                    integer(v, 1, 10_000_000)?;
                }
            }
        }
        "artifact" => {
            object(l, &["artifact_digest", "build_id", "artifact_kind"])?;
            require(
                l["artifact_digest"]
                    .as_str()
                    .and_then(|s| s.strip_prefix("sha256:"))
                    .is_some_and(|s| hex(s, 64)),
            )?;
            require(
                [
                    "binary",
                    "debug_symbols",
                    "source_map",
                    "sbom",
                    "manifest",
                    "other",
                ]
                .contains(&l["artifact_kind"].as_str().ok_or(INVALID)?),
            )?;
            if let Some(v) = l.get("build_id") {
                string(v, 256)?;
            }
        }
        _ => return Err(INVALID),
    }
    Ok(())
}
/// JSON 整数兼容浮点表示。 / Accept integral JSON floating-point representations.
fn integer(v: &Value, min: u64, max: u64) -> Result<(), HttpError> {
    require(
        v.as_f64().is_some_and(|n| {
            n.is_finite() && n.fract() == 0.0 && n >= min as f64 && n <= max as f64
        }),
    )
}
/// 校验完整事件并直接返回领域类型。 / Validate the complete event and return its domain type directly.
pub fn event(input: &Value) -> Result<DiagnosticEvent, HttpError> {
    let o = object(
        input,
        &[
            "event_id",
            "schema_version",
            "kind",
            "signal",
            "recovery_of_event_id",
            "severity",
            "service_name",
            "environment",
            "deployment_id",
            "instance_id",
            "occurred_at",
            "correlation_id",
            "trace_id",
            "span_id",
            "summary",
            "fingerprint",
            "evidence",
            "attributes",
        ],
    )?;
    require(name(string(&input["service_name"], 63)?, &['-']))?;
    utc(&input["occurred_at"])?;
    string(&input["summary"], 512)?;
    let kind = string(&input["kind"], 128)?;
    require(
        kind.len() >= 3
            && kind.contains('.')
            && kind.split('.').enumerate().all(|(i, p)| {
                !p.is_empty()
                    && p.as_bytes()[0].is_ascii_lowercase()
                    && p.bytes().all(|b| {
                        b.is_ascii_lowercase() || b.is_ascii_digit() || (i > 0 && b == b'_')
                    })
            }),
    )?;
    let fp = object(
        &input["fingerprint"],
        &[
            "dependency",
            "operation",
            "error_type",
            "component",
            "capability",
            "region",
            "protocol",
        ],
    )?;
    require(!fp.is_empty())?;
    for (k, v) in fp {
        if k == "protocol" {
            require(
                ["http", "rpc", "tcp", "dns", "queue", "database"]
                    .contains(&v.as_str().ok_or(INVALID)?),
            )?;
        } else {
            string(v, if k == "region" { 64 } else { 128 })?;
        }
    }
    if let Some(v) = o.get("evidence") {
        let a = v.as_array().ok_or(INVALID)?;
        require(a.len() <= 8)?;
        for v in a {
            evidence(v)?;
        }
    }
    if let Some(v) = o.get("attributes") {
        let attrs = object(
            v,
            &[
                "dependency.name",
                "operation.name",
                "error.type",
                "component.id",
                "cloud.region",
                "http.request.method",
                "http.response.status_code",
                "rpc.system",
                "db.system.name",
                "deployment.environment.name",
            ],
        )?;
        for (k, v) in attrs {
            match k.as_str() {
                "http.response.status_code" => integer(v, 100, 599)?,
                "http.request.method" => require(
                    [
                        "GET", "HEAD", "POST", "PUT", "DELETE", "CONNECT", "OPTIONS", "TRACE",
                        "PATCH",
                    ]
                    .contains(&v.as_str().ok_or(INVALID)?),
                )?,
                "deployment.environment.name" => require(
                    ["development", "test", "staging", "production"]
                        .contains(&v.as_str().ok_or(INVALID)?),
                )?,
                _ => {
                    string(
                        v,
                        if ["cloud.region", "rpc.system", "db.system.name"].contains(&k.as_str()) {
                            64
                        } else {
                            128
                        },
                    )?;
                }
            }
        }
    }
    if let Some(v) = o.get("instance_id") {
        let s = string(v, 36)?;
        require(
            s.len() == 36
                && s.bytes().enumerate().all(|(i, b)| {
                    if [8, 13, 18, 23].contains(&i) {
                        b == b'-'
                    } else {
                        b.is_ascii_hexdigit()
                    }
                }),
        )?;
    }
    let event: DiagnosticEvent = serde_json::from_value(input.clone()).map_err(|_| INVALID)?;
    event.validate().map_err(|_| INVALID)?;
    Ok(event)
}
/// W3C version 00 traceparent；拒绝零身份。 / W3C version 00 traceparent with nonzero identities.
pub fn traceparent(s: &str) -> bool {
    let p: Vec<_> = s.split('-').collect();
    p.len() == 4 && p[0] == "00" && id(p[1], 32) && id(p[2], 16) && hex(p[3], 2)
}
/// 队列身份与来源必须匹配事件；监视器来源限定调度器。 / Queue identity must match the event; monitor origin is scheduler-only.
pub fn envelope(input: &Value) -> Result<DiagnosticEvent, HttpError> {
    object(
        input,
        &[
            "schema_version",
            "message_id",
            "event",
            "received_at",
            "origin",
            "producer",
            "trace_context",
        ],
    )?;
    require(input["schema_version"] == "1.0")?;
    uuid(&input["message_id"])?;
    utc(&input["received_at"])?;
    let event = event(&input["event"])?;
    let p = &input["producer"];
    object(
        p,
        &[
            "subject",
            "service_name",
            "environment",
            "deployment_id",
            "scopes",
            "token_id",
            "auth_method",
        ],
    )?;
    string(&p["subject"], 255)?;
    string(&p["token_id"], 255)?;
    require(
        ["jwt", "oauth2", "service_binding", "mtls"]
            .contains(&p["auth_method"].as_str().ok_or(INVALID)?),
    )?;
    for k in ["service_name", "environment", "deployment_id"] {
        require(p[k] == input["event"][k])?;
    }
    let scopes = p["scopes"].as_array().ok_or(INVALID)?;
    require(!scopes.is_empty() && scopes.len() <= 32)?;
    for s in scopes {
        let s = string(s, 128)?;
        require(
            s.as_bytes()[0].is_ascii_lowercase()
                && s.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b":_-".contains(&b)),
        )?;
    }
    require(scopes.iter().any(|s| s == "diagnostics:write"))?;
    let t = &input["trace_context"];
    object(t, &["correlation_id", "traceparent", "tracestate"])?;
    require(t["correlation_id"] == input["event"]["correlation_id"])?;
    if let Some(v) = t.get("traceparent") {
        require(traceparent(v.as_str().ok_or(INVALID)?))?;
    }
    if let Some(v) = t.get("tracestate") {
        string(v, 512)?;
    }
    if let Some(origin) = input.get("origin") {
        match origin["kind"].as_str() {
            Some("external") => {
                object(origin, &["kind"])?;
            }
            Some("monitor") => {
                object(origin, &["kind", "monitor_id"])?;
                uuid(&origin["monitor_id"])?;
                require(
                    p["subject"] == "status-scheduler" && p["auth_method"] == "service_binding",
                )?;
            }
            _ => return Err(INVALID),
        }
    }
    Ok(event)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 最小合法事件。 / Minimal valid event fixture.
    fn fixture() -> Value {
        json!({"event_id":"01900000-0000-7000-8000-000000000001","schema_version":"1.0","kind":"dependency.failed","severity":"error","service_name":"api","environment":"production","deployment_id":"01900000-0000-7000-8000-000000000002","occurred_at":"2026-09-12T00:00:00Z","correlation_id":"01900000-0000-7000-8000-000000000003","summary":"failed","fingerprint":{"dependency":"db"},"trace_id":"11111111111111111111111111111111"})
    }

    #[test]
    fn rejects_loose_domain_inputs() {
        assert!(event(&fixture()).is_ok());
        for (key, value) in [
            ("service_name", json!("Not Valid")),
            ("occurred_at", json!("2026-09-12T00:00:00+00:00")),
            ("trace_id", Value::Null),
            ("attributes", json!({"http.response.status_code":600})),
            ("fingerprint", json!({"protocol":"ftp"})),
        ] {
            let mut v = fixture();
            v[key] = value;
            assert!(event(&v).is_err(), "{key}");
        }
    }

    #[test]
    fn rejects_unknown_locator_and_unbounded_query() {
        let mut v = fixture();
        v["evidence"] = json!([{"kind":"trace","backend":"tempo","locator":{"trace_id":"11111111111111111111111111111111","url":"https://example.com"}}]);
        assert!(event(&v).is_err());
        v["evidence"][0]["locator"]
            .as_object_mut()
            .unwrap()
            .remove("url");
        assert!(event(&v).is_ok());
        assert!(query(&json!({"nested":{"secret":"value"}})).is_err());
        assert!(query(&json!({"service":"a".repeat(513)})).is_err());
    }

    #[test]
    fn validates_traceparent_without_panics() {
        assert!(traceparent(
            "00-11111111111111111111111111111111-2222222222222222-01"
        ));
        assert!(!traceparent(
            "00-00000000000000000000000000000000-2222222222222222-01"
        ));
        assert!(!traceparent("é"));
    }

    #[test]
    fn binds_queue_identity_and_scope() {
        let mut v = json!({"schema_version":"1.0","message_id":"01900000-0000-7000-8000-000000000004","event":fixture(),"received_at":"2026-09-12T00:00:00Z","producer":{"subject":"api","service_name":"api","environment":"production","deployment_id":"01900000-0000-7000-8000-000000000002","scopes":["diagnostics:write"],"token_id":"token","auth_method":"jwt"},"trace_context":{"correlation_id":"01900000-0000-7000-8000-000000000003"}});
        assert!(envelope(&v).is_ok());
        v["producer"]["service_name"] = json!("other");
        assert!(envelope(&v).is_err());
        v["producer"]["service_name"] = json!("api");
        v["origin"] = json!({"kind":"monitor","monitor_id":"01900000-0000-7000-8000-000000000005"});
        assert!(envelope(&v).is_err());
    }
}

//! 注册引用解码；存储损坏不能成为出站查询。 / Decode registered references; corrupt storage must not become outbound queries.
use crate::wire::{Id, Slug, UtcTime};
use serde_json::{json, Value};
/// 映射并验证 D1 引用，供诊断图和查询共用。 / Map and validate a D1 reference for graph and query callers.
pub fn map_reference(row: &Value) -> Result<Value, String> {
    let fail = || "Stored telemetry reference is invalid".to_string();
    let locator: Value =
        serde_json::from_str(row["locator_json"].as_str().ok_or_else(fail)?).map_err(|_| fail())?;
    let mut result = json!({"id":row["telemetry_reference_id"],"kind":row["kind"],"backend":row["backend_name"],"service_name":row["service_name"],"deployment_id":row["deployment_id"],"locator":locator});
    for key in ["correlation_id", "trace_id", "span_id", "expires_at"] {
        if !row[key].is_null() {
            result[key] = row[key].clone();
        }
    }
    for key in ["id", "deployment_id"] {
        Id::new(result[key].as_str().ok_or_else(fail)?.into()).map_err(|_| fail())?;
    }
    if let Some(v) = result.get("correlation_id") {
        Id::new(v.as_str().ok_or_else(fail)?.into()).map_err(|_| fail())?;
    }
    Slug::<63>::new(result["service_name"].as_str().ok_or_else(fail)?.into())
        .map_err(|_| fail())?;
    let backend = result["backend"].as_str().ok_or_else(fail)?;
    if !registry_name(backend) {
        return Err(fail());
    }
    for (key, len) in [("trace_id", 32), ("span_id", 16)] {
        if let Some(v) = result.get(key) {
            if !hex(v, len) {
                return Err(fail());
            }
        }
    }
    if result.get("span_id").is_some() && result.get("trace_id").is_none() {
        return Err(fail());
    }
    if let Some(v) = result.get("expires_at") {
        UtcTime::new(v.as_str().ok_or_else(fail)?.into()).map_err(|_| fail())?;
    }
    let kind = result["kind"].as_str().ok_or_else(fail)?;
    let l = &result["locator"];
    let keys: &[&str] = match kind {
        "trace" => &["trace_id", "span_id"],
        "log_query" => &["query"],
        "metric_query" => &["metric_name", "query"],
        "profile" => &["profile_type", "profile_id", "query"],
        "source" => &["repository_url", "git_commit", "path", "line", "column"],
        "artifact" => &["artifact_digest", "artifact_kind", "build_id"],
        _ => return Err(fail()),
    };
    if l.as_object()
        .is_none_or(|o| o.keys().any(|k| !keys.contains(&k.as_str())))
    {
        return Err(fail());
    }
    let valid = match kind {
        "trace" => {
            hex(&l["trace_id"], 32)
                && l.get("span_id").is_none_or(|v| hex(v, 16))
                && result.get("trace_id").is_none_or(|v| v == &l["trace_id"])
        }
        "log_query" => valid_query(&l["query"]),
        "metric_query" => bounded(&l["metric_name"], 255) && valid_query(&l["query"]),
        "profile" => {
            ["cpu", "memory", "allocations", "mutex", "goroutine", "wall"]
                .contains(&l["profile_type"].as_str().unwrap_or(""))
                && (l.get("profile_id").is_some() || l.get("query").is_some())
                && l.get("profile_id").is_none_or(|v| bounded(v, 256))
                && l.get("query").is_none_or(valid_query)
        }
        "source" => valid_source(l),
        "artifact" => {
            l["artifact_digest"].as_str().is_some_and(|s| {
                s.strip_prefix("sha256:")
                    .is_some_and(|h| hex_digits(&json!(h), 64))
            }) && [
                "binary",
                "debug_symbols",
                "source_map",
                "sbom",
                "manifest",
                "other",
            ]
            .contains(&l["artifact_kind"].as_str().unwrap_or(""))
                && l.get("build_id").is_none_or(|v| bounded(v, 256))
        }
        _ => false,
    };
    if !valid {
        return Err(fail());
    }
    if ["log_query", "metric_query", "profile"].contains(&kind) {
        let start = row["range_start"].as_str().ok_or_else(fail)?;
        let end = row["range_end"].as_str().ok_or_else(fail)?;
        UtcTime::new(start.into()).map_err(|_| fail())?;
        UtcTime::new(end.into()).map_err(|_| fail())?;
        if chrono::DateTime::parse_from_rfc3339(start).map_err(|_| fail())?
            > chrono::DateTime::parse_from_rfc3339(end).map_err(|_| fail())?
        {
            return Err(fail());
        }
        result["time_range"] = json!({"start":start,"end":end});
    }
    Ok(result)
}
/// 注册名限定字母数字段。 / Registry names admit lowercase alphanumeric segments.
pub(super) fn registry_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.split(['.', '_', '-']).all(|p| {
            !p.is_empty()
                && p.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
}
/// 文本长度按 UTF-16。 / Text length follows UTF-16.
fn bounded(v: &Value, max: usize) -> bool {
    v.as_str()
        .is_some_and(|s| (1..=max).contains(&s.encode_utf16().count()))
}
/// 规范非零十六进制。 / Canonical nonzero hexadecimal.
fn hex(v: &Value, len: usize) -> bool {
    hex_digits(v, len) && v.as_str().is_some_and(|s| s.bytes().any(|b| b != b'0'))
}
/// 规范摘要十六进制允许全零值。 / Canonical digest hexadecimal permits zero values.
fn hex_digits(v: &Value, len: usize) -> bool {
    v.as_str().is_some_and(|s| {
        s.len() == len
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
/// 查询只包含有限标量。 / Queries contain bounded scalars only.
fn valid_query(v: &Value) -> bool {
    v.as_object().is_some_and(|o| {
        o.len() <= 16
            && o.iter().all(|(k, v)| {
                !k.is_empty()
                    && k.len() <= 64
                    && k.as_bytes()[0].is_ascii_lowercase()
                    && k.bytes().all(|b| {
                        b.is_ascii_lowercase() || b.is_ascii_digit() || b"_.-".contains(&b)
                    })
                    && (bounded(v, 512) || v.is_number() || v.is_boolean())
            })
    })
}
/// 源码路径必须相对且 commit 固定。 / Source paths are relative and commits pinned.
fn valid_source(l: &Value) -> bool {
    let url = l["repository_url"]
        .as_str()
        .and_then(|s| url::Url::parse(s).ok());
    url.is_some_and(|u| u.scheme() == "https" && u.as_str().len() <= 2048)
        && (hex_digits(&l["git_commit"], 40) || hex_digits(&l["git_commit"], 64))
        && bounded(&l["path"], 1024)
        && l["path"].as_str().is_some_and(|p| {
            !p.starts_with('/') && !p.split('/').any(|p| p == "..") && !p.contains(['\n', '\r'])
        })
        && ["line", "column"].iter().all(|k| {
            l.get(*k)
                .is_none_or(|v| v.as_u64().is_some_and(|n| (1..=10_000_000).contains(&n)))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_reference_identity_and_rejects_path_escape() {
        let mut row = json!({"telemetry_reference_id":"018f0000-0000-7000-8000-000000000001","deployment_id":"018f0000-0000-7000-8000-000000000002","service_name":"api","backend_name":"source","kind":"source","locator_json":json!({"repository_url":"https://github.com/org/repo","git_commit":"a".repeat(40),"path":"src/main.rs"}).to_string()});
        assert!(map_reference(&row).is_ok());
        row["locator_json"]=json!(json!({"repository_url":"https://github.com/org/repo","git_commit":"a".repeat(40),"path":"../secret"}).to_string());
        assert!(map_reference(&row).is_err());
    }
    #[test]
    fn rejects_reversed_range_and_trace_identity_conflict() {
        let mut row = json!({"telemetry_reference_id":"018f0000-0000-7000-8000-000000000001","deployment_id":"018f0000-0000-7000-8000-000000000002","service_name":"api","backend_name":"logs","kind":"log_query","locator_json":"{\"query\":{\"severity\":\"error\"}}","range_start":"2026-09-12T01:00:00Z","range_end":"2026-09-12T00:00:00Z"});
        assert!(map_reference(&row).is_err());
        row["range_end"] = json!("2026-09-12T02:00:00Z");
        assert!(map_reference(&row).is_ok());
    }
}

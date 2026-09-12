//! 区域信封与注册表纯校验。 / Pure regional envelope and registry validation.
#[cfg(test)]
use serde_json::json;
use serde_json::Value;
/// 严格对象拒绝未知键和缺失键。 / Exact objects reject unknown and missing keys.
fn exact(value: &Value, keys: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|o| o.len() == keys.len() && keys.iter().all(|k| o.contains_key(*k)))
}

/// 运维身份只允许有界 ASCII。 / Operator identities are bounded ASCII.
fn identity(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// 平台机房代码。 / Platform colo code.
fn colo(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|s| s.len() == 3 && s.bytes().all(|b| b.is_ascii_uppercase()))
}

/// 校验整个注册表，避免部分损坏配置被静默接受。 / Validate the entire registry, not merely the selected entry.
pub(super) fn valid_registry(value: &Value) -> bool {
    value.as_object().is_some_and(|registry| {
        registry.iter().all(|(location, config)| {
            identity(location)
                && exact(
                    config,
                    &["binding", "executor_id", "allowed_colos", "allowed_kinds"],
                )
                && config["executor_id"].as_str().is_some_and(identity)
                && config["binding"]
                    .as_str()
                    .and_then(|s| s.strip_prefix("PROBE_EXECUTOR_"))
                    .is_some_and(|s| {
                        !s.is_empty()
                            && s.bytes()
                                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
                    })
                && config["allowed_colos"]
                    .as_array()
                    .is_some_and(|v| (1..=64).contains(&v.len()) && v.iter().all(colo))
                && config["allowed_kinds"].as_array().is_some_and(|v| {
                    (1..=5).contains(&v.len())
                        && v.iter().all(|k| {
                            matches!(
                                k.as_str(),
                                Some("http" | "tcp" | "dns" | "rpc" | "synthetic")
                            )
                        })
                })
        })
    })
}

/// UUIDv7 使用共享领域验证。 / Reuse the domain's canonical UUIDv7 validation.
pub(super) fn uuid(value: &str) -> bool {
    status_domain::validate_uuid_v7(value, "id").is_ok()
        && matches!(value.as_bytes().get(19), Some(b'8' | b'9' | b'a' | b'b'))
}

/// UTC 协议时间转为毫秒。 / Convert UTC protocol timestamps to milliseconds.
pub(super) fn timestamp(value: &str) -> Option<f64> {
    if !value.ends_with('Z') || value.len() < 20 || value.as_bytes().get(10) != Some(&b'T') {
        return None;
    }
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|v| v.timestamp_millis() as f64)
}

/// 完整验证回显信封后才允许其进入健康评估。 / Validate the full envelope before admitting health evidence.
pub(super) fn valid_response(value: &Value) -> bool {
    let o = &value["observation"];
    exact(
        value,
        &[
            "version",
            "executor_id",
            "location",
            "run_id",
            "scheduled_for",
            "actual_colo",
            "observation",
        ],
    ) && value["version"] == "1"
        && ["executor_id", "location"]
            .iter()
            .all(|k| value[*k].as_str().is_some_and(identity))
        && value["run_id"].as_str().is_some_and(uuid)
        && value["scheduled_for"]
            .as_str()
            .and_then(timestamp)
            .is_some()
        && colo(&value["actual_colo"])
        && exact(
            o,
            &[
                "observationId",
                "monitorId",
                "observedAt",
                "outcome",
                "latencyMs",
                "protocolStatus",
                "errorType",
                "correlationId",
            ],
        )
        && ["observationId", "monitorId", "correlationId"]
            .iter()
            .all(|k| o[*k].as_str().is_some_and(uuid))
        && o["observedAt"].as_str().and_then(timestamp).is_some()
        && matches!(
            o["outcome"].as_str(),
            Some("success" | "failure" | "timeout" | "invalid")
        )
        && o["latencyMs"]
            .as_f64()
            .is_some_and(|n| n.is_finite() && (0.0..=300_000.0).contains(&n))
        && ["protocolStatus", "errorType"].iter().all(|k| {
            o[*k].is_null()
                || o[*k]
                    .as_str()
                    .is_some_and(|s| s.encode_utf16().count() <= 128)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_rejects_untrusted_bindings_and_extra_fields() {
        let mut registry = json!({"asia": {"binding":"PROBE_EXECUTOR_ASIA", "executor_id":"asia-1",
            "allowed_colos":["SIN"], "allowed_kinds":["http"]}});
        assert!(valid_registry(&registry));
        registry["asia"]["binding"] = json!("USER_INPUT");
        assert!(!valid_registry(&registry));
        registry["asia"]["binding"] = json!("PROBE_EXECUTOR_ASIA");
        registry["asia"]["url"] = json!("https://example.com");
        assert!(!valid_registry(&registry));
    }

    #[test]
    fn response_rejects_forged_execution_and_invalid_latency() {
        let id = "0198f803-1111-7111-8111-111111111111";
        let mut value = json!({"version":"1", "executor_id":"asia-1", "location":"asia",
            "run_id":id, "scheduled_for":"2026-09-12T12:00:00Z", "actual_colo":"SIN",
            "observation":{"observationId":id,"monitorId":id,"observedAt":"2026-09-12T12:00:00Z",
                "outcome":"success","latencyMs":1,"protocolStatus":null,"errorType":null,"correlationId":id}});
        assert!(valid_response(&value));
        value["observation"]["latencyMs"] = json!(-1);
        assert!(!valid_response(&value));
        value["observation"]["latencyMs"] = json!(1);
        value["observation"]["execution"] = json!({"actualColo":"SIN"});
        assert!(!valid_response(&value));
    }
}

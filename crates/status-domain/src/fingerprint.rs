//! 稳定 Diagnostic 指纹规范化。 / Stable Diagnostic fingerprint canonicalization.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::{DomainError, DomainResult};

/// 规范指纹及其 SHA-256 摘要。 / Canonical fingerprint and its SHA-256 digest.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CanonicalFingerprint {
    /// 无拼接歧义的规范 JSON。 / Canonical JSON without concatenation ambiguity.
    pub canonical: String,
    /// 64 位小写十六进制 SHA-256。 / 64-character lowercase hexadecimal SHA-256.
    pub hash: String,
}

/// 规范化 `kind + service_name + fingerprint` 并计算 SHA-256。 / Canonicalizes `kind + service_name + fingerprint` and computes SHA-256.
pub fn canonical_fingerprint(
    kind: &str,
    service_name: &str,
    fingerprint: &Value,
) -> DomainResult<CanonicalFingerprint> {
    let canonical = canonicalize_fingerprint(kind, service_name, fingerprint)?;
    let hash = hex::encode(Sha256::digest(canonical.as_bytes()));
    Ok(CanonicalFingerprint { canonical, hash })
}

/// 生成排序键、拒绝易变字段的无歧义规范 JSON。 / Produces unambiguous, key-sorted canonical JSON while rejecting volatile fields.
pub fn canonicalize_fingerprint(
    kind: &str,
    service_name: &str,
    fingerprint: &Value,
) -> DomainResult<String> {
    if !valid_dotted_name(kind) || service_name.trim().is_empty() {
        return Err(DomainError::Validation(
            "kind must be lowercase dotted text and service_name must be non-empty".into(),
        ));
    }
    let Value::Object(_) = fingerprint else {
        return Err(DomainError::Validation(
            "fingerprint must be a JSON object".into(),
        ));
    };
    let normalized = normalize(fingerprint)?;
    // A JSON tuple makes boundaries explicit; plain string concatenation has collisions.
    serde_json::to_string(&(kind, service_name, normalized)).map_err(Into::into)
}

fn normalize(value: &Value) -> DomainResult<Value> {
    match value {
        Value::Null | Value::Bool(_) | Value::String(_) => Ok(value.clone()),
        Value::Number(number) => {
            if number.as_f64().is_some_and(|number| !number.is_finite()) {
                return Err(DomainError::Validation(
                    "fingerprint numbers must be finite".into(),
                ));
            }
            Ok(value.clone())
        }
        Value::Array(values) => values
            .iter()
            .map(normalize)
            .collect::<DomainResult<Vec<_>>>()
            .map(Value::Array),
        Value::Object(values) => {
            let mut sorted = BTreeMap::new();
            for (key, value) in values {
                if key.trim().is_empty() || volatile_key(key) {
                    return Err(DomainError::Validation(format!(
                        "fingerprint key `{key}` is empty or volatile"
                    )));
                }
                sorted.insert(key.clone(), normalize(value)?);
            }
            serde_json::to_value(sorted).map_err(Into::into)
        }
    }
}

fn volatile_key(key: &str) -> bool {
    matches!(
        key.to_ascii_lowercase().as_str(),
        "timestamp"
            | "occurred_at"
            | "observed_at"
            | "received_at"
            | "event_id"
            | "diagnostic_event_id"
            | "trace_id"
            | "span_id"
            | "correlation_id"
            | "instance_id"
            | "request_id"
            | "summary"
            | "message"
            | "stacktrace"
    )
}

fn valid_dotted_name(value: &str) -> bool {
    !value.is_empty()
        && value.split('.').all(|segment| {
            !segment.is_empty()
                && segment
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
        })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn key_order_does_not_change_hash() {
        let left = canonical_fingerprint(
            "dependency.unavailable",
            "identity",
            &json!({"operation":"lookup","dependency":"d1"}),
        )
        .unwrap();
        let right = canonical_fingerprint(
            "dependency.unavailable",
            "identity",
            &json!({"dependency":"d1","operation":"lookup"}),
        )
        .unwrap();
        assert_eq!(left, right);
        assert_eq!(left.hash.len(), 64);
    }

    #[test]
    fn tuple_encoding_prevents_boundary_collision() {
        let a = canonical_fingerprint("a.bc", "d", &json!({"x":"e"})).unwrap();
        let b = canonical_fingerprint("a.b", "cd", &json!({"x":"e"})).unwrap();
        assert_ne!(a.hash, b.hash);
    }

    #[test]
    fn volatile_identity_and_free_text_are_rejected() {
        assert!(canonical_fingerprint(
            "dependency.unavailable",
            "identity",
            &json!({"trace_id":"4bf92f3577b34da6a3ce929d0e0e4736"})
        )
        .is_err());
        assert!(canonical_fingerprint(
            "dependency.unavailable",
            "identity",
            &json!({"summary":"random text"})
        )
        .is_err());
    }
}

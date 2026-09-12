//! 领域标识通知；Queue 至少一次投递，收件方按 event_id 去重。
//! Domain-ID notifications; Queue delivery is at least once and recipients deduplicate by event_id.

use crate::telemetry::{stable_token, TraceContext};
use serde::{Deserialize, Serialize};

/// 有版本、无私有正文的持久通知。 / Versioned durable notification without private bodies.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Notification {
    /// 消息协议版本。 / Message schema version.
    pub schema_version: String,
    /// 稳定 outbox ID。 / Stable outbox ID.
    pub event_id: String,
    /// 已发生领域事件。 / Domain event that occurred.
    pub event_type: String,
    /// 聚合类型。 / Aggregate type.
    pub aggregate_type: String,
    /// 聚合标识，不包含正文。 / Aggregate identifier, never a body.
    pub aggregate_id: String,
    /// 逻辑执行关联，不使用它授权。 / Logical execution correlation, not authorization.
    pub correlation_id: String,
    /// 生产者 W3C 上下文。 / Producer W3C context.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub traceparent: Option<String>,
    /// 有界 vendor 状态。 / Bounded vendor state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tracestate: Option<String>,
}

impl Notification {
    /// 构造并验证消息，重试须复用原始 event_id。 / Construct and validate; retries must reuse the original event_id.
    pub fn new(
        event_id: String,
        event_type: String,
        aggregate_type: String,
        aggregate_id: String,
        correlation_id: String,
        traceparent: Option<String>,
    ) -> Result<Self, &'static str> {
        let result = Self {
            schema_version: "1.0".into(),
            event_id,
            event_type,
            aggregate_type,
            aggregate_id,
            correlation_id,
            traceparent,
            tracestate: None,
        };
        result.validate()?;
        Ok(result)
    }
    /// 不接受未知版本或污染的执行身份。 / Reject unknown versions and polluted execution identities.
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.schema_version != "1.0"
            || status_domain::validate_uuid_v7(&self.event_id, "event_id").is_err()
            || status_domain::validate_uuid_v7(&self.correlation_id, "correlation_id").is_err()
            || !stable_token(&self.event_type, 128)
            || self.event_type.split('.').count() < 2
            || !self.event_type.split('.').all(|part| {
                part.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
                    && part
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
            })
            || !stable_token(&self.aggregate_type, 64)
            || self.aggregate_id.is_empty()
            || self.aggregate_id.len() > 256
            || !self
                .aggregate_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-:".contains(&b))
            || self
                .traceparent
                .as_deref()
                .is_some_and(|s| TraceContext::parse(s).is_none())
            || self
                .tracestate
                .as_deref()
                .is_some_and(|s| crate::telemetry::parse_tracestate(s).is_none())
            || (self.tracestate.is_some() && self.traceparent.is_none())
        {
            return Err("invalid_notification");
        }
        Ok(())
    }
}

/// Webhook 配置只来自 Secrets；禁止重定向泄漏授权。 / Webhook config comes only from Secrets; redirects must not leak authorization.
pub fn validate_endpoint(endpoint: &str, authorization: &str) -> Result<url::Url, &'static str> {
    let url = url::Url::parse(endpoint).map_err(|_| "invalid_notification_endpoint")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || authorization.is_empty()
        || authorization.len() > 8192
        || authorization.chars().any(char::is_control)
    {
        return Err("invalid_notification_configuration");
    }
    Ok(url)
}

/// 有界指数退避。 / Bounded exponential backoff.
pub fn retry_delay(attempt: u32) -> u32 {
    (1u32 << attempt.min(8)).min(300)
}

#[cfg(target_arch = "wasm32")]
mod platform;
#[cfg(target_arch = "wasm32")]
pub use platform::{consume_raw, publish};

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_unsafe_destinations() {
        for url in [
            "http://example.org",
            "https://user:pass@example.org",
            "https://example.org/#secret",
        ] {
            assert!(validate_endpoint(url, "Bearer key").is_err());
        }
        assert!(validate_endpoint("https://example.org/webhook", "Bearer key").is_ok());
        assert!(validate_endpoint("https://example.org", "Bearer key\r\nx: y").is_err());
    }
    #[test]
    fn rejects_unknown_versions_and_private_fields() {
        let id = "0199d09a-b692-7ce0-a1c0-5138a43d7402".to_string();
        let mut n = Notification::new(
            id.clone(),
            "incident.created".into(),
            "incident".into(),
            id.clone(),
            id,
            None,
        )
        .unwrap();
        n.schema_version = "2.0".into();
        assert!(n.validate().is_err());
        let mut v = serde_json::to_value(n).unwrap();
        v["private_body"] = serde_json::json!("secret");
        assert!(serde_json::from_value::<Notification>(v).is_err());
        assert_eq!(retry_delay(u32::MAX), 256);
    }
    #[test]
    fn accepts_service_target_and_preserves_delivery_identity() {
        let id = "0199d09a-b692-7ce0-a1c0-5138a43d7402".to_string();
        let n = Notification::new(
            id.clone(),
            "status.changed".into(),
            "status_target".into(),
            "service:api".into(),
            id.clone(),
            None,
        )
        .unwrap();
        let restored: Notification =
            serde_json::from_value(serde_json::to_value(n).unwrap()).unwrap();
        assert_eq!(restored.event_id, id);
        assert_eq!(restored.aggregate_id, "service:api");
        assert!(restored.validate().is_ok());
    }
}

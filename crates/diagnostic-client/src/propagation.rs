//! 安全执行上下文传播。 / Safe execution-context propagation.
use status_domain::{validate_uuid_v7, DomainError, DomainResult};
use std::collections::BTreeSet;

/// 已验证且不可直接构造的上下文。 / Validated context with private construction.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiagnosticPropagation {
    correlation_id: String,
    trace_id: String,
    span_id: String,
    traceparent: String,
    tracestate: Option<String>,
}
impl DiagnosticPropagation {
    /// 创建根上下文。 / Creates a root context.
    pub fn new(now_ms: i64) -> DomainResult<Self> {
        Self::from_headers(None, None, None, false, false, now_ms)
    }
    /// 解析边界；公网轮换关联 ID，所有边界新建 span。 / Parses a boundary; public correlation rotates and every span is new.
    pub fn from_headers(
        traceparent: Option<&str>,
        tracestate: Option<&str>,
        correlation_id: Option<&str>,
        internal: bool,
        trust_trace: bool,
        now_ms: i64,
    ) -> DomainResult<Self> {
        let incoming = traceparent.filter(|_| trust_trace).and_then(parse_parent);
        let (trace_id, flags) = incoming.clone().unwrap_or((random_hex(16)?, "00".into()));
        let span_id = random_hex(8)?;
        let correlation_id = match correlation_id
            .filter(|s| internal && validate_uuid_v7(s, "correlation_id").is_ok())
        {
            Some(id) => id.to_owned(),
            None => uuid_v7(now_ms)?,
        };
        Ok(Self {
            traceparent: format!("00-{trace_id}-{span_id}-{flags}"),
            trace_id,
            span_id,
            correlation_id,
            tracestate: if incoming.is_some() {
                tracestate.and_then(parse_state)
            } else {
                None
            },
        })
    }
    /// 关联身份。 / Correlation identity.
    pub fn correlation_id(&self) -> &str {
        &self.correlation_id
    }
    /// Trace 身份。 / Trace identity.
    pub fn trace_id(&self) -> &str {
        &self.trace_id
    }
    /// Span 身份。 / Span identity.
    pub fn span_id(&self) -> &str {
        &self.span_id
    }
    /// 出站 traceparent。 / Outgoing traceparent.
    pub fn traceparent(&self) -> &str {
        &self.traceparent
    }
    /// 出站 tracestate。 / Outgoing tracestate.
    pub fn tracestate(&self) -> Option<&str> {
        self.tracestate.as_deref()
    }
}
/// 验证非零小写 W3C ID。 / Validates a nonzero lowercase W3C ID.
pub(crate) fn valid_hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn parse_parent(value: &str) -> Option<(String, String)> {
    let parts: Vec<_> = value.split('-').collect();
    if parts.len() < 4
        || !valid_hex(parts[0], 2)
        || parts[0] == "ff"
        || (parts[0] == "00" && parts.len() != 4)
        || !valid_hex(parts[1], 32)
        || !valid_hex(parts[2], 16)
        || !valid_hex(parts[3], 2)
        || parts[1].bytes().all(|b| b == b'0')
        || parts[2].bytes().all(|b| b == b'0')
        || parts[4..]
            .iter()
            .any(|p| p.is_empty() || !valid_hex(p, p.len()))
    {
        return None;
    }
    Some((parts[1].into(), parts[3].into()))
}
fn parse_state(value: &str) -> Option<String> {
    if value.is_empty() || value.len() > 512 {
        return None;
    }
    let key = regex::Regex::new(
        r"^(?:[a-z][a-z0-9_*/-]{0,255}|[a-z0-9][a-z0-9_*/-]{0,240}@[a-z][a-z0-9_*/-]{0,13})$",
    )
    .ok()?;
    let mut keys = BTreeSet::new();
    let mut result = Vec::new();
    for member in value.split(',') {
        let (k, v) = member.trim().split_once('=')?;
        if !key.is_match(k)
            || !keys.insert(k)
            || v.is_empty()
            || v.len() > 256
            || v.ends_with(' ')
            || !v
                .bytes()
                .all(|b| (0x20..=0x7e).contains(&b) && b != b'=' && b != b',')
        {
            return None;
        }
        result.push(format!("{k}={v}"));
    }
    (result.len() <= 32).then(|| result.join(","))
}
fn random_hex(len: usize) -> DomainResult<String> {
    let mut bytes = vec![0; len];
    getrandom::getrandom(&mut bytes)
        .map_err(|_| DomainError::Validation("secure randomness unavailable".into()))?;
    if bytes.iter().all(|b| *b == 0) {
        return random_hex(len);
    }
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
/// 创建带随机尾部的 UUIDv7。 / Creates UUIDv7 with a random suffix.
pub(crate) fn uuid_v7(now_ms: i64) -> DomainResult<String> {
    if !(0..=0xffff_ffff_ffff).contains(&now_ms) {
        return Err(DomainError::Validation("clock outside UUIDv7 range".into()));
    }
    let mut bytes = [0; 16];
    getrandom::getrandom(&mut bytes)
        .map_err(|_| DomainError::Validation("secure randomness unavailable".into()))?;
    bytes[..6].copy_from_slice(&now_ms.to_be_bytes()[2..]);
    bytes[6] = (bytes[6] & 15) | 0x70;
    bytes[8] = (bytes[8] & 63) | 0x80;
    let h: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &h[..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..]
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn boundary_rotates_and_validates() {
        let root = DiagnosticPropagation::new(1234).unwrap();
        let child = DiagnosticPropagation::from_headers(
            Some(root.traceparent()),
            Some("vendor=ok"),
            Some(root.correlation_id()),
            true,
            true,
            1235,
        )
        .unwrap();
        assert_eq!(root.trace_id(), child.trace_id());
        assert_ne!(root.span_id(), child.span_id());
        assert_eq!(root.correlation_id(), child.correlation_id());
        assert!(parse_parent("00-00000000000000000000000000000000-1234567890123456-01").is_none());
        assert!(parse_state("a=b,a=c").is_none());
    }
}

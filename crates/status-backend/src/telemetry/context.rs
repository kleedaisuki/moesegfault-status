//! 显式 W3C 上下文，不冒充 Cloudflare 平台 trace。 / Explicit W3C context, never impersonating platform traces.

use serde::{Deserialize, Serialize};

/// 已验证的执行上下文。 / Validated execution context.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TraceContext {
    /// 非零 trace ID。 / Nonzero trace ID.
    pub trace_id: String,
    /// 当前边界 span ID。 / Current boundary span ID.
    pub span_id: String,
    /// 保留的采样位。 / Preserved sampling flags.
    pub trace_flags: u8,
    /// 合法的 vendor 状态。 / Valid vendor state.
    pub tracestate: Option<String>,
}

/// 小写十六进制判定。 / Lowercase hexadecimal check.
pub fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl TraceContext {
    /// 拒绝零标识、非法版本、长度及 flags；未来版本只接受十六进制扩展。 / Reject zero IDs, invalid versions, lengths and flags; future extensions must be hexadecimal.
    pub fn parse(value: &str) -> Option<Self> {
        let parts: Vec<_> = value.split('-').collect();
        if parts.len() < 4
            || !hex(parts[0], 2)
            || parts[0] == "ff"
            || (parts[0] == "00" && parts.len() != 4)
            || !hex(parts[1], 32)
            || !hex(parts[2], 16)
            || !hex(parts[3], 2)
            || parts[1].bytes().all(|b| b == b'0')
            || parts[2].bytes().all(|b| b == b'0')
            || parts[4..].iter().any(|s| s.is_empty() || !hex(s, s.len()))
        {
            return None;
        }
        Some(Self {
            trace_id: parts[1].into(),
            span_id: parts[2].into(),
            trace_flags: u8::from_str_radix(parts[3], 16).ok()?,
            tracestate: None,
        })
    }

    /// 序列化规范 version 00。 / Serialize canonical version 00.
    pub fn traceparent(&self) -> String {
        format!(
            "00-{}-{}-{:02x}",
            self.trace_id, self.span_id, self.trace_flags
        )
    }

    /// 新建边界 span，保留父 trace 和采样决策。 / Create boundary span, preserving the parent trace and sampling decision.
    #[cfg(target_arch = "wasm32")]
    pub fn child(parent: Option<&str>, state: Option<&str>) -> worker::Result<Self> {
        let mut result = match parent.and_then(Self::parse) {
            Some(parent) => parent,
            None => Self {
                trace_id: random_hex(16)?,
                span_id: String::new(),
                trace_flags: 1,
                tracestate: None,
            },
        };
        result.span_id = random_hex(8)?;
        result.tracestate = parent
            .and_then(Self::parse)
            .and_then(|_| state.and_then(parse_tracestate));
        Ok(result)
    }
}

/// W3C tracestate 原子校验；非法列表整体丢弃。 / Atomically validate W3C tracestate; reject the whole invalid list.
pub fn parse_tracestate(value: &str) -> Option<String> {
    if value.is_empty() || value.len() > 512 {
        return None;
    }
    let mut keys = std::collections::BTreeSet::new();
    let mut entries = Vec::new();
    for raw in value.split(',') {
        let (key, value) = raw.trim_matches([' ', '\t']).split_once('=')?;
        if !state_key(key)
            || !keys.insert(key)
            || keys.len() > 32
            || value.is_empty()
            || value.len() > 256
            || value.starts_with(' ')
            || value.ends_with(' ')
            || !value
                .bytes()
                .all(|b| (0x20..=0x7e).contains(&b) && b != b'=' && b != b',')
        {
            return None;
        }
        entries.push(format!("{key}={value}"));
    }
    Some(entries.join(","))
}

/// W3C vendor key 范围。 / W3C vendor-key bounds.
fn state_key(key: &str) -> bool {
    let valid = |s: &str| {
        s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"_-*/".contains(&b))
    };
    match key.split_once('@') {
        Some((tenant, system)) => {
            !tenant.is_empty()
                && tenant.len() <= 241
                && tenant.as_bytes()[0].is_ascii_alphanumeric()
                && valid(tenant)
                && !system.is_empty()
                && system.len() <= 14
                && system.as_bytes()[0].is_ascii_lowercase()
                && valid(system)
        }
        None => {
            !key.is_empty()
                && key.len() <= 256
                && key.as_bytes()[0].is_ascii_lowercase()
                && valid(key)
        }
    }
}

/// 确定性比例采样；错误、慢请求和 incident 强制保留。 / Deterministic ratio sampling; retain errors, slow operations and incidents.
pub fn should_sample(trace_id: &str, rate: f64, error: bool, slow: bool, incident: bool) -> bool {
    if !hex(trace_id, 32) || !(0.0..=1.0).contains(&rate) {
        return false;
    }
    if error || slow || incident {
        return true;
    }
    let hash = trace_id.bytes().fold(2_166_136_261u32, |h, b| {
        (h ^ u32::from(b)).wrapping_mul(16_777_619)
    });
    f64::from(hash) / 4_294_967_296.0 < rate
}

/// 加密随机非零标识。 / Cryptographically random nonzero identifiers.
#[cfg(target_arch = "wasm32")]
fn random_hex(length: usize) -> worker::Result<String> {
    let mut bytes = vec![0; length];
    loop {
        getrandom::getrandom(&mut bytes)
            .map_err(|_| worker::Error::RustError("randomness_unavailable".into()))?;
        if bytes.iter().any(|b| *b != 0) {
            return Ok(bytes.iter().map(|b| format!("{b:02x}")).collect());
        }
    }
}

/// RFC 9562 UUIDv7，时间与随机数均由平台提供。 / RFC 9562 UUIDv7 using platform time and cryptographic randomness.
#[cfg(target_arch = "wasm32")]
pub fn create_correlation_id() -> worker::Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes)
        .map_err(|_| worker::Error::RustError("randomness_unavailable".into()))?;
    let now = js_sys::Date::now() as u64;
    bytes[..6].copy_from_slice(&now.to_be_bytes()[2..]);
    bytes[6] = (bytes[6] & 0x0f) | 0x70;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn trace_validation_and_sampling() {
        let valid = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01";
        assert_eq!(TraceContext::parse(valid).unwrap().traceparent(), valid);
        for value in [
            valid.replace("00-", "ff-"),
            format!("{valid}-ab"),
            "00-0123456789abcdef0123456789abcdef-0000000000000000-01".into(),
            valid.to_uppercase(),
        ] {
            assert!(TraceContext::parse(&value).is_none());
        }
        assert!(should_sample(&"a".repeat(32), 0.0, true, false, false));
        assert!(!should_sample(&"a".repeat(32), 0.0, false, false, false));
        assert!(should_sample(&"a".repeat(32), 1.0, false, false, false));
    }
    #[test]
    fn tracestate_is_atomic() {
        assert_eq!(
            parse_tracestate("foo=bar, 1@vendor=baz"),
            Some("foo=bar,1@vendor=baz".into())
        );
        for value in ["foo=a,foo=b", "Foo=a", "foo=a=b", "foo=", "foo= a"] {
            assert!(parse_tracestate(value).is_none());
        }
    }
}

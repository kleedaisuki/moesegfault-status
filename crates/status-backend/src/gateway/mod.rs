//! 固定 HTTP 能力表与浏览器边界，业务验证由私有 Rust 服务执行。
//! Fixed HTTP capability table and browser boundary; private Rust services validate business contracts.

mod routes;
pub use routes::{resolve, Route, RpcMethod};
#[cfg(target_arch = "wasm32")]
mod runtime;
#[cfg(target_arch = "wasm32")]
pub use runtime::handle;

use crate::http::HttpError;

/// 配置错误不泄漏部署细节。 / Configuration failures reveal no deployment details.
pub const CONFIG: HttpError = HttpError::new(
    503,
    "gateway-misconfigured",
    "Administrative gateway is unavailable",
);
/// 验证精确来源，无路径、凭证或隐式规范化。 / Validate exact origin without paths, credentials or implicit normalization.
pub fn configured_origin(value: &str) -> Result<String, HttpError> {
    let url = url::Url::parse(value).map_err(|_| CONFIG)?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if url.origin().ascii_serialization() != value
        || !url.username().is_empty()
        || url.password().is_some()
        || !(url.scheme() == "https" || local && url.scheme() == "http")
    {
        return Err(CONFIG);
    }
    Ok(value.into())
}
/// 严格强数字 ETag；拒绝弱标签、通配符和列表。 / Strict numeric strong ETag; reject weak tags, wildcards and lists.
pub fn expected_revision(value: Option<&str>) -> Result<u64, HttpError> {
    let invalid = HttpError::new(
        428,
        "precondition-required",
        "A strong numeric If-Match value is required",
    );
    let s = value
        .and_then(|s| s.strip_prefix('"'))
        .and_then(|s| s.strip_suffix('"'))
        .ok_or_else(|| invalid.clone())?;
    if s.is_empty() || s.len() > 10 || s.starts_with('0') || !s.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(invalid);
    }
    s.parse().map_err(|_| invalid)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn origin_and_preconditions_are_exact() {
        assert!(configured_origin("https://ops.example.com").is_ok());
        for s in [
            "https://ops.example.com/",
            "https://a@ops.example.com",
            "http://ops.example.com",
            "https://ops.example.com?q=1",
        ] {
            assert!(configured_origin(s).is_err(), "{s}");
        }
        assert_eq!(expected_revision(Some("\"42\"")).unwrap(), 42);
        for s in ["42", "W/\"42\"", "\"0\"", "\"01\"", "*", "\"1\",\"2\""] {
            assert!(expected_revision(Some(s)).is_err());
        }
    }
}

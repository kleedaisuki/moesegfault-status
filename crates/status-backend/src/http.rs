//! Rust 请求边界；校验实际流长度，不信任 Content-Length。
//! Rust request boundary; validate actual streamed bytes, not Content-Length alone.

use futures_util::{Stream, StreamExt};
use serde::de::DeserializeOwned;

/// 只携带可安全公开的错误。 / Contains only safe public errors.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{detail}")]
pub struct HttpError {
    /// HTTP 状态。 / HTTP status.
    pub status: u16,
    /// 稳定协议错误码。 / Stable protocol error code.
    pub code: &'static str,
    /// 不含内部错误或秘密。 / No internal errors or secrets.
    pub detail: &'static str,
}

impl HttpError {
    /// 创建安全错误。 / Construct a safe error.
    pub const fn new(status: u16, code: &'static str, detail: &'static str) -> Self {
        Self {
            status,
            code,
            detail,
        }
    }
}

/// 请求体超限。 / Request body exceeds the limit.
const TOO_LARGE: HttpError =
    HttpError::new(413, "payload-too-large", "Request body exceeds the limit");
/// 非法 UTF-8 或 JSON。 / Invalid UTF-8 or JSON.
const INVALID_JSON: HttpError =
    HttpError::new(400, "invalid-json", "Body must contain valid UTF-8 JSON");

/// 在读取请求体前拒绝错误媒体类型和过大的声明长度。
/// Reject invalid media type and oversized declared length before reading the body.
pub fn validate_body_headers(
    content_type: Option<&str>,
    content_length: Option<&str>,
    maximum: usize,
) -> Result<(), HttpError> {
    if !content_type.is_some_and(|s| {
        s.split(';')
            .next()
            .unwrap_or("")
            .trim()
            .eq_ignore_ascii_case("application/json")
    }) {
        return Err(HttpError::new(
            415,
            "unsupported-media-type",
            "application/json is required",
        ));
    }
    if let Some(length) = content_length {
        if length.is_empty()
            || !length.bytes().all(|b| b.is_ascii_digit())
            || length.parse::<usize>().map_or(true, |n| n > maximum)
        {
            return Err(TOO_LARGE);
        }
    }
    Ok(())
}

/// 按块限制内存，超限立即返回并丢弃流；不预分配声明长度。
/// Bound memory per chunk; drop the stream on overflow without preallocating declared length.
pub async fn read_json_stream<T, S, E>(mut stream: S, maximum: usize) -> Result<T, HttpError>
where
    T: DeserializeOwned,
    S: Stream<Item = Result<Vec<u8>, E>> + Unpin,
{
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| INVALID_JSON)?;
        if chunk.len() > maximum.saturating_sub(bytes.len()) {
            return Err(TOO_LARGE);
        }
        bytes.extend_from_slice(&chunk);
    }
    // 与 TextDecoder 默认 BOM 行为一致。 / Match TextDecoder's default BOM handling.
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
    serde_json::from_slice(bytes).map_err(|_| INVALID_JSON)
}

/// 直接从 Workers Rust SDK 读取请求，不经过 TypeScript。
/// Read requests directly through the Workers Rust SDK, without TypeScript.
#[cfg(target_arch = "wasm32")]
pub async fn read_json<T: DeserializeOwned>(
    request: &mut worker::Request,
    maximum: usize,
) -> Result<T, HttpError> {
    let content_type = request
        .headers()
        .get("content-type")
        .map_err(|_| INVALID_JSON)?;
    let content_length = request
        .headers()
        .get("content-length")
        .map_err(|_| INVALID_JSON)?;
    validate_body_headers(content_type.as_deref(), content_length.as_deref(), maximum)?;
    let stream = request
        .stream()
        .map_err(|_| HttpError::new(400, "invalid-json", "JSON body is required"))?;
    read_json_stream(stream, maximum).await
}

/// 保持分页 limit 的词法约束，拒绝前导零及正负号。
/// Preserve lexical pagination bounds, rejecting leading zeros and signs.
pub fn parse_limit(value: Option<&str>) -> Result<u16, HttpError> {
    let Some(value) = value else {
        return Ok(50);
    };
    let invalid = HttpError::new(
        400,
        "invalid-request",
        "limit must be an integer from 1 through 100",
    );
    if value.is_empty()
        || value.len() > 3
        || value.starts_with('0')
        || !value.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(invalid);
    }
    value
        .parse::<u16>()
        .ok()
        .filter(|n| (1..=100).contains(n))
        .ok_or(invalid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{stream, FutureExt};
    use serde_json::Value;

    #[test]
    fn validates_headers_before_reading() {
        assert!(
            validate_body_headers(Some("Application/JSON; charset=utf-8"), Some("0002"), 2).is_ok()
        );
        assert_eq!(
            validate_body_headers(Some("application/json"), Some("3"), 2),
            Err(TOO_LARGE)
        );
        assert_eq!(
            validate_body_headers(Some("application/json"), Some("-1"), 2),
            Err(TOO_LARGE)
        );
        assert_eq!(
            validate_body_headers(None, None, 2).unwrap_err().status,
            415
        );
    }

    #[test]
    fn bounds_actual_stream_and_validates_encoding() {
        let chunks: Vec<Result<Vec<u8>, ()>> = vec![Ok(b"{\"x\":".to_vec()), Ok(b"1}".to_vec())];
        let result = read_json_stream::<Value, _, _>(stream::iter(chunks.clone()), 7)
            .now_or_never()
            .unwrap()
            .unwrap();
        assert_eq!(result["x"], 1);
        assert_eq!(
            read_json_stream::<Value, _, _>(stream::iter(chunks), 6)
                .now_or_never()
                .unwrap(),
            Err(TOO_LARGE)
        );
        let bad: Vec<Result<Vec<u8>, ()>> = vec![Ok(vec![b'"', 0xff, b'"'])];
        assert_eq!(
            read_json_stream::<Value, _, _>(stream::iter(bad), 3)
                .now_or_never()
                .unwrap(),
            Err(INVALID_JSON)
        );
    }

    #[test]
    fn preserves_limit_contract() {
        assert_eq!(parse_limit(None), Ok(50));
        assert_eq!(parse_limit(Some("100")), Ok(100));
        for value in ["", "0", "01", "+1", "-1", "101", "1.0", " 1"] {
            assert!(parse_limit(Some(value)).is_err(), "{value}");
        }
    }
}

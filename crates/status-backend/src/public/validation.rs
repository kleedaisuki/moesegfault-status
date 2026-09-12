//! 公开协议共享验证。 / Shared public wire validation.

/// 与 JavaScript 字符串契约一样使用 UTF-16 长度。 / Match JavaScript string contracts using UTF-16 length.
pub(super) fn text(value: &str, minimum: usize, maximum: usize) -> bool {
    (minimum..=maximum).contains(&value.encode_utf16().count())
}

/// 严格 UTC RFC3339，最多纳秒精度，不接受闰秒或偏移。
/// Strict UTC RFC3339, at most nanosecond precision, without leap seconds or offsets.
pub(super) fn timestamp(value: &str) -> bool {
    if !value.is_ascii()
        || !(20..=30).contains(&value.len())
        || !value.ends_with('Z')
        || value.as_bytes().get(10) != Some(&b'T')
    {
        return false;
    }
    if value.len() > 20
        && (value.as_bytes()[19] != b'.'
            || !(1..=9).contains(&(value.len() - 21))
            || !value.as_bytes()[20..value.len() - 1]
                .iter()
                .all(u8::is_ascii_digit))
    {
        return false;
    }
    if &value[17..19] == "60" {
        return false;
    }
    chrono::DateTime::parse_from_rfc3339(value).is_ok()
}

/// 公开服务名使用有界小写 ASCII 分段。 / Public service names use bounded lowercase ASCII segments.
pub(super) fn service_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 63
        && value.split('-').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
}

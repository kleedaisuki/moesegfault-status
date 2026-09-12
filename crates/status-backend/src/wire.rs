//! 在反序列化时维护协议不变量，避免业务层重复条件检查。
//! Enforce wire invariants during deserialization instead of repeating checks in business logic.

use serde::{Deserialize, Deserializer, Serialize};
use std::fmt;

/// 不包含用户数据的验证错误。 / Validation error without user data.
#[derive(Debug, thiserror::Error)]
#[error("Value violates the wire contract")]
pub struct InvalidValue;

/// 有界 UTF-16 文本，与现有浏览器字符串长度契约一致。
/// Bounded UTF-16 text matching the existing browser string-length contract.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct Text<const MIN: usize, const MAX: usize>(String);

impl<const MIN: usize, const MAX: usize> Text<MIN, MAX> {
    /// 校验一次，之后不可变。 / Validate once, then remain immutable.
    pub fn new(value: String) -> Result<Self, InvalidValue> {
        if !(MIN..=MAX).contains(&value.encode_utf16().count()) {
            return Err(InvalidValue);
        }
        Ok(Self(value))
    }
    /// 借用已验证文本。 / Borrow validated text.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
impl<'de, const MIN: usize, const MAX: usize> Deserialize<'de> for Text<MIN, MAX> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

/// 不可变的有界小写 kebab-case 标识。 / Immutable bounded lowercase kebab-case identifier.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(transparent)]
pub struct Slug<const MAX: usize>(String);
impl<const MAX: usize> Slug<MAX> {
    /// 拒绝空段、非 ASCII 和越界长度。 / Reject empty segments, non-ASCII, and excessive length.
    pub fn new(value: String) -> Result<Self, InvalidValue> {
        if value.is_empty()
            || value.len() > MAX
            || !value.split('-').all(|p| {
                !p.is_empty()
                    && p.bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
            })
        {
            return Err(InvalidValue);
        }
        Ok(Self(value))
    }
    /// 借用稳定标识。 / Borrow the stable identifier.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
impl<'de, const MAX: usize> Deserialize<'de> for Slug<MAX> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

/// 规范小写 UUIDv7。 / Canonical lowercase UUIDv7.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct Id(String);
impl Id {
    /// 验证 RFC 9562 版本与规范形式。 / Validate RFC 9562 version and canonical form.
    pub fn new(value: String) -> Result<Self, InvalidValue> {
        status_domain::validate_uuid_v7(&value, "id").map_err(|_| InvalidValue)?;
        Ok(Self(value))
    }
    /// 借用身份字符串。 / Borrow identity text.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
impl<'de> Deserialize<'de> for Id {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

/// UTC RFC3339，保留原始精度但禁止偏移与闰秒。 / UTC RFC3339, preserving precision but excluding offsets and leap seconds.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct UtcTime(String);
impl UtcTime {
    /// 与既有 UTC wire schema 相同的语法。 / Syntax matching the existing UTC wire schema.
    pub fn new(value: String) -> Result<Self, InvalidValue> {
        if !value.is_ascii()
            || !(20..=30).contains(&value.len())
            || !value.ends_with('Z')
            || value.as_bytes()[10] != b'T'
        {
            return Err(InvalidValue);
        }
        if value.len() > 20
            && (value.as_bytes()[19] != b'.'
                || !(1..=9).contains(&(value.len() - 21))
                || !value.as_bytes()[20..value.len() - 1]
                    .iter()
                    .all(u8::is_ascii_digit))
        {
            return Err(InvalidValue);
        }
        if &value[17..19] == "60" || chrono::DateTime::parse_from_rfc3339(&value).is_err() {
            return Err(InvalidValue);
        }
        Ok(Self(value))
    }
    /// 借用 UTC 时间字符串。 / Borrow UTC timestamp text.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
impl<'de> Deserialize<'de> for UtcTime {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

/// 正整数乐观并发版本，保证 JavaScript 客户端可精确表示。
/// Positive optimistic-concurrency revision, exactly representable by JavaScript clients.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct Revision(u64);
impl Revision {
    /// 仅允许安全正整数。 / Allow safe positive integers only.
    pub fn new(value: u64) -> Result<Self, InvalidValue> {
        if !(1..=9_007_199_254_740_991).contains(&value) {
            return Err(InvalidValue);
        }
        Ok(Self(value))
    }
    /// 数值版本。 / Numeric revision.
    pub fn get(self) -> u64 {
        self.0
    }
    /// 安全递增，不能静默溢出。 / Checked increment, never silently overflowing.
    pub fn next(self) -> Result<Self, InvalidValue> {
        Self::new(self.0 + 1)
    }
}
impl<'de> Deserialize<'de> for Revision {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(u64::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}
impl fmt::Display for Revision {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_invalid_values_at_deserialization_boundary() {
        assert!(serde_json::from_str::<Slug<63>>(r#""Upper""#).is_err());
        assert!(serde_json::from_str::<Slug<63>>(r#""two--parts""#).is_err());
        assert!(serde_json::from_str::<Id>(r#""not-an-id""#).is_err());
        assert!(serde_json::from_str::<UtcTime>(r#""2026-09-12T00:00:00+00:00""#).is_err());
        assert!(serde_json::from_str::<UtcTime>(r#""2026-09-12T00:00:00.123Z""#).is_ok());
        assert!(serde_json::from_str::<Revision>("0").is_err());
        assert!(Revision::new(9_007_199_254_740_991)
            .unwrap()
            .next()
            .is_err());
    }
    #[test]
    fn counts_utf16_units_and_preserves_serialization() {
        assert!(Text::<1, 1>::new("猫".into()).is_ok());
        assert!(Text::<1, 1>::new("🐈".into()).is_err());
        let value = Text::<1, 2>::new("🐈".into()).unwrap();
        assert_eq!(serde_json::to_string(&value).unwrap(), "\"🐈\"");
    }
}

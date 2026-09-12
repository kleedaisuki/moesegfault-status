//! 配置端点和 secret 引用边界。 / Configured endpoint and secret-reference boundaries.
use serde::Deserialize;
use std::collections::BTreeMap;
use url::Url;
/// 每注册后端的不可变出站策略。 / Immutable outbound policy per registered backend.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Config {
    /// 固定 API 根。 / Pinned API root.
    pub endpoint: String,
    /// 精确主机列表。 / Exact host list.
    pub allowed_hosts: Vec<String>,
    /// 固定认证方案。 / Fixed authentication scheme.
    #[serde(default = "auth")]
    pub auth_scheme: String,
    /// 整个正文请求期限。 / Whole-body request deadline.
    #[serde(default = "timeout")]
    pub timeout_ms: u64,
    /// 流式正文硬上限。 / Streaming body hard limit.
    #[serde(default = "maximum")]
    pub max_response_bytes: usize,
    /// 部署提供的租户。 / Deployment-provided tenant.
    pub tenant_id: Option<String>,
}
fn auth() -> String {
    "bearer".into()
}
fn timeout() -> u64 {
    3000
}
fn maximum() -> usize {
    512000
}
/// 全表验证失败关闭。 / Validate the whole map and fail closed.
pub(super) fn configs(raw: Option<&str>) -> BTreeMap<String, Config> {
    let Some(raw) = raw.filter(|r| r.len() <= 256000) else {
        return BTreeMap::new();
    };
    let Ok(map) = serde_json::from_str::<BTreeMap<String, Config>>(raw) else {
        return BTreeMap::new();
    };
    if map
        .iter()
        .any(|(name, c)| !super::reference::registry_name(name) || !valid(c))
    {
        return BTreeMap::new();
    }
    map
}
/// HTTPS 和凭据排除检查每个 URL。 / Check HTTPS and exclude URL credentials on every URL.
pub(super) fn allowed(raw: &str, c: &Config) -> Option<Url> {
    let u = Url::parse(raw).ok()?;
    (u.scheme() == "https"
        && u.username().is_empty()
        && u.password().is_none()
        && u.host_str()
            .is_some_and(|h| c.allowed_hosts.iter().any(|a| a == h)))
    .then_some(u)
}
fn valid(c: &Config) -> bool {
    (1..=16).contains(&c.allowed_hosts.len())
        && c.allowed_hosts.iter().all(|h| {
            !h.is_empty()
                && h.len() <= 253
                && h.split('.').all(|p| {
                    !p.is_empty()
                        && p.len() <= 63
                        && !p.starts_with('-')
                        && !p.ends_with('-')
                        && p.bytes()
                            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                })
        })
        && c.endpoint.len() <= 2048
        && allowed(&c.endpoint, c).is_some()
        && ["bearer", "basic", "none"].contains(&c.auth_scheme.as_str())
        && (100..=10000).contains(&c.timeout_ms)
        && (1024..=2000000).contains(&c.max_response_bytes)
        && c.tenant_id
            .as_ref()
            .is_none_or(|v| !v.is_empty() && v.encode_utf16().count() <= 128)
}
/// Secret 值只送往固定鉴权头，不序列化。 / Secret values only reach pinned auth headers, never serialization.
pub(super) fn secrets(raw: Option<&str>) -> BTreeMap<String, String> {
    let Some(raw) = raw.filter(|r| r.len() <= 256000) else {
        return BTreeMap::new();
    };
    let Ok(map) = serde_json::from_str::<BTreeMap<String, String>>(raw) else {
        return BTreeMap::new();
    };
    if map.iter().any(|(k, v)| {
        k.is_empty()
            || !k.as_bytes()[0].is_ascii_uppercase()
            || !k
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
            || v.is_empty()
            || v.encode_utf16().count() > 16384
    }) {
        return BTreeMap::new();
    }
    map
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_untrusted_hosts_and_bad_map() {
        assert!(configs(Some(
            r#"{"logs":{"endpoint":"https://evil.test","allowed_hosts":["good.test"]}}"#
        ))
        .is_empty());
        assert_eq!(
            configs(Some(
                r#"{"logs":{"endpoint":"https://good.test","allowed_hosts":["good.test"]}}"#
            ))
            .len(),
            1
        );
    }
}

#[cfg(test)]
mod secret_tests {
    use super::*;
    #[test]
    fn secrets_validate_whole_map() {
        assert_eq!(secrets(Some(r#"{"QUERY_TOKEN":"value"}"#)).len(), 1);
        assert!(secrets(Some(r#"{"QUERY_TOKEN":"value","bad":"other"}"#)).is_empty());
    }
    #[test]
    fn rejects_userinfo_redirect_hosts_and_plain_http() {
        let map = configs(Some(
            r#"{"logs":{"endpoint":"https://good.test","allowed_hosts":["good.test"]}}"#,
        ));
        let c = &map["logs"];
        for bad in [
            "http://good.test/",
            "https://user:password@good.test/",
            "https://good.test.evil.test/",
        ] {
            assert!(allowed(bad, c).is_none());
        }
    }
}

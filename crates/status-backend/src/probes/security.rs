//! 公网目标策略；网络解析由运行时执行。 / Public target policy; runtime owns DNS resolution.
use std::{collections::HashSet, net::IpAddr};
use url::Url;

/// 精确主机名与 TCP 端口许可。 / Exact hostname and TCP port allowlists.
#[derive(Clone, Debug, Default)]
pub struct TargetPolicy {
    /// 规范化精确主机名。 / Normalized exact hostnames.
    pub allowed_hostnames: HashSet<String>,
    /// 允许的 TCP 端口。 / Allowed TCP ports.
    pub allowed_tcp_ports: HashSet<u16>,
}
/// 规范化主机名并拒绝本地名称及非法 DNS 标签。 / Normalize hostname, rejecting local names and malformed DNS labels.
pub fn normalize_hostname(value: &str) -> Result<String, &'static str> {
    let host = value.trim().to_ascii_lowercase();
    let host = host.strip_suffix('.').unwrap_or(&host);
    let host = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host);
    if host == "localhost"
        || [".localhost", ".local", ".internal", ".home.arpa"]
            .iter()
            .any(|s| host.ends_with(s))
    {
        return Err("local_hostname");
    }
    if host.is_empty() || host.len() > 253 {
        return Err("invalid_hostname");
    }
    if host.parse::<IpAddr>().is_ok() {
        return Ok(host.to_owned());
    }
    if !host.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    }) {
        return Err("invalid_hostname");
    }
    Ok(host.to_owned())
}
/// 拒绝私有、特殊用途和保留地址。 / Reject private, special-purpose and reserved addresses.
pub fn is_public_address(address: &str) -> bool {
    match address.parse::<IpAddr>() {
        Ok(IpAddr::V4(v)) => {
            let n = u32::from(v);
            ![
                (0x00000000, 8),
                (0x0a000000, 8),
                (0x64400000, 10),
                (0x7f000000, 8),
                (0xa9fe0000, 16),
                (0xac100000, 12),
                (0xc0000000, 24),
                (0xc0000200, 24),
                (0xc0a80000, 16),
                (0xc6120000, 15),
                (0xc6336400, 24),
                (0xcb007100, 24),
                (0xe0000000, 4),
                (0xf0000000, 4),
            ]
            .iter()
            .any(|&(network, prefix)| n >> (32 - prefix) == network >> (32 - prefix))
        }
        Ok(IpAddr::V6(v)) => {
            let n = u128::from(v);
            // 仅接受公网单播分配空间，特殊用途继续拒绝。 / Permit global unicast allocation space only, excluding special-use ranges.
            n >> 125 == 1
                && ![
                    (0, 128),
                    (1, 128),
                    (0, 96),
                    (0xffffu128 << 32, 96),
                    (0x0064ff9bu128 << 96, 96),
                    (0x0100u128 << 112, 64),
                    (0xfc00u128 << 112, 7),
                    (0xfe80u128 << 112, 10),
                    (0xff00u128 << 112, 8),
                    (0x20010db8u128 << 96, 32),
                    (0x20010000u128 << 96, 23),
                    (0x3fffu128 << 112, 20),
                    (0x20010010u128 << 96, 28),
                    (0x2002u128 << 112, 16),
                ]
                .iter()
                .any(|&(network, prefix)| n >> (128 - prefix) == network >> (128 - prefix))
        }
        Err(_) => false,
    }
}
/// 校验主机许可及字面地址；域名仍须校验全部 DNS 结果。 / Enforce allowlist and literals; domains still require all DNS answers to be checked.
pub fn assert_allowed_hostname(value: &str, policy: &TargetPolicy) -> Result<String, &'static str> {
    let host = normalize_hostname(value)?;
    if !policy.allowed_hostnames.contains(&host) {
        return Err("hostname_not_allowed");
    }
    if host.parse::<IpAddr>().is_ok() && !is_public_address(&host) {
        return Err("private_or_reserved_address");
    }
    Ok(host)
}
/// 校验全部解析结果；混合公私地址及空结果一律拒绝。 / Validate every answer; reject mixed public/private sets and empty results.
pub fn assert_public_addresses(addresses: &[String]) -> Result<(), &'static str> {
    if addresses.is_empty() {
        return Err("dns_no_address");
    }
    if addresses.iter().any(|a| !is_public_address(a)) {
        return Err("private_or_reserved_address");
    }
    Ok(())
}
/// 校验 HTTP URL 静态策略；调用方仍须解析并检查地址。 / Validate static HTTP URL policy; caller must resolve and check addresses.
pub fn validate_http_url(value: &str, policy: &TargetPolicy) -> Result<Url, &'static str> {
    let mut url = Url::parse(value).map_err(|_| "invalid_url")?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("invalid_scheme");
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("url_credentials");
    }
    if !matches!(url.port_or_known_default(), Some(80 | 443)) {
        return Err("http_port_not_allowed");
    }
    let host = assert_allowed_hostname(url.host_str().ok_or("invalid_hostname")?, policy)?;
    // 固定规范化域名，避免尾点导致校验与连接身份不一致。 / Bind normalized DNS identity to the eventual connection.
    if host.parse::<IpAddr>().is_err() {
        url.set_host(Some(&host)).map_err(|_| "invalid_hostname")?;
    }
    Ok(url)
}
/// 校验 TCP 端口和静态主机策略；运行时另行校验解析结果。 / Validate TCP port and static hostname policy; runtime checks DNS answers.
pub fn validate_tcp_target(
    hostname: &str,
    port: u16,
    policy: &TargetPolicy,
) -> Result<String, &'static str> {
    if port == 0 || !policy.allowed_tcp_ports.contains(&port) {
        return Err("tcp_port_not_allowed");
    }
    assert_allowed_hostname(hostname, policy)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_reserved_and_mixed_addresses() {
        for address in [
            "127.0.0.1",
            "10.0.0.1",
            "100.64.0.1",
            "192.0.2.1",
            "::1",
            "fec0::1",
            "64:ff9b:1::1",
            "2001:20::1",
            "3fff::1",
            "::ffff:8.8.8.8",
            "64:ff9b::808:808",
            "2001:db8::1",
            "fc00::1",
            "2002::1",
            "garbage",
        ] {
            assert!(!is_public_address(address), "{address}");
        }
        for address in ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"] {
            assert!(is_public_address(address), "{address}");
        }
        assert!(assert_public_addresses(&[]).is_err());
        assert!(assert_public_addresses(&["8.8.8.8".into(), "127.0.0.1".into()]).is_err());
    }
    #[test]
    fn normalizes_and_enforces_exact_policy() {
        let policy = TargetPolicy {
            allowed_hostnames: HashSet::from(["example.com".into()]),
            allowed_tcp_ports: HashSet::from([443]),
        };
        assert_eq!(normalize_hostname(" EXAMPLE.com. ").unwrap(), "example.com");
        for host in [
            "a.local",
            "a.internal",
            "localhost",
            "example.com..",
            "a/b",
            "a%00.com",
        ] {
            assert!(normalize_hostname(host).is_err());
        }
        assert!(validate_http_url("https://example.com", &policy).is_ok());
        for url in [
            "https://user:pass@example.com",
            "https://example.com:8443",
            "ftp://example.com",
            "https://sub.example.com",
        ] {
            assert!(validate_http_url(url, &policy).is_err());
        }
        assert!(validate_tcp_target("example.com", 80, &policy).is_err());
    }
}

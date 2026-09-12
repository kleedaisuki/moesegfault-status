//! 严格的区域探测协议。 / Strict regional probe wire protocol.
use serde::{Deserialize, Serialize};

/// 允许的 HTTP 方法。 / Permitted HTTP methods.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub enum HttpMethod {
    /// 读取响应。 / Read response.
    GET,
    /// 仅读取头。 / Read headers only.
    #[default]
    HEAD,
}
impl HttpMethod {
    /// 返回协议名称。 / Return wire method name.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::GET => "GET",
            Self::HEAD => "HEAD",
        }
    }
}
/// DNS 地址记录类型。 / DNS address record type.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum RecordType {
    /// IPv4 地址。 / IPv4 address.
    A,
    /// IPv6 地址。 / IPv6 address.
    AAAA,
}
impl RecordType {
    /// 返回协议名称。 / Return wire record name.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::A => "A",
            Self::AAAA => "AAAA",
        }
    }
}
/// 封闭探测能力集合；拒绝额外字段。 / Closed probe capabilities; unknown fields rejected.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum Probe {
    /// HTTP 探测。 / HTTP probe.
    Http {
        /// 绝对 URL。 / Absolute URL.
        url: String,
        /// 请求方法。 / Request method.
        #[serde(default)]
        method: HttpMethod,
        /// 允许的状态码；空表示默认策略。 / Accepted statuses; empty selects default policy.
        #[serde(default, rename = "expectedStatuses")]
        expected_statuses: Vec<u16>,
        /// 最大重定向次数。 / Redirect limit.
        #[serde(default, rename = "maxRedirects")]
        max_redirects: u8,
    },
    /// TCP 连接。 / TCP connection.
    Tcp {
        /// 目标主机。 / Target hostname.
        hostname: String,
        /// 目标端口。 / Target port.
        port: u16,
    },
    /// DNS 查询。 / DNS query.
    Dns {
        /// 查询主机。 / Query hostname.
        hostname: String,
        /// 地址族。 / Address family.
        #[serde(rename = "recordType")]
        record_type: RecordType,
    },
    /// 已声明 RPC 能力。 / Declared RPC capability.
    Rpc {
        /// 绑定名称。 / Binding name.
        binding: String,
        /// 操作名称。 / Operation name.
        operation: String,
    },
    /// 已声明合成场景。 / Declared synthetic scenario.
    Synthetic {
        /// 绑定名称。 / Binding name.
        binding: String,
        /// 场景名称。 / Scenario name.
        scenario: String,
    },
}
impl Probe {
    /// 返回稳定能力名称。 / Return stable capability name.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Http { .. } => "http",
            Self::Tcp { .. } => "tcp",
            Self::Dns { .. } => "dns",
            Self::Rpc { .. } => "rpc",
            Self::Synthetic { .. } => "synthetic",
        }
    }
    /// 校验协议范围，不执行网络请求。 / Validate wire limits without networking.
    pub fn validate(&self) -> Result<(), &'static str> {
        let valid = match self {
            Self::Http {
                url,
                expected_statuses,
                max_redirects,
                ..
            } => {
                url.len() <= 2048
                    && url::Url::parse(url).is_ok()
                    && expected_statuses.len() <= 32
                    && expected_statuses.iter().all(|s| (100..=599).contains(s))
                    && *max_redirects <= 3
            }
            Self::Tcp { hostname, port } => bounded(hostname, 253) && *port != 0,
            Self::Dns { hostname, .. } => bounded(hostname, 253),
            Self::Rpc { binding, operation } => bounded(binding, 64) && bounded(operation, 64),
            Self::Synthetic { binding, scenario } => bounded(binding, 64) && bounded(scenario, 64),
        };
        if valid {
            Ok(())
        } else {
            Err("invalid_probe")
        }
    }
}
/// 带身份与绝对截止时间的请求。 / Identity-bound request with absolute deadline.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProbeRequest {
    /// 协议版本。 / Protocol version.
    pub version: String,
    /// 执行器身份。 / Executor identity.
    pub executor_id: String,
    /// 逻辑位置。 / Logical location.
    pub location: String,
    /// 运行 UUIDv7。 / Run UUIDv7.
    pub run_id: String,
    /// 监控 UUIDv7。 / Monitor UUIDv7.
    pub monitor_id: String,
    /// 关联 UUIDv7。 / Correlation UUIDv7.
    pub correlation_id: String,
    /// UTC 截止时间。 / UTC deadline.
    pub deadline_at: String,
    /// UTC 调度时间。 / UTC scheduled time.
    pub scheduled_for: String,
    /// W3C 跟踪上下文。 / W3C trace context.
    pub traceparent: String,
    /// 毫秒超时。 / Timeout in milliseconds.
    pub timeout_ms: u32,
    /// 探测能力。 / Probe capability.
    pub probe: Probe,
}
impl ProbeRequest {
    /// 校验完整协议；运行时另行校验剩余预算。 / Validate wire contract; runtime checks remaining budget.
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.version != "1"
            || !identity(&self.executor_id)
            || !identity(&self.location)
            || !(1..=300000).contains(&self.timeout_ms)
        {
            return Err("invalid_request");
        }
        for id in [&self.run_id, &self.monitor_id, &self.correlation_id] {
            status_domain::validate_uuid_v7(id, "id").map_err(|_| "invalid_uuid")?;
            if !matches!(id.as_bytes().get(19), Some(b'8' | b'9' | b'a' | b'b')) {
                return Err("invalid_uuid");
            }
        }
        self.deadline_ms()?;
        self.scheduled_ms()?;
        if !trace_valid(&self.traceparent) {
            return Err("invalid_traceparent");
        }
        self.probe.validate()
    }
    /// 截止时间的 Unix 毫秒。 / Deadline as Unix milliseconds.
    pub fn deadline_ms(&self) -> Result<i64, &'static str> {
        timestamp(&self.deadline_at)
    }
    /// 调度时间的 Unix 毫秒。 / Scheduled time as Unix milliseconds.
    pub fn scheduled_ms(&self) -> Result<i64, &'static str> {
        timestamp(&self.scheduled_for)
    }
}
/// 检查文本边界。 / Check text bounds.
fn bounded(value: &str, max: usize) -> bool {
    !value.is_empty() && value.chars().count() <= max
}
/// 校验逻辑身份。 / Validate logical identity.
fn identity(value: &str) -> bool {
    bounded(value, 64)
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
/// 解析 UTC 时间。 / Parse UTC timestamp.
fn timestamp(value: &str) -> Result<i64, &'static str> {
    if !value.ends_with('Z') || value.len() < 20 || value.as_bytes().get(10) != Some(&b'T') {
        return Err("invalid_timestamp");
    }
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|v| v.timestamp_millis())
        .map_err(|_| "invalid_timestamp")
}
/// 检查非零小写十六进制上下文。 / Check nonzero lowercase hexadecimal context.
fn trace_valid(value: &str) -> bool {
    let p: Vec<_> = value.split('-').collect();
    p.len() == 4
        && p[0] == "00"
        && matches!(p[3], "00" | "01")
        && [(p[1], 32), (p[2], 16)].iter().all(|(v, n)| {
            v.len() == *n
                && v.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                && v.bytes().any(|b| b != b'0')
        })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_request_contract() {
        let mut value = serde_json::json!({
            "version":"1", "executor_id":"probe_sin", "location":"sin",
            "run_id":"01900000-0000-7000-8000-000000000001",
            "monitor_id":"01900000-0000-7000-8000-000000000002",
            "correlation_id":"01900000-0000-7000-8000-000000000003",
            "deadline_at":"2026-09-12T12:00:01Z", "scheduled_for":"2026-09-12T12:00:00Z",
            "traceparent":"00-11111111111111111111111111111111-1111111111111111-01",
            "timeout_ms":1000, "probe":{"kind":"tcp","hostname":"example.com","port":443}
        });
        let request: ProbeRequest = serde_json::from_value(value.clone()).unwrap();
        assert!(request.validate().is_ok());
        value["timeout_ms"] = serde_json::json!(300001);
        assert!(serde_json::from_value::<ProbeRequest>(value.clone())
            .unwrap()
            .validate()
            .is_err());
        value["extra"] = serde_json::json!(true);
        assert!(serde_json::from_value::<ProbeRequest>(value).is_err());
    }
    #[test]
    fn strict_variants() {
        assert!(serde_json::from_str::<Probe>(
            r#"{"kind":"http","url":"https://example.com","headers":{}}"#
        )
        .is_err());
        assert!(serde_json::from_str::<Probe>(
            r#"{"kind":"http","url":"https://example.com","method":"POST"}"#
        )
        .is_err());
        let p: Probe =
            serde_json::from_str(r#"{"kind":"http","url":"https://example.com"}"#).unwrap();
        assert!(p.validate().is_ok());
    }
    #[test]
    fn timestamp_trace_limits() {
        assert!(timestamp("2026-09-12T12:00:00Z").is_ok());
        assert!(timestamp("2026-09-12T12:00:00+00:00").is_err());
        assert!(!trace_valid(
            "00-00000000000000000000000000000000-1111111111111111-01"
        ));
    }
}

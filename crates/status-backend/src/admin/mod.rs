//! 仅通过命名私有能力调用的管理服务；不得挂到公开 HTTP 路由。
//! Administrative services reachable only through the named private capability, never public HTTP routes.

#[cfg(target_arch = "wasm32")]
pub mod diagnostics;
#[cfg(target_arch = "wasm32")]
pub mod mutations;
#[cfg(target_arch = "wasm32")]
pub mod reads;

use crate::{
    access::AdminRole,
    wire::{Id, Text, UtcTime},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 来自可信网关的转发主体；此类型本身不是 JWT 验证器。
/// Principal forwarded by a trusted gateway; this type is not itself a JWT verifier.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ForwardedPrincipal {
    /// 稳定主体。 / Stable subject.
    subject: Text<1, 255>,
    /// 验证过的邮箱。 / Verified email.
    email: Text<1, 320>,
    /// 网关授予的角色。 / Gateway-granted roles.
    roles: Vec<AdminRole>,
    /// 会话签发时间。 / Session issue time.
    authenticated_at: UtcTime,
    /// 应用绑定。 / Application binding.
    access_application: Text<1, 255>,
}

impl ForwardedPrincipal {
    /// 角色包含关系；不从其他请求字段提权。 / Role inclusion without elevation from other request fields.
    pub fn has_role(&self, role: AdminRole) -> bool {
        self.roles.iter().any(|r| *r >= role)
    }
    /// 审计主体。 / Audit subject.
    pub fn subject(&self) -> &str {
        self.subject.as_str()
    }
    /// 严格校验网关 wire 形状。 / Strict validation of the gateway wire shape.
    fn validate(&self) -> bool {
        (1..=3).contains(&self.roles.len()) && valid_email(self.email.as_str())
    }
}

/// 有界 W3C trace 转发。 / Bounded W3C trace propagation.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TraceContext {
    /// 版本 00 traceparent。 / Version 00 traceparent.
    traceparent: Text<55, 55>,
    /// 可选 tracestate。 / Optional tracestate.
    #[serde(skip_serializing_if = "Option::is_none")]
    tracestate: Option<Text<1, 512>>,
}
impl TraceContext {
    /// 拒绝全零 trace/span ID 与非规范十六进制。 / Reject zero trace/span IDs and noncanonical hex.
    fn valid(&self) -> bool {
        let p = self.traceparent.as_str();
        let parts = p.split('-').collect::<Vec<_>>();
        parts.len() == 4
            && parts[0] == "00"
            && parts[1].len() == 32
            && parts[2].len() == 16
            && parts[3].len() == 2
            && parts[1..].iter().all(|s| {
                s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
            && parts[1].bytes().any(|b| b != b'0')
            && parts[2].bytes().any(|b| b != b'0')
    }
}

/// 已验证的私有 RPC 上下文。 / Validated private RPC context.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RpcContext {
    /// 唯一授权来源。 / Sole authorization source.
    principal: ForwardedPrincipal,
    /// 请求关联身份。 / Request correlation identity.
    correlation_id: Id,
    /// 可选追踪上下文。 / Optional trace context.
    trace_context: Option<TraceContext>,
}
impl RpcContext {
    /// 从命名私有入口的参数提取上下文，拒绝未知字段与身份混淆。
    /// Extract context from named private entrypoint arguments, rejecting unknown fields and identity confusion.
    pub fn parse(raw: &Value, fields: &[&str]) -> Result<Self, RpcProblem> {
        let invalid = || RpcProblem::new(400, "Invalid RPC request", raw, "validation");
        let object = raw.as_object().ok_or_else(invalid)?;
        if raw.get("trace_context").is_some_and(Value::is_null) {
            return Err(invalid());
        }
        if object.keys().any(|key| {
            !["principal", "correlation_id", "trace_context"].contains(&key.as_str())
                && !fields.contains(&key.as_str())
        }) {
            return Err(invalid());
        }
        let context:Self=serde_json::from_value(serde_json::json!({"principal":raw["principal"],"correlation_id":raw["correlation_id"],"trace_context":raw.get("trace_context")})).map_err(|_|invalid())?;
        if !context.principal.validate()
            || context.trace_context.as_ref().is_some_and(|t| !t.valid())
        {
            return Err(invalid());
        }
        Ok(context)
    }
    /// 要求操作角色。 / Require operation role.
    pub fn require(&self, role: AdminRole) -> bool {
        self.principal.has_role(role)
    }
    /// 审计身份。 / Audit principal.
    pub fn principal(&self) -> &ForwardedPrincipal {
        &self.principal
    }
    /// 关联 ID。 / Correlation ID.
    pub fn correlation_id(&self) -> &str {
        self.correlation_id.as_str()
    }
}

/// 兼容既有 RPC Problem 协议，不携带 SQL 或秘密。
/// Existing RPC Problem wire shape, without SQL or secrets.
#[derive(Debug, Serialize)]
pub struct RpcProblem {
    /// 问题类型。 / Problem type.
    #[serde(rename = "type")]
    kind: String,
    /// 稳定摘要。 / Stable summary.
    title: String,
    /// HTTP 类状态码。 / HTTP-like status code.
    status: u16,
    /// RPC 路径。 / RPC path.
    instance: String,
    /// 安全关联 ID。 / Safe correlation ID.
    correlation_id: String,
}
impl RpcProblem {
    /// 只序列化公开错误类别。 / Serialize only public error categories.
    pub fn new(status: u16, title: &str, raw: &Value, operation: &str) -> Self {
        let correlation = raw["correlation_id"]
            .as_str()
            .filter(|s| Id::new((*s).into()).is_ok())
            .unwrap_or("018f0000-0000-7000-8000-000000000000");
        let slug = match status {
            400 => "invalid-request",
            403 => "forbidden",
            404 => "not-found",
            409 => "conflict",
            _ => "internal-error",
        };
        Self {
            kind: format!("https://status.moesegfault.dev/problems/{slug}"),
            title: title.into(),
            status,
            instance: format!("/rpc/{operation}"),
            correlation_id: correlation.into(),
        }
    }
}

/// 与现有 email schema 的 ASCII 邮箱形状一致，不使用邮箱进行授权。
/// Match existing ASCII email schema shape; never use email for authorization.
fn valid_email(value: &str) -> bool {
    let Some((local, domain)) = value.split_once('@') else {
        return false;
    };
    if local.is_empty()
        || local.starts_with('.')
        || !local
            .bytes()
            .last()
            .is_some_and(|b| b.is_ascii_alphanumeric() || b"_+-".contains(&b))
        || local.contains("..")
        || !local
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_'+-.".contains(&b))
    {
        return false;
    }
    let labels = domain.split('.').collect::<Vec<_>>();
    labels.len() >= 2
        && labels.iter().all(|s| {
            !s.is_empty()
                && s.bytes().next().is_some_and(|b| b.is_ascii_alphanumeric())
                && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
        && labels
            .last()
            .is_some_and(|s| s.len() >= 2 && s.bytes().all(|b| b.is_ascii_alphabetic()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_private_context_and_role_hierarchy() {
        let mut raw = serde_json::json!({"principal":{"subject":"human","email":"human@example.com","roles":["operator"],"authenticated_at":"2026-09-12T00:00:00Z","access_application":"app"},"correlation_id":"0199d0a8-2e12-7a59-a51e-000000000001","service_name":"api"});
        let context = RpcContext::parse(&raw, &["service_name"]).unwrap();
        assert!(context.require(AdminRole::Viewer));
        assert!(!context.require(AdminRole::Admin));
        raw["untrusted_role"] = serde_json::json!("admin");
        assert!(RpcContext::parse(&raw, &["service_name"]).is_err());
    }
}

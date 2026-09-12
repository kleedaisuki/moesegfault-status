//! 人类 Access 信任域；角色只能来自部署控制的 subject 映射。
//! Human Access trust domain; roles come only from deployment-controlled subject mappings.

use crate::{
    auth::{verify_claims, PublicKeys},
    http::HttpError,
};
use chrono::{DateTime, SecondsFormat};
use jsonwebtoken::Algorithm;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use url::Url;

/// 无效 Access assertion，公开错误不泄漏内部细节。 / Invalid Access assertion; public error reveals no internals.
const INVALID: HttpError = HttpError::new(
    401,
    "invalid-access-token",
    "Cloudflare Access authentication failed",
);
/// 部署配置有误，失败关闭。 / Invalid deployment configuration; fail closed.
const CONFIG: HttpError = HttpError::new(
    503,
    "authentication-unavailable",
    "Cloudflare Access authentication is not configured",
);

/// 包含关系 admin ≥ operator ≥ viewer。 / Role inclusion admin ≥ operator ≥ viewer.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AdminRole {
    /// 只读权限。 / Read-only access.
    Viewer,
    /// 运维操作。 / Operational changes.
    Operator,
    /// 管理配置。 / Administrative configuration.
    Admin,
}

/// 无公共字段，调用者无法绕过部署配置检查。 / No public fields; callers cannot bypass configuration checks.
#[derive(Clone, Debug)]
pub struct AccessTrust {
    /// 精确 team origin。 / Exact team origin.
    issuer: String,
    /// 精确应用 AUD。 / Exact application AUD.
    audience: String,
    /// 最大会话秒数。 / Maximum session age in seconds.
    max_age: i64,
    /// 稳定 subject 的显式映射。 / Explicit stable subject mapping.
    roles: BTreeMap<String, Vec<AdminRole>>,
}

impl AccessTrust {
    /// 校验配置，不接受邮箱/通配符角色回退。 / Validate configuration without email or wildcard role fallback.
    pub fn new(
        issuer: &str,
        audience: &str,
        max_age: &str,
        role_mapping: &str,
    ) -> Result<Self, HttpError> {
        let url = Url::parse(issuer).map_err(|_| CONFIG)?;
        if url.scheme() != "https"
            || url.origin().ascii_serialization() != issuer
            || !url
                .host_str()
                .is_some_and(|host| host.ends_with(".cloudflareaccess.com"))
        {
            return Err(CONFIG);
        }
        if audience.len() != 64 || !audience.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(CONFIG);
        }
        let max_age: i64 = max_age.parse().map_err(|_| CONFIG)?;
        if !(60..=2_592_000).contains(&max_age) {
            return Err(CONFIG);
        }
        let roles: BTreeMap<String, Vec<AdminRole>> =
            serde_json::from_str(role_mapping).map_err(|_| CONFIG)?;
        if roles.len() > 256 {
            return Err(CONFIG);
        }
        for (subject, list) in &roles {
            if !valid_subject(subject)
                || list.is_empty()
                || list.len() > 3
                || list.iter().collect::<BTreeSet<_>>().len() != list.len()
            {
                return Err(CONFIG);
            }
        }
        Ok(Self {
            issuer: issuer.into(),
            audience: audience.into(),
            max_age,
            roles,
        })
    }

    /// Access 的固定公钥地址。 / Fixed Access public key endpoint.
    pub fn jwks_url(&self) -> String {
        format!("{}/cdn-cgi/access/certs", self.issuer)
    }
}

/// 仅认证代码可构造的管理身份，序列化保持现有 RPC 协议。
/// Administrative identity constructible only by authentication; serialization preserves RPC wire format.
#[derive(Clone, Debug, Serialize)]
pub struct AdminPrincipal {
    /// 稳定主体。 / Stable subject.
    subject: String,
    /// 经 Access 签名的邮箱，仅用于展示。 / Access-signed email, display only.
    email: String,
    /// 部署映射授权。 / Deployment-mapped authorization.
    roles: Vec<AdminRole>,
    /// JWT 签发的 UTC 时间。 / JWT issue time in UTC.
    authenticated_at: String,
    /// 应用受众。 / Application audience.
    access_application: String,
}

impl AdminPrincipal {
    /// 稳定主体，不使用邮箱识别权限。 / Stable subject; email does not identify permissions.
    pub fn subject(&self) -> &str {
        &self.subject
    }
    /// 高权限包含低权限。 / Higher privilege includes lower privilege.
    pub fn has_role(&self, required: AdminRole) -> bool {
        self.roles.iter().any(|role| *role >= required)
    }
}

/// 验证 RS256、应用身份、会话时间及显式角色授权。 / Verify RS256, app identity, session time, and explicit role authorization.
pub fn verify_access(
    token: &str,
    trust: &AccessTrust,
    keys: &PublicKeys,
    now: i64,
) -> Result<AdminPrincipal, HttpError> {
    let claims = verify_claims(
        token,
        &trust.issuer,
        &trust.audience,
        keys,
        &[Algorithm::RS256],
    )
    .map_err(|_| INVALID)?;
    let subject = claims["sub"]
        .as_str()
        .filter(|s| valid_subject(s))
        .ok_or(INVALID)?;
    let email = claims["email"]
        .as_str()
        .filter(|s| s.len() <= 320 && s.contains('@'))
        .ok_or(INVALID)?;
    let nonce = claims["identity_nonce"].as_str().ok_or(INVALID)?;
    if claims["type"] != "app" || nonce.is_empty() || nonce.len() > 512 {
        return Err(INVALID);
    }
    let iat = timestamp(&claims, "iat")?;
    let exp = timestamp(&claims, "exp")?;
    let nbf = timestamp(&claims, "nbf")?;
    // 零 nbf 宽限与现有 jwtVerify 一致；不能仅用下方业务的 60 秒宽限。
    // Zero nbf leeway matches existing jwtVerify; the business 60-second allowance is not sufficient alone.
    if nbf > now
        || exp <= now
        || iat > now.saturating_add(60)
        || nbf < iat.saturating_sub(60)
        || now.saturating_sub(iat) > trust.max_age
        || exp.saturating_sub(iat) > trust.max_age + 60
    {
        return Err(INVALID);
    }
    let roles = trust.roles.get(subject).ok_or(INVALID)?.clone();
    let authenticated_at = DateTime::from_timestamp(iat, 0)
        .ok_or(INVALID)?
        .to_rfc3339_opts(SecondsFormat::Millis, true);
    Ok(AdminPrincipal {
        subject: subject.into(),
        email: email.into(),
        roles,
        authenticated_at,
        access_application: trust.audience.clone(),
    })
}

/// 必须是整数 NumericDate。 / Require integer NumericDate.
fn timestamp(claims: &Value, key: &str) -> Result<i64, HttpError> {
    claims[key].as_i64().ok_or(INVALID)
}

/// 不透明 subject 是 ASCII，绝非邮箱。 / Opaque subject is ASCII, never an email.
fn valid_subject(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_alphanumeric())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verifies_human_role_from_configuration_only() {
        let vectors: Vec<Value> =
            serde_json::from_str(include_str!("../../../tests/fixtures/jwt-vectors.json")).unwrap();
        let vector = &vectors[0];
        let keys = PublicKeys::parse(
            &serde_json::to_vec(&serde_json::json!({"keys": [vector["jwk"]]})).unwrap(),
        )
        .unwrap();
        let trust = AccessTrust::new(
            "https://team.cloudflareaccess.com",
            &"a".repeat(64),
            "3600",
            r#"{"human-1":["operator"]}"#,
        )
        .unwrap();
        let token = vector["tokens"]["access"].as_str().unwrap();
        let principal = verify_access(token, &trust, &keys, 1700000010).unwrap();
        assert!(principal.has_role(AdminRole::Viewer));
        assert!(principal.has_role(AdminRole::Operator));
        assert!(!principal.has_role(AdminRole::Admin));
        assert_eq!(principal.subject(), "human-1");
        assert!(verify_access(token, &trust, &keys, 1700000300).is_err());
        let empty = AccessTrust::new(
            "https://team.cloudflareaccess.com",
            &"a".repeat(64),
            "3600",
            "{}",
        )
        .unwrap();
        assert!(verify_access(token, &empty, &keys, 1700000010).is_err());
    }

    #[test]
    fn rejects_role_mapping_escalation_and_untrusted_issuer() {
        for roles in [
            r#"{"*": ["admin"]}"#,
            r#"{"user@example.com": ["admin"]}"#,
            r#"{"human-1": ["admin", "admin"]}"#,
            r#"{"human-1": ["owner"]}"#,
        ] {
            assert!(AccessTrust::new(
                "https://team.cloudflareaccess.com",
                &"a".repeat(64),
                "3600",
                roles
            )
            .is_err());
        }
        assert!(AccessTrust::new(
            "https://team.cloudflareaccess.com.attacker.example",
            &"a".repeat(64),
            "3600",
            "{}"
        )
        .is_err());
    }
}

//! 固定信任源的 JWT 验证；不读取令牌提供的公钥 URL。
//! JWT verification with pinned trust sources; never fetch token-supplied key URLs.
//!
//! ```no_run
//! use status_backend::auth::{MachineTrust, PublicKeys, verify_machine};
//! # fn authenticate(token: &str, downloaded_jwks: &[u8], now_seconds: f64) -> Result<(), status_backend::http::HttpError> {
//! let trust = MachineTrust::new("https://issuer.example", "status", "https://issuer.example/jwks")?;
//! let keys = PublicKeys::parse(downloaded_jwks)?;
//! let identity = verify_machine(token, &trust, &keys, now_seconds)?;
//! identity.require_scope("diagnostics:write")?;
//! # Ok(()) }
//! ```

use crate::http::HttpError;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use jsonwebtoken::{decode, decode_header, jwk::Jwk, Algorithm, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use status_domain::{validate_uuid_v7, Environment};
use std::collections::BTreeSet;
use url::Url;

#[cfg(target_arch = "wasm32")]
pub mod cloudflare;

/// 签名或标准声明验证失败。 / Signature or standard claim validation failed.
const INVALID_TOKEN: HttpError = HttpError::new(
    401,
    "invalid-machine-token",
    "Machine token verification failed",
);
/// 机器授权声明不充分。 / Insufficient machine authorization claims.
const INVALID_CLAIMS: HttpError = HttpError::new(
    403,
    "invalid-machine-claims",
    "Machine claims are insufficient",
);
/// 身份验证配置无效。 / Authentication configuration is invalid.
const UNAVAILABLE: HttpError = HttpError::new(
    503,
    "authentication-unavailable",
    "Machine authentication is not configured",
);

/// 已验证的部署信任配置；字段私有以阻止绕过构造验证。
/// Validated deployment trust configuration; private fields prevent bypassing validation.
#[derive(Clone, Debug)]
pub struct MachineTrust {
    /// 精确 issuer 字符串。 / Exact issuer string.
    issuer: String,
    /// 精确受众。 / Exact audience.
    audience: String,
    /// 与 issuer 同源的固定地址。 / Pinned same-origin URL.
    jwks: Url,
}

impl MachineTrust {
    /// 只接受同源 HTTPS JWKS，拒绝 URL 内嵌凭据。
    /// Accept same-origin HTTPS JWKS only, rejecting embedded URL credentials.
    pub fn new(issuer: &str, audience: &str, jwks: &str) -> Result<Self, HttpError> {
        let issuer_url = Url::parse(issuer).map_err(|_| UNAVAILABLE)?;
        let jwks = Url::parse(jwks).map_err(|_| UNAVAILABLE)?;
        if !secure_url(&issuer_url)
            || !secure_url(&jwks)
            || issuer_url.origin() != jwks.origin()
            || audience.is_empty()
        {
            return Err(UNAVAILABLE);
        }
        Ok(Self {
            issuer: issuer.into(),
            audience: audience.into(),
            jwks,
        })
    }

    /// 固定下载地址，不由 JWT header 影响。 / Pinned fetch URL, unaffected by JWT headers.
    pub fn jwks_url(&self) -> &Url {
        &self.jwks
    }
}

/// 检查配置 URL，而非信任请求输入。 / Validate configured URLs, not request-controlled input.
fn secure_url(url: &Url) -> bool {
    url.scheme() == "https"
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
}

/// 只有完成密码学与声明检查后才构造；不能直接反序列化为身份。
/// Constructed only after cryptographic and claim checks; cannot be deserialized as an identity.
#[derive(Clone, Debug)]
pub struct MachineIdentity {
    /// 签名确认的主体。 / Cryptographically authenticated subject.
    subject: String,
    /// 唯一 token 身份。 / Unique token identity.
    token_id: String,
    /// 服务绑定。 / Service binding.
    service_name: String,
    /// 环境绑定。 / Environment binding.
    environment: Environment,
    /// 部署绑定。 / Deployment binding.
    deployment_id: String,
    /// 操作权限。 / Operation permissions.
    scopes: BTreeSet<String>,
}

impl MachineIdentity {
    /// 已认证主体。 / Authenticated subject.
    pub fn subject(&self) -> &str {
        &self.subject
    }
    /// 已认证 token ID。 / Authenticated token ID.
    pub fn token_id(&self) -> &str {
        &self.token_id
    }
    /// 在读取请求体前检查操作权限。 / Check scope before reading the request body.
    pub fn require_scope(&self, scope: &str) -> Result<(), HttpError> {
        if self.scopes.contains(scope) {
            return Ok(());
        }
        Err(HttpError::new(
            403,
            "insufficient-scope",
            "Machine scope does not authorize this operation",
        ))
    }
    /// 请求资源必须同时匹配三个授权维度。 / Match all three resource authorization dimensions.
    pub fn authorizes(&self, service: &str, environment: Environment, deployment: &str) -> bool {
        self.service_name == service
            && self.environment == environment
            && self.deployment_id == deployment
    }
}

/// 固定来源下载的公钥集，保留未知 key 元数据用于拒绝错误用途。
/// Public key set downloaded from a pinned source; retain metadata to reject invalid usage.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PublicKeys {
    /// 仅公钥，绝不请求或保存私钥。 / Public keys only; never request or retain private keys.
    keys: Vec<Value>,
}

impl PublicKeys {
    /// 有界解析远端 JSON。 / Bounded parsing of remote JSON.
    pub fn parse(bytes: &[u8]) -> Result<Self, HttpError> {
        if bytes.len() > 262_144 {
            return Err(INVALID_TOKEN);
        }
        let keys: Self = serde_json::from_slice(bytes).map_err(|_| INVALID_TOKEN)?;
        if keys.keys.is_empty() || keys.keys.len() > 128 {
            return Err(INVALID_TOKEN);
        }
        if keys.keys.iter().any(|key| {
            !key.is_object()
                || ["d", "p", "q", "dp", "dq", "qi", "k"]
                    .iter()
                    .any(|field| key.get(field).is_some())
        }) {
            return Err(INVALID_TOKEN);
        }
        Ok(keys)
    }

    /// key 必须唯一匹配算法、kid、用途与曲线。 / Require one key matching algorithm, kid, use, and curve.
    fn select(&self, algorithm: Algorithm, kid: Option<&str>) -> Result<DecodingKey, HttpError> {
        let mut matching = self
            .keys
            .iter()
            .filter(|key| matches_key(key, algorithm, kid));
        let key = matching.next().ok_or(INVALID_TOKEN)?;
        if matching.next().is_some() {
            return Err(INVALID_TOKEN);
        }
        let key: Jwk = serde_json::from_value(key.clone()).map_err(|_| INVALID_TOKEN)?;
        DecodingKey::from_jwk(&key).map_err(|_| INVALID_TOKEN)
    }
}

/// 筛选策略独立于不可信 token 的 jku/x5u。 / Selection policy ignores token-controlled jku/x5u.
fn matches_key(key: &Value, algorithm: Algorithm, kid: Option<&str>) -> bool {
    let (name, kty, curve) = match algorithm {
        Algorithm::RS256 => ("RS256", "RSA", None),
        Algorithm::ES256 => ("ES256", "EC", Some("P-256")),
        Algorithm::EdDSA => ("EdDSA", "OKP", Some("Ed25519")),
        _ => return false,
    };
    if key["kty"] != kty
        || kid.is_some_and(|id| key["kid"] != id)
        || curve.is_some_and(|c| key["crv"] != c)
    {
        return false;
    }
    // 与 jose 的 RS256 最小模数强度一致。 / Match jose's minimum RS256 modulus strength.
    if algorithm == Algorithm::RS256 {
        let modulus = key["n"]
            .as_str()
            .and_then(|n| URL_SAFE_NO_PAD.decode(n).ok());
        let Some(modulus) = modulus else {
            return false;
        };
        let leading = modulus
            .iter()
            .position(|b| *b != 0)
            .unwrap_or(modulus.len());
        let bits = modulus.get(leading).map_or(0, |first| {
            (modulus.len() - leading - 1) * 8 + (8 - first.leading_zeros() as usize)
        });
        if bits < 2048 {
            return false;
        }
    }
    if key.get("alg").is_some_and(|v| v != name) || key.get("use").is_some_and(|v| v != "sig") {
        return false;
    }
    if key.get("key_ops").is_some_and(|v| {
        !v.as_array()
            .is_some_and(|ops| ops.iter().any(|op| op == "verify"))
    }) {
        return false;
    }
    true
}

/// 提取有界 Bearer 令牌，保持现有协议大小上限。 / Extract bounded Bearer token with existing protocol limits.
pub fn bearer(authorization: Option<&str>) -> Result<&str, HttpError> {
    authorization
        .filter(|s| s.len() <= 8192)
        .and_then(|s| s.strip_prefix("Bearer "))
        .ok_or(HttpError::new(
            401,
            "authentication-required",
            "A machine bearer token is required",
        ))
}

/// 验证签名、固定 issuer/audience、时间和资源绑定后返回不可伪造身份。
/// Verify signature, pinned issuer/audience, time, and resource binding before returning an identity.
pub fn verify_machine(
    token: &str,
    trust: &MachineTrust,
    keys: &PublicKeys,
    now: f64,
) -> Result<MachineIdentity, HttpError> {
    let claims = verify_claims(
        token,
        &trust.issuer,
        &trust.audience,
        keys,
        &[Algorithm::RS256, Algorithm::ES256, Algorithm::EdDSA],
    )?;
    let sub = claims["sub"].as_str().ok_or(INVALID_TOKEN)?;
    let jti = claims["jti"].as_str().ok_or(INVALID_TOKEN)?;
    let iat = numeric_date(&claims, "iat")?;
    let exp = numeric_date(&claims, "exp")?;
    if !now.is_finite() || exp <= now - 5.0 || now - iat > 905.0 || iat > now + 5.0 {
        return Err(INVALID_TOKEN);
    }
    if let Some(nbf) = claims.get("nbf") {
        if nbf
            .as_f64()
            .filter(|n| n.is_finite() && *n <= now + 5.0)
            .is_none()
        {
            return Err(INVALID_TOKEN);
        }
    }
    if sub.is_empty()
        || jti.is_empty()
        || iat == 0.0
        || exp == 0.0
        || exp <= iat
        || exp - iat > 900.0
    {
        return Err(INVALID_CLAIMS);
    }
    let service_name = claims["service_name"]
        .as_str()
        .filter(|s| valid_service(s))
        .ok_or(INVALID_CLAIMS)?;
    let environment =
        serde_json::from_value(claims["environment"].clone()).map_err(|_| INVALID_CLAIMS)?;
    let deployment_id = claims["deployment_id"].as_str().ok_or(INVALID_CLAIMS)?;
    validate_uuid_v7(deployment_id, "deployment_id").map_err(|_| INVALID_CLAIMS)?;
    let scope = claims["scope"]
        .as_str()
        .filter(|s| s.len() <= 2048)
        .ok_or(INVALID_CLAIMS)?;
    let scopes: BTreeSet<String> = scope
        .split(' ')
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect();
    if scopes.is_empty() || scopes.iter().any(|s| !valid_scope(s)) {
        return Err(INVALID_CLAIMS);
    }
    Ok(MachineIdentity {
        subject: sub.into(),
        token_id: jti.into(),
        service_name: service_name.into(),
        environment,
        deployment_id: deployment_id.into(),
        scopes,
    })
}

/// 所有调用者必须接着检查自身时间策略，不允许暴露未验证身份。
/// Callers must apply their temporal policy next; never expose unverified identities.
pub(crate) fn verify_claims(
    token: &str,
    issuer: &str,
    audience: &str,
    keys: &PublicKeys,
    allowed: &[Algorithm],
) -> Result<Value, HttpError> {
    if token.len() > 8185 {
        return Err(INVALID_TOKEN);
    }
    let header = decode_header(token).map_err(|_| INVALID_TOKEN)?;
    if !allowed.contains(&header.alg) {
        return Err(INVALID_TOKEN);
    }
    let raw_header = token.split('.').next().ok_or(INVALID_TOKEN)?;
    let bytes = URL_SAFE_NO_PAD
        .decode(raw_header)
        .map_err(|_| INVALID_TOKEN)?;
    let raw: Value = serde_json::from_slice(&bytes).map_err(|_| INVALID_TOKEN)?;
    if raw.get("crit").is_some() || raw.get("b64").is_some() {
        return Err(INVALID_TOKEN);
    }
    let key = keys.select(header.alg, header.kid.as_deref())?;
    let mut validation = Validation::new(header.alg);
    validation.set_issuer(&[issuer]);
    validation.set_audience(&[audience]);
    validation.set_required_spec_claims(&["iss", "aud"]);
    // 不使用系统时钟；调用者使用注入的时钟严格检查 exp/iat/nbf。
    // Do not use the system clock; callers strictly validate exp/iat/nbf using an injected clock.
    validation.validate_exp = false;
    validation.validate_nbf = false;
    decode::<Value>(token, &key, &validation)
        .map(|data| data.claims)
        .map_err(|_| INVALID_TOKEN)
}

/// JWT NumericDate 允许有限小数，与 jose 的机器协议一致。
/// JWT NumericDate permits finite fractions, matching the machine jose contract.
fn numeric_date(claims: &Value, field: &str) -> Result<f64, HttpError> {
    claims[field]
        .as_f64()
        .filter(|n| n.is_finite())
        .ok_or(INVALID_TOKEN)
}

/// 服务名为小写 ASCII 段。 / Service names are lowercase ASCII segments.
fn valid_service(value: &str) -> bool {
    !value.is_empty()
        && value.split('-').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
}

/// Scope 使用固定 ASCII 语法。 / Scope uses fixed ASCII syntax.
fn valid_scope(value: &str) -> bool {
    value.bytes().next().is_some_and(|b| b.is_ascii_lowercase())
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b":_-".contains(&b))
}

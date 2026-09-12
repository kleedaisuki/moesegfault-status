//! 保持现有公开 API 游标签名与绑定契约。 / Preserve public API cursor signatures and bindings.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::Sha256;

/// 最大安全 JSON 整数。 / Largest exact JavaScript JSON integer.
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// 游标绑定到路由、筛选条件与排序。 / Bind a cursor to route, filters, and ordering.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Binding {
    /// API 路由。 / API route.
    pub route: String,
    /// 规范化筛选条件。 / Canonical filter query.
    pub query: String,
    /// 排序契约。 / Ordering contract.
    pub sort: String,
}

/// 对外不泄漏密码学细节。 / Do not disclose cryptographic failure details.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CursorError {
    /// 配置缺失，不是客户端错误。 / Missing configuration, not a client error.
    #[error("Public API cursorSecret is required")]
    MissingSecret,
    /// 统一处理篡改、过期及跨路由重放。 / Uniform tamper, expiry, and replay rejection.
    #[error("Invalid or expired cursor")]
    Invalid,
}

/// 保持原有字段名与签名版本。 / Preserve existing wire fields and signing version.
#[derive(Serialize, Deserialize)]
struct WireCursor {
    /// 格式版本。 / Format version.
    v: u8,
    /// 绑定字段保持平铺 JSON。 / Keep binding fields flat in JSON.
    #[serde(flatten)]
    binding: Binding,
    /// 最后一行的排序键。 / Last row's ordering key.
    key: Map<String, Value>,
    /// Unix 秒截止时间。 / Expiry in Unix seconds.
    exp: i64,
}

/// 已验证非空的签名配置，不实现 Debug 避免日志泄漏。 / Nonempty signing configuration, deliberately not Debug.
pub struct CursorSigner<'a> {
    /// 原始 UTF-8 密钥，不做改变签名的 trim。 / Original UTF-8 secret; trimming would change signatures.
    secret: &'a [u8],
}

impl<'a> CursorSigner<'a> {
    /// 验证配置；保留原密钥字节。 / Validate configuration while preserving original key bytes.
    pub fn new(secret: &'a str) -> Result<Self, CursorError> {
        if secret.trim().is_empty() {
            return Err(CursorError::MissingSecret);
        }
        Ok(Self {
            secret: secret.as_bytes(),
        })
    }

    /// 签发 15 分钟有效的游标；now 为 Unix 秒。 / Issue a 15-minute cursor; now is Unix seconds.
    ///
    /// ```
    /// use status_backend::cursor::{Binding, CursorSigner};
    /// let signer = CursorSigner::new("deployment-secret")?;
    /// let binding = Binding { route: "/v1/services".into(), query: "".into(), sort: "name".into() };
    /// let token = signer.sign(binding.clone(), serde_json::Map::new(), 100)?;
    /// assert!(signer.verify(&token, &binding, 101)?.is_empty());
    /// # Ok::<(), status_backend::cursor::CursorError>(())
    /// ```
    pub fn sign(
        &self,
        binding: Binding,
        key: Map<String, Value>,
        now: i64,
    ) -> Result<String, CursorError> {
        let exp = now
            .checked_add(900)
            .filter(|n| n.abs() <= MAX_SAFE_INTEGER)
            .ok_or(CursorError::Invalid)?;
        let wire = WireCursor {
            v: 1,
            binding,
            key,
            exp,
        };
        let bytes = serde_json::to_vec(&wire).map_err(|_| CursorError::Invalid)?;
        let body = URL_SAFE_NO_PAD.encode(bytes);
        let mut mac = self.mac()?;
        mac.update(body.as_bytes());
        Ok(format!(
            "{body}.{}",
            URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
        ))
    }

    /// 先验证 MAC 再解析数据，保持旧游标可用。 / Verify MAC before parsing; accept existing cursors.
    pub fn verify(
        &self,
        token: &str,
        binding: &Binding,
        now: i64,
    ) -> Result<Map<String, Value>, CursorError> {
        let (body, signature) = token.split_once('.').ok_or(CursorError::Invalid)?;
        let signature = URL_SAFE_NO_PAD
            .decode(signature)
            .map_err(|_| CursorError::Invalid)?;
        let mut mac = self.mac()?;
        mac.update(body.as_bytes());
        mac.verify_slice(&signature)
            .map_err(|_| CursorError::Invalid)?;
        let bytes = URL_SAFE_NO_PAD
            .decode(body)
            .map_err(|_| CursorError::Invalid)?;
        let wire: WireCursor = serde_json::from_slice(&bytes).map_err(|_| CursorError::Invalid)?;
        if wire.v != 1
            || &wire.binding != binding
            || wire.exp <= now
            || !(-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&wire.exp)
        {
            return Err(CursorError::Invalid);
        }
        Ok(wire.key)
    }

    /// 使用标准 HMAC 库完成常数时间验证。 / Use standard HMAC constant-time verification.
    fn mac(&self) -> Result<Hmac<Sha256>, CursorError> {
        Hmac::<Sha256>::new_from_slice(self.secret).map_err(|_| CursorError::MissingSecret)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 由 Node createHmac 独立生成的旧协议向量。 / Legacy vector independently generated with Node createHmac.
    const LEGACY: &str = "eyJ2IjoxLCJyb3V0ZSI6Ii92MS9zZXJ2aWNlcyIsInF1ZXJ5IjoiIiwic29ydCI6Im5hbWUiLCJrZXkiOnsibmFtZSI6ImFwaSJ9LCJleHAiOjEwMDB9.3Xnkm7CZb1m5D_7CsJEMSQzvJXkQsDxdm_PqXp2bXBs";

    /// 共享测试绑定。 / Shared test binding.
    fn binding() -> Binding {
        Binding {
            route: "/v1/services".into(),
            query: "".into(),
            sort: "name".into(),
        }
    }

    #[test]
    fn accepts_legacy_wire_and_rejects_expiry_and_replay() {
        let signer = CursorSigner::new("secret").unwrap();
        let token = LEGACY.to_owned();
        assert_eq!(
            signer.verify(&token, &binding(), 999).unwrap()["name"],
            "api"
        );
        assert_eq!(
            signer.verify(&token, &binding(), 1000),
            Err(CursorError::Invalid)
        );
        let mut other = binding();
        other.route = "/v1/incidents".into();
        assert_eq!(
            signer.verify(&token, &other, 999),
            Err(CursorError::Invalid)
        );
        assert_eq!(
            signer.verify(&(token + ".extra"), &binding(), 999),
            Err(CursorError::Invalid)
        );
    }

    #[test]
    fn rejects_wrong_secret_and_invalid_configuration() {
        assert!(matches!(
            CursorSigner::new(" \t"),
            Err(CursorError::MissingSecret)
        ));
        let signer = CursorSigner::new("secret").unwrap();
        let token = signer.sign(binding(), Map::new(), 100).unwrap();
        assert_eq!(
            CursorSigner::new("other")
                .unwrap()
                .verify(&token, &binding(), 101),
            Err(CursorError::Invalid)
        );
        assert!(signer.sign(binding(), Map::new(), i64::MAX).is_err());
    }
}

//! AWS SigV4 仅签名指定对象 PUT。 / AWS SigV4 signs only one object PUT.
use super::{encode, INVALID};
use crate::http::HttpError;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
/// 签名配置只存在本次调用。 / Signing configuration lives only for this invocation.
pub(super) struct Config<'a> {
    /// 固定Cloudflare账户。 / Pinned Cloudflare account.
    pub account: &'a str,
    /// 私有bucket名称。 / Private bucket name.
    pub bucket: &'a str,
    /// 仅对象写入的访问键。 / Object-write-only access key.
    pub access: &'a str,
    /// Worker secret，不记录日志。 / Worker secret, never logged.
    pub secret: &'a str,
}
/// HMAC 子密钥派生。 / HMAC subkey derivation.
fn mac(key: &[u8], data: &str) -> Vec<u8> {
    let mut h = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts all key lengths");
    h.update(data.as_bytes());
    h.finalize().into_bytes().to_vec()
}
/// 固定十分钟、所有头受签名保护。 / Fixed ten-minute expiry; every header is signed.
pub(super) fn sign(
    config: Config<'_>,
    key: &str,
    mut headers: BTreeMap<String, String>,
    date: &str,
) -> Result<(String, BTreeMap<String, String>), HttpError> {
    if config.account.len() != 32
        || !config
            .account
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        || config.bucket.is_empty()
        || !config
            .bucket
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        || config.access.is_empty()
        || config.secret.is_empty()
        || date.len() != 16
    {
        return Err(INVALID);
    }
    if headers
        .values()
        .any(|v| v.contains(['\r', '\n']) || v.trim() != v)
    {
        return Err(INVALID);
    }
    let host = format!("{}.r2.cloudflarestorage.com", config.account);
    headers.insert("host".into(), host.clone());
    let names = headers.keys().cloned().collect::<Vec<_>>().join(";");
    let canonical_headers = headers
        .iter()
        .map(|(k, v)| {
            format!(
                "{k}:{}\n",
                v.split_whitespace().collect::<Vec<_>>().join(" ")
            )
        })
        .collect::<String>();
    let scope = format!("{}/auto/s3/aws4_request", &date[..8]);
    let query = BTreeMap::from([
        ("X-Amz-Algorithm", "AWS4-HMAC-SHA256".to_string()),
        ("X-Amz-Credential", format!("{}/{}", config.access, scope)),
        ("X-Amz-Date", date.into()),
        ("X-Amz-Expires", "600".into()),
        ("X-Amz-SignedHeaders", names.clone()),
    ]);
    let query = query
        .iter()
        .map(|(k, v)| format!("{}={}", encode(k), encode(v)))
        .collect::<Vec<_>>()
        .join("&");
    let path = format!(
        "/{}/{}",
        config.bucket,
        key.split('/').map(encode).collect::<Vec<_>>().join("/")
    );
    let canonical = format!("PUT\n{path}\n{query}\n{canonical_headers}\n{names}\nUNSIGNED-PAYLOAD");
    let signing = format!(
        "AWS4-HMAC-SHA256\n{date}\n{scope}\n{:x}",
        Sha256::digest(canonical.as_bytes())
    );
    let k = mac(format!("AWS4{}", config.secret).as_bytes(), &date[..8]);
    let k = mac(&k, "auto");
    let k = mac(&k, "s3");
    let k = mac(&k, "aws4_request");
    let signature = mac(&k, &signing)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    headers.remove("host");
    Ok((
        format!("https://{host}{path}?{query}&X-Amz-Signature={signature}"),
        headers,
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn signatures_bind_every_header() {
        let config = || Config {
            account: "0123456789abcdef0123456789abcdef",
            bucket: "private-artifacts",
            access: "test",
            secret: "test-secret",
        };
        let headers = BTreeMap::from([
            ("if-none-match".into(), "*".into()),
            ("content-md5".into(), "checksum".into()),
        ]);
        let (first, returned) =
            sign(config(), "a/b c", headers.clone(), "20260912T000000Z").unwrap();
        let mut altered = headers;
        altered.insert("content-md5".into(), "other".into());
        let (second, _) = sign(config(), "a/b c", altered, "20260912T000000Z").unwrap();
        assert_ne!(first, second);
        // aws4fetch 1.0.20 独立实现的固定向量。 / Fixed vector from independent aws4fetch implementation.
        assert!(first.ends_with(
            "X-Amz-Signature=7e156ccc42115d9f51f18eb78b02125065d1f26356b7872f06beca88ceb99712"
        ));
        assert!(first.contains("/a/b%20c?"));
        assert!(first.contains("content-md5%3Bhost%3Bif-none-match"));
        assert_eq!(returned["if-none-match"], "*");
    }
}

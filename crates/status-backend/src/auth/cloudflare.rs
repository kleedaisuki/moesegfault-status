//! Workers Rust SDK 的固定 JWKS 获取与公钥缓存。
//! Pinned JWKS fetch and public-key cache using the Workers Rust SDK.

use super::{bearer, verify_machine, MachineIdentity, MachineTrust, PublicKeys, INVALID_TOKEN};
use crate::http::{read_json_stream, HttpError};
use futures_util::{
    future::{select, Either},
    pin_mut,
};
use jsonwebtoken::{decode_header, Algorithm};
use serde_json::Value;
use std::{cell::RefCell, time::Duration};
use worker::{AbortController, Date, Delay, Fetch, Request, RequestInit, RequestRedirect};

/// 一个部署信任源的有界缓存；只保存公钥，不保存请求、token 或异步请求句柄。
/// Bounded single-trust-source cache; stores public keys, never requests, tokens, or async request handles.
struct CachedKeys {
    /// 已完成下载的来源。 / Source of the completed download.
    url: String,
    /// 公开 key material。 / Public key material.
    keys: PublicKeys,
    /// 完成下载的 Unix 毫秒。 / Download completion time in Unix milliseconds.
    fetched_at: u64,
}

thread_local! {
    /// 不跨 await 持有借用，也不共享跨请求 I/O Promise。 / No borrow spans await and no cross-request I/O promises are shared.
    static CACHE: RefCell<Option<CachedKeys>> = const { RefCell::new(None) };
}

/// 完整的机器请求认证入口。 / Complete machine request authentication entrypoint.
pub async fn authenticate_machine(
    request: &Request,
    trust: &MachineTrust,
) -> Result<MachineIdentity, HttpError> {
    let authorization = request
        .headers()
        .get("authorization")
        .map_err(|_| INVALID_TOKEN)?;
    let token = bearer(authorization.as_deref())?;
    let keys = match trust.embedded_keys() {
        Some(keys) => keys?,
        None => {
            remote_keys(
                trust.jwks_url().as_str(),
                token,
                &[Algorithm::RS256, Algorithm::ES256, Algorithm::EdDSA],
            )
            .await?
        }
    };
    verify_machine(token, trust, &keys, Date::now().as_millis() as f64 / 1000.0)
}

/// 缓存十分钟，未知 kid 最多每三十秒重新下载一次。
/// Cache for ten minutes; reload for unknown kid at most once every thirty seconds after a successful fetch.
async fn remote_keys(
    url: &str,
    token: &str,
    allowed: &[Algorithm],
) -> Result<PublicKeys, HttpError> {
    if token.len() > 8185 {
        return Err(INVALID_TOKEN);
    }
    let header = decode_header(token).map_err(|_| INVALID_TOKEN)?;
    if !allowed.contains(&header.alg) {
        return Err(INVALID_TOKEN);
    }
    let now = Date::now().as_millis();
    let cached = CACHE.with(|slot| {
        let slot = slot.borrow();
        let cached = slot
            .as_ref()
            .filter(|c| c.url == url && now.saturating_sub(c.fetched_at) < 600_000)?;
        if cached
            .keys
            .select(header.alg, header.kid.as_deref())
            .is_ok()
        {
            return Some(Ok(cached.keys.clone()));
        }
        (now.saturating_sub(cached.fetched_at) < 30_000).then_some(Err(INVALID_TOKEN))
    });
    if let Some(result) = cached {
        return result;
    }
    let keys = download_keys(url).await?;
    CACHE.with(|slot| {
        *slot.borrow_mut() = Some(CachedKeys {
            url: url.into(),
            keys: keys.clone(),
            fetched_at: Date::now().as_millis(),
        });
    });
    keys.select(header.alg, header.kid.as_deref())?;
    Ok(keys)
}

/// 超时覆盖响应体读取，拒绝重定向和超大内容。 / Timeout covers body reads; reject redirects and oversized content.
async fn download_keys(url: &str) -> Result<PublicKeys, HttpError> {
    let mut init = RequestInit::new();
    init.with_redirect(RequestRedirect::Manual);
    let request = Request::new_with_init(url, &init).map_err(|_| INVALID_TOKEN)?;
    let controller = AbortController::default();
    let signal = controller.signal();
    let download = async {
        let mut response = Fetch::Request(request)
            .send_with_signal(&signal)
            .await
            .map_err(|_| INVALID_TOKEN)?;
        if response.status_code() != 200 {
            return Err(INVALID_TOKEN);
        }
        let stream = response.stream().map_err(|_| INVALID_TOKEN)?;
        let value: Value = read_json_stream(stream, 262_144)
            .await
            .map_err(|_| INVALID_TOKEN)?;
        PublicKeys::parse(&serde_json::to_vec(&value).map_err(|_| INVALID_TOKEN)?)
    };
    let timeout = Delay::from(Duration::from_secs(5));
    pin_mut!(download, timeout);
    let result = match select(download, timeout).await {
        Either::Left((result, _)) => result,
        Either::Right(_) => Err(INVALID_TOKEN),
    };
    // 也取消失败或超限的下载，不留悬挂网络操作。 / Also abort failed or oversized downloads, leaving no dangling operation.
    controller.abort();
    result
}

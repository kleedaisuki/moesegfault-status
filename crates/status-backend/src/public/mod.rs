//! Rust 公共只读 API；响应仅投影公开字段。 / Rust public read-only API; project public fields only.

mod incidents;

use crate::{database::Database, http::HttpError};
use serde::Serialize;
use url::Url;
use worker::{Headers, Method, Request, Response};

/// 公开错误语义。 / Public error semantics.
const INVALID: HttpError = HttpError::new(400, "invalid-request", "Invalid request");
/// 不泄漏 SQL 的内部错误。 / Internal error without SQL disclosure.
const INTERNAL: HttpError = HttpError::new(
    500,
    "internal-error",
    "The status service could not complete the public read.",
);
/// 未找到 Incident。 / Incident not found.
const NOT_FOUND: HttpError =
    HttpError::new(404, "not-found", "The public incident does not exist.");

/// 单次调用的公开读上下文；密钥和数据库不跨请求存储。
/// Invocation-local public read context; secrets and database bindings are not retained across requests.
pub struct PublicContext<'a> {
    /// D1 权威来源。 / Authoritative D1 source.
    pub db: &'a Database,
    /// 游标签名密钥。 / Cursor signing secret.
    pub cursor_secret: &'a str,
    /// 可信调用关联 ID。 / Trusted invocation correlation ID.
    pub correlation_id: &'a str,
    /// Unix 秒，供确定性分页测试注入。 / Unix seconds, injectable for deterministic pagination tests.
    pub now: i64,
}

/// 路由已迁移的 Incident 公开接口；其他路由返回 None，不能冒充健康响应。
/// Route migrated public Incident endpoints; other paths return None, never a fabricated healthy response.
pub async fn handle_incidents(
    request: &Request,
    context: &PublicContext<'_>,
) -> worker::Result<Option<Response>> {
    if request.method() != Method::Get {
        return Ok(None);
    }
    let url = request.url()?;
    let detail = url
        .path()
        .strip_prefix("/v1/incidents/")
        .filter(|p| !p.is_empty() && !p.contains('/'));
    if url.path() != "/v1/incidents" && detail.is_none() {
        return Ok(None);
    }
    let result = async {
        if url.as_str().len() > 2048 {
            return Err(INVALID);
        }
        crate::cursor::CursorSigner::new(context.cursor_secret).map_err(|_| INTERNAL)?;
        match detail {
            Some(id) => {
                let id = percent_encoding::percent_decode_str(id)
                    .decode_utf8()
                    .map_err(|_| INVALID)?;
                incidents::detail(&id, &url, context).await
            }
            None => incidents::list(&url, context).await,
        }
    }
    .await;
    let response = match result {
        Ok(body) => json(&body, context.correlation_id)?,
        Err(error) => problem(&error, &url, context.correlation_id)?,
    };
    Ok(Some(response))
}

/// 使用可信固定 origin，而不是客户端 Host。 / Use a trusted fixed origin, never client Host.
fn self_link(url: &Url) -> String {
    let query = url.query().map(|q| format!("?{q}")).unwrap_or_default();
    format!("https://status.moesegfault.dev{}{query}", url.path())
}

/// 拒绝重复单值参数。 / Reject repeated single-valued parameters.
fn single(url: &Url, key: &str) -> Result<Option<String>, HttpError> {
    let mut values = url
        .query_pairs()
        .filter(|(k, _)| k == key)
        .map(|(_, value)| value.into_owned());
    let first = values.next();
    if values.next().is_some() {
        return Err(INVALID);
    }
    Ok(first)
}

/// 公开响应缓存策略与安全头。 / Public response cache policy and security headers.
fn json<T: Serialize>(body: &T, correlation: &str) -> worker::Result<Response> {
    let headers = headers(
        correlation,
        "application/json; charset=utf-8",
        "public, max-age=30, stale-if-error=60",
    )?;
    Ok(Response::from_json(body)?.with_headers(headers))
}

/// 安全的 RFC 9457 响应。 / Safe RFC 9457 response.
fn problem(error: &HttpError, url: &Url, correlation: &str) -> worker::Result<Response> {
    let title = match error.status {
        400 => "Invalid request",
        404 => "Incident not found",
        _ => "Internal server error",
    };
    let body = serde_json::json!({"type": format!("https://status.moesegfault.dev/problems/{}", error.code), "title": title, "status": error.status, "detail": error.detail, "instance": url.path(), "correlation_id": correlation});
    Ok(Response::from_json(&body)?
        .with_status(error.status)
        .with_headers(headers(
            correlation,
            "application/problem+json; charset=utf-8",
            "no-store",
        )?))
}

/// 一致的响应头。 / Consistent response headers.
fn headers(correlation: &str, media_type: &str, cache: &str) -> worker::Result<Headers> {
    let headers = Headers::new();
    headers.set("content-type", media_type)?;
    headers.set("cache-control", cache)?;
    headers.set("x-content-type-options", "nosniff")?;
    headers.set("x-moesegfault-correlation-id", correlation)?;
    Ok(headers)
}

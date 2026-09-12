//! 公开 Rust Worker 的事件组合；管理能力只存在于独立命名模块。
//! Public Rust Worker event composition; administrative capabilities exist only in the separate named module.
#![cfg(target_arch = "wasm32")]

use serde_json::json;
use status_backend::{
    bootstrap, database::Database, deployments, diagnostics, notifications, public, scheduling,
    telemetry,
};
use wasm_bindgen::prelude::*;
use worker::{Context, Env, Request, Response};

/// 安全边界错误不回传 SQL、平台异常或配置。 / Boundary errors never disclose SQL, platform exceptions, or configuration.
fn problem(status: u16, code: &str, correlation: &str) -> worker::Result<Response> {
    let mut response = Response::from_json(&json!({
        "type":format!("https://status.moesegfault.dev/problems/{code}"),
        "title":code,"status":status,"correlation_id":correlation
    }))?
    .with_status(status);
    response
        .headers_mut()
        .set("content-type", "application/problem+json")?;
    response.headers_mut().set("cache-control", "no-store")?;
    response
        .headers_mut()
        .set("x-moesegfault-correlation-id", correlation)?;
    Ok(response)
}

/// 明确启用 bootstrap 时，队列/Cron 不能写入未就绪业务状态。
/// Explicit bootstrap mode prevents Queue/Cron writes to unready application state.
fn bootstrap_mode(env: &Env) -> bool {
    env.var("BOOTSTRAP_MODE")
        .is_ok_and(|value| value.to_string() == "true")
}

/// 公网请求不接受管理员转发身份，也不提供通用 RPC HTTP 隧道。
/// Public requests accept no forwarded administrator identity and expose no generic RPC HTTP tunnel.
#[worker::event(fetch)]
pub async fn fetch(request: Request, env: Env, ctx: Context) -> worker::Result<Response> {
    let correlation = correlation_id(&request)?;
    let started = telemetry::now_ms();
    if !bootstrap::allows(&request, &env) {
        return problem(503, "bootstrap-in-progress", &correlation);
    }
    // Bootstrap 尚无注册产物来源；不可伪造来源以绕过发布前置条件。
    // Bootstrap has no registered artifact provenance; never fabricate it to bypass release prerequisites.
    let observer = if bootstrap_mode(&env) {
        None
    } else {
        match telemetry::for_invocation(&env) {
            Ok(value) => value,
            Err(_) => return problem(503, "provenance-unavailable", &correlation),
        }
    };
    let attributes = observer
        .as_ref()
        .map(|t| t.span_attributes("http.request", Some(&correlation), None))
        .unwrap_or_else(|| json!({"operation.name":"http.request"}));
    let invocation_id = correlation.clone();
    let scoped_observer = observer.clone();
    let response = telemetry::with_span("http.request", attributes, async move {
        route(request, env, ctx, &invocation_id, scoped_observer.as_ref()).await
    })
    .await;
    let mut response = match response {
        Ok(response) => response,
        Err(_) => problem(500, "internal-error", &correlation)?,
    };
    let response_id = response
        .headers()
        .get("x-moesegfault-correlation-id")?
        .unwrap_or(correlation);
    response
        .headers_mut()
        .set("x-moesegfault-correlation-id", &response_id)?;
    if let Some(observer) = observer {
        observer.http(response.status_code(), started, &response_id, None);
        observer.report_drops();
    }
    Ok(response)
}

/// 各功能模块拥有自己的严格认证/验证；此处只组合固定路由。
/// Feature modules own strict authentication/validation; this function only composes fixed routes.
async fn route(
    mut request: Request,
    env: Env,
    ctx: Context,
    correlation: &str,
    observer: Option<&telemetry::Telemetry>,
) -> worker::Result<Response> {
    if let Some(response) =
        deployments::handle_with_correlation(&mut request, &env, &ctx, correlation).await?
    {
        return Ok(response);
    }
    if let Some(response) =
        diagnostics::handle_with_correlation(&mut request, &env, &ctx, correlation).await?
    {
        return Ok(response);
    }
    let db = Database::new(env.d1("DB")?);
    let cursor = env.secret("CURSOR_SIGNING_KEY")?.to_string();
    let context = public::PublicContext {
        db: &db,
        telemetry: observer,
        cursor_secret: &cursor,
        correlation_id: correlation,
        now_millis: telemetry::now_ms() as i64,
    };
    match public::handle_public(&request, &context).await? {
        Some(response) => Ok(response),
        None => problem(404, "route-not-found", correlation),
    }
}

/// 机器事件关联引用可跨跳传播，但永远不能用于授权；公开读取不信任调用者 ID。
/// Machine event references may propagate across hops but never authorize access; public reads distrust caller IDs.
fn correlation_id(request: &Request) -> worker::Result<String> {
    let machine =
        request.path() == "/v1/diagnostic-events" || request.path().starts_with("/v1/deployments/");
    if machine {
        if let Some(value) = request
            .headers()
            .get("x-moesegfault-correlation-id")?
            .filter(|value| status_domain::validate_uuid_v7(value, "correlation_id").is_ok())
        {
            return Ok(value);
        }
    }
    telemetry::create_correlation_id()
}

/// 保留官方 Queue attempts 与 ack/retry 方法；未知队列失败关闭，不误投诊断。
/// Preserve official Queue attempts and ack/retry methods; unknown queues fail closed, never misroute diagnostics.
#[wasm_bindgen(js_name = queue)]
pub async fn queue(batch: JsValue, env: Env, ctx: JsValue) -> worker::Result<()> {
    let ctx = Context::new(ctx.unchecked_into());
    if bootstrap_mode(&env) {
        return Err(worker::Error::RustError("bootstrap-in-progress".into()));
    }
    let name = js_sys::Reflect::get(&batch, &"queue".into())?
        .as_string()
        .unwrap_or_default();
    let notification = env.var("NOTIFICATION_QUEUE_NAME")?.to_string();
    let diagnostic = env.var("DIAGNOSTIC_QUEUE_NAME")?.to_string();
    if name == notification {
        return notifications::consume_raw(batch, env, ctx).await;
    }
    if name == diagnostic {
        return diagnostics::consume_raw(batch, env, ctx).await;
    }
    Err(worker::Error::RustError("unknown-queue".into()))
}

/// 等待所有 Cron 工作与有界产物清理；不启动脱离 invocation 的任务。
/// Await all Cron work and bounded artifact cleanup; never detach tasks from the invocation.
#[wasm_bindgen(js_name = scheduled)]
pub async fn scheduled(_event: JsValue, env: Env, ctx: JsValue) -> worker::Result<()> {
    let ctx = Context::new(ctx.unchecked_into());
    if bootstrap_mode(&env) {
        return Err(worker::Error::RustError("bootstrap-in-progress".into()));
    }
    let cleanup_env = env.clone();
    let cleanup = async move {
        use futures_util::future::{select, Either};
        use std::time::Duration;
        // 产物清理故障不能阻止健康检查；重试依靠不可变对象及持久墓碑。
        // Artifact cleanup failures must not block health checks; immutable objects and durable tombstones make retries safe.
        let result = select(
            Box::pin(deployments::cleanup(&cleanup_env)),
            Box::pin(worker::Delay::from(Duration::from_secs(10))),
        )
        .await;
        match result {
            Either::Left((Ok(()), _)) => (),
            Either::Left((Err(_), _)) => worker::console_error!("artifact.cleanup.failed"),
            Either::Right(_) => worker::console_error!("artifact.cleanup.timeout"),
        }
    };
    let (result, ()) = futures_util::future::join(scheduling::scheduled(env, ctx), cleanup).await;
    result
}

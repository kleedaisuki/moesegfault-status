//! 私有默认 fetch 入口，业务完全由 Rust 实现。 / Private default fetch entrypoint with Rust-only business logic.
#[cfg(target_arch = "wasm32")]
use worker::{event, Context, Env, Request, Response, Result};

/// 默认入口参与平台 placement；禁止公开路由。 / Default entrypoint participates in platform placement; public routes are forbidden.
#[cfg(target_arch = "wasm32")]
#[event(fetch)]
pub async fn fetch(request: Request, env: Env, ctx: Context) -> Result<Response> {
    status_backend::probes::handle(request, env, ctx).await
}

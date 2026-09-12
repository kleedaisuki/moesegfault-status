//! 仅 Rust 的运维入口；部署仍须显式选择该构建。
//! Rust-only operations entrypoint; deployment must explicitly select this build.

/// 认证、同源防护及固定私有能力调度。 / Authentication, same-origin guards and fixed private capability routing.
#[cfg(target_arch = "wasm32")]
#[worker::event(fetch)]
pub async fn fetch(
    request: worker::Request,
    env: worker::Env,
    ctx: worker::Context,
) -> worker::Result<worker::Response> {
    status_backend::gateway::handle(request, env, ctx).await
}

//! 首次部署仅开放正常认证的控制平面，不伪造业务就绪。
//! Initial deployment exposes only normally authenticated control-plane routes, never fake readiness.
/// bootstrap只接受机器部署端点；真正认证仍在deployment handler执行。
/// Bootstrap accepts only machine deployment endpoints; the deployment handler still authenticates.
pub fn allows_path(method: &str, path: &str) -> bool {
    let Some(rest) = path.strip_prefix("/v1/deployments/") else {
        return false;
    };
    let parts = rest.split('/').collect::<Vec<_>>();
    if parts.is_empty() || status_domain::validate_uuid_v7(parts[0], "deployment_id").is_err() {
        return false;
    }
    (parts.len() == 1 && method == "PUT")
        || (parts.len() == 2
            && method == "POST"
            && ["artifact-uploads", "artifacts"].contains(&parts[1]))
        || (parts.len() == 3
            && method == "PUT"
            && parts[1] == "artifact-uploads"
            && status_domain::validate_uuid_v7(parts[2], "upload_id").is_ok())
}
/// 只有显式控制平面配置能打开bootstrap；HTTP头无法改变模式。
/// Only explicit control-plane configuration enables bootstrap; HTTP headers cannot change the mode.
#[cfg(target_arch = "wasm32")]
pub fn allows(request: &worker::Request, env: &worker::Env) -> bool {
    env.var("BOOTSTRAP_MODE")
        .map(|v| v.to_string() != "true")
        .unwrap_or(true)
        || allows_path(request.method().as_ref(), &request.path())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bootstrap_never_allows_health_admin_or_telemetry() {
        for p in [
            "/health",
            "/v1/status",
            "/v1/admin/deployments",
            "/v1/telemetry",
            "/v1/deployments/not-an-id",
        ] {
            assert!(!allows_path("PUT", p));
        }
        let p = "/v1/deployments/01994800-0000-7000-8000-000000000001";
        assert!(allows_path("PUT", p));
        assert!(!allows_path("GET", p));
        assert!(allows_path("POST", &format!("{p}/artifacts")));
        let upload = format!("{p}/artifact-uploads/01994800-0000-7000-8000-000000000002");
        assert!(allows_path("PUT", &upload));
        assert!(!allows_path("GET", &upload));
        assert!(!allows_path(
            "PUT",
            &format!("{p}/artifact-uploads/not-an-id")
        ));
        assert!(!allows_path("PUT", &format!("{upload}/extra")));
        assert!(!allows_path("POST", &format!("{p}/activate")));
    }
}

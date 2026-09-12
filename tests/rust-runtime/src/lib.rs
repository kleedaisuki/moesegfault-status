//! 仅测试的 Rust Worker 驱动，调用真实后端模块。 / Test-only Rust Worker driver invoking real backend modules.
#![cfg(target_arch = "wasm32")]

use status_backend::{
    access::AccessTrust,
    auth::{
        cloudflare::{authenticate_access, authenticate_machine},
        MachineTrust,
    },
    http::read_json,
};
use worker::*;

/// 此入口不部署到生产；不替代任何业务接口。 / Never deploy this entrypoint to production; it replaces no business API.
#[event(fetch)]
pub async fn fetch(mut request: Request, env: Env, _ctx: Context) -> Result<Response> {
    let issuer = env.var("ISSUER")?.to_string();
    let audience = env.var("AUDIENCE")?.to_string();
    if request.path() == "/json" {
        return match read_json::<serde_json::Value>(&mut request, 16).await {
            Ok(value) => Response::from_json(&value),
            Err(error) => Response::error(error.code, error.status),
        };
    }
    if request.path() == "/access" {
        let trust = AccessTrust::new(
            &issuer,
            &audience,
            "3600",
            r#"{"runtime-human":["operator"]}"#,
        )
        .map_err(|e| Error::RustError(e.to_string()))?;
        let token = request
            .headers()
            .get("cf-access-jwt-assertion")?
            .unwrap_or_default();
        return match authenticate_access(&token, &trust).await {
            Ok(principal) => Response::from_json(&principal),
            Err(error) => Response::error(error.code, error.status),
        };
    }
    let trust = MachineTrust::new(&issuer, &audience, &format!("{issuer}/jwks"))
        .map_err(|e| Error::RustError(e.to_string()))?;
    match authenticate_machine(&request, &trust).await {
        Ok(identity) => match identity.require_scope("diagnostics:write") {
            Ok(()) => Response::from_json(&serde_json::json!({"subject": identity.subject()})),
            Err(error) => Response::error(error.code, error.status),
        },
        Err(error) => Response::error(error.code, error.status),
    }
}

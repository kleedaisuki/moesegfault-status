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
    if request.path().starts_with("/v1/incidents") {
        let db = status_backend::database::Database::new(env.d1("DB")?);
        let context = status_backend::public::PublicContext {
            db: &db,
            cursor_secret: "runtime-cursor-secret",
            correlation_id: "0199d0a8-2e12-7a59-a51e-000000000099",
            now: (Date::now().as_millis() / 1000) as i64,
        };
        return status_backend::public::handle_incidents(&request, &context)
            .await?
            .map_or_else(|| Response::error("Not found", 404), Ok);
    }
    if request.path().starts_with("/database/") {
        return database_check(&request.path(), &env).await;
    }
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

/// 真实 D1 行解码和事务行为的测试驱动，不是生产管理入口。
/// Real D1 decoding and transaction test driver, not a production administrative endpoint.
async fn database_check(path: &str, env: &Env) -> Result<Response> {
    use status_backend::database::{Database, Query, SqlValue};
    let db = Database::new(env.d1("DB")?);
    let result = match path {
        "/database/rollback" => {
            db.batch(&[Query::new(
                "CREATE TABLE IF NOT EXISTS rust_atomic (id INTEGER PRIMARY KEY)",
                vec![],
            )])
            .await
            .map_err(|e| Error::RustError(e.to_string()))?;
            let failed = db
                .batch(&[
                    Query::new("INSERT INTO rust_atomic(id) VALUES (?)", vec![1_i64.into()]),
                    Query::new("INSERT INTO rust_atomic(id) VALUES (?)", vec![1_i64.into()]),
                ])
                .await
                .is_err();
            let count: Option<serde_json::Value> = db
                .first(&Query::new(
                    "SELECT COUNT(*) AS count FROM rust_atomic",
                    vec![],
                ))
                .await
                .map_err(|e| Error::RustError(e.to_string()))?;
            serde_json::json!({"failed": failed, "row": count})
        }
        "/database/row-error" => {
            #[derive(serde::Deserialize)]
            struct Count {
                count: u64,
            }
            let failed = db
                .all::<Count>(&Query::new("SELECT 'wrong' AS count", vec![]))
                .await
                .is_err();
            let good = db
                .all::<Count>(&Query::new("SELECT 7 AS count", vec![]))
                .await
                .map_err(|e| Error::RustError(e.to_string()))?;
            serde_json::json!({"failed": failed, "count": good[0].count})
        }
        "/database/values" => {
            let rows: Vec<serde_json::Value> = db
                .all(&Query::new(
                    "SELECT ? AS missing, ? AS text, ? AS integer, ? AS boolean, hex(?) AS blob",
                    vec![
                        SqlValue::Null,
                        "'; DROP TABLE services; --".into(),
                        SqlValue::Integer(9_007_199_254_740_991),
                        true.into(),
                        SqlValue::Blob(vec![0, 255]),
                    ],
                ))
                .await
                .map_err(|e| Error::RustError(e.to_string()))?;
            serde_json::json!({"rows": rows})
        }
        _ => return Response::error("Not found", 404),
    };
    Response::from_json(&result)
}

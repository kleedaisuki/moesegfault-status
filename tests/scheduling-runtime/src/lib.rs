//! 仅测试的实际 Rust 调度入口，不允许部署到生产。 / Test-only real Rust scheduler entrypoint; never deploy to production.
#![cfg(target_arch = "wasm32")]

use serde_json::{json, Value};
use status_backend::{
    database::{Database, Query},
    scheduling::{
        self,
        store::{lease_guard, SchedulerStore},
    },
};
use worker::*;

/// 运行生产 scheduled，并提供一个租约竞态注入入口。 / Run production scheduled and expose one lease-race injection endpoint.
#[event(fetch)]
pub async fn fetch(mut request: Request, env: Env, ctx: Context) -> Result<Response> {
    if request.method() != Method::Post {
        return Response::error("Method not allowed", 405);
    }
    if request.path() == "/tick" {
        scheduling::scheduled(env, ctx).await?;
        return Response::from_json(&json!({"completed":true}));
    }
    if request.path() == "/diagnostic-lease-race" {
        let input = request.json::<Value>().await?;
        let db = Database::new(env.d1("DB")?);
        let store = SchedulerStore::new(&db);
        let now = chrono::DateTime::from_timestamp_millis(Date::now().as_millis() as i64)
            .unwrap()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let future = chrono::DateTime::parse_from_rfc3339(&now)
            .map_err(|_| Error::RustError("clock".into()))?
            + chrono::Duration::seconds(90);
        let rows = store
            .due(&now, 500)
            .await
            .map_err(|_| Error::RustError("due".into()))?;
        let row = rows
            .iter()
            .find(|row| row["monitor_id"] == input["monitor_id"])
            .ok_or_else(|| Error::RustError("monitor not due".into()))?;
        let revision = store
            .claim_monitor(
                row,
                "runtime-race",
                &now,
                &future.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            )
            .await
            .map_err(|_| Error::RustError("claim".into()))?
            .ok_or_else(|| Error::RustError("not claimed".into()))?;
        let id = row["monitor_id"].as_str().unwrap();
        let locations = store
            .locations(id)
            .await
            .map_err(|_| Error::RustError("locations".into()))?;
        if input["disable"] == true {
            db.batch(&[Query::new(
                "UPDATE monitors SET enabled=0,revision=revision+1 WHERE monitor_id=?",
                vec![id.into()],
            )])
            .await
            .map_err(|_| Error::RustError("disable".into()))?;
        }
        let guard = lease_guard(row, "runtime-race", &now, &locations, revision)
            .map_err(|_| Error::RustError("guard".into()))?;
        return match status_backend::diagnostics::process_monitor_envelope(
            &env,
            input["envelope"].clone(),
            guard,
            None,
        )
        .await
        {
            Ok(processed) => Response::from_json(&json!({"accepted":true,"processed":processed})),
            Err(error) => Response::from_json(&json!({"accepted":false,"error":error.to_string()})),
        };
    }
    Response::error("Not found", 404)
}

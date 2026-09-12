//! 真实 Rust SDK 与 Workers Fetch 集成驱动；只有远端服务是 fixture。
//! Real Rust SDK and Workers Fetch integration driver; only the remote service is a fixture.
#![cfg(target_arch = "wasm32")]
use diagnostic_client::{
    builder::{DiagnosticEventBuilder, DiagnosticEventInput},
    publisher::{DiagnosticClient, Options},
    workers::WorkersTransport,
};
use futures_util::FutureExt;
use serde_json::{json, Value};
use status_domain::{DeploymentManifest, DiagnosticSeverity};
use std::{cell::Cell, rc::Rc, time::Duration};
use worker::*;

/// 完整不可变 manifest，不绕过生产来源验证。 / Complete immutable manifest without bypassing production validation.
fn manifest() -> DeploymentManifest {
    serde_json::from_value(json!({
        "deployment_id":"0199d09a-b692-7ce0-a1c0-5138a43d7402",
        "service_name":"api", "environment":"test", "service_version":"1",
        "repository_url":"https://github.com/example/api", "git_commit":"a".repeat(40),
        "git_ref":"main", "artifact_digest":format!("sha256:{}", "b".repeat(64)),
        "ci_provider":"github", "ci_run_id":"1", "deployed_at":"2026-09-12T08:00:00Z",
        "region":["global"], "artifacts":[{"kind":"other", "file_name":"index.wasm",
        "artifact_digest":format!("sha256:{}", "b".repeat(64)), "media_type":"application/wasm", "size_bytes":1}]
    })).expect("valid test manifest")
}

/// 每次请求独立客户端，避免跨请求 I/O 状态。 / Invocation-local client avoids cross-request I/O state.
#[event(fetch)]
pub async fn fetch(mut request: Request, _env: Env, _ctx: Context) -> Result<Response> {
    if request.path() == "/history" {
        return Fetch::Url("https://remote.test/history".parse()?)
            .send()
            .await;
    }
    let body = request.json::<Value>().await?;
    let mode = body["mode"].as_str().unwrap_or("retry").to_owned();
    let builder = DiagnosticEventBuilder::from_manifest(&manifest()).expect("valid manifest");
    let mut input =
        DiagnosticEventInput::new("dependency.failed", DiagnosticSeverity::Error, &mode);
    input
        .fingerprint
        .insert("dependency".into(), "database".into());
    let prepared = builder.fault(input).expect("valid event");
    let auth_calls = Rc::new(Cell::new(0));
    let calls = auth_calls.clone();
    let slow_auth = mode == "auth-timeout";
    let transport = WorkersTransport::new(Rc::new(move || {
        calls.set(calls.get() + 1);
        let n = calls.get();
        async move {
            if slow_auth {
                Delay::from(Duration::from_millis(300)).await;
            }
            Ok(format!("Bearer fixture-secret-{n}"))
        }
        .boxed_local()
    }));
    let mut options = Options::new("https://remote.test/v1/diagnostic-events");
    options.max_attempts = if mode == "retry" { 2 } else { 1 };
    options.timeout_ms = if mode.contains("timeout") { 40 } else { 2000 };
    options.base_backoff_ms = 1;
    options.max_backoff_ms = 1;
    let client = DiagnosticClient::new(builder, options, Rc::new(transport)).expect("valid client");
    client.publish(prepared.clone()).expect("matching identity");
    let stats = client.flush().await;
    Response::from_json(
        &json!({"stats":stats, "authCalls":auth_calls.get(), "event":prepared.event()}),
    )
}

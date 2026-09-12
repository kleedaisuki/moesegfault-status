//! 可信区域分派；执行器故障不是目标故障。 / Trusted regional dispatch; executor failure is not target failure.

use super::runtime::{bounded_json, iso, now};
use super::validation::{timestamp, uuid, valid_registry, valid_response};
use futures_util::future::{select, Either};
use serde_json::{json, Value};
use std::time::Duration;
use worker::{Env, Headers, Method, RequestInit};

/// 仅接受注册且回显身份匹配的样本。 / Accept only registered, identity-bound observations.
///
/// 调用方传入本轮绝对截止时间；任何传输或协议故障返回 None。
/// The caller supplies the invocation deadline; all transport/protocol failures return None.
pub async fn dispatch(
    env: &Env,
    monitor: &Value,
    location: &str,
    run_id: &str,
    correlation_id: &str,
    deadline_at: &str,
) -> worker::Result<Option<Value>> {
    Ok(
        attempt(env, monitor, location, run_id, correlation_id, deadline_at)
            .await
            .ok()
            .flatten(),
    )
}

/// 在单个截止时间内完成请求和有界读取。 / Share one deadline across request and bounded body read.
async fn attempt(
    env: &Env,
    monitor: &Value,
    location: &str,
    run_id: &str,
    correlation_id: &str,
    deadline_at: &str,
) -> worker::Result<Option<Value>> {
    let registry: Value = serde_json::from_str(&env.var("PROBE_REGIONAL_CONFIG")?.to_string())?;
    if !valid_registry(&registry) {
        return Ok(None);
    }
    let config = &registry[location];
    let probe: super::model::Probe = serde_json::from_value(monitor["probe"].clone())?;
    if probe.validate().is_err() {
        return Ok(None);
    }
    let kind = probe.kind();
    let timeout = monitor["timeoutMs"].as_u64().unwrap_or(0);
    let monitor_id = monitor["monitorId"].as_str().unwrap_or("");
    let scheduled = monitor["scheduledFor"].as_str().unwrap_or("");
    if !config["allowed_kinds"]
        .as_array()
        .is_some_and(|v| v.iter().any(|k| k == kind))
        || !(1..=300_000).contains(&timeout)
        || ![run_id, correlation_id, monitor_id]
            .iter()
            .all(|id| uuid(id))
        || timestamp(scheduled).is_none()
    {
        return Ok(None);
    }
    let started = now();
    let Some(outer_deadline) = timestamp(deadline_at) else {
        return Ok(None);
    };
    let deadline = outer_deadline.min(started + timeout as f64 + 2000.0);
    if deadline <= started {
        return Ok(None);
    }
    // 新的随机跟踪身份，不复用业务 UUID。 / Fresh random trace identity, independent of business UUIDs.
    let mut random = [0_u8; 24];
    getrandom::getrandom(&mut random)
        .map_err(|_| worker::Error::RustError("trace_random".into()))?;
    random[0] |= 1;
    random[16] |= 1;
    let hex = |bytes: &[u8]| bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
    let body = json!({
        "version": "1", "executor_id": config["executor_id"], "location": location,
        "run_id": run_id, "monitor_id": monitor_id, "correlation_id": correlation_id,
        "deadline_at": iso(deadline), "scheduled_for": scheduled,
        "traceparent": format!("00-{}-{}-01", hex(&random[..16]), hex(&random[16..])),
        "timeout_ms": timeout, "probe": probe
    });
    let headers = Headers::new();
    headers.set("content-type", "application/json")?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_redirect(worker::RequestRedirect::Manual)
        .with_body(Some(body.to_string().into()));
    let service = env.service(config["binding"].as_str().unwrap_or(""))?;
    let controller = worker::AbortController::default();
    let signal = controller.signal();
    let web_init: web_sys::RequestInit = (&init).into();
    web_init.set_signal(Some(&signal));
    let request =
        web_sys::Request::new_with_str_and_init("https://regional.internal/probe", &web_init)?;
    let fetch = Box::pin(service.fetch_request(worker::Request::from(request)));
    let timer = Box::pin(worker::Delay::from(Duration::from_millis(
        (deadline - now()).max(0.0) as u64,
    )));
    let response = match select(fetch, timer).await {
        Either::Left((response, _)) => response?,
        Either::Right(_) => {
            controller.abort();
            return Ok(None);
        }
    };
    if !(200..300).contains(&response.status_code()) {
        super::runtime::cancel(&response).await;
        return Ok(None);
    }
    let result = bounded_json(response, deadline).await?;
    if !valid_response(&result) || now() > deadline {
        return Ok(None);
    }
    let observation = &result["observation"];
    let observed = timestamp(observation["observedAt"].as_str().unwrap_or("")).unwrap_or(f64::NAN);
    if result["executor_id"] != config["executor_id"]
        || result["location"] != location
        || result["run_id"] != run_id
        || result["scheduled_for"] != scheduled
        || observation["monitorId"] != monitor_id
        || observation["correlationId"] != correlation_id
        || !config["allowed_colos"]
            .as_array()
            .is_some_and(|v| v.contains(&result["actual_colo"]))
        || observed < started - 1000.0
        || observed > now() + 1000.0
    {
        return Ok(None);
    }
    let mut observation = observation.clone();
    observation["execution"] = json!({"runtime":"cloudflare-worker", "location":location,
        "executorId":result["executor_id"], "actualColo":result["actual_colo"]});
    Ok(Some(observation))
}

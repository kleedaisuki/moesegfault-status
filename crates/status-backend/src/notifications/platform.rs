//! Queue、超时和 webhook 原生适配。 / Native Queue, timeout and webhook adapters.

use super::*;
use serde_json::{json, Value};
use wasm_bindgen::{JsCast, JsValue};

/// 调度器在领取外部 outbox 前检查；关闭时保留 D1 pending，不伪造投递成功。
/// Check before claiming external outbox rows; disabled delivery leaves D1 pending, never fabricates success.
pub fn delivery_enabled(env: &worker::Env) -> worker::Result<bool> {
    let mode = env.var("NOTIFICATIONS_ENABLED").ok().map(|v| v.to_string());
    if !delivery_mode(mode.as_deref()).map_err(|e| worker::Error::RustError(e.into()))? {
        return Ok(false);
    }
    let endpoint = env.secret("NOTIFICATION_WEBHOOK_URL")?.to_string();
    let authorization = env.secret("NOTIFICATION_AUTHORIZATION")?.to_string();
    validate_endpoint(&endpoint, &authorization).map_err(|e| worker::Error::RustError(e.into()))?;
    Ok(true)
}

/// 原始官方消息 binding 保留 attempts；DLQ 接受之前绝不确认失败消息。
/// Raw official message bindings retain attempts; never acknowledge failure before DLQ acceptance.
pub async fn consume_raw(
    batch: JsValue,
    env: worker::Env,
    _ctx: worker::Context,
) -> worker::Result<()> {
    let telemetry = crate::telemetry::for_invocation(&env)?;
    let enabled = delivery_enabled(&env);
    let endpoint = env
        .secret("NOTIFICATION_WEBHOOK_URL")
        .map(|s| s.to_string());
    let authorization = env
        .secret("NOTIFICATION_AUTHORIZATION")
        .map(|s| s.to_string());
    let maximum = env
        .var("NOTIFICATION_MAX_ATTEMPTS")
        .ok()
        .and_then(|s| s.to_string().parse::<u32>().ok())
        .filter(|n| (1..=100).contains(n))
        .unwrap_or(5);
    let messages = js_sys::Reflect::get(&batch, &"messages".into())?;
    if !js_sys::Array::is_array(&messages) {
        return Err(worker::Error::RustError(
            "invalid_notification_batch".into(),
        ));
    }
    let messages = js_sys::Array::from(&messages);
    let mut retried = 0;
    let mut acknowledged = 0;
    let mut dead = 0;
    let mut lag = 0.0;
    let mut lag_count = 0;
    for raw in messages.iter() {
        let attempt = js_sys::Reflect::get(&raw, &"attempts".into())?
            .as_f64()
            .filter(|n| n.is_finite() && *n >= 1.0 && n.fract() == 0.0)
            .unwrap_or(1.0) as u32;
        let timestamp = js_sys::Reflect::get(&raw, &"timestamp".into())?;
        if let Some(date) = timestamp.dyn_ref::<js_sys::Date>() {
            let age = crate::telemetry::now_ms() - date.get_time();
            if age.is_finite() && age >= 0.0 {
                lag += age;
                lag_count += 1;
            }
        }
        let body = js_sys::Reflect::get(&raw, &"body".into())?;
        let notification = serde_wasm_bindgen::from_value::<Value>(body.clone())
            .ok()
            .and_then(|value| serde_json::from_value::<Notification>(value).ok())
            .filter(|n| n.validate().is_ok());
        let result = match (&notification, &endpoint, &authorization) {
            (Some(n), Ok(url), Ok(auth)) if matches!(enabled, Ok(true)) => {
                deliver_traced(n, url, auth, telemetry.as_ref()).await
            }
            _ => Err(worker::Error::RustError(
                "notification_configuration_or_schema_invalid".into(),
            )),
        };
        if result.is_ok() {
            disposition(&raw, "ack", None)?;
            acknowledged += 1;
            continue;
        }
        let problem = if notification.is_none() {
            "invalid-notification"
        } else if matches!(enabled, Ok(false)) {
            "notification-delivery-disabled"
        } else if enabled.is_err() || endpoint.is_err() || authorization.is_err() {
            "notification-configuration-unavailable"
        } else {
            "notification-delivery-failed"
        };
        if let Some(t) = &telemetry {
            t.event(
                "status.notification.failed",
                true,
                json!({"error.type":problem,"failure.stage":"notification.delivery"}),
                notification.as_ref().map(|n| n.correlation_id.as_str()),
                None,
            );
        }
        if attempt >= maximum {
            // 仅保存校验过的域消息；非法输入不复制秘密或任意 payload 到 DLQ。
            // Retain validated domain messages only; never copy secrets or arbitrary malformed payloads to DLQ.
            let event_id = js_sys::Reflect::get(&body, &"event_id".into())
                .ok()
                .and_then(|v| v.as_string())
                .filter(|s| status_domain::validate_uuid_v7(s, "event_id").is_ok());
            let envelope = json!({"schema_version":"1.0","event_id":event_id,"original_event":notification,"producer_identity":{"service_name":"status","deployment_id":env.var("DEPLOYMENT_ID").map(|v|v.to_string()).unwrap_or_default()},"failure_stage":"notification.delivery","last_problem_type":format!("https://status.moesegfault.dev/problems/{problem}"),"attempts":attempt,"queue_message_id":js_sys::Reflect::get(&raw,&"id".into())?.as_string()});
            if let Ok(queue) = env.queue("NOTIFICATION_DLQ") {
                let payload =
                    envelope.serialize(&serde_wasm_bindgen::Serializer::json_compatible())?;
                if queue
                    .send_raw(
                        worker::RawMessageBuilder::new(payload)
                            .build_with_content_type(worker::QueueContentType::Json),
                    )
                    .await
                    .is_ok()
                {
                    disposition(&raw, "ack", None)?;
                    dead += 1;
                    continue;
                }
            }
        }
        disposition(&raw, "retry", Some(retry_delay(attempt)))?;
        retried += 1;
    }
    if let Some(t) = telemetry {
        for (name, count) in [
            ("queue.message.received", messages.length()),
            ("queue.message.retry_requested", retried),
            ("queue.message.acknowledged", acknowledged),
            ("queue.message.dead_lettered", dead),
        ] {
            t.metric(name, count as f64, "notification", false);
        }
        if lag_count > 0 {
            t.metric("queue.consumer.lag.sum", lag, "notification", true);
            t.metric(
                "queue.consumer.lag.count",
                lag_count as f64,
                "notification",
                false,
            );
        }
        t.report_drops();
    }
    Ok(())
}

/// 调用原生确认方法并保留接收者 this。 / Call the native disposition method while retaining receiver this.
fn disposition(message: &JsValue, method: &str, delay: Option<u32>) -> worker::Result<()> {
    let function = js_sys::Reflect::get(message, &method.into())?
        .dyn_into::<js_sys::Function>()
        .map_err(|_| worker::Error::RustError("invalid_queue_binding".into()))?;
    if let Some(delay) = delay {
        function.call1(
            message,
            &json!({"delaySeconds":delay})
                .serialize(&serde_wasm_bindgen::Serializer::json_compatible())?,
        )?;
    } else {
        function.call0(message)?;
    }
    Ok(())
}

/// 定时 outbox 的 Queue 移交；仅 Queue 接受后调用者才能标记 delivered。
/// Scheduled outbox handoff; callers may mark delivered only after Queue acceptance.
pub async fn publish(env: &worker::Env, notification: &Notification) -> worker::Result<()> {
    if !delivery_enabled(env)? {
        return Err(worker::Error::RustError(
            "notification_delivery_disabled".into(),
        ));
    }
    notification
        .validate()
        .map_err(|e| worker::Error::RustError(e.into()))?;
    env.queue("NOTIFICATION_QUEUE")?.send(notification).await?;
    Ok(())
}

/// 五秒硬超时并取消底层请求；不消费不可信的返回正文。 / Five-second deadline aborts the request; never consume an untrusted response body.
async fn deliver(
    notification: &Notification,
    endpoint: &str,
    authorization: &str,
    telemetry: Option<&crate::telemetry::Telemetry>,
    trace: &TraceContext,
) -> worker::Result<()> {
    let endpoint = validate_endpoint(endpoint, authorization)
        .map_err(|e| worker::Error::RustError(e.into()))?;
    let headers = worker::Headers::new();
    headers.set("content-type", "application/json")?;
    headers.set("authorization", authorization)?;
    headers.set("idempotency-key", &notification.event_id)?;
    headers.set("x-moesegfault-correlation-id", &notification.correlation_id)?;
    headers.set("traceparent", &trace.traceparent())?;
    if let Some(state) = &trace.tracestate {
        headers.set("tracestate", state)?;
    }
    let mut init = worker::RequestInit::new();
    init.with_method(worker::Method::Post)
        .with_headers(headers)
        // Workers Request 不支持 redirect:error；Manual 加下游非2xx拒绝等价禁止跟随。
        // Workers Request rejects redirect:error; Manual plus non-2xx rejection forbids following.
        .with_redirect(worker::RequestRedirect::Manual)
        .with_body(Some(serde_json::to_string(notification)?.into()));
    let request = worker::Request::new_with_init(endpoint.as_str(), &init)?;
    let controller = worker::AbortController::default();
    let signal = controller.signal();
    let fetch = worker::Fetch::Request(request);
    let send = fetch.send_with_signal(&signal);
    let timeout = worker::Delay::from(std::time::Duration::from_secs(5));
    futures_util::pin_mut!(send, timeout);
    let result = match futures_util::future::select(send, timeout).await {
        futures_util::future::Either::Left((response, _)) => response.and_then(|r| {
            if (200..300).contains(&r.status_code()) {
                Ok(())
            } else {
                Err(worker::Error::RustError(
                    "notification_receiver_rejected".into(),
                ))
            }
        }),
        futures_util::future::Either::Right(_) => {
            Err(worker::Error::RustError("notification_timeout".into()))
        }
    };
    controller.abort();
    if let Some(t) = telemetry {
        t.event(
            "status.notification.processed",
            result.is_err(),
            json!({"operation.name":"notification.deliver"}),
            Some(&notification.correlation_id),
            Some(trace),
        );
    }
    result
}

/// 每次投递创建全新 consumer span，重试不重用原 span。 / Each delivery creates a fresh consumer span, never reusing a retry span.
async fn deliver_traced(
    notification: &Notification,
    endpoint: &str,
    authorization: &str,
    telemetry: Option<&crate::telemetry::Telemetry>,
) -> worker::Result<()> {
    let notification = notification.clone();
    let endpoint = endpoint.to_owned();
    let authorization = authorization.to_owned();
    let telemetry = telemetry.cloned();
    let trace = TraceContext::child(
        notification.traceparent.as_deref(),
        notification.tracestate.as_deref(),
    )?;
    let attrs=telemetry.as_ref().map(|t|t.span_attributes("notification.consume",Some(&notification.correlation_id),Some(&trace))).unwrap_or_else(||json!({"operation.name":"notification.consume","moesegfault.correlation.id":notification.correlation_id}));
    crate::telemetry::with_span("queue.notification.consume", attrs, async move {
        deliver(
            &notification,
            &endpoint,
            &authorization,
            telemetry.as_ref(),
            &trace,
        )
        .await
    })
    .await
}

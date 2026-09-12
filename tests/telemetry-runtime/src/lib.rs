//! 测试原生遥测及Queue边界；生产逻辑只调用真实Rust模块。
//! Test native telemetry and Queue boundaries; production behavior calls real Rust modules only.
#![cfg(target_arch = "wasm32")]
use serde::Serialize;
use serde_json::{json, Value};
use std::{cell::RefCell, rc::Rc};
use wasm_bindgen::{prelude::*, JsCast};
use worker::*;

/// 测试HTTP驱动；仅ack/retry观察器是内存fixture。 / Test HTTP driver; only ack/retry observers are in-memory fixtures.
#[event(fetch)]
pub async fn fetch(mut request: Request, env: Env, ctx: Context) -> Result<Response> {
    if request.path() == "/trace" {
        return Response::from_json(
            &json!({"trace":status_backend::telemetry::TraceContext::child(None,None).map(|t|t.traceparent()).map_err(|e|e.to_string()),"endpoint":status_backend::notifications::validate_endpoint(&env.secret("NOTIFICATION_WEBHOOK_URL")?.to_string(),&env.secret("NOTIFICATION_AUTHORIZATION")?.to_string()).map(|_|true)}),
        );
    }
    if request.path() == "/history" {
        return Fetch::Url("https://webhook.test/history".parse()?)
            .send()
            .await;
    }
    if request.path() == "/span" {
        let env = if request.headers().get("x-test-metrics-disabled")?.is_some() {
            let object = js_sys::Object::assign(
                &js_sys::Object::new(),
                env.unchecked_ref::<js_sys::Object>(),
            );
            js_sys::Reflect::delete_property(&object, &"ANALYTICS".into())?;
            object.unchecked_into::<Env>()
        } else {
            env
        };
        let t = status_backend::telemetry::for_invocation(&env)?;
        let result = status_backend::telemetry::with_span(
            "test.operation",
            json!({"operation.name":"test.operation"}),
            async { Ok::<_, worker::Error>(42) },
        )
        .await?;
        if let Some(t) = t {
            t.metric("test.count", 1.0, "test", false);
            t.event(
                "status.test.completed",
                false,
                json!({"operation.name":"test"}),
                None,
                None,
            );
            return Response::from_json(&json!({"result":result,"dropped":t.dropped()}));
        }
        return Response::from_json(&json!({"result":result,"disabled":true}));
    }
    let body = request.json::<Value>().await?;
    let env = if let Some(binding) = body["remove_binding"].as_str() {
        let object = js_sys::Object::assign(
            &js_sys::Object::new(),
            env.unchecked_ref::<js_sys::Object>(),
        );
        js_sys::Reflect::delete_property(&object, &binding.into())?;
        object.unchecked_into::<Env>()
    } else {
        env
    };
    let dispositions = Rc::new(RefCell::new(Vec::<Value>::new()));
    let message = js_sys::Object::new();
    let observed = dispositions.clone();
    let ack = Closure::wrap_assert_unwind_safe(Box::new(move || {
        observed.borrow_mut().push(json!({"action":"ack"}));
    }) as Box<dyn FnMut()>);
    let observed = dispositions.clone();
    let retry = Closure::wrap_assert_unwind_safe(Box::new(move |options: JsValue| {
        let delay = js_sys::Reflect::get(&options, &"delaySeconds".into())
            .ok()
            .and_then(|v| v.as_f64());
        observed
            .borrow_mut()
            .push(json!({"action":"retry","delay":delay}));
    }) as Box<dyn FnMut(JsValue)>);
    js_sys::Reflect::set(&message, &"ack".into(), ack.as_ref())?;
    js_sys::Reflect::set(&message, &"retry".into(), retry.as_ref())?;
    js_sys::Reflect::set(
        &message,
        &"body".into(),
        &body["body"].serialize(&serde_wasm_bindgen::Serializer::json_compatible())?,
    )?;
    js_sys::Reflect::set(
        &message,
        &"attempts".into(),
        &(body["attempts"].as_f64().unwrap_or(1.0)).into(),
    )?;
    js_sys::Reflect::set(&message, &"id".into(), &"test-message".into())?;
    js_sys::Reflect::set(&message, &"timestamp".into(), &js_sys::Date::new_0())?;
    let messages = js_sys::Array::new();
    messages.push(&message);
    let batch = js_sys::Object::new();
    js_sys::Reflect::set(&batch, &"messages".into(), &messages)?;
    status_backend::notifications::consume_raw(batch.into(), env, ctx).await?;
    let result = dispositions.borrow().clone();
    Response::from_json(&result)
}

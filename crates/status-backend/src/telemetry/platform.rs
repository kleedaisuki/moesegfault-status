//! 原生 Workers binding；仅声明 JS API，不包含 TS 业务桥。
//! Native Workers bindings; JS API declarations only, with no TS business bridge.

use super::*;
use wasm_bindgen::{prelude::*, JsCast};

#[wasm_bindgen(module = "cloudflare:workers")]
extern "C" {
    /// 原生自动生命周期 span。 / Native automatically scoped span.
    #[wasm_bindgen(js_namespace = tracing, js_name = enterSpan, catch)]
    fn enter_span(name: &str, callback: &js_sys::Function) -> Result<JsValue, JsValue>;
}

/// 配置缺失 fail closed；仅无任何来源的 development 显式禁用。 / Fail closed for missing config; only development with no provenance is explicitly disabled.
pub fn for_invocation(env: &worker::Env) -> worker::Result<Option<Telemetry>> {
    for_service_invocation(env, "status")
}

/// 多服务复用相同遥测契约，服务名必须来自代码中的稳定目录名。 / Share telemetry across services; use a stable catalog name controlled by code.
pub fn for_service_invocation(
    env: &worker::Env,
    service: &str,
) -> worker::Result<Option<Telemetry>> {
    let get = |name| env.var(name).map(|v| v.to_string()).unwrap_or_default();
    let resource = Resource {
        service: service.into(),
        environment: get("ENVIRONMENT"),
        version: get("STATUS_VERSION"),
        deployment: get("DEPLOYMENT_ID"),
        revision: get("GIT_COMMIT"),
        digest: get("ARTIFACT_DIGEST"),
    };
    if resource.environment == "development"
        && resource.deployment.is_empty()
        && resource.revision.is_empty()
        && resource.digest.is_empty()
    {
        return Ok(None);
    }
    let dataset = env.analytics_engine("ANALYTICS").ok();
    let metrics: Sink = Rc::new(move |point| {
        let Some(dataset) = &dataset else {
            return false;
        };
        let Ok(value) = point.serialize(&serde_wasm_bindgen::Serializer::json_compatible()) else {
            return false;
        };
        let Ok(method) = js_sys::Reflect::get(dataset.as_ref(), &"writeDataPoint".into()) else {
            return false;
        };
        let Some(method) = method.dyn_ref::<js_sys::Function>() else {
            return false;
        };
        method.call1(dataset.as_ref(), &value).is_ok()
    });
    let logs: Sink = Rc::new(|record| {
        let Ok(value) = record.serialize(&serde_wasm_bindgen::Serializer::json_compatible()) else {
            return false;
        };
        let Ok(console) = js_sys::Reflect::get(&js_sys::global(), &"console".into()) else {
            return false;
        };
        let number = record["SeverityNumber"].as_i64().unwrap_or(9);
        let level = if number >= 17 {
            "error"
        } else if number >= 13 {
            "warn"
        } else {
            "log"
        };
        let Ok(method) = js_sys::Reflect::get(&console, &level.into()) else {
            return false;
        };
        let Some(method) = method.dyn_ref::<js_sys::Function>() else {
            return false;
        };
        method.call1(&console, &value).is_ok()
    });
    Telemetry::new(resource, metrics, logs)
        .map(Some)
        .map_err(|e| worker::Error::RustError(e.into()))
}

/// 原生异步 span 内执行拥有数据的 Future；保留 Rust 错误身份，不导出异常字符串。
/// Execute an owned Future inside a native async span; preserve Rust error identity without exporting exception strings.
///
/// ```ignore
/// let value = with_span("d1.query", json!({"operation.name":"d1.query"}), async move { db.all(&query).await }).await;
/// ```
pub async fn with_span<T: 'static, E: 'static>(
    name: &'static str,
    attributes: Value,
    future: impl Future<Output = Result<T, E>> + 'static,
) -> Result<T, E> {
    use std::cell::RefCell;
    let result = Rc::new(RefCell::new(None));
    let target = result.clone();
    let pending = Rc::new(RefCell::new(Some(future)));
    let run = pending.clone();
    let completion = Rc::new(RefCell::new(None));
    let completion_target = completion.clone();
    let safe = safe_attributes(&attributes);
    let callback = Closure::once_assert_unwind_safe(move |span: JsValue| -> js_sys::Promise {
        if let Some(attrs) = safe.as_object() {
            for (key, value) in attrs {
                set_attribute(&span, key, value);
            }
        }
        let future = run.borrow_mut().take();
        let promise = wasm_bindgen_futures::future_to_promise(async move {
            if let Some(future) = future {
                let value = future.await;
                let failed = value.is_err();
                if failed {
                    set_attribute(&span, "error.type", &json!("OperationFailed"));
                }
                *target.borrow_mut() = Some(value);
                if failed {
                    return Err(JsValue::from_str("operation_failed"));
                }
            }
            Ok(JsValue::UNDEFINED)
        });
        *completion_target.borrow_mut() = Some(promise.clone());
        promise
    });
    let entered = enter_span(name, callback.as_ref().unchecked_ref());
    if let Ok(promise) = entered {
        let _ = wasm_bindgen_futures::JsFuture::from(js_sys::Promise::resolve(&promise)).await;
    }
    // 平台在启动callback后抛错时仍等待同一操作，不panic或重复执行副作用。
    // If the platform throws after starting the callback, await that same operation without replaying effects.
    let completed = { completion.borrow_mut().take() };
    if let Some(promise) = completed {
        let _ = wasm_bindgen_futures::JsFuture::from(promise).await;
    }
    // API 失效前未启动的操作只运行一次；绝不重试已产生副作用的 Future。
    // Run once if the API failed before starting; never replay a Future with side effects.
    let future = { pending.borrow_mut().take() };
    if let Some(future) = future {
        return future.await;
    }
    let value = result
        .borrow_mut()
        .take()
        .expect("native span promise settles after its callback");
    value
}

/// 仅标量经已验证白名单进入 span。 / Only allowlisted scalars enter a span.
fn set_attribute(span: &JsValue, key: &str, value: &Value) {
    let Ok(method) = js_sys::Reflect::get(span, &"setAttribute".into()) else {
        return;
    };
    let Some(method) = method.dyn_ref::<js_sys::Function>() else {
        return;
    };
    let Ok(value) = serde_wasm_bindgen::to_value(value) else {
        return;
    };
    let _ = method.call2(span, &key.into(), &value);
}

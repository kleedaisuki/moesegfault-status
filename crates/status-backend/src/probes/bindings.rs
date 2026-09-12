//! 有限 RPC 能力与资源生命周期。 / Finite RPC capabilities and resource lifetimes.
use super::{
    model::{Probe, ProbeRequest},
    runtime::{iso, now, within, USER_AGENT},
};
use js_sys::{Function, Promise, Reflect};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::{future_to_promise, JsFuture};
use worker::{Env, Error, Result};

/// 严格配置拒绝额外能力。 / Strict configuration rejects extra capabilities.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Entry {
    /// 无副作用能力。 / Side-effect-free capability.
    Rpc {
        service_binding: String,
        operations: Vec<String>,
        timeout_ms: u32,
    },
    /// 隔离测试能力。 / Isolated testing capability.
    Synthetic {
        service_binding: String,
        scenarios: Vec<String>,
        test_subject: String,
        timeout_ms: u32,
    },
}
/// 协议响应只允许有限字段。 / Protocol responses allow only finite fields.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Response {
    schema_version: String,
    ok: bool,
    status: Option<String>,
    cleanup_completed: Option<bool>,
    test_subject: Option<String>,
}
/// 稳定策略错误不泄漏异常原文。 / Stable policy errors never leak raw exceptions.
fn policy(code: &str) -> Error {
    Error::RustError(format!("policy:{code}"))
}
/// 标识符精确匹配 ASCII 语法。 / Identifiers exactly match the ASCII grammar.
fn identifier(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.as_bytes()[0].is_ascii_alphabetic()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
}
/// 配置整体校验，不能忽略未选中的恶意条目。 / Validate all entries, not only the selected alias.
fn config(raw: &str) -> Result<BTreeMap<String, Entry>> {
    if raw.encode_utf16().count() > 65_536 {
        return Err(policy("probe_config_too_large"));
    }
    let entries: BTreeMap<String, Entry> =
        serde_json::from_str(raw).map_err(|_| policy("invalid_probe_config"))?;
    if entries.len() > 64 {
        return Err(policy("invalid_probe_config"));
    }
    for (alias, entry) in &entries {
        let (binding, allowed, timeout, subject) = match entry {
            Entry::Rpc {
                service_binding,
                operations,
                timeout_ms,
            } => (service_binding, operations, timeout_ms, None),
            Entry::Synthetic {
                service_binding,
                scenarios,
                timeout_ms,
                test_subject,
            } => (service_binding, scenarios, timeout_ms, Some(test_subject)),
        };
        let suffix = binding.strip_prefix("PROBE_SERVICE_").unwrap_or("");
        let valid_binding = !suffix.is_empty()
            && suffix.len() <= 96
            && suffix.as_bytes()[0].is_ascii_uppercase()
            && suffix
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_');
        if !identifier(alias)
            || !valid_binding
            || !(1..=30_000).contains(timeout)
            || allowed.is_empty()
            || allowed.len() > 64
            || !allowed.iter().all(|s| identifier(s))
            || subject.is_some_and(|s| !test_subject(s))
        {
            return Err(policy("invalid_probe_config"));
        }
    }
    Ok(entries)
}
/// 专用主体语法。 / Dedicated principal syntax.
fn test_subject(s: &str) -> bool {
    let s = s.strip_prefix("probe:").unwrap_or("");
    !s.is_empty()
        && s.len() <= 120
        && s.as_bytes()[0].is_ascii_alphanumeric()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
}
/// 尽力释放，不让清理异常掩盖原始状态。 / Best-effort disposal never masks the original status.
fn dispose(value: &JsValue) {
    if !value.is_object() && !value.is_function() {
        return;
    }
    let symbol = Reflect::get(&js_sys::global(), &"Symbol".into())
        .ok()
        .and_then(|symbol| Reflect::get(&symbol, &"dispose".into()).ok());
    let Some(symbol) = symbol.filter(|s| !s.is_undefined()) else {
        return;
    };
    if let Ok(close) = Reflect::get(value, &symbol) {
        if let Some(close) = close.dyn_ref::<Function>() {
            let _ = Reflect::apply(close, value, &js_sys::Array::new());
        }
    }
}
/// 调用句柄在所有退出路径释放。 / Invocation handles are disposed on every exit path.
struct Handle(JsValue);
impl Drop for Handle {
    fn drop(&mut self) {
        dispose(&self.0);
    }
}
/// 复制并校验纯数据，然后由调用者释放返回对象。 / Copy and validate data before caller disposes the result.
fn response(value: JsValue, subject: Option<&str>) -> Result<(bool, String)> {
    let code = if subject.is_some() {
        "invalid_synthetic_probe_response"
    } else {
        "invalid_rpc_probe_response"
    };
    let status = Reflect::get(&value, &"status".into()).map_err(|_| policy(code))?;
    if !status.is_undefined() && !status.is_string() {
        return Err(policy(code));
    }
    let parsed: Response =
        serde_wasm_bindgen::from_value(value.clone()).map_err(|_| policy(code))?;
    let keys = js_sys::Object::keys(&value.clone().unchecked_into::<js_sys::Object>());
    // serde-wasm-bindgen 按已知字段读取对象，不能依赖 deny_unknown_fields。 / serde-wasm-bindgen reads known object fields; enforce unknown-key rejection explicitly.
    let allowed: &[&str] = if subject.is_some() {
        &[
            "schema_version",
            "ok",
            "status",
            "cleanup_completed",
            "test_subject",
        ]
    } else {
        &["schema_version", "ok", "status"]
    };
    if keys.iter().any(|key| {
        key.as_string()
            .is_none_or(|key| !allowed.contains(&key.as_str()))
    }) || parsed.schema_version != "1.0"
        || parsed.status.as_ref().is_some_and(|s| !identifier(s))
    {
        return Err(policy(code));
    }
    if let Some(subject) = subject {
        if parsed.test_subject.as_deref() != Some(subject) || parsed.cleanup_completed.is_none() {
            return Err(policy(code));
        }
        if parsed.cleanup_completed == Some(false) {
            return Ok((false, "cleanup_failed".into()));
        }
    } else if Reflect::has(&value, &"test_subject".into()).unwrap_or(true)
        || Reflect::has(&value, &"cleanup_completed".into()).unwrap_or(true)
    {
        return Err(policy(code));
    }
    Ok((
        parsed.ok,
        parsed.status.unwrap_or_else(|| {
            if parsed.ok {
                "ok".into()
            } else {
                "failed".into()
            }
        }),
    ))
}
/// 固定方法和 this，截止时间取最小值；晚返回也释放。 / Fixed methods preserve this and minimum deadlines; late results are disposed.
pub async fn execute(
    env: &Env,
    spec: &Probe,
    request: &ProbeRequest,
    deadline: f64,
) -> Result<(bool, String)> {
    let raw = env
        .var("PROBE_BINDING_CONFIG")
        .map_err(|_| policy("invalid_probe_config"))?
        .to_string();
    let entries = config(&raw)?;
    let (alias, operation, synthetic) = match spec {
        Probe::Rpc { binding, operation } => (binding, operation, false),
        Probe::Synthetic { binding, scenario } => (binding, scenario, true),
        _ => return Err(policy("invalid_probe_kind")),
    };
    let (binding, allowed, timeout, subject) = match entries.get(alias) {
        Some(Entry::Rpc {
            service_binding,
            operations,
            timeout_ms,
        }) if !synthetic => (service_binding, operations, timeout_ms, None),
        Some(Entry::Synthetic {
            service_binding,
            scenarios,
            timeout_ms,
            test_subject,
        }) if synthetic => (
            service_binding,
            scenarios,
            timeout_ms,
            Some(test_subject.clone()),
        ),
        _ => return Err(policy("probe_service_binding_missing")),
    };
    if !allowed.contains(operation) {
        return Err(policy("probe_operation_not_allowed"));
    }
    let deadline = deadline.min(now() + f64::from(*timeout));
    if deadline <= now() {
        return Err(Error::RustError("deadline_exceeded".into()));
    }
    let receiver = Reflect::get(env.as_ref(), &JsValue::from_str(binding))
        .map_err(|_| policy("probe_service_binding_missing"))?;
    if !receiver.is_object() && !receiver.is_function() {
        return Err(policy("probe_service_binding_missing"));
    }
    let method = Reflect::get(
        &receiver,
        &JsValue::from_str(if synthetic { "run" } else { "probe" }),
    )
    .map_err(|_| policy("probe_service_method_missing"))?
    .dyn_into::<Function>()
    .map_err(|_| policy("probe_service_method_missing"))?;
    let mut data = serde_json::json!({"schema_version":"1.0", "correlation_id":request.correlation_id,
        "traceparent":request.traceparent, "user_agent":USER_AGENT, "deadline_at":iso(deadline)});
    data[if synthetic { "scenario" } else { "operation" }] = operation.clone().into();
    if let Some(subject) = &subject {
        data["test_subject"] = subject.clone().into();
    }
    let data = data
        .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(|_| policy("invalid_probe_request"))?;
    // RPC stub 的 .call 是远端属性，必须使用 Reflect.apply。 / RPC stub .call is a remote property; use Reflect.apply.
    let pending = Handle(
        Reflect::apply(&method, &receiver, &js_sys::Array::of1(&data))
            .map_err(|_| Error::RustError("probe_failed".into()))?,
    );
    let promise = Promise::resolve(&pending.0);
    // 此独立 future 不随本地等待超时取消。 / This independent future survives local wait cancellation.
    let completion = future_to_promise(async move {
        let result = match JsFuture::from(promise).await {
            Ok(value) => {
                let result = response(value.clone(), subject.as_deref());
                dispose(&value);
                result
            }
            Err(_) => Err(Error::RustError("probe_failed".into())),
        }
        .map_err(|error| match error {
            Error::RustError(s) => s,
            _ => "probe_failed".into(),
        });
        serde_wasm_bindgen::to_value(&result).map_err(|_| JsValue::from_str("probe_failed"))
    });
    let value = within(
        async {
            JsFuture::from(completion)
                .await
                .map_err(|_| Error::RustError("probe_failed".into()))
        },
        deadline,
    )
    .await?;
    let result: std::result::Result<(bool, String), String> =
        serde_wasm_bindgen::from_value(value).map_err(|_| policy("invalid_probe_response"))?;
    result.map_err(Error::RustError)
}

/// 注册时检查实际能力而不执行探测。 / Check actual capabilities during registration without invoking them.
pub(super) fn validate_configuration(env: &Env, spec: &Probe) -> Result<()> {
    let (alias, operation, synthetic) = match spec {
        Probe::Rpc { binding, operation } => (binding, operation, false),
        Probe::Synthetic { binding, scenario } => (binding, scenario, true),
        _ => return Ok(()),
    };
    let raw = env
        .var("PROBE_BINDING_CONFIG")
        .map_err(|_| policy("invalid_probe_config"))?
        .to_string();
    let entries = config(&raw)?;
    let (binding, allowed) = match entries.get(alias) {
        Some(Entry::Rpc {
            service_binding,
            operations,
            ..
        }) if !synthetic => (service_binding, operations),
        Some(Entry::Synthetic {
            service_binding,
            scenarios,
            ..
        }) if synthetic => (service_binding, scenarios),
        _ => return Err(policy("probe_service_binding_missing")),
    };
    if !allowed.contains(operation) {
        return Err(policy("probe_operation_not_allowed"));
    }
    let receiver = Reflect::get(env.as_ref(), &JsValue::from_str(binding))
        .map_err(|_| policy("probe_service_binding_missing"))?;
    if !receiver.is_object() && !receiver.is_function() {
        return Err(policy("probe_service_binding_missing"));
    }
    let method = Reflect::get(
        &receiver,
        &JsValue::from_str(if synthetic { "run" } else { "probe" }),
    )
    .map_err(|_| policy("probe_service_method_missing"))?;
    if !method.is_function() {
        return Err(policy("probe_service_method_missing"));
    }
    Ok(())
}

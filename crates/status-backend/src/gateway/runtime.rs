//! Workers 平台边界；没有公开 HTTP RPC 回退。
//! Workers platform boundary; no public HTTP RPC fallback.
use super::{configured_origin, expected_revision, resolve, RpcMethod, CONFIG};
use crate::{
    access::AccessTrust,
    auth::cloudflare::authenticate_access,
    http::{read_json, HttpError},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;
use worker::{Context, Env, Request, Response};

/// RPC 失败采用固定安全错误。 / RPC failures use a fixed safe error.
const RPC: HttpError = HttpError::new(
    502,
    "status-rpc-unavailable",
    "Status management service is unavailable",
);
/// RPC 响应损坏。 / Invalid RPC response.
const INVALID_RPC: HttpError = HttpError::new(
    502,
    "invalid-rpc-response",
    "Status management service returned an invalid response",
);
/// 无效命令。 / Invalid command.
const COMMAND: HttpError = HttpError::new(
    400,
    "invalid-command",
    "Administrative command does not match its contract",
);
/// 管理正文最大字节数。 / Maximum administrative body bytes.
const MAX_COMMAND_BYTES: usize = 32 * 1024;

/// 私有 typed 响应 envelope；拒绝同时出现 data/problem。 / Typed private response envelope; reject simultaneous data/problem.
#[derive(Deserialize)]
#[serde(untagged)]
enum RpcResult {
    /// 成功分支。 / Success branch.
    Data(DataResult),
    /// 业务拒绝。 / Business rejection.
    Problem(ProblemResult),
}
/// 精确成功结构。 / Exact success shape.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DataResult {
    /// 领域服务输出。 / Domain service output.
    data: Value,
}
/// 精确错误结构。 / Exact error shape.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProblemResult {
    /// 领域错误。 / Domain problem.
    problem: RpcProblem,
}
/// 只允许安全错误字段。 / Only safe problem fields are accepted.
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RpcProblem {
    /// 错误 URI。 / Problem URI.
    #[serde(rename = "type")]
    kind: String,
    /// 安全标题。 / Safe title.
    title: String,
    /// HTTP 状态。 / HTTP status.
    status: u16,
    /// 服务提供的路径，不直接返回。 / Service path, never reflected directly.
    #[serde(default)]
    instance: String,
    /// 关联身份必须匹配本次请求。 / Correlation must match this invocation.
    correlation_id: String,
    /// 可选安全详情。 / Optional safe detail.
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

/// 固定命名私有服务客户端。 / Fixed named private service client.
struct AdminRpcClient(js_sys::Object);
impl AdminRpcClient {
    /// 仅使用 STATUS Service Binding，绝不构造网络地址。 / Use only STATUS service binding, never construct a network URL.
    fn new(env: &Env) -> Result<Self, HttpError> {
        Ok(Self(env.service("STATUS").map_err(|_| RPC)?.into_rpc()))
    }
    /// 方法只由固定 enum 提供，序列化为普通 JS 对象。 / Method comes only from a fixed enum, serialized as plain JS objects.
    async fn call(&self, method: RpcMethod, input: &Value) -> Result<RpcResult, HttpError> {
        let function =
            js_sys::Reflect::get(&self.0, &JsValue::from_str(method.name())).map_err(|_| RPC)?;
        // RPC callable proxies lack Function.prototype; check typeof, not instanceof. / RPC 可调用代理没有 Function.prototype，使用 typeof 而非 instanceof。
        if !function.is_function() {
            return Err(RPC);
        }
        let function: js_sys::Function = function.unchecked_into();
        let argument = input
            .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
            .map_err(|_| COMMAND)?;
        // 平台 RpcPromise 是 thenable，不要求原生 Promise 品牌。 / Platform RpcPromise is a thenable, not necessarily a branded native Promise.
        // Reflect.apply 不访问 proxy.call 远端属性。 / Reflect.apply does not access the remote proxy.call property.
        let arguments = js_sys::Array::new();
        arguments.push(&argument);
        let promise = js_sys::Reflect::apply(&function, &self.0, &arguments).map_err(|_| RPC)?;
        let result = JsFuture::from(js_sys::Promise::resolve(&promise))
            .await
            .map_err(|_| RPC)?;
        let value: Value = serde_wasm_bindgen::from_value(result).map_err(|_| INVALID_RPC)?;
        serde_json::from_value(value).map_err(|_| INVALID_RPC)
    }
}

/// 完整运维 HTTP 边界。 / Complete administrative HTTP boundary.
///
/// 浏览器 mutation 必须带 Origin、JSON 与 X-MoeSegFault-CSRF: 1。
/// Browser mutations require Origin, JSON and X-MoeSegFault-CSRF: 1.
pub async fn handle(mut request: Request, env: Env, _ctx: Context) -> worker::Result<Response> {
    let correlation = crate::telemetry::create_correlation_id()?;
    let trace_context = crate::telemetry::TraceContext::child(None, None)?;
    let trace = trace_context.traceparent();
    let started = worker::Date::now().as_millis() as f64;
    let telemetry = crate::telemetry::for_service_invocation(&env, "ops-gateway");
    let path = request
        .url()
        .map(|u| u.path().chars().take(2048).collect::<String>())
        .unwrap_or_else(|_| "/".into());
    let result = if telemetry.is_err() {
        Err(CONFIG)
    } else {
        dispatch(
            &mut request,
            &env,
            &correlation,
            &trace,
            &path,
            telemetry.as_ref().ok().and_then(Option::as_ref),
            &trace_context,
        )
        .await
    };
    let mut response = match result {
        Ok(response) => response,
        Err(error) => response(
            &json!({"type":format!("https://ops.moesegfault.dev/problems/{}",error.code),"title":error.detail,"status":error.status,"instance":path,"correlation_id":correlation}),
            error.status,
            true,
            &correlation,
        )?,
    };
    response.headers_mut().set("traceparent", &trace)?;
    if let Ok(Some(telemetry)) = telemetry {
        telemetry.http(
            response.status_code(),
            started,
            &correlation,
            Some(&trace_context),
        );
        telemetry.report_drops();
    }
    Ok(response)
}

/// 先配置和认证，再做固定路由与正文读取。 / Configuration and authentication precede fixed routing and body reads.
async fn dispatch(
    request: &mut Request,
    env: &Env,
    correlation: &str,
    trace: &str,
    path: &str,
    telemetry: Option<&crate::telemetry::Telemetry>,
    trace_context: &crate::telemetry::TraceContext,
) -> Result<Response, HttpError> {
    let origin = configured_origin(&variable(env, "OPS_ORIGIN")?)?;
    let trust = AccessTrust::new(
        &variable(env, "ACCESS_ISSUER")?,
        &variable(env, "ACCESS_AUDIENCE")?,
        &variable(env, "ACCESS_MAX_TOKEN_AGE_SECONDS")?,
        &variable(env, "ACCESS_ROLE_MAPPING")?,
    )
    .map_err(|_| CONFIG)?;
    let url = request.url().map_err(|_| COMMAND)?;
    if !url.path().starts_with("/api/") || url.origin().ascii_serialization() != origin {
        return Err(HttpError::new(
            404,
            "route-not-found",
            "Administrative API route not found",
        ));
    }
    let denied = HttpError::new(
        401,
        "access-denied",
        "A valid Cloudflare Access session is required",
    );
    let token = header(request, "cf-access-jwt-assertion")?.ok_or_else(|| denied.clone())?;
    let principal = authenticate_access(&token, &trust)
        .await
        .map_err(|_| denied)?;
    if url.query().is_some() {
        return Err(HttpError::new(
            400,
            "unexpected-query",
            "Query parameters are not accepted",
        ));
    }
    let route = resolve(request.method().as_ref(), url.path())?;
    if !principal.has_role(route.role) {
        return Err(HttpError::new(
            403,
            "insufficient-role",
            "Administrative role is insufficient",
        ));
    }
    if route.method == RpcMethod::Session {
        return response(&json!({"data":principal}), 200, false, correlation).map_err(|_| RPC);
    }
    let mut input = json!({"principal":principal,"correlation_id":correlation,"trace_context":{"traceparent":trace}});
    if request.method() != worker::Method::Get {
        mutation_guards(request, &origin)?;
        let body: Value = read_json(request, MAX_COMMAND_BYTES).await?;
        if !body.is_object() {
            return Err(COMMAND);
        }
        if route.body.is_empty() {
            // 仅允许明确的小型业务字段，不让浏览器覆盖认证上下文。 / Only explicit small-command fields, never caller-supplied authentication context.
            let allowed = if route.method == RpcMethod::AcknowledgeIssue {
                &["command_id"][..]
            } else {
                &["command_id", "reason", "until"][..]
            };
            let object = body.as_object().ok_or(COMMAND)?;
            if object.keys().any(|k| !allowed.contains(&k.as_str())) {
                return Err(COMMAND);
            }
            for (key, value) in object {
                input[key] = value.clone();
            }
        } else {
            input[route.body] = body;
        }
    }
    if let Some((key, id)) = route.identity {
        input[key] = json!(id);
    }
    if route.revision {
        input["expected_revision"] =
            json!(expected_revision(header(request, "if-match")?.as_deref())?);
    }
    let client = AdminRpcClient::new(env)?;
    let method = route.method;
    let result = crate::telemetry::with_span(
        "gateway.private_rpc",
        telemetry
            .map(|t| t.span_attributes(method.name(), Some(correlation), Some(trace_context)))
            .unwrap_or_else(|| json!({"operation.name": method.name()})),
        async move { client.call(method, &input).await },
    )
    .await?;
    match result {
        RpcResult::Data(data) => {
            let mut result = response(&json!({"data":data.data}), route.status, false, correlation)
                .map_err(|_| RPC)?;
            if let Some(revision) = data
                .data
                .get("revision")
                .and_then(Value::as_u64)
                .filter(|r| *r > 0 && *r <= 9_007_199_254_740_991)
            {
                result
                    .headers_mut()
                    .set("etag", &format!("\"{revision}\""))
                    .map_err(|_| RPC)?;
            }
            Ok(result)
        }
        RpcResult::Problem(mut result) => {
            let p = &mut result.problem;
            if p.correlation_id != correlation
                || !(400..=599).contains(&p.status)
                || p.title.is_empty()
                || p.title.len() > 512
                || p.kind.len() > 2048
                || url::Url::parse(&p.kind).is_err()
                || p.detail.as_ref().is_some_and(|d| d.len() > 4096)
            {
                return Err(INVALID_RPC);
            }
            p.instance = path.into();
            response(&json!(p), p.status, true, correlation).map_err(|_| RPC)
        }
    }
}

/// 同源与非简单请求头双重防护，不提供 CORS 许可。 / Same-origin plus non-simple-header protection, with no CORS permission.
fn mutation_guards(request: &Request, origin: &str) -> Result<(), HttpError> {
    if header(request, "origin")?.as_deref() != Some(origin)
        || header(request, "sec-fetch-site")?.is_some_and(|s| s != "same-origin")
    {
        return Err(HttpError::new(
            403,
            "cross-origin-request",
            "Cross-origin request rejected",
        ));
    }
    if header(request, "x-moesegfault-csrf")?.as_deref() != Some("1") {
        return Err(HttpError::new(
            403,
            "csrf-check-failed",
            "CSRF check failed",
        ));
    }
    if header(request, "content-encoding")?.is_some_and(|s| !s.eq_ignore_ascii_case("identity")) {
        return Err(HttpError::new(
            415,
            "unsupported-content-encoding",
            "Compressed command bodies are not accepted",
        ));
    }
    Ok(())
}
/// 有界配置读取失败关闭。 / Configuration lookup fails closed.
fn variable(env: &Env, key: &str) -> Result<String, HttpError> {
    env.var(key).map(|v| v.to_string()).map_err(|_| CONFIG)
}
/// 请求头读取错误不泄漏平台错误。 / Header failures do not expose platform errors.
fn header(request: &Request, key: &str) -> Result<Option<String>, HttpError> {
    request.headers().get(key).map_err(|_| COMMAND)
}
/// 统一安全响应头。 / Uniform security response headers.
fn response(
    body: &Value,
    status: u16,
    problem: bool,
    correlation: &str,
) -> worker::Result<Response> {
    let mut response = Response::from_json(body)?.with_status(status);
    for (key, value) in [
        ("cache-control", "no-store"),
        (
            "content-type",
            if problem {
                "application/problem+json; charset=utf-8"
            } else {
                "application/json; charset=utf-8"
            },
        ),
        ("cross-origin-resource-policy", "same-origin"),
        ("referrer-policy", "no-referrer"),
        ("x-content-type-options", "nosniff"),
        ("x-moesegfault-correlation-id", correlation),
    ] {
        response.headers_mut().set(key, value)?;
    }
    Ok(response)
}

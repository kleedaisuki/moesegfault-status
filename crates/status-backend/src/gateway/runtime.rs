//! Workers 平台边界；没有公开 HTTP RPC 回退。
//! Workers platform boundary; no public HTTP RPC fallback.
use super::{configured_origin, expected_revision, resolve, RpcMethod, CONFIG};
use crate::http::{read_json, HttpError};
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
    let url = request.url().map_err(|_| COMMAND)?;
    if !url.path().starts_with("/api/") || url.origin().ascii_serialization() != origin {
        return Err(HttpError::new(
            404,
            "route-not-found",
            "Administrative API route not found",
        ));
    }
    if url.query().is_some() {
        return Err(HttpError::new(
            400,
            "unexpected-query",
            "Query parameters are not accepted",
        ));
    }
    let client = AdminRpcClient::new(env)?;
    if url.path().starts_with("/api/auth/") {
        return authentication(request, &client, &origin, correlation).await;
    }
    let route = resolve(request.method().as_ref(), url.path())?;
    let principal = authenticate(request, &client, correlation).await?;
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

/// 不透明会话 cookie；拒绝重复值以消除解析器分歧。 / Opaque session cookie; reject duplicates to eliminate parser disagreement.
fn session_token(request: &Request) -> Result<String, HttpError> {
    let cookies = header(request, "cookie")?.ok_or(DENIED)?;
    if cookies.len() > 8192 {
        return Err(DENIED);
    }
    let mut found = None;
    for pair in cookies.split(';') {
        let Some((name, value)) = pair.trim().split_once('=') else {
            continue;
        };
        if name != "__Host-moe_session" {
            continue;
        }
        if found.is_some() || !valid_token(value) {
            return Err(DENIED);
        }
        found = Some(value.to_owned());
    }
    found.ok_or(DENIED)
}
/// 固定会话拒绝，不区分密码、账户或失效原因。 / Uniform denial does not distinguish password, account or expiry causes.
const DENIED: HttpError = HttpError::new(
    401,
    "authentication-required",
    "Administrator authentication is required",
);
/// 256 位随机值的无填充 base64url 编码。 / Unpadded base64url encoding of a 256-bit random value.
fn valid_token(value: &str) -> bool {
    value.len() == 43
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
/// 可信身份形状；浏览器不提供任何身份字段。 / Trusted principal shape; the browser supplies no identity fields.
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Principal {
    /// 唯一主体。 / Sole subject.
    subject: String,
    /// 管理员联系地址。 / Administrator contact address.
    email: crate::wire::Text<1, 320>,
    /// 固定管理员权限。 / Fixed administrator permission.
    roles: Vec<String>,
    /// 原始登录时间。 / Original login timestamp.
    authenticated_at: crate::wire::UtcTime,
    /// 会话认证机制。 / Session authentication mechanism.
    access_application: String,
}
/// 精确认证响应。 / Exact authentication response.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Authentication {
    /// 仅接受服务端身份。 / Accept only service-produced identity.
    principal: Principal,
}
/// 精确登录响应，token 只能进入 Cookie。 / Exact login response; token may only enter a cookie.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Login {
    /// 敏感会话凭据。 / Sensitive session credential.
    session_token: String,
    /// 服务端绝对到期时间。 / Server absolute expiry.
    expires_at: crate::wire::UtcTime,
    /// 服务端身份。 / Server identity.
    principal: Principal,
}
/// 校验固定单管理员能力。 / Validate the fixed single-administrator capability.
fn principal(value: Principal) -> Result<Principal, HttpError> {
    if value.subject != "single-admin"
        || value.roles != ["admin"]
        || value.access_application != "single-admin-password"
    {
        return Err(INVALID_RPC);
    }
    Ok(value)
}
/// 验证安全 RPC 错误，不反射任意正文。 / Validate a safe RPC problem without reflecting arbitrary bodies.
fn auth_data(result: RpcResult, correlation: &str) -> Result<Value, HttpError> {
    match result {
        RpcResult::Data(data) => Ok(data.data),
        RpcResult::Problem(result) => {
            let p = result.problem;
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
            match p.status {
                401 | 403 => Err(DENIED),
                429 => Err(HttpError::new(
                    429,
                    "authentication-rate-limited",
                    "Too many authentication attempts; try again later",
                )),
                400 => Err(COMMAND),
                _ => Err(RPC),
            }
        }
    }
}
/// 每次业务调用都重新验证会话，不缓存撤销状态。 / Revalidate each business request; never cache revocation state.
async fn authenticate(
    request: &Request,
    client: &AdminRpcClient,
    correlation: &str,
) -> Result<Principal, HttpError> {
    let input = json!({"session_token":session_token(request)?,"correlation_id":correlation});
    let data = auth_data(
        client
            .call(RpcMethod::AuthenticateAdministrator, &input)
            .await?,
        correlation,
    )?;
    let data: Authentication = serde_json::from_value(data).map_err(|_| INVALID_RPC)?;
    principal(data.principal)
}
/// 两个固定表单端点，共享同源、正文限制和严格字段集合。 / Two fixed form endpoints share origin, body limits and exact field sets.
async fn authentication(
    request: &mut Request,
    client: &AdminRpcClient,
    origin: &str,
    correlation: &str,
) -> Result<Response, HttpError> {
    let path = request.url().map_err(|_| COMMAND)?.path().to_owned();
    let (method, fields) = match path.as_str() {
        "/api/auth/login" => (RpcMethod::LoginAdministrator, &["password"][..]),
        "/api/auth/logout" => (RpcMethod::LogoutAdministrator, &[][..]),
        _ => {
            return Err(HttpError::new(
                404,
                "route-not-found",
                "Administrative API route not found",
            ))
        }
    };
    if request.method() != worker::Method::Post {
        return Err(HttpError::new(
            405,
            "method-not-allowed",
            "Method not allowed",
        ));
    }
    mutation_guards(request, origin)?;
    let mut input: Value = read_json(request, 8192).await?;
    let object = input.as_object().ok_or(COMMAND)?;
    if object.len() != fields.len()
        || fields
            .iter()
            .any(|field| !object.get(*field).is_some_and(Value::is_string))
    {
        return Err(COMMAND);
    }
    input["correlation_id"] = json!(correlation);
    if method == RpcMethod::LogoutAdministrator {
        input["session_token"] = json!(session_token(request)?);
    }
    let data = auth_data(client.call(method, &input).await?, correlation)?;
    let mut cookie = None;
    let body = if method == RpcMethod::LoginAdministrator {
        let data: Login = serde_json::from_value(data).map_err(|_| INVALID_RPC)?;
        if !valid_token(&data.session_token) {
            return Err(INVALID_RPC);
        }
        let identity = principal(data.principal)?;
        cookie = Some(format!(
            "__Host-moe_session={}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200",
            data.session_token
        ));
        json!({"data":{"principal":identity,"expires_at":data.expires_at}})
    } else {
        if data != json!({"ok":true}) {
            return Err(INVALID_RPC);
        }
        if method == RpcMethod::LogoutAdministrator {
            cookie = Some(
                "__Host-moe_session=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0".into(),
            );
        }
        json!({"data":{"ok":true}})
    };
    let mut result = response(&body, 200, false, correlation).map_err(|_| RPC)?;
    if let Some(cookie) = cookie {
        result
            .headers_mut()
            .set("set-cookie", &cookie)
            .map_err(|_| RPC)?;
    }
    Ok(result)
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

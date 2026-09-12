//! 有界 I/O 和真实网络探针。 / Bounded I/O and real network probes.
use super::{
    model::{HttpMethod, Probe, ProbeRequest, RecordType},
    security::{self, TargetPolicy},
};
use futures_util::future::{select, Either};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{future::Future, time::Duration};
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;
use worker::{
    Context, Env, Error, Fetch, Method, Request, RequestInit, RequestRedirect, Response, Result,
};

pub(super) const USER_AGENT: &str = "moesegfault-status-probe/1.0";
/// 平台时钟毫秒。 / Platform wall clock milliseconds.
pub(super) fn now() -> f64 {
    js_sys::Date::now()
}
/// RFC3339 毫秒时间。 / RFC3339 millisecond time.
pub(super) fn iso(ms: f64) -> String {
    js_sys::Date::new(&JsValue::from_f64(ms))
        .to_iso_string()
        .into()
}
/// 丢弃执行 future 也取消请求。 / Dropping the execution future also aborts fetch.
struct FetchGuard(Option<worker::AbortController>);
impl Drop for FetchGuard {
    fn drop(&mut self) {
        if let Some(c) = self.0.take() {
            c.abort();
        }
    }
}
/// 取消路径立即启动 socket 关闭，不留下连接。 / Cancellation immediately starts socket close.
struct SocketGuard(Option<worker::Socket>);
impl Drop for SocketGuard {
    fn drop(&mut self) {
        if let Some(mut socket) = self.0.take() {
            wasm_bindgen_futures::spawn_local(async move {
                let _ = within(socket.close(), now() + 1000.0).await;
            });
        }
    }
}
fn err(code: &str) -> Error {
    Error::RustError(code.into())
}
fn policy(code: &str) -> Error {
    err(&format!("policy:{code}"))
}
/// 无论远端是否遵守取消，均有界等待。 / Bound waiting even when a remote ignores cancellation.
pub(super) async fn within<T>(future: impl Future<Output = Result<T>>, deadline: f64) -> Result<T> {
    if now() >= deadline {
        return Err(err("deadline_exceeded"));
    }
    let timer = worker::Delay::from(Duration::from_millis((deadline - now()).max(1.0) as u64));
    match select(Box::pin(future), Box::pin(timer)).await {
        Either::Left((result, _)) => result,
        Either::Right(_) => Err(err("deadline_exceeded")),
    }
}
/// Future 取消时仍释放 reader。 / Release readers even when their future is cancelled.
struct ReaderGuard(web_sys::ReadableStreamDefaultReader);
impl Drop for ReaderGuard {
    fn drop(&mut self) {
        let promise = self.0.cancel();
        self.0.release_lock();
        wasm_bindgen_futures::spawn_local(async move {
            let _ = within(async { Ok(JsFuture::from(promise).await?) }, now() + 100.0).await;
        });
    }
}
/// 平台事件代替轮询，作用域结束移除监听器。 / Platform events replace polling and listeners are removed on scope exit.
struct AbortWait {
    signal: web_sys::AbortSignal,
    callback: wasm_bindgen::closure::Closure<dyn FnMut()>,
    promise: js_sys::Promise,
}
impl AbortWait {
    fn new(signal: web_sys::AbortSignal) -> Result<Self> {
        let mut callback = None;
        let promise = js_sys::Promise::new(&mut |resolve, _reject| {
            callback = Some(wasm_bindgen::closure::Closure::wrap(Box::new(move || {
                let _ = resolve.call0(&JsValue::UNDEFINED);
            })
                as Box<dyn FnMut()>));
        });
        let callback = callback.ok_or_else(|| err("abort_listener"))?;
        signal.add_event_listener_with_callback("abort", callback.as_ref().unchecked_ref())?;
        if signal.aborted() {
            let function: &js_sys::Function = callback.as_ref().unchecked_ref();
            function.call0(&JsValue::UNDEFINED)?;
        }
        Ok(Self {
            signal,
            callback,
            promise,
        })
    }
}
impl Drop for AbortWait {
    fn drop(&mut self) {
        let _ = self
            .signal
            .remove_event_listener_with_callback("abort", self.callback.as_ref().unchecked_ref());
    }
}
/// 每条路径取消流并释放 reader；不信任 Content-Length。 / Cancel streams and release readers on every path, without trusting Content-Length.
async fn read_stream(stream: web_sys::ReadableStream, deadline: f64) -> Result<Value> {
    let reader: web_sys::ReadableStreamDefaultReader = stream
        .get_reader()
        .dyn_into()
        .map_err(|_| err("reader_invalid"))?;
    let guard = ReaderGuard(reader);
    let reader = &guard.0;
    let result = async {
        let mut bytes = Vec::new();
        loop {
            let part = within(async { Ok(JsFuture::from(reader.read()).await?) }, deadline).await?;
            if js_sys::Reflect::get(&part, &"done".into())?.as_bool() == Some(true) {
                break;
            }
            let chunk = js_sys::Uint8Array::new(&js_sys::Reflect::get(&part, &"value".into())?);
            if bytes.len() + chunk.length() as usize > 16384 {
                return Err(err("body_limit"));
            }
            bytes.extend(chunk.to_vec());
        }
        serde_json::from_slice(&bytes).map_err(Error::from)
    }
    .await;
    // 取消调用立即发生，等待也有界。 / Cancellation starts immediately and its wait is bounded.
    let _ = within(
        async { Ok(JsFuture::from(reader.cancel()).await?) },
        now() + 100.0,
    )
    .await;
    drop(guard);
    result
}
/// 有界 JSON 响应供区域分派复用。 / Bounded JSON responses shared with regional dispatch.
pub(super) async fn bounded_json(response: Response, deadline: f64) -> Result<Value> {
    match response.body() {
        worker::ResponseBody::Stream(stream) => read_stream(stream.clone(), deadline).await,
        worker::ResponseBody::Body(bytes) if bytes.len() <= 16384 => {
            Ok(serde_json::from_slice(bytes)?)
        }
        _ => Err(err("body_invalid")),
    }
}
pub(super) async fn cancel(response: &Response) {
    if let worker::ResponseBody::Stream(stream) = response.body() {
        let _ = within(
            async { Ok(JsFuture::from(stream.cancel()).await?) },
            now() + 100.0,
        )
        .await;
    }
}
/// Fetch 超时主动 abort，响应体在调用方显式释放。 / Abort timed-out fetches; callers explicitly release response bodies.
async fn fetch(request: Request, deadline: f64) -> Result<Response> {
    let mut controller = FetchGuard(Some(worker::AbortController::default()));
    let signal = controller.0.as_ref().unwrap().signal();
    let result = within(Fetch::Request(request).send_with_signal(&signal), deadline).await;
    if result.is_ok() {
        controller.0.take();
    }
    result
}
async fn resolve(host: &str, record: RecordType, deadline: f64) -> Result<Vec<String>> {
    let typ = match record {
        RecordType::A => "A",
        RecordType::AAAA => "AAAA",
    };
    let mut url =
        url::Url::parse("https://cloudflare-dns.com/dns-query").map_err(|_| err("resolver_url"))?;
    url.query_pairs_mut()
        .append_pair("name", host)
        .append_pair("type", typ);
    let mut init = RequestInit::new();
    init.headers.set("accept", "application/dns-json")?;
    init.redirect = RequestRedirect::Manual;
    let response = fetch(Request::new_with_init(url.as_str(), &init)?, deadline).await?;
    if response.status_code() != 200 {
        cancel(&response).await;
        return Err(err("dns_transport"));
    }
    let body = bounded_json(response, deadline).await?;
    if body["Status"].as_u64() != Some(0) {
        return Err(err("dns_error"));
    }
    let answers = body.get("Answer").and_then(Value::as_array);
    let mut addresses = Vec::new();
    for answer in answers.into_iter().flatten() {
        let expected = if typ == "A" { 1 } else { 28 };
        if answer["type"].as_u64() == Some(expected) {
            let address = answer["data"].as_str().ok_or_else(|| err("dns_invalid"))?;
            addresses.push(address.to_string());
        }
    }
    Ok(addresses)
}
async fn addresses(host: &str, deadline: f64) -> Result<Vec<String>> {
    if host.parse::<std::net::IpAddr>().is_ok() {
        return Ok(vec![host.into()]);
    }
    let mut addresses = resolve(host, RecordType::A, deadline).await?;
    addresses.extend(resolve(host, RecordType::AAAA, deadline).await?);
    security::assert_public_addresses(&addresses).map_err(policy)?;
    Ok(addresses)
}
async fn http(
    spec: &Probe,
    request: &ProbeRequest,
    policy_config: &TargetPolicy,
    deadline: f64,
) -> Result<(bool, String)> {
    let Probe::Http {
        url,
        method,
        expected_statuses,
        max_redirects,
    } = spec
    else {
        unreachable!()
    };
    let mut url = security::validate_http_url(url, policy_config).map_err(policy)?;
    for redirects in 0..=*max_redirects {
        let host = url
            .host_str()
            .ok_or_else(|| policy("invalid_hostname"))?
            .trim_matches(['[', ']']);
        addresses(host, deadline).await?;
        let mut init = RequestInit::new();
        init.method = match method {
            HttpMethod::GET => Method::Get,
            HttpMethod::HEAD => Method::Head,
        };
        init.redirect = RequestRedirect::Manual;
        init.cache = Some(worker::CacheMode::NoStore);
        init.headers.set("user-agent", USER_AGENT)?;
        init.headers.set("cache-control", "no-store")?;
        init.headers.set("traceparent", &request.traceparent)?;
        init.headers
            .set("x-moesegfault-correlation-id", &request.correlation_id)?;
        let response = fetch(Request::new_with_init(url.as_str(), &init)?, deadline).await?;
        let status = response.status_code();
        let location = response.headers().get("location")?;
        cancel(&response).await;
        if (300..400).contains(&status) && location.is_some() {
            if redirects == *max_redirects {
                return Ok((false, "redirect_limit".into()));
            }
            let next = url
                .join(location.as_deref().unwrap_or_default())
                .map_err(|_| policy("invalid_redirect"))?;
            url = security::validate_http_url(next.as_str(), policy_config).map_err(policy)?;
            continue;
        }
        let ok = if expected_statuses.is_empty() {
            (200..400).contains(&status)
        } else {
            expected_statuses.contains(&status)
        };
        return Ok((ok, format!("http_{status}")));
    }
    Err(err("redirect_limit"))
}
async fn execute(
    env: &Env,
    request: &ProbeRequest,
    policy_config: &TargetPolicy,
    deadline: f64,
) -> Result<(bool, String)> {
    match &request.probe {
        Probe::Http { .. } => http(&request.probe, request, policy_config, deadline).await,
        Probe::Tcp { hostname, port } => {
            let host =
                security::validate_tcp_target(hostname, *port, policy_config).map_err(policy)?;
            let ips = addresses(&host, deadline).await?;
            // 连接已验证的 IP，避免 TCP DNS 重绑定。 / Pin a validated IP to avoid TCP DNS rebinding.
            let mut guard = SocketGuard(Some(
                worker::Socket::builder().connect(ips[0].clone(), *port)?,
            ));
            let socket = guard.0.as_mut().unwrap();
            let result = within(socket.opened(), deadline).await;
            let closed = within(socket.close(), now() + 1000.0).await;
            guard.0.take();
            result?;
            closed?;
            Ok((true, "connected".into()))
        }
        Probe::Dns {
            hostname,
            record_type,
        } => {
            let host =
                security::assert_allowed_hostname(hostname, policy_config).map_err(policy)?;
            addresses(&host, deadline).await?;
            let answers = resolve(&host, *record_type, deadline).await?;
            if !answers.is_empty() {
                security::assert_public_addresses(&answers).map_err(policy)?;
            }
            Ok((
                !answers.is_empty(),
                if answers.is_empty() {
                    "no_answer"
                } else {
                    "dns_answer"
                }
                .into(),
            ))
        }
        Probe::Rpc { .. } | Probe::Synthetic { .. } => {
            super::bindings::execute(env, &request.probe, request, deadline).await
        }
    }
}
fn observation_id(request: &ProbeRequest) -> String {
    let seed = format!(
        "{}:{}:{}:{}:observation",
        request.executor_id, request.run_id, request.monitor_id, request.correlation_id
    );
    let mut bytes: [u8; 32] = Sha256::digest(seed.as_bytes()).into();
    let time = request.scheduled_ms().unwrap_or_default().max(0) as u64;
    bytes[..6].copy_from_slice(&time.to_be_bytes()[2..]);
    bytes[6] = (bytes[6] & 15) | 112;
    bytes[8] = (bytes[8] & 63) | 128;
    let hex: String = bytes[..16].iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}
/// 仅私有默认 fetch；cf-placement 必须由平台注入。 / Private default fetch only; the platform must supply cf-placement.
pub async fn handle(request: Request, env: Env, _ctx: Context) -> Result<Response> {
    crate::telemetry::with_span(
        "probe.execute",
        json!({"operation.name":"probe.execute"}),
        async move { handle_inner(request, env).await },
    )
    .await
}
/// 验证入口后执行单次探针。 / Execute one probe after validating the private entrypoint.
async fn handle_inner(request: Request, env: Env) -> Result<Response> {
    if request.method() != Method::Post || request.path() != "/probe" {
        return Response::empty().map(|r| r.with_status(404));
    }
    let placement = request.headers().get("cf-placement")?.unwrap_or_default();
    let colo = placement
        .strip_prefix("remote-")
        .or_else(|| placement.strip_prefix("local-"));
    let Some(colo) = colo.filter(|v| v.len() == 3 && v.bytes().all(|b| b.is_ascii_uppercase()))
    else {
        return Response::error("placement_unavailable", 503);
    };
    let raw = request.inner();
    let Some(stream) = raw.body() else {
        return Response::error("invalid_request", 400);
    };
    let value = match read_stream(stream, now() + 2000.0).await {
        Ok(v) => v,
        Err(_) => return Response::error("invalid_request", 400),
    };
    let body: ProbeRequest = match serde_json::from_value(value) {
        Ok(v) => v,
        Err(_) => return Response::error("invalid_request", 400),
    };
    if body.validate().is_err() {
        return Response::error("invalid_request", 400);
    }
    let kinds: Vec<String> = serde_json::from_str(&env.var("EXECUTOR_ALLOWED_KINDS")?.to_string())?;
    if body.executor_id != env.var("EXECUTOR_ID")?.to_string()
        || body.location != env.var("EXECUTOR_LOCATION")?.to_string()
        || !kinds.iter().any(|k| k == body.probe.kind())
    {
        return Response::error("identity_mismatch", 403);
    }
    let telemetry = crate::telemetry::for_service_invocation(&env, "probe-executor")?;
    let started = now();
    let remaining = body.deadline_ms().map_err(policy)? as f64 - started;
    if remaining <= 0.0 || remaining > 302000.0 {
        return Response::error("deadline_invalid", 408);
    }
    let policy_config = TargetPolicy {
        allowed_hostnames: serde_json::from_str(&env.var("PROBE_ALLOWED_HOSTS")?.to_string())?,
        allowed_tcp_ports: serde_json::from_str(&env.var("PROBE_ALLOWED_TCP_PORTS")?.to_string())?,
    };
    let deadline = started + remaining.min(body.timeout_ms as f64);
    let abort = AbortWait::new(raw.signal())?;
    let cancelled = async {
        let _ = JsFuture::from(abort.promise.clone()).await;
        Err(err("deadline_exceeded"))
    };
    let execution = execute(&env, &body, &policy_config, deadline);
    let result = match select(Box::pin(execution), Box::pin(cancelled)).await {
        Either::Left((result, _)) => result,
        Either::Right((result, _)) => result,
    };
    let (outcome, status, error) = match result {
        Ok((ok, status)) => (
            if ok { "success" } else { "failure" },
            Some(status),
            if ok {
                None
            } else {
                Some("unexpected_result".to_string())
            },
        ),
        Err(e) => {
            let code = e.to_string();
            if code.contains("deadline_exceeded") || now() >= deadline {
                ("timeout", None, Some("deadline_exceeded".into()))
            } else if let Some(code) = code.strip_prefix("policy:") {
                ("invalid", None, Some(code.into()))
            } else {
                ("failure", None, Some("probe_error".into()))
            }
        }
    };
    let response = json!({"version":"1","executor_id":body.executor_id,"location":body.location,"run_id":body.run_id,"scheduled_for":body.scheduled_for,"actual_colo":colo,"observation":{"observationId":observation_id(&body),"monitorId":body.monitor_id,"observedAt":iso(now()),"outcome":outcome,"latencyMs":(now()-started).clamp(0.0,300000.0),"protocolStatus":status,"errorType":error,"correlationId":body.correlation_id}});
    if let Some(telemetry) = telemetry {
        let trace = crate::telemetry::TraceContext::parse(&body.traceparent);
        telemetry.event(
            "probe.executor.completed",
            outcome != "success",
            json!({"operation.name":"probe.execute","http.response.status_code":200}),
            Some(&body.correlation_id),
            trace.as_ref(),
        );
        telemetry.metric(
            "probe.execute.duration",
            (now() - started).max(0.0),
            "probe.execute",
            true,
        );
        telemetry.metric("probe.execute.count", 1.0, "probe.execute", false);
    }
    let mut response = Response::from_json(&response)?;
    response.headers_mut().set("cache-control", "no-store")?;
    Ok(response)
}

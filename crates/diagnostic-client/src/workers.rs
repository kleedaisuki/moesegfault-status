//! Workers原生HTTP传输；凭据每次获取，deadline覆盖认证与正文。
//! Native Workers HTTP transport; credentials are fetched per attempt and deadlines cover authorization and bodies.
use crate::{
    builder::PreparedDiagnostic,
    publisher::{permanent_status, Attempt, Transport},
};
use futures_util::{
    future::{select, Either, LocalBoxFuture},
    pin_mut, FutureExt,
};
use serde_json::Value;
use std::{rc::Rc, time::Duration};
use url::Url;
use worker::{AbortController, Delay, Fetch, Method, Request, RequestInit, RequestRedirect};
/// 返回当次Authorization值的异步提供者；错误不含秘密。 / Asynchronous per-attempt Authorization provider with secret-free failures.
pub type Authorization = Rc<dyn Fn() -> LocalBoxFuture<'static, Result<String, ()>>>;
/// 对Workers Fetch的真实适配，不包含JavaScript业务桥。 / Real Workers Fetch adapter without a JavaScript business bridge.
pub struct WorkersTransport {
    authorization: Authorization,
}
impl WorkersTransport {
    /// 提供者每次尝试调用；客户端不缓存返回的token。 / Invoke the provider for every attempt; never cache returned tokens.
    pub fn new(authorization: Authorization) -> Self {
        Self { authorization }
    }
}
/// Future被取消也立即中止网络。 / Abort the network even when the future is cancelled.
struct AbortOnDrop(Option<AbortController>);
impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        if let Some(controller) = self.0.take() {
            controller.abort();
        }
    }
}
impl Transport for WorkersTransport {
    fn now_millis(&self) -> u64 {
        worker::Date::now().as_millis()
    }
    fn sleep(&self, millis: u64) -> LocalBoxFuture<'static, ()> {
        async move { Delay::from(Duration::from_millis(millis)).await }.boxed_local()
    }
    fn attempt(
        &self,
        endpoint: Url,
        event: PreparedDiagnostic,
        timeout_ms: u64,
    ) -> LocalBoxFuture<'static, Attempt> {
        let authorization = self.authorization.clone();
        async move {
            let controller = AbortController::default();
            let signal = controller.signal();
            let _abort = AbortOnDrop(Some(controller));
            let transport = async {
                let token = authorization().await.map_err(|_| ())?;
                if token.is_empty() || token.len() > 8192 || token.contains(['\r', '\n']) {
                    return Err(());
                }
                let mut init = RequestInit::new();
                init.with_method(Method::Post);
                init.with_redirect(RequestRedirect::Manual);
                init.headers.set("authorization", &token).map_err(|_| ())?;
                init.headers
                    .set("content-type", "application/json")
                    .map_err(|_| ())?;
                init.headers
                    .set("x-moesegfault-correlation-id", event.correlation_id())
                    .map_err(|_| ())?;
                init.headers
                    .set("traceparent", event.propagation().traceparent())
                    .map_err(|_| ())?;
                if let Some(state) = event.propagation().tracestate() {
                    init.headers.set("tracestate", state).map_err(|_| ())?;
                }
                init.with_body(Some(js_sys::Uint8Array::from(event.bytes()).into()));
                let request = Request::new_with_init(endpoint.as_str(), &init).map_err(|_| ())?;
                let mut response = Fetch::Request(request)
                    .send_with_signal(&signal)
                    .await
                    .map_err(|_| ())?;
                let status = response.status_code();
                if status != 202 {
                    return Ok(if permanent_status(status) {
                        Attempt::Rejected
                    } else {
                        Attempt::Retry
                    });
                }
                let stream = response.stream().map_err(|_| ())?;
                let receipt: Value = status_backend::http::read_json_stream(stream, 4096)
                    .await
                    .map_err(|_| ())?;
                let matching = receipt.as_object().is_some_and(|o| {
                    o.len() == 2
                        && receipt["accepted"] == true
                        && receipt["event_id"] == event.event().event_id
                });
                Ok(if matching {
                    Attempt::Accepted
                } else {
                    Attempt::Retry
                })
            };
            let timeout = Delay::from(Duration::from_millis(timeout_ms));
            pin_mut!(transport, timeout);
            match select(transport, timeout).await {
                Either::Left((outcome, _)) => outcome.unwrap_or(Attempt::Retry),
                Either::Right(_) => Attempt::Timeout,
            }
        }
        .boxed_local()
    }
}

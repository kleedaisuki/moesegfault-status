//! 有界内存队列和合并flush；网络可靠性不等同于持久性。
//! Bounded memory queue and coalesced flush; transport reliability does not imply durability.
use crate::builder::{DiagnosticEventBuilder, DiagnosticEventInput, PreparedDiagnostic};
use futures_util::{
    future::{LocalBoxFuture, Shared, WeakShared},
    FutureExt,
};
use serde::Serialize;
use std::{cell::RefCell, collections::VecDeque, rc::Rc};
use url::Url;

/// 单次认证和HTTP尝试的无秘密结果。 / Secret-free outcome of one authorization and HTTP attempt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Attempt {
    /// 匹配事件身份的202回执。 / Matching 202 receipt.
    Accepted,
    /// 可能恢复的传输失败。 / Retryable transport failure.
    Retry,
    /// 认证加HTTP墙钟超时。 / Authorization-plus-HTTP wall-clock timeout.
    Timeout,
    /// 永久请求拒绝。 / Permanent request rejection.
    Rejected,
}
/// 平台适配点；实现必须保留body字节并限制整个尝试，包括认证与回执读取。
/// Platform adapter; preserve exact body bytes and bound the entire attempt, including authorization and receipt reads.
pub trait Transport {
    /// 无凭据缓存的一次尝试；不得跟随重定向。 / One attempt without cached credentials; never follow redirects.
    fn attempt(
        &self,
        endpoint: Url,
        event: PreparedDiagnostic,
        timeout_ms: u64,
    ) -> LocalBoxFuture<'static, Attempt>;
    /// 可替换异步睡眠。 / Replaceable asynchronous sleep.
    fn sleep(&self, millis: u64) -> LocalBoxFuture<'static, ()>;
    /// 单调使用的epoch毫秒时钟。 / Epoch-millisecond clock used for scheduling.
    fn now_millis(&self) -> u64;
}
/// 发布配置；构造客户端时统一验证。 / Publisher configuration validated when constructing the client.
#[derive(Clone, Debug)]
pub struct Options {
    /// 无凭据HTTPS固定摄入路径。 / Credential-free HTTPS pinned ingress path.
    pub endpoint: String,
    /// 排队事件上限，包括在途队首。 / Queue bound, including the in-flight head.
    pub capacity: usize,
    /// 每尝试认证与网络总期限。 / Total authorization and network deadline per attempt.
    pub timeout_ms: u64,
    /// 每flush轮最大尝试数。 / Maximum attempts per flush round.
    pub max_attempts: u32,
    /// 初始退避毫秒。 / Initial backoff milliseconds.
    pub base_backoff_ms: u64,
    /// 退避上限。 / Backoff ceiling.
    pub max_backoff_ms: u64,
}
impl Options {
    /// 创建有界默认配置；new客户端仍会验证endpoint。 / Create bounded defaults; client construction still validates the endpoint.
    pub fn new(endpoint: impl Into<String>) -> Self {
        Self {
            endpoint: endpoint.into(),
            capacity: 64,
            timeout_ms: 2000,
            max_attempts: 3,
            base_backoff_ms: 100,
            max_backoff_ms: 2000,
        }
    }
    /// 严格校验网络与内存边界。 / Strictly validate network and memory bounds.
    fn validate(&self) -> Result<Url, ClientError> {
        let url = Url::parse(&self.endpoint).map_err(|_| ClientError::Configuration)?;
        if url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/v1/diagnostic-events"
            || !(1..=10000).contains(&self.capacity)
            || !(1..=60000).contains(&self.timeout_ms)
            || !(1..=10).contains(&self.max_attempts)
            || !(1..=60000).contains(&self.base_backoff_ms)
            || !(1..=300000).contains(&self.max_backoff_ms)
            || self.base_backoff_ms > self.max_backoff_ms
        {
            return Err(ClientError::Configuration);
        }
        Ok(url)
    }
    /// 封顶指数退避，不溢出。 / Capped exponential backoff without overflow.
    fn backoff(&self, count: u64) -> u64 {
        self.base_backoff_ms
            .saturating_mul(1u64 << count.saturating_sub(1).min(30))
            .min(self.max_backoff_ms)
    }
}
/// 不包含事件或秘密的客户端错误。 / Client errors without event data or secrets.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ClientError {
    /// 配置违反安全边界。 / Configuration violates safety bounds.
    #[error("Invalid diagnostic publisher configuration")]
    Configuration,
    /// 事件与客户端部署身份不一致。 / Event differs from the client's deployment identity.
    #[error("Diagnostic event provenance does not match this client")]
    Provenance,
    /// 事件构造违反领域或隐私约束。 / Event construction violates domain or privacy constraints.
    #[error("Invalid diagnostic event input")]
    InvalidEvent,
}
/// 不包含payload或凭据的累计统计。 / Cumulative statistics without payloads or credentials.
#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    /// 当前队列深度。 / Current queue depth.
    pub depth: usize,
    /// 入队总数。 / Total enqueued.
    pub enqueued: u64,
    /// 匹配回执总数。 / Total matching receipts.
    pub published: u64,
    /// 满队列或永久拒绝丢弃。 / Queue-full or permanently rejected drops.
    pub dropped: u64,
    /// 可重试失败尝试总数。 / Total retryable failed attempts.
    pub failed_attempts: u64,
    /// 超时尝试总数。 / Total timed-out attempts.
    pub timeouts: u64,
    /// 连续耗尽重试轮数。 / Consecutive exhausted retry rounds.
    pub consecutive_failures: u64,
    /// 最近成功毫秒。 / Latest successful epoch milliseconds.
    pub last_success_at: Option<u64>,
    /// 下一轮最早尝试时间。 / Earliest next retry round.
    pub next_attempt_at: Option<u64>,
}
/// flush返回可共享Future；所有调用者等待同一轮。 / Shared flush future; callers await the same round.
pub type Flush = Shared<LocalBoxFuture<'static, Stats>>;
/// 单调用生命周期状态，不跨Workers请求共享I/O。 / Invocation-lifetime state; never share I/O across Workers requests.
struct State {
    queue: VecDeque<PreparedDiagnostic>,
    stats: Stats,
    flush: Option<WeakShared<LocalBoxFuture<'static, Stats>>>,
}
/// 客户端拥有的不可变依赖和可借用本地状态。 / Immutable dependencies and borrowable local state.
struct Inner {
    builder: DiagnosticEventBuilder,
    options: Options,
    endpoint: Url,
    transport: Rc<dyn Transport>,
    state: RefCell<State>,
}
/// 同步入队、显式flush的尽力而为生产客户端。 / Best-effort producer client with synchronous enqueue and explicit flush.
#[derive(Clone)]
pub struct DiagnosticClient {
    inner: Rc<Inner>,
}
impl DiagnosticClient {
    /// 创建manifest绑定客户端；传输由调用方选择真实平台或测试替身。
    /// Construct a manifest-bound client with a production platform transport or test double.
    pub fn new(
        builder: DiagnosticEventBuilder,
        options: Options,
        transport: Rc<dyn Transport>,
    ) -> Result<Self, ClientError> {
        let endpoint = options.validate()?;
        Ok(Self {
            inner: Rc::new(Inner {
                builder,
                options,
                endpoint,
                transport,
                state: RefCell::new(State {
                    queue: VecDeque::new(),
                    stats: Stats::default(),
                    flush: None,
                }),
            }),
        })
    }
    /// 借用不可变事件构建器。 / Borrow the immutable event builder.
    pub fn builder(&self) -> &DiagnosticEventBuilder {
        &self.inner.builder
    }
    /// 同步入队；返回false表示满队列，不阻塞业务请求。 / Enqueue synchronously; false means full, without blocking the business request.
    pub fn publish(&self, event: PreparedDiagnostic) -> Result<bool, ClientError> {
        if !self.inner.builder.identity_matches(event.event()) {
            return Err(ClientError::Provenance);
        }
        let mut state = self.inner.state.borrow_mut();
        if state.queue.len() >= self.inner.options.capacity {
            state.stats.dropped = state.stats.dropped.saturating_add(1);
            return Ok(false);
        }
        state.queue.push_back(event);
        state.stats.enqueued = state.stats.enqueued.saturating_add(1);
        Ok(true)
    }
    /// 构造故障并同步入队，满队列返回None。 / Build a fault and enqueue synchronously; None means full.
    pub fn fault(
        &self,
        input: DiagnosticEventInput,
    ) -> Result<Option<PreparedDiagnostic>, ClientError> {
        let event = self
            .builder()
            .fault(input)
            .map_err(|_| ClientError::InvalidEvent)?;
        Ok(self.publish(event.clone())?.then_some(event))
    }
    /// 构造因果恢复并同步入队；绝不从静默推导恢复。 / Build causal recovery and enqueue; never infer recovery from silence.
    pub fn recovery(
        &self,
        input: DiagnosticEventInput,
        recovery_of_event_id: &str,
    ) -> Result<Option<PreparedDiagnostic>, ClientError> {
        let event = self
            .builder()
            .recovery(input, recovery_of_event_id)
            .map_err(|_| ClientError::InvalidEvent)?;
        Ok(self.publish(event.clone())?.then_some(event))
    }
    /// 不含秘密的即时统计。 / Immediate statistics without secrets.
    pub fn stats(&self) -> Stats {
        let state = self.inner.state.borrow();
        let mut stats = state.stats.clone();
        stats.depth = state.queue.len();
        stats
    }
    /// 合并并发flush；弱引用防止客户端和未轮询Future形成引用环。
    /// Coalesce concurrent flushes; weak references avoid cycles with unpolled futures.
    pub fn flush(&self) -> Flush {
        if let Some(pending) = self
            .inner
            .state
            .borrow()
            .flush
            .as_ref()
            .and_then(WeakShared::upgrade)
        {
            return pending;
        }
        let client = self.clone();
        let pending = async move {
            let stats = client.drain().await;
            client.inner.state.borrow_mut().flush = None;
            stats
        }
        .boxed_local()
        .shared();
        self.inner.state.borrow_mut().flush = pending.downgrade();
        pending
    }
    /// 在Workers请求结束时提交后台flush，不伪称持久交付。 / Schedule background flush at request end without claiming durable delivery.
    #[cfg(target_arch = "wasm32")]
    pub fn flush_background(&self, context: &worker::Context) {
        let pending = self.flush();
        context.wait_until(async move {
            pending.await;
        });
    }
    /// 串行处理开始轮询时的有限快照；新事件留到下一轮。 / Serially process the finite snapshot at first poll; later events wait for the next round.
    async fn drain(&self) -> Stats {
        let now = self.inner.transport.now_millis();
        let remaining = {
            let state = self.inner.state.borrow();
            if state.stats.next_attempt_at.is_some_and(|at| now < at) {
                return self.stats();
            }
            state.queue.len()
        };
        for _ in 0..remaining {
            let event = self.inner.state.borrow().queue.front().cloned();
            let Some(event) = event else { break };
            let outcome = self.send_with_retries(event).await;
            let mut state = self.inner.state.borrow_mut();
            match outcome {
                Attempt::Accepted => {
                    state.queue.pop_front();
                    state.stats.published = state.stats.published.saturating_add(1);
                    state.stats.consecutive_failures = 0;
                    state.stats.next_attempt_at = None;
                    state.stats.last_success_at = Some(self.inner.transport.now_millis());
                }
                Attempt::Rejected => {
                    state.queue.pop_front();
                    state.stats.dropped = state.stats.dropped.saturating_add(1);
                }
                _ => {
                    state.stats.consecutive_failures =
                        state.stats.consecutive_failures.saturating_add(1);
                    state.stats.next_attempt_at =
                        Some(self.inner.transport.now_millis().saturating_add(
                            self.inner.options.backoff(state.stats.consecutive_failures),
                        ));
                    break;
                }
            }
        }
        self.stats()
    }
    /// 每次尝试均使用同一个不可变prepared对象。 / Every attempt uses the same immutable prepared event.
    async fn send_with_retries(&self, event: PreparedDiagnostic) -> Attempt {
        for attempt in 0..self.inner.options.max_attempts {
            if attempt > 0 {
                self.inner
                    .transport
                    .sleep(self.inner.options.backoff(u64::from(attempt)))
                    .await;
            }
            let outcome = self
                .inner
                .transport
                .attempt(
                    self.inner.endpoint.clone(),
                    event.clone(),
                    self.inner.options.timeout_ms,
                )
                .await;
            if matches!(outcome, Attempt::Accepted | Attempt::Rejected) {
                return outcome;
            }
            let mut state = self.inner.state.borrow_mut();
            state.stats.failed_attempts = state.stats.failed_attempts.saturating_add(1);
            if outcome == Attempt::Timeout {
                state.stats.timeouts = state.stats.timeouts.saturating_add(1);
            }
        }
        Attempt::Retry
    }
}
/// HTTP错误分类保留鉴权错误可重试，以允许每次取得新凭据。 / Keep authentication errors retryable so each attempt may obtain fresh credentials.
pub fn permanent_status(status: u16) -> bool {
    [400, 404, 405, 409, 410, 413, 415, 422].contains(&status)
}

#[cfg(test)]
mod tests;

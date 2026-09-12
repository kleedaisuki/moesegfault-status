//! 有界批量导出状态机；Workers 默认使用平台原生 OTLP，不同步等待外部后端。
//! Bounded batch-export state machine; Workers defaults to native OTLP without awaiting external backends.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::VecDeque;

/// OTel 日志优先级；容量不足时先丢弃低优先级。 / OTel log priority; discard lower priorities first under pressure.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Priority {
    /// 默认不导出的详细日志。 / Detailed logs, not exported by default.
    Trace,
    /// 调试日志。 / Debug logs.
    Debug,
    /// 正常运维事件。 / Normal operational events.
    Info,
    /// 可恢复偏离。 / Recoverable deviation.
    Warn,
    /// 操作失败。 / Operation failure.
    Error,
    /// 运行时不可恢复失败。 / Unrecoverable runtime failure.
    Fatal,
}

/// 有界待导出记录，正文应由上游白名单构造。 / Bounded pending record; upstream must construct payloads through allowlists.
#[derive(Clone, Debug)]
pub struct ExportRecord {
    /// 优先级。 / Priority.
    pub priority: Priority,
    /// 已清理的遥测记录。 / Scrubbed telemetry record.
    pub value: Value,
    /// 序列化字节数，用于内存上限。 / Serialized bytes for memory accounting.
    bytes: usize,
}

/// 自可观测性计数，不向本队列递归发送。 / Self-observability counters, never recursively queued.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ExportStats {
    /// 成功导出条数。 / Successfully exported records.
    pub exported: u64,
    /// 资源边界丢弃数。 / Resource-boundary drops.
    pub dropped: u64,
    /// 批次失败数。 / Failed batches.
    pub failures: u64,
    /// 超时批次数。 / Timed-out batches.
    pub timeouts: u64,
    /// 连续失败次数。 / Consecutive failures.
    pub consecutive_failures: u32,
    /// 最早重试 epoch 毫秒。 / Earliest retry epoch milliseconds.
    pub next_attempt_at: u64,
}

/// 一次flush的明确结果，不携带可能含秘密的传输异常。 / Explicit flush outcome without potentially sensitive transport errors.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FlushOutcome {
    /// 无记录、正在发送或尚在退避。 / Empty, in-flight, or backing off.
    Idle,
    /// 已成功交付整批。 / Entire batch delivered.
    Sent,
    /// 传输失败，记录保持待重试。 / Transport failure; records remain retryable.
    Failed,
    /// 超时并取消传输，记录保持待重试。 / Timed out and transport cancelled; records remain retryable.
    TimedOut,
}

/// 单次调用的有界队列；只允许一个在途批次。 / Invocation-local bounded queue; permits only one in-flight batch.
pub struct BoundedExporter {
    /// 待发送队列。 / Pending queue.
    queue: VecDeque<ExportRecord>,
    /// 在途副本保留，失败无需重建记录身份。 / Retained in-flight records preserve identity on failure.
    inflight: Vec<ExportRecord>,
    /// 总记录上限。 / Total record limit.
    capacity: usize,
    /// 总序列化字节上限。 / Total serialized byte limit.
    byte_limit: usize,
    /// 计数快照。 / Counter snapshot.
    stats: ExportStats,
}

/// 取消安全的在途租约；Future被丢弃时取消I/O并恢复队列。 / Cancellation-safe flight lease; dropping the Future aborts I/O and restores the queue.
struct Flight<'a, A: FnOnce(), C: Fn() -> u64> {
    /// 独占在途队列。 / Exclusively borrowed in-flight queue.
    exporter: &'a mut BoundedExporter,
    /// 可消费一次的取消动作。 / One-shot cancellation action.
    abort: Option<A>,
    /// 可测试完成时钟。 / Testable completion clock.
    clock: C,
}
impl<A: FnOnce(), C: Fn() -> u64> Drop for Flight<'_, A, C> {
    fn drop(&mut self) {
        if let Some(abort) = self.abort.take() {
            abort();
        }
        if !self.exporter.inflight.is_empty() {
            self.exporter.complete((self.clock)(), false, false);
        }
    }
}

impl BoundedExporter {
    /// 实际执行单批flush；竞争真实截止Future，超时先取消传输再重新入队。
    /// Execute one batch flush; race the actual deadline Future, aborting transport before requeueing on timeout.
    pub async fn flush_with_deadline<S, F, E, D, A, C>(
        &mut self,
        batch_size: usize,
        send: S,
        deadline: D,
        abort: A,
        clock: C,
    ) -> FlushOutcome
    where
        S: FnOnce(Vec<Value>) -> F,
        F: std::future::Future<Output = Result<(), E>>,
        D: std::future::Future<Output = ()>,
        A: FnOnce(),
        C: Fn() -> u64,
    {
        let Some(batch) = self.begin(clock(), batch_size) else {
            return FlushOutcome::Idle;
        };
        let mut flight = Flight {
            exporter: self,
            abort: Some(abort),
            clock,
        };
        let send = send(batch);
        futures_util::pin_mut!(send, deadline);
        let outcome = match futures_util::future::select(send, deadline).await {
            futures_util::future::Either::Left((Ok(()), _)) => FlushOutcome::Sent,
            futures_util::future::Either::Left((Err(_), _)) => FlushOutcome::Failed,
            futures_util::future::Either::Right(_) => {
                if let Some(abort) = flight.abort.take() {
                    abort();
                }
                FlushOutcome::TimedOut
            }
        };
        flight.abort.take();
        flight.exporter.complete(
            (flight.clock)(),
            outcome == FlushOutcome::Sent,
            outcome == FlushOutcome::TimedOut,
        );
        outcome
    }
    /// Workers真实定时器与AbortSignal；发送函数必须把signal传给底层Fetch。
    /// Real Workers timer and AbortSignal; the sender must pass the signal to its underlying Fetch.
    #[cfg(target_arch = "wasm32")]
    pub async fn flush<S, F, E>(
        &mut self,
        batch_size: usize,
        timeout_ms: u32,
        send: S,
    ) -> FlushOutcome
    where
        S: FnOnce(Vec<Value>, worker::AbortSignal) -> F,
        F: std::future::Future<Output = Result<(), E>>,
    {
        let controller = worker::AbortController::default();
        let signal = controller.signal();
        self.flush_with_deadline(
            batch_size,
            |batch| send(batch, signal),
            worker::Delay::from(std::time::Duration::from_millis(u64::from(
                timeout_ms.clamp(1, 30000),
            ))),
            || controller.abort(),
            || super::now_ms() as u64,
        )
        .await
    }
    /// 有界配置，拒绝零容量和过大的内存预算。 / Bounded configuration rejects zero capacity and excessive memory budgets.
    pub fn new(capacity: usize, byte_limit: usize) -> Result<Self, &'static str> {
        if !(1..=4096).contains(&capacity) || !(1024..=4 * 1024 * 1024).contains(&byte_limit) {
            return Err("invalid_export_budget");
        }
        Ok(Self {
            queue: VecDeque::new(),
            inflight: Vec::new(),
            capacity,
            byte_limit,
            stats: ExportStats::default(),
        })
    }
    /// 不可变计数快照。 / Immutable counter snapshot.
    pub fn stats(&self) -> &ExportStats {
        &self.stats
    }
    /// 包含在途记录的队列深度。 / Queue depth including in-flight records.
    pub fn depth(&self) -> usize {
        self.queue.len() + self.inflight.len()
    }
    /// 包含在途记录的字节预算。 / Byte budget including in-flight records.
    fn bytes(&self) -> usize {
        self.queue
            .iter()
            .chain(self.inflight.iter())
            .map(|r| r.bytes)
            .sum()
    }
    /// 入队并按优先级驱逐，单条最大 64 KiB。 / Enqueue with priority eviction; individual records are bounded to 64 KiB.
    pub fn enqueue(&mut self, priority: Priority, value: Value) -> bool {
        let bytes = match serde_json::to_vec(&value) {
            Ok(bytes) => bytes.len(),
            Err(_) => {
                self.stats.dropped += 1;
                return false;
            }
        };
        if bytes > 65536 || bytes > self.byte_limit {
            self.stats.dropped += 1;
            return false;
        }
        while self.depth() >= self.capacity || self.bytes() + bytes > self.byte_limit {
            let candidate = self
                .queue
                .iter()
                .enumerate()
                .filter(|(_, r)| r.priority < priority)
                .min_by_key(|(_, r)| r.priority)
                .map(|(i, _)| i);
            let Some(index) = candidate else {
                self.stats.dropped += 1;
                return false;
            };
            self.queue.remove(index);
            self.stats.dropped += 1;
        }
        self.queue.push_back(ExportRecord {
            priority,
            value,
            bytes,
        });
        true
    }
    /// 获取有界批次；调用者必须设发送超时并恰好一次调用 complete。
    /// Take a bounded batch; callers must enforce a send timeout and invoke complete exactly once.
    pub fn begin(&mut self, now_ms: u64, batch_size: usize) -> Option<Vec<Value>> {
        if !self.inflight.is_empty()
            || self.queue.is_empty()
            || now_ms < self.stats.next_attempt_at
            || batch_size == 0
        {
            return None;
        }
        self.inflight = self
            .queue
            .drain(..batch_size.min(self.queue.len()).min(256))
            .collect();
        Some(self.inflight.iter().map(|r| r.value.clone()).collect())
    }
    /// 失败保留相同记录，指数退避最多 30 秒；成功重置连续失败。
    /// Failure retains the same records with exponential backoff capped at 30 seconds; success resets failures.
    pub fn complete(&mut self, now_ms: u64, success: bool, timed_out: bool) {
        if self.inflight.is_empty() {
            return;
        }
        if success {
            self.stats.exported += self.inflight.len() as u64;
            self.inflight.clear();
            self.stats.consecutive_failures = 0;
            self.stats.next_attempt_at = 0;
            return;
        }
        self.stats.failures += 1;
        self.stats.timeouts += u64::from(timed_out);
        self.stats.consecutive_failures = self.stats.consecutive_failures.saturating_add(1);
        self.stats.next_attempt_at =
            now_ms.saturating_add((1000u64 << self.stats.consecutive_failures.min(5)).min(30000));
        for record in self.inflight.drain(..).rev() {
            self.queue.push_front(record);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn preserves_high_priority_and_inflight_budget() {
        let mut e = BoundedExporter::new(2, 1024).unwrap();
        assert!(e.enqueue(Priority::Info, json!(1)));
        assert!(e.enqueue(Priority::Debug, json!(2)));
        assert!(e.enqueue(Priority::Error, json!(3)));
        assert_eq!(e.stats().dropped, 1);
        assert_eq!(e.begin(0, 10), Some(vec![json!(1), json!(3)]));
        assert!(!e.enqueue(Priority::Fatal, json!(4)));
        assert_eq!(e.depth(), 2);
    }
    #[test]
    fn retry_preserves_records_and_has_backoff() {
        let mut e = BoundedExporter::new(2, 1024).unwrap();
        e.enqueue(Priority::Error, json!({"event_id":"fixed"}));
        let first = e.begin(100, 2).unwrap();
        e.complete(200, false, true);
        assert!(e.begin(201, 2).is_none());
        assert_eq!(e.begin(2200, 2), Some(first));
        e.complete(2300, true, false);
        assert_eq!(e.stats().exported, 1);
        assert_eq!(e.stats().timeouts, 1);
        assert_eq!(e.depth(), 0);
    }
    #[test]
    fn flush_runs_sender_and_aborts_timeout_before_retry() {
        use futures_util::{future, FutureExt};
        let mut e = BoundedExporter::new(4, 1024).unwrap();
        e.enqueue(Priority::Error, json!("record"));
        let aborted = std::cell::Cell::new(false);
        let timeout = e
            .flush_with_deadline(
                4,
                |_| future::pending::<Result<(), ()>>(),
                future::ready(()),
                || aborted.set(true),
                || 100,
            )
            .now_or_never()
            .unwrap();
        assert_eq!(timeout, FlushOutcome::TimedOut);
        assert!(aborted.get());
        assert_eq!(e.depth(), 1);
        let idle = e
            .flush_with_deadline(
                4,
                |_| future::ready(Ok::<_, ()>(())),
                future::pending(),
                || {},
                || 101,
            )
            .now_or_never()
            .unwrap();
        assert_eq!(idle, FlushOutcome::Idle);
        let sent = e
            .flush_with_deadline(
                4,
                |batch| {
                    assert_eq!(batch, vec![json!("record")]);
                    future::ready(Ok::<_, ()>(()))
                },
                future::pending(),
                || {},
                || 2200,
            )
            .now_or_never()
            .unwrap();
        assert_eq!(sent, FlushOutcome::Sent);
        assert_eq!(e.depth(), 0);
        assert_eq!(e.stats().timeouts, 1);
    }
    #[test]
    fn cancelling_flush_restores_inflight_records() {
        use futures_util::{future, FutureExt};
        let mut e = BoundedExporter::new(4, 1024).unwrap();
        e.enqueue(Priority::Warn, json!(1));
        let aborted = std::cell::Cell::new(false);
        assert!(e
            .flush_with_deadline(
                4,
                |_| future::pending::<Result<(), ()>>(),
                future::pending(),
                || aborted.set(true),
                || 100
            )
            .now_or_never()
            .is_none());
        assert!(aborted.get());
        assert_eq!(e.depth(), 1);
        assert!(e.begin(2200, 4).is_some());
    }
}

# diagnostic-client（Rust）

Manifest-bound, bounded, **best-effort** Diagnostic producer SDK. The in-memory queue is **not durable**: process termination, isolate eviction, cancellation, or an omitted flush can lose pending events. Use an application-owned durable outbox when loss is unacceptable. / 绑定 manifest、有界、**尽力而为**的诊断 SDK。内存队列**不持久**：进程退出、isolate 回收、取消或未调用 flush 均可能丢失待发事件；不允许丢失时须使用应用自己的持久 outbox。

## Workers usage / Workers 使用

```rust,ignore
use diagnostic_client::{DiagnosticClient, DiagnosticEventBuilder, DiagnosticEventInput, Options};
use diagnostic_client::workers::WorkersTransport;
use futures_util::FutureExt;
use std::rc::Rc;

// 每个请求创建客户端；不得全局跨请求缓存Workers I/O。
// Create a client per request; never cache Workers I/O globally across requests.
let builder = DiagnosticEventBuilder::from_manifest(&manifest)?;
let secret_env = env.clone();
let transport = WorkersTransport::new(Rc::new(move || {
    let env = secret_env.clone();
    async move {
        // 每一次HTTP尝试重新取得秘密；不进入prepared事件或统计。
        // Obtain the secret for every HTTP attempt; never put it into events or statistics.
        let token = env.secret("DIAGNOSTIC_TOKEN").map_err(|_| ())?.to_string();
        Ok(format!("Bearer {token}"))
    }.boxed_local()
}));
let client = DiagnosticClient::new(
    builder,
    Options::new("https://status.example/v1/diagnostic-events"),
    Rc::new(transport),
)?;
let mut input = DiagnosticEventInput::new(
    "dependency.failure", status_domain::DiagnosticSeverity::Error,
    "Inventory dependency failed",
);
input.fingerprint.insert("dependency".into(), "inventory".into());
let fault = client.fault(input)?;
client.flush_background(&ctx); // 不阻塞业务响应。 / Does not block the business response.
```

Recovery uses `client.recovery(input, &fault.event().event_id)` and is an explicit positive signal. It must name the matching current fault head; silence never creates recovery. / `client.recovery(input, &fault.event().event_id)` 表示显式正向证据，必须引用对应当前故障头；静默不等于恢复。

## Contracts / 契约

| Boundary / 边界 | Guarantee / 保证                                                                                                                                                                                           |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manifest        | Complete domain validation and exact resource identity cross-check; per-event provenance cannot override it. / 完整领域验证与资源逐项绑定，事件不可覆盖部署来源。                                          |
| Prepared event  | Private fields, no `Deserialize`, immutable event and serialized bytes; caller cannot manufacture unchecked bodies. / 私有字段、无 `Deserialize`，不可伪造未经检查正文。                                   |
| Evidence        | Six finite typed builders with typed query keys, range and identity checks, and redacted text. / 六种有限类型构建器、类型化查询键、范围与身份校验、文本脱敏。                                              |
| Payload         | UTF-8 body hard limit 64 KiB, fixed attribute allowlist, stable event ID and bytes across all attempts. / UTF-8 正文 64 KiB 硬限、属性白名单、全部重试复用事件 ID 与字节。                                 |
| Queue           | Default 64 events; `publish` synchronously returns false when full, retaining the in-flight head within capacity. / 默认 64 项；满时同步返回 false，在途队首也计入容量。                                   |
| Flush           | Finite snapshot, serial sends, coalesced concurrent callers, bounded attempts and capped backoff. / 有限快照、串行发送、并发合并、有界次数与退避。                                                         |
| Transport       | HTTPS exact `/v1/diagnostic-events`, no credentials/query/fragment in URL, manual redirect rejection. / 固定 HTTPS 路径，无 URL 凭据、查询或 fragment，手动拒绝重定向。                                    |
| Deadline        | Authorization, HTTP, and bounded 4 KiB receipt read share one wall-clock deadline; cancellation aborts Fetch. / 认证、HTTP 与 4 KiB 回执共享期限，取消会中止 Fetch。                                       |
| Retry           | Only matching 202 receipt succeeds; permanent request errors drop, transient/auth failures remain retryable with fresh credentials. / 仅匹配 202 回执成功；永久请求错误丢弃，暂时/认证错误取得新凭据再试。 |
| Statistics      | Depth, enqueued/published/dropped, failed attempts/timeouts, retry rounds and deadlines contain no secrets or bodies. / 深度、入队/发布/丢弃、失败/超时、轮数与时间不含秘密及正文。                        |

Native users supply `publisher::Transport` for their platform HTTP runtime. `WorkersTransport` is the included production adapter; a mock transport is only a test double. / 原生进程为自己的 HTTP runtime 实现 `publisher::Transport`；内置 `WorkersTransport` 是真实平台适配器，模拟传输仅用于测试。

## Validation / 验证

- `cargo test -p diagnostic-client`
- `cargo clippy -p diagnostic-client --all-targets -- -D warnings`
- `cargo clippy -p diagnostic-client --target wasm32-unknown-unknown -- -D warnings`
- Build `tests/diagnostic-client-runtime`, then run `tests/diagnostic-client-rust.test.ts` for real workerd transport validation. / 构建测试 Worker 后运行实际 workerd 传输测试。

[Workers request lifetime](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil) explains why background work is not durable delivery. [Cloudflare Queue retry guidance](https://developers.cloudflare.com/queues/configuration/batching-retries/) motivates stable event identities at the durable consumer boundary. / Workers 生命周期解释后台工作不等于持久交付；Queue 重试原则要求持久消费者边界拥有稳定事件身份。

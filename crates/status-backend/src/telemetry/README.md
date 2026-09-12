# Rust 遥测 / Rust telemetry

每次 invocation 创建一个 `for_invocation(&env)`（其他服务使用 `for_service_invocation`）。
clone 共享 Analytics Engine 的 **250 次尝试**预算，失败同样消耗预算；不得为每条消息重新构造。
Create one facade per invocation; clones share the 250-attempt Analytics Engine budget, including failed writes.

```rust,ignore
let telemetry = for_invocation(&env)?;
let attrs = telemetry.as_ref().map(|t| t.span_attributes("queue.consume", Some(&correlation), Some(&trace)))
    .unwrap_or_default();
let result = with_span("queue.consume", attrs, async move { consume_owned(env).await }).await;
```

## 边界 / Boundaries

- 原生 tracing/logging 由 Cloudflare OTLP exporter 承载；这里不维护第二份 D1 日志仓库。
  Native tracing/logging is carried by Cloudflare OTLP export, never a second D1 log warehouse.
- Cloudflare 不暴露原生 span IDs，也不允许手动设置 parent/link。独立 W3C 上下文用外部 trace/span 属性和 Correlation ID 关联，不冒充平台 trace。
  Cloudflare exposes neither native span IDs nor manual parent/link wiring. Independent W3C references and correlation IDs do not impersonate platform traces.
- 平台原生 head sampling 必须配置为 `1` 才能保证错误/慢请求完整保留。`should_sample` 只是独立策略工具，不能逆转已丢弃的原生 trace。
  Configure native head sampling to `1` to retain all errors/slow traces. `should_sample` cannot recover discarded native traces.
- `BoundedExporter::flush` 是非原生 exporter 的真实有界批量发送入口，内置 Workers timer、AbortSignal、取消恢复及退避；发送函数必须传播该 signal。Workers 默认仍使用平台原生 OTLP。
  `BoundedExporter::flush` executes bounded batches with a Workers timer, AbortSignal, cancellation recovery and backoff; senders must propagate that signal. Workers defaults to native OTLP.
- 缺失/错误部署来源 fail closed；仅无来源配置的 development 显式 disabled。缺失 AE binding 计为 sample drop，不影响业务结果。
  Invalid/missing provenance fails closed; only development with no provenance is explicitly disabled. Missing AE bindings count drops without changing business results.
- Diagnostic 生产者使用独立 Rust diagnostic-client 的完整 Manifest 绑定与64KiB构建器，避免两套校验语义；status 自身失败不递归创建 Diagnostic。
  Diagnostic producers use the independent Rust diagnostic-client manifest-bound, 64-KiB builder, avoiding duplicate validation semantics; status failures never recursively diagnose themselves.

## 通知 / Notifications

Scheduler 拥有 outbox claim/事务及重试时间；`notifications::publish` 只做 Queue 接受。
入口必须使用 `consume_raw` 保留 SDK 未公开的 attempts。终止失败写入 `NOTIFICATION_DLQ` 后才 ack，
并携带 event ID、生产者、失败阶段和 Problem URI；无效 payload 只保留验证过的 ID，不复制秘密。
The scheduler owns outbox claims/transactions/retry scheduling. `publish` means Queue acceptance only.
Use `consume_raw` to preserve attempts omitted by the high-level SDK; acknowledge terminal failures only
after durable DLQ acceptance, preserving identity and bounded failure metadata.

通知 webhook 必须 HTTPS、无 URL 凭据，授权来自 Secrets。Workers Request 不支持 redirect:error，
因此使用 Manual 并拒绝所有非 2xx，绝不跟随重定向。五秒硬超时 abort 底层请求。
Webhook URLs must use credential-free HTTPS and Secrets authorization. Workers rejects redirect:error;
Manual plus rejection of all non-2xx responses prevents redirects. The five-second deadline aborts I/O.

`serde_json::Value` 发往 JavaScript API 时必须采用 `Serializer::json_compatible()`；默认 Map 不等于普通对象。
Queue 的 raw 发送使用 `RawMessageBuilder` 和 Json content type。
Serialize JSON values with `Serializer::json_compatible()`; default Maps are not plain objects.
Raw Queue publication uses `RawMessageBuilder` with Json content type.

## 验证与依据 / Verification and references

`cargo test -p status-backend telemetry`、`cargo test -p status-backend notifications`；
`worker-build tests/telemetry-runtime --release --no-opt` 后运行 `node node_modules/vitest/vitest.mjs run tests/telemetry-rust.test.ts`。

- [Cloudflare custom spans](https://developers.cloudflare.com/workers/observability/traces/custom-spans/)
- [Cloudflare OTLP export](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/)
- [Cloudflare Queue retries](https://developers.cloudflare.com/queues/configuration/batching-retries/)
- [Cloudflare dead letter queues](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/)

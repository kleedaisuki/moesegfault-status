# Rust diagnostic pipeline / Rust 诊断流水线

`handle` authenticates machine JWTs, validates the bounded 64 KiB body and its provenance, and returns 202 only after the native Queue binding accepts an immutable envelope. It does not query or mutate D1. / `handle` 验证机器 JWT、64 KiB 有界请求与来源，原生 Queue 接受不可变信封后才返回 202；摄入不查询或修改 D1。

`process_envelope` validates trusted Queue provenance again and directly calls `status_domain::evaluate_diagnostic`. A single D1 batch commits the permanent dedup claim, optimistic-concurrency assertions, Issue/occurrence/evidence mutations, incident links, public status plan, audit and outbox. Every domain mutation is gated by the winning processing token. / `process_envelope` 再验 Queue 来源并直接调用领域函数；同一 D1 batch 提交永久去重认领、乐观并发断言、Issue/发生记录/证据、incident 关联、公开状态、审计和 outbox，所有领域变更由获胜 token 门控。

Recovery never creates a fault occurrence and never infers health from silence. Recovery must causally reference the latest fault head; stale evidence remains auditable without overwriting it. / 恢复不创建故障发生记录、不由静默推断健康，必须因果引用最新故障头；过期恢复可审计但不覆盖新故障。

`consume_raw` receives the native platform batch because SDK 0.8.5 does not expose message attempts. It acknowledges each successful message independently, retries with bounded exponential delays, and acknowledges exhausted messages only after a failure-tagged DLQ envelope is accepted. / SDK 0.8.5 未暴露 attempts，故 `consume_raw` 读取原生 batch，独立确认成功消息、有界指数退避重试，失败证据信封获 DLQ 接受后才确认耗尽消息。

Retention is owned by scheduling's D1 retention job and deployment artifact R2 cleanup; this module pins occurrence retention-policy revisions at ingestion. / 保留清理由 scheduling 的 D1 作业与部署产物 R2 清理负责；本模块固定发生记录保留策略修订。

## Verification / 验证

- `cargo test -p status-backend diagnostics --lib`: strict wire validation and SQL plan parameter/ownership tests. / 严格传输验证与 SQL 参数、所有权测试。
- `node node_modules/vitest/vitest.mjs run tests/diagnostics-rust.test.ts`: actual Rust WASM + workerd + D1 integration, after building `tests/rust-runtime`. / 构建测试 Worker 后执行真实 WASM/workerd/D1 集成。

## Design references / 设计依据

- [Cloudflare individual acknowledgement and retries](https://developers.cloudflare.com/queues/configuration/batching-retries/): per-message acknowledgements prevent poison messages from replaying successful siblings. / 逐消息确认避免毒消息导致同批已成功项重放。
- [Reliable Actors with Retry Orchestration](https://arxiv.org/abs/2111.11562): retry execution and completed-effect deduplication are distinct concerns; the implementation relies on a database transaction, not on an assumption of exactly-once Queue delivery. / 重试执行与已完成效果去重是不同问题；实现依赖数据库事务，不假定 Queue 恰好一次投递。

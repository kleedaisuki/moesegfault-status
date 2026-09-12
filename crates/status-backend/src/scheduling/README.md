# Rust scheduling / Rust 调度

`scheduled(Env, Context)` awaits one bounded invocation. All monitor and status decisions call `status-domain` directly; there is no JavaScript or JSON command dispatcher.

`scheduled(Env, Context)` 等待一次有界调用完成。监控和状态判断直接调用 `status-domain`，不存在 JavaScript 或 JSON 命令分派器。

## Contracts / 契约

- One monitor lease covers every configured region. Global and per-target concurrency limits apply before serial regional fan-out. Missing executors contribute no fabricated failures or votes.
- 一个 monitor 租约涵盖全部配置区域；先限制全局与每目标并发，再串行分派区域请求。失联执行器不产生伪造故障或投票。
- Configuration revision, enabled locations, lease ownership and lease expiry are checked in the same D1 batch that writes checkpoints, advances the schedule and persists a reevaluation outbox event. Raw observations go only to the invocation-budgeted Analytics sink.
- 配置修订、启用位置、租约身份及期限，与检查点、调度推进和持久重评任务在同一 D1 批事务内核验。原始观察只写入具有调用预算的 Analytics 出口。
- `reevaluate::plan_reevaluation_with_overlay` returns the generation guard first. Every guard must precede **all** causal mutations and snapshot writes in the caller's atomic batch. Never commit the mutation before planning. `plan_admin` returns the target guards first and forwards pending service state to supporting components.
- `reevaluate::plan_reevaluation_with_overlay` 首项为 generation 栅栏。调用方原子事务必须把全部栅栏放在**所有**因果变更与快照写入之前，禁止先提交变更再规划。`plan_admin` 将目标栅栏前置，并向支撑组件传递待写服务状态。
- Outbox delivery is at least once. External notifications publish only domain identifiers through `NOTIFICATION_QUEUE`; recipients must deduplicate the immutable event ID. Internal expiry and reevaluation events never become external notifications.
- outbox 至少投递一次；外部通知仅通过 `NOTIFICATION_QUEUE` 发送领域标识，接收方必须按不可变事件 ID 去重。内部到期及重评任务不转成外部通知。
- Service dependency propagation uses persistent fan-out and cycle-safe graph evaluation. Supporting components inside a multi-target management transaction see the candidate service state; independent invocations converge through the outbox.
- 服务依赖通过持久重评任务及循环安全图评估传播；管理多目标事务中的支撑组件读取候选服务状态，独立调用通过 outbox 收敛。

## Verification / 验证

```text
cargo test -p status-backend scheduling:: --lib
cargo check -p status-backend --target wasm32-unknown-unknown
python -m unittest discover -s tests/database -p 'test_scheduling_rust_*.py'
```

Native tests exercise real Rust window/quorum/cron code. SQLite tests execute SQL extracted from the Rust source against every repository migration, including rollback and late-pin races. These do not establish physical deployment placement or real multi-region availability; verify executor identity, platform colo metadata and distinct-colo quorum after deployment.

原生测试运行真实 Rust 窗口、仲裁与 cron 代码；SQLite 测试从 Rust 源码抽取 SQL，在仓库全部迁移上验证回滚及延迟 pin 竞态。它们不证明部署物理位置或真实跨区域可用性；部署后仍须验证执行器身份、平台机房元数据与不同机房仲裁。

Platform references / 平台依据：[D1 batch transaction semantics](https://developers.cloudflare.com/d1/worker-api/d1-database/), [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/).

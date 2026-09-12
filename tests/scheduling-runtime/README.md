# Scheduling runtime acceptance / 调度运行时验收

This crate is a **test-only** default Worker entrypoint. `/tick` directly invokes the production Rust `scheduling::scheduled`; `/diagnostic-lease-race` deterministically inserts an administrative configuration change between lease acquisition and the production diagnostic transaction. Never deploy this crate.

本 crate 是**仅测试**的默认 Worker 入口。`/tick` 直接调用生产 Rust 调度函数；`/diagnostic-lease-race` 在领取租约和生产诊断事务之间注入确定性的管理配置变更。禁止部署此 crate。

```text
worker-build tests/scheduling-runtime --release --no-opt -- --locked
node node_modules/vitest/vitest.mjs run tests/scheduling-rust.test.ts
```

Miniflare runs the compiled Rust/Wasm, real D1 bindings and every repository migration. Only the regional network endpoint is a fixture; it supplies protocol observations, not status decisions. Assertions cover concurrent ticks, lease/schedule/checkpoint atomicity, outbox acknowledgement and retry, stale monitor diagnostics with a positive control, and retention with incident pins.

Miniflare 运行编译后的 Rust/Wasm、真实 D1 binding 和全部数据库迁移。仅区域网络端点使用夹具，提供协议观察而非状态判断。断言覆盖并发 tick、租约/调度/检查点原子性、outbox 确认与重试、带正向对照的陈旧监控诊断，以及 Incident pin 保留清理。

This suite does not prove physical regional placement, actual Internet probe execution or external notification receipt. Those require production deployment verification.

本测试不证明物理区域放置、真实互联网探针执行或外部通知收件，仍需部署验收。

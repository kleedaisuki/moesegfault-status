# 本地真实运行时验收 / Real local-runtime acceptance

```sh
node scripts/build-wasm.mjs
pnpm exec vitest run tests/runtime/acceptance.test.ts
```

前置：工作区依赖、Stable Rust + wasm32、匹配 wasm-bindgen CLI、Node 24+、Python 3。
Prerequisites: workspace dependencies, Stable Rust + wasm32, matching wasm-bindgen CLI, Node 24+, Python 3.

测试直接 bundle 生产 Status 和 Ops Gateway，在 workerd 中通过真实 named AdminRpc Service binding 调用，使用 Miniflare D1 执行全部编号迁移及真实编译 Rust WASM。SQLite 自身的 `complete_statement` 负责拆分触发器，不模拟 SQL。
Tests bundle production Status and Ops Gateway, call the real named AdminRpc Service binding in workerd, and execute all numbered migrations in Miniflare D1 with compiled Rust WASM. SQLite's own `complete_statement` splits trigger-containing migrations; SQL is not mocked.

临时 RSA 密钥不落盘。唯一出站接收器仅在固定 issuer 的两个 JWKS 路径提供公钥，其余请求全部拒绝；生产签名、issuer、audience、claim、角色与 scope 验证保持不变。没有真实秘密、网络依赖或远端修改。
Ephemeral RSA private keys never touch disk. The sole outbound fixture serves public keys only at two pinned issuer JWKS paths and rejects everything else. Production signature, issuer, audience, claim, role, and scope verification remain intact. No real secrets, external-network dependencies, or remote changes are involved.

覆盖：空平台 unknown、公开入口无管理/证据路由、匿名拒绝、viewer 写入拒绝、机器 JWT scope 拒绝、管理员注册服务与保留策略、维护变更后公共状态立即反映 maintenance、公开响应隐藏操作者。
Coverage: empty platform unknown; no public admin/evidence routes; anonymous denial; viewer write denial; machine JWT scope denial; administrator service/retention bootstrap; maintenance immediately visible in public state; actor hidden from public responses.

边界：不证明真实 Cloudflare Access 配置、远端 D1、供应商遥测后端、地理独立区域、完整队列或部署产物字节生命周期。其他集成测试提供额外证据，而不是由此测试推断。
Limits: this does not prove deployed Cloudflare Access configuration, remote D1, vendor telemetry backends, geographically independent regions, complete queue delivery, or deployment artifact byte lifecycle. Separate tests provide additional evidence; this suite must not be used to infer those guarantees.

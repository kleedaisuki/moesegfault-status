# Named Rust AdminRpc / 命名 Rust 管理能力

This crate is compiled separately from `status-worker`. Its worker-build-generated default class contains the 27 fixed Rust RPC functions and must only be re-exported as the named `AdminRpc` entrypoint of the final multi-module Worker.

此 crate 与 `status-worker` 分别编译。worker-build 自动生成的默认类包含 27 个固定 Rust RPC 函数，最终多模块 Worker 必须仅将其作为命名 `AdminRpc` 重新导出。

```javascript
// 仅模块装配，没有业务逻辑。 / Module assembly only, no business logic.
export { default } from "./public.js";
export { default as AdminRpc } from "./admin.js";
```

Never copy the admin functions into the public default class, and never add a public HTTP RPC dispatcher. `BOOTSTRAP_MODE=true` disables every normal admin method before domain execution or D1 lookup. The Cloudflare `env` import is accessed only within invocation execution; callers cannot supply bindings through arguments.

禁止将管理方法复制到公开默认类，禁止添加公开 HTTP RPC 分派。`BOOTSTRAP_MODE=true` 在领域执行或 D1 获取之前拒绝全部普通管理方法。Cloudflare `env` 仅在 invocation 中访问，调用参数不能提供 bindings。

Input first becomes `serde_json::Value` so subsequent typed domain parsing enforces unknown-field rejection. Output uses `Serializer::json_compatible()` so RPC transports plain objects, not JS Maps. Each domain service independently authorizes and validates commands; shared native spans/logging carry deployment provenance but no command bodies.

输入先转为 `serde_json::Value`，后续领域类型解析严格拒绝未知字段；输出采用 `Serializer::json_compatible()`，确保 RPC 传输普通对象而非 JS Map。每个领域服务独立执行权限及命令校验；共享原生 span/日志携带部署来源，不记录命令正文。

## Local verification / 本地验证

```powershell
worker-build crates/status-worker --release --no-opt
worker-build crates/admin-rpc-worker --release --no-opt
node node_modules/vitest/vitest.mjs run tests/admin-rpc-rust.test.ts
```

The tests load both independently compiled production Wasm modules in one real workerd Worker. They verify all named/default method boundaries, all bootstrap denials, real migrated D1 health, service creation/read persistence, authorization and safe missing-record errors. No domain result is mocked.

测试在真实 workerd Worker 内加载两个独立编译的生产 Wasm 模块，逐项验证全部命名/默认入口隔离、bootstrap 拒绝、真实迁移 D1 健康、服务创建/读取持久化、权限及安全缺记录错误；不 mock 领域结果。

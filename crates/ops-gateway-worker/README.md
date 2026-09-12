# Rust operations gateway / Rust 运维网关

This Worker is the browser-facing Rust boundary. It authenticates Access using the shared Rust verifier, enforces same-origin/custom-header CSRF protection, limits actual streamed JSON to 32 KiB, and maps 28 allowlisted HTTP routes to session data or 27 fixed named private RPC capabilities.

此 Worker 是浏览器侧 Rust 边界：复用 Rust Access 验证器，强制同源与自定义 CSRF 请求头，按实际流字节限制 JSON 为 32 KiB，并把 28 条固定 HTTP 路由映射到会话或 27 个命名私有 RPC 能力。

## Private binding / 私有绑定

`STATUS` must bind to the status Worker's named `AdminRpc` entrypoint. `Fetcher::into_rpc` exposes that private capability directly. There is no `fetch` fallback, arbitrary browser-selected method, public RPC URL, or password/JWT implementation in this crate. Domain handlers independently validate their typed commands and authorize the principal; the gateway validates the response envelope and correlation identity.

`STATUS` 必须绑定 status Worker 的命名 `AdminRpc` 入口。`Fetcher::into_rpc` 直接调用私有能力；没有 HTTP 回退、浏览器任意选方法、公开 RPC 地址或重复密码学实现。领域服务独立校验强类型命令并授权；网关校验响应结构与关联身份。

Configuration variables: `OPS_ORIGIN`, `ACCESS_ISSUER`, `ACCESS_AUDIENCE`, `ACCESS_MAX_TOKEN_AGE_SECONDS`, `ACCESS_ROLE_MAPPING`, and the shared telemetry deployment provenance variables. No deployment routes are changed by this implementation.

配置变量包括上述 Origin/Access 项及共享遥测部署来源字段。本实现不切换部署路由。

## Build and validation / 构建验证

```powershell
cargo test -p status-backend gateway --lib
worker-build crates/ops-gateway-worker --release --no-opt
node node_modules/vitest/vitest.mjs run tests/gateway-rust.test.ts
```

The workerd test uses real independently signed Access tokens and an isolated named RPC fixture to verify HTTP projection, guards and private transport. It does not claim to test domain persistence (owned by each administrative service's tests).

workerd 测试使用独立签名的真实 Access token 与命名 RPC fixture，验证 HTTP 投影、防护及私有传输；领域持久化由对应服务测试负责。

Release builds retain DWARF for the release pipeline to split into private symbol artifacts; never publish private debug artifacts as browser assets.

发布构建保留 DWARF，供流水线分离为私有符号产物；不得作为浏览器资源公开。

## References / 依据

- [Cloudflare production best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/): bindings rather than public network calls, streaming boundaries, invocation-local state.
- [Cloudflare RPC service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/): named WorkerEntrypoint capability model.
- Workers Rust SDK 0.8.5 `src/fetcher.rs`, inspected locally: `Fetcher::into_rpc<T: JsCast>`.

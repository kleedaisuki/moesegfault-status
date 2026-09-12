# moeSegFault Status

Rust 实现的 Cloudflare Workers 运维后端，TypeScript 实现的运维前端。 / A Rust Cloudflare Workers operations backend with a TypeScript operations frontend.

**Rust 后端迁移及本地验收已完成；不能把本地测试当作线上部署证明。远端 D1 的 8 个迁移已应用；应用尚未完成云端发布，R2 尚未开通。** / **Rust backend migration and local acceptance are complete; local tests are not production evidence. Eight remote D1 migrations are applied; application cloud release and R2 provisioning remain outstanding.**

统一验收命令与边界见 [Rust 验收记录](docs/rust-acceptance.md)。 / See the [Rust acceptance record](docs/rust-acceptance.md) for consolidated checks and limitations.

## 结构 / Structure

| 路径 / Path                 | 职责 / Responsibility                                                                                                                          |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `crates/status-domain`      | 无 I/O 领域规则，后端直接调用 / Pure domain rules called directly by Rust                                                                      |
| `crates/status-backend`     | HTTP、认证、D1、管理、诊断、调度、探针、R2、遥测和通知 / Backend application and platform logic                                                |
| `crates/status-worker`      | status 的公开 HTTP、Queue 与 Cron 入口 / Public HTTP, Queue and Cron entrypoints                                                               |
| `crates/admin-rpc-worker`   | 同一个 status Worker 的独立命名私有 RPC 模块 / Separate named private RPC module in the same status Worker                                     |
| `crates/ops-gateway-worker` | Rust Access/CSRF 管理网关 / Rust administrative trust boundary                                                                                 |
| `crates/probe-worker`       | Rust 私有区域探针 / Rust private regional executor                                                                                             |
| `crates/status-build`       | SDK 构建、模块组装、运行字节与调试符号分离 / SDK build, assembly and symbol separation                                                         |
| `crates/status-release`     | 来源、实际上传字节审计、上传及 ready 发布门禁 / Provenance, byte audit, uploads and release gates                                              |
| `crates/diagnostic-client`  | Rust 诊断生产者 SDK：资源绑定、脱敏与有界尽力投递 / Rust diagnostic producer SDK: resource binding, redaction and bounded best-effort delivery |
| `apps/ops`                  | TypeScript 运维 UI / TypeScript operations UI                                                                                                  |
| `packages/contracts`        | 前端类型、契约测试与 OpenAPI；不是服务器验证实现 / Frontend types, contract tests and OpenAPI, not server validation                           |
| `migrations`                | D1 schema 迁移 / D1 schema migrations                                                                                                          |
| `tests`                     | Rust、SQLite、workerd 与 TypeScript 测试驱动 / Native, SQLite and workerd validation; TypeScript test drivers                                  |
| `workers`                   | 部署配置和操作说明，不承载 TypeScript 后端业务 / Deployment configuration and runbooks, not TypeScript backend business logic                  |

后端诊断生产者 SDK 也使用 Rust，旧 TypeScript diagnostic-client/telemetry 不属于目标架构。生成的 JavaScript 仅用于官方 SDK 胶水与声明式模块导出；没有手写 TypeScript 业务转发层。 / The backend diagnostic producer SDK is also Rust; legacy TypeScript diagnostic-client/telemetry packages are not part of the target architecture. Generated JavaScript is SDK glue and declarative module exports, not a handwritten TypeScript business forwarding layer.

## 本地开发 / Local development

需要 Node.js 24+、pnpm 12.4.1、Python 3.13+、Stable Rust、`wasm32-unknown-unknown` 和平台链接器。 / Requires Node.js 24+, pnpm 12.4.1, Python 3.13+, Stable Rust, the WASM target and a platform linker.

```sh
pnpm install --frozen-lockfile
rustup target add wasm32-unknown-unknown
cargo install worker-build --version 0.8.5 --locked
# 构建全部 Rust Worker；不是部署。 / Build all Rust Workers, without deploying.
pnpm build:backend
cargo fmt --all -- --check
cargo test --workspace
# 构建真实测试 Worker 后运行平台测试。 / Build actual test Workers before platform tests.
pnpm build:rust-runtime
pnpm test
pnpm test:database
pnpm typecheck
pnpm contracts:check
pnpm openapi:lint
pnpm deploy:check
```

忽略的 `.dev.vars` 只放本地测试配置；`CURSOR_SIGNING_KEY` 至少 32 字符，不复制生产密钥。缺失机器身份配置时拒绝机器写入。Ops 需要同源 Rust gateway 和真实 Access 配置；无依赖时不得伪造登录或绿色健康状态。 / Use ignored `.dev.vars` for local-only configuration, including a random cursor key of at least 32 characters; never copy production secrets. Missing authentication fails closed. Ops requires its same-origin Rust gateway and Access, not simulated login or health.

## 发布与验收 / Release and acceptance

- [Rust 架构与验证边界 / Rust architecture and evidence](docs/rust-backend-migration.md)
- [生产运维手册 / Operations](docs/operations.md)
- [Rust 发布流程 / Rust release](scripts/release/rust-release-README.md)
- [数据库 / Database](docs/database.md)
- [实现决策 / Decisions](docs/implementation-decisions.md)
- 原始需求 / Source requirements: [服务设计](docs/status-design.md)、[可观测性标准](docs/observability-standard.md)

D1 保存事务状态；R2 保存产物与符号，二者不是“更顺手”的替代选择。不要裸运行 `wrangler deploy` 绕过来源和 ready 门禁，也不要因配置里存在绑定就认为资源或凭据已可用。 / D1 holds transactional state; R2 holds artifacts and symbols. They are complementary, not interchangeable. Never bypass release gates with bare deployment or infer provisioning from configuration alone.

## 许可证 / License

GNU General Public License version 3；参见 / see [LICENSE](LICENSE).

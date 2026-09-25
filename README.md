# moeSegFault Status

**Retired on 2026-09-25.** The three project Workers were deleted, and the `status.moesegfault.dev` and `ops.moesegfault.dev` custom domains were detached. These endpoints are no longer available. The deployment and integration instructions below are historical; see [decommission record](docs/decommission-2026-09-25.md).

Rust 实现的 Cloudflare Workers 运维后端，TypeScript 实现的运维前端。 / A Rust Cloudflare Workers operations backend with a TypeScript operations frontend.

**截至 2026-09-12，三个 Rust Worker 已通过 GitHub Actions 发布并激活，真实浏览器登录、跨域读取及注销已验证；尚未登记外部监控目标或启用通知。** / **As verified on 2026-09-12, all three Rust Workers were released through GitHub Actions and activated; real browser login, cross-origin reads and logout passed. External monitor targets and notifications remain unconfigured.**

统一验收命令与边界见 [Rust 验收记录](docs/rust-acceptance.md)。 / See the [Rust acceptance record](docs/rust-acceptance.md) for consolidated checks and limitations.

## 接入与交接 / Integration and handoff

- [调用者接入指南 / Caller integration guide](docs/integration-guide.md)：入口、认证、调用与重试。 / Endpoints, authentication, calls and retries.
- [项目上下文交接 / Project context handoff](docs/project-handoff.md)：架构、代码导航、已验证状态和维护边界。 / Architecture, source navigation, verified state and maintenance boundaries.

## 结构 / Structure

| 路径 / Path                 | 职责 / Responsibility                                                                                                                          |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `crates/status-domain`      | 无 I/O 领域规则，后端直接调用 / Pure domain rules called directly by Rust                                                                      |
| `crates/status-backend`     | HTTP、认证、D1、管理、诊断、调度、探针、R2、遥测和通知 / Backend application and platform logic                                                |
| `crates/status-worker`      | status 的公开 HTTP、Queue 与 Cron 入口 / Public HTTP, Queue and Cron entrypoints                                                               |
| `crates/admin-rpc-worker`   | 同一个 status Worker 的独立命名私有 RPC 模块 / Separate named private RPC module in the same status Worker                                     |
| `crates/ops-gateway-worker` | Rust owner 会话/CSRF 管理网关 / Rust administrative trust boundary                                                                             |
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

忽略的 `.dev.vars` 只放本地测试配置；`CURSOR_SIGNING_KEY` 至少 32 字符，不复制生产密钥。缺失机器身份配置时拒绝机器写入。Ops 需要同源 Rust gateway 与预配置 owner 密码会话；无依赖时不得伪造登录或绿色健康状态。 / Use ignored `.dev.vars` for local-only configuration, including a random cursor key of at least 32 characters; never copy production secrets. Missing authentication fails closed. Ops requires its same-origin Rust gateway and preconfigured owner-password session, not simulated login or health.

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

## 单管理员与部署职责 / Single owner and deployment duties

管理员仅一人：预配置随机口令登录/退出，无注册、setup 或改密 UI，无 Cloudflare Access。派生记录只存 Worker Secret `ADMIN_PASSWORD_RECORD`；本地凭据位于被 Git 忽略的 `.local/credentials/`，不进入代码、GitHub 或聊天。 / One owner uses a pre-generated random credential without registration, setup, password-change UI or Access. The verifier lives in a Worker Secret; local credentials remain in ignored `.local/credentials/`, never source control, GitHub or chat.

Ops UI 使用同一个 Rust gateway Worker 的 Static Assets，`/api/*` 进入 Rust。GitHub 只发布 Worker 版本；本机 CLI 管理 Custom Domain/触发器，Cloudflare 自动配置对应 DNS 与证书。全部 9 个 D1 迁移已在远端应用且完整性检查通过；`0009` 保存会话摘要与登录预算，不保存密码。 / Ops assets share the Rust gateway Worker, with API paths entering Rust. GitHub publishes versions; local CLI manages domains/triggers. All nine remote migrations and integrity checks passed; migration 0009 stores sessions and login budgets, not passwords.

上传通过机器 JWT 认证的 Rust Worker PUT 使用原生 R2 binding，无需 S3 凭据；完整 commit/ready 门禁保留。通知默认关闭，外部待发事件保留；外部遥测凭据可选。平台发布不代表外部服务健康，实际证据见 [部署记录](docs/deployment-status.md)。 / Authenticated Rust Worker PUT uses native R2 without S3 credentials and retains commit/readiness. Notifications remain disabled with pending events retained; external telemetry credentials are optional. Platform publication is not evidence of external service health; see the deployment record.

**应用部署（包括 bootstrap）只走 GitHub Actions；本机不上传应用代码。** 本机仅管理 DNS、Secrets、平台资源并测试。不要将历史 bootstrap 记录或配置文件当作当前运行状态。 / **GitHub Actions exclusively deploys application code, including bootstrap.** Local operations manage DNS, Secrets and platform resources and run tests. Historical bootstrap entries and configuration files do not prove current runtime state.

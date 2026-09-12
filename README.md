# moeSegFault Status

基于 Stable Rust、TypeScript 与 Cloudflare Workers 的运维领域服务。 / An operations-domain service built with Stable Rust, TypeScript, and Cloudflare Workers.

**代码实现与本地验收已完成，尚未部署线上服务。远端 D1 仅已创建，迁移没有应用到远端。** / **Implementation and local acceptance are complete; no production Worker is deployed and remote D1 migrations have not been applied.**

## 结构 / Structure

| 路径 / Path                  | 职责 / Responsibility                                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `crates/status-domain`       | 无 I/O Rust 领域核心、状态机、策略、指纹、来源校验 / Pure Rust domain rules                                      |
| `packages/domain-wasm`       | Workers WASM 初始化与 JSON 调度桥 / Workers WASM bridge                                                          |
| `packages/contracts`         | 共享 Zod schema、类型与生成的 OpenAPI 3.1.1 / Shared schemas and generated OpenAPI                               |
| `packages/telemetry`         | 执行上下文、脱敏、日志、采样与有界导出 / Context, redaction, logs, sampling, bounded export                      |
| `packages/diagnostic-client` | 资源绑定、脱敏及有界诊断投递客户端 / Resource-bound redacted diagnostic producer                                 |
| `workers/status`             | 公共 HTTP、私有 AdminRpc、D1/Queue/R2、调度 / Platform adapters and authoritative state                          |
| `workers/ops-gateway`        | Access JWT、CSRF、管理 Service Binding / Administrative trust boundary                                           |
| `workers/probe-executor`     | 私有区域探针及真实执行来源校验 / Private regional probes with verified execution provenance                      |
| `apps/ops`                   | GitHub Pages 无状态管理前端 / Stateless administrative UI                                                        |
| `migrations`                 | 编号 D1 schema 迁移 / Numbered D1 schema migrations                                                              |
| `tests/integration`          | 真实 SQLite + Rust WASM 跨模块验证 / Real SQLite and Rust WASM integration tests                                 |
| `tests/runtime`              | 真实 workerd、D1、WASM、JWT 与 Service Binding 验收 / Real workerd, D1, WASM, JWT and Service Binding acceptance |
| `scripts/release`            | 来源清单、上传、ready 门禁与发布 / Provenance and readiness-gated release                                        |

## 本地开发 / Local development

需要 Node.js 24 或更新版本、pnpm 12.4.1、Python 3.13+、Stable Rust 及平台 C/C++ 链接器。 / Requires Node.js 24+, pnpm 12.4.1, Python 3.13+, Stable Rust, and the platform C/C++ linker.

```sh
# 安装锁定的 JS 依赖。 / Install locked JS dependencies.
pnpm install --frozen-lockfile

# 编译核心；CLI 版本必须与 Cargo.lock 中的 wasm-bindgen 一致。 / CLI must match wasm-bindgen in Cargo.lock.
cargo install wasm-bindgen-cli --version 0.2.128 --locked
node scripts/build-wasm.mjs

# 全部自动检查。 / Automated checks.
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace
pnpm typecheck
pnpm test
pnpm test:database
pnpm contracts:check
pnpm openapi:lint
pnpm format:check
pnpm build
```

首次本地运行，在根目录 `.dev.vars` 设置随机 `CURSOR_SIGNING_KEY`（至少 32 字符）。不要使用真实 production 凭据作为本地示例。R2 S3 上传测试另需受限凭据；未配置机器 issuer 的本地环境拒绝公网机器写入。 / Set a random `CURSOR_SIGNING_KEY` of at least 32 characters in ignored `.dev.vars`. Do not copy production credentials for local development. R2 S3 uploads require separately scoped credentials; unconfigured machine authentication fails closed.

```sh
pnpm db:migrate:local
pnpm --filter @moesegfault/status dev
pnpm --filter @moesegfault/ops dev
```

Ops 管理接口需要同源 gateway 和 Access 配置。独立打开 UI 而没有管理网关时，显示“监控系统不可用”是预期行为，不应伪造登录或绿色状态。 / Ops requires the same-origin gateway and Access configuration. An unavailable banner without those dependencies is intentional, not a simulated login or healthy status.

## 发布边界 / Release boundary

- 不直接执行裸 `wrangler deploy` 绕过来源与 ready 门禁。 / Do not bypass provenance/readiness gates with a bare deployment.
- 本地默认配置不包含真实身份服务、遥测后端或 production 密钥。 / Local defaults do not contain real identity/telemetry services or production secrets.
- 生产配置与运维流程见 [运行手册](docs/operations.md)。 / See the operations runbook for production configuration.
- 完整需求见 [服务设计](docs/status-design.md) 与 [可观测性标准](docs/observability-standard.md)。 / The supplied designs remain the authoritative requirements.
- 数据库不变量和演进验证见 [数据库说明](docs/database.md)。 / Database invariants and migration checks are documented separately.
- 实现决策及验收边界见 [实现决策](docs/implementation-decisions.md)。 / Implementation decisions distinguish code evidence from production validation.

## 许可证 / License

GNU General Public License version 3；参见 [LICENSE](LICENSE)。 / GNU General Public License version 3; see LICENSE.

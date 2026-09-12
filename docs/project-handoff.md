# 项目上下文交接 / Project context handoff

面向接手开发者与 Agent；这是架构、操作边界与证据入口，不包含凭据。整理日期：2026-09-12。 / For incoming developers and agents: architecture, operational boundaries and evidence, without credentials. Prepared on 2026-09-12.

## 1. 先读这些 / Start here

1. 本文理解上下文；接口使用见 [调用者接入指南](integration-guide.md)。 / Read this context first; use the caller guide for integration.
2. [最终生产验收](deployment-status.md#最终生产验收--final-production-acceptance) 是已执行上线的证据入口。 / Final production acceptance records executed rollout evidence.
3. [运维手册](operations.md)、[发布工具说明](../scripts/release/rust-release-README.md) 解释操作；[实现决策](implementation-decisions.md) 与 [原始设计](status-design.md) 解释意图。 / Operations and release documentation describe procedures; decisions and original design explain intent.

**冲突处理：实际行为以当前源码、契约与可复现测试为依据；部署状态以最近有时间与回执的验收记录为依据。** 原始设计、历史截点、未勾选旧清单不等于当前实现或未完成工作。`deployment-status.md` 的最终验收明确取代下方早期“仍在引导、Cron 未启用”的记录；发现其他矛盾应核验并修正文档，不靠推测更改生产。本文不代表重新实时查询了云端。 / **Resolve conflicts using current code, contracts and reproducible tests for behavior, and the latest dated acceptance receipts for deployment state.** Historical designs, cutoffs and unchecked old lists do not prove current implementation or outstanding work. Final acceptance supersedes earlier bootstrap and disabled-Cron entries. Investigate other discrepancies before changing production. This handoff is not a new live cloud inspection.

## 2. 项目是什么 / What this project is

这是 Cloudflare 上的状态与运维控制面（Control Plane）：维护服务目录、部署来源、状态证据、诊断及管理操作。**业务后端全部 Rust，浏览器运维前端 TypeScript。** 不引入 TypeScript 后端转发层；构建生成的 JavaScript 是 Workers SDK 胶水和模块导出，不是第二套业务实现。 / This Cloudflare status and operations control plane maintains service catalog, deployment provenance, status evidence, diagnostics and administration. **Business backends are Rust; the browser operations UI is TypeScript.** Generated JavaScript is SDK glue and module exports, not a second business backend.

```text
浏览器 / Browser
  ├─ public GET ───────────────────> status.moesegfault.dev
  └─ UI + /api/* ──> ops.moesegfault.dev (Rust gateway + Static Assets)
                         └─ STATUS binding / private AdminRpc ──> status Worker
GitHub Actions ── machine JWT ───────────────────────────────────> status Worker
                                                                  ├─ DB → D1
                                                                  ├─ ARTIFACTS → private R2
                                                                  └─ Cron / diagnostics queue
私有探针 / Private probe: moesegfault-probe-asia
  已发布，目标与区域映射尚未配置 / Published; targets and regional mapping unconfigured
```

| 入口 / Entry                     | 平台名称 / Platform name  | 边界 / Boundary                                                                                                   |
| -------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `https://status.moesegfault.dev` | `moesegfault-status`      | 公开读取与机器写入；管理 RPC 不公开 / Public reads and authenticated machine writes; no public administrative RPC |
| `https://ops.moesegfault.dev`    | `moesegfault-ops-gateway` | 静态 UI、会话与管理网关；`/api/*` 先运行 Rust / Static UI, sessions and administration; API paths run Rust first  |
| 无公开域名 / No public domain    | `moesegfault-probe-asia`  | 私有探针执行器；发布不等于已配置探测链路 / Private executor; publication does not establish configured probing    |

默认 `workers.dev` 与预览地址禁用。域名前缀是 `status`，不是 `moesegfault-status`。 / Default and preview URLs are disabled. The public hostname prefix is `status`, not the Worker name.

## 3. 代码导航与状态所有权 / Code map and state ownership

| 位置 / Location                                    | 从这里修改什么 / Responsibility                                                                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crates/status-domain`                             | 无 I/O 领域规则、不变量 / Pure domain rules and invariants                                                                                                          |
| `crates/status-backend/src`                        | `public`、`auth`、`admin_auth`、`gateway`、`admin`、`deployments`、`diagnostics`、`scheduling`、`probes`、`telemetry`、`notifications` 的实现 / Application modules |
| `crates/status-worker`、`crates/admin-rpc-worker`  | 同一 status Worker 的公开入口与命名私有 RPC（Remote Procedure Call） / Public entry and named private RPC in the same Worker                                        |
| `crates/ops-gateway-worker`、`crates/probe-worker` | Rust 管理网关、私有探针入口 / Rust administrative gateway and private probe entry                                                                                   |
| `crates/status-build`、`crates/status-release`     | 真实字节构建、调试符号、不可变清单、上传审核与发布门禁 / Actual-byte builds, symbols, immutable inventories and release gates                                       |
| `crates/diagnostic-client`                         | Rust 诊断 SDK；有界、脱敏、尽力投递 / Bounded, redacted, best-effort Rust diagnostics SDK                                                                           |
| `apps/ops`                                         | TypeScript UI；上游 `moesegfault-style` 固定版本位于 `vendor` / UI with pinned upstream style assets                                                                |
| `packages/contracts`                               | 类型、OpenAPI 与契约测试；不是后端验证器 / Types, OpenAPI and tests, not backend validation                                                                         |
| `migrations`、`tests/database`                     | 编号 schema 迁移与 SQL 不变量验证 / Numbered migrations and SQL invariants                                                                                          |
| `tests`、`.github/workflows`                       | 真实 workerd 驱动、CI、迁移和发布 / Real runtime drivers, CI, migration and release                                                                                 |

**D1 是领域状态的权威数据源；R2 是私有产物存储，不互相替代。** D1 保存部署状态、修订号、审计、事务发件箱（Transactional Outbox）和会话摘要；R2 保存产物与符号。管理变更保持事务边界、修订冲突检查和幂等性（Idempotency），不要手工 SQL 伪造 `ready`/`active` 或健康观测。 / **D1 is authoritative domain state; R2 holds private artifacts, not a substitute database.** Preserve transaction boundaries, revision checks, audit/outbox and idempotency. Never manufacture readiness, activation or health using SQL.

原生 R2 上传路径：Actions 用机器 JWT（JSON Web Token）访问 Rust 上传接口，Worker 通过 `ARTIFACTS` 绑定（Binding）访问桶。服务端保留归属、权限、过期、禁止覆盖和摘要校验，提交通过后才能就绪；原生 `DigestStream` 处理流式摘要。**无需 S3 Access Key、预签名 URL 或公开桶；JWT 由 Worker 验证，不由 R2 验证。** / Native R2 uploads authenticate at the Rust API, which accesses the private bucket through its binding. Ownership, scope, expiry, non-overwrite and integrity gates remain enforced before readiness. No S3 credentials, presigned URLs or public bucket are needed; JWT authentication belongs to the Worker, not R2.

## 4. 身份、凭据和隐私 / Identity, credentials and privacy

| 配置位置 / Location                                      | 名称或用途 / Names or purpose                                                                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| GitHub Secrets                                           | `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN`、`MACHINE_JWT_PRIVATE_KEY`、`CURSOR_SIGNING_KEY`                                     |
| status Worker Secrets                                    | `ADMIN_EMAIL`、`ADMIN_PASSWORD_RECORD`、`CURSOR_SIGNING_KEY`                                                                         |
| 被 Git 忽略的仓库目录 / Git-ignored repository directory | `.local/credentials/administrator-login.txt`：本机管理员凭据，只由操作者读取 / Local administrator credentials, operator access only |
| 公开源码 / Public source                                 | `config/machine-jwks.json`：只含公钥集合（JSON Web Key Set, JWKS） / Public keys only                                                |

- Cloudflare Token 授权平台发布；机器私钥签发最长 15 分钟、绑定部署/服务/环境/权限的 JWT；管理员口令用于浏览器会话。这三者不能互换。当前自己的精确 issuer/JWKS 配置使用编译内置公钥，避免自请求依赖；轮换必须协调信任公钥和私钥，不能只改 GitHub Secret。 / Platform token, machine signing key and browser password have separate trust boundaries. Own-issuer verification uses compiled pinned keys for the exact configuration; coordinate both sides of key rotation.
- 单管理员，没有 Cloudflare Access、首次访问者认领、注册或改密 UI。私有 `AdminRpc` 只通过服务绑定调用；网关维护安全 Cookie 和来源/跨站请求伪造（Cross-Site Request Forgery, CSRF）检查。 / One preconfigured owner; no Access, first-visitor claim, registration or password-change UI. Private service-bound RPC and gateway cookie/Origin/CSRF checks remain mandatory.
- 本机脚本 [`admin-secret.mjs`](../scripts/operations/admin-secret.mjs) 管理凭据；默认目录不是 AppData。已有凭据不要重新 `create`；轮换是明确的运维动作，按手册执行并验证旧会话失效。`.gitignore` 不是加密，也不能保护已被跟踪的文件。 / The local helper uses the ignored repository directory, not AppData. Do not regenerate existing credentials casually. Rotation is an explicit operation with session-revocation verification; Git ignore is neither encryption nor protection for tracked files.
- 管理员身份可能在受认证响应中供内部使用，但 UI 不展示邮箱。不要把邮箱、口令、私钥、Cookie 或完整敏感响应写进源码、文档、提交、日志、截图或聊天。 / Private identity may exist in authenticated responses, but the UI must not render the email. Never record credentials or sensitive responses in source, documentation, commits, logs, screenshots or chat.

## 5. 已验收与未启用 / Accepted state and disabled capabilities

以下是 [2026-09-12 最终生产验收](deployment-status.md) 的记录，不是承诺它永远不变。 / These are dated acceptance observations, not permanently asserted live state.

| 项目 / Item                      | 记录状态 / Recorded state                                                                                                                                                                                                                |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| status `0.1.2`                   | [Actions 34701836331](https://github.com/kleedaisuki/moesegfault-status/actions/runs/34701836331)，已发布并激活 / Released and active                                                                                                    |
| ops `0.1.0`                      | [Actions 34700970772](https://github.com/kleedaisuki/moesegfault-status/actions/runs/34700970772)，已发布并激活 / Released and active                                                                                                    |
| probe `0.1.0`                    | [Actions 34700972438](https://github.com/kleedaisuki/moesegfault-status/actions/runs/34700972438)，已发布并激活 / Released and active                                                                                                    |
| 端到端 / End to end              | 真实 Chrome 登录、私有读取、固定来源跨域资源共享（Cross-Origin Resource Sharing, CORS）、注销及旧 Cookie 拒绝均通过 / Browser login, private reads, CORS, logout and revoked-cookie rejection passed                                     |
| 数据与调度 / Data and scheduling | 9 个迁移、3 个内部服务身份；每分钟 Cron 与 diagnostics consumer 已配置 / Nine migrations, three internal service identities, per-minute Cron and diagnostics consumer configured                                                         |
| 尚未启用 / Not enabled           | 零监控器与公开组件；没有目标主机；区域映射与外部遥测配置为空；通知关闭、待发事件保留 / No monitors, components or target hosts; empty regional and external telemetry configuration; notifications disabled with pending events retained |

**没有登记监控对象不等于对象健康；私有探针上线不等于真实地域探测已经验证。** `placement` 配置不单独构成地域证据。外部遥测未配置也不等于平台日志被关闭。 / **No monitored targets is not healthy-target evidence; a published probe is not verified geographic execution.** Placement configuration alone proves neither location nor actual execution. External telemetry being unconfigured does not mean platform observability is disabled.

## 6. 发布职责与操作顺序 / Release duties and sequence

1. 测试并提交实际源码，确认对应 CI；[`deploy.yml`](../.github/workflows/deploy.yml) 在 `main` 手动选择 `status`、`ops` 或 `probe` 和不可变版本。它不是完整 CI 的替代品。 / Test and commit, check the matching CI, then manually dispatch a selected service and immutable version on main. Release is not a substitute for full CI.
2. 需要 schema 变更时使用 [`migrate.yml`](../.github/workflows/migrate.yml)：保存恢复书签、应用编号迁移、检查远端账本和完整性。它与发布是两个独立工作流，不会自动串联。 / Use the separate migration workflow when needed; it records a recovery bookmark, applies migrations and checks remote integrity. Release does not automatically invoke it.
3. Actions 构建真实字节，登记部署，上传/提交产物，满足 `ready` 门禁后才发布准确版本。日志管道必须传播失败，不能只看绿色图标；检查 `release-completed` 回执。 / Actions builds actual bytes, registers and verifies artifacts, then publishes the exact version after readiness. Preserve pipeline failures and inspect the receipt, not only the green badge.
4. 发布后真实验证公开 API、浏览器登录/读取/注销，再由管理员读取最新激活上下文并显式激活。**平台版本发布与 D1 权威指针激活是两件事，发布 JWT 没有管理员激活权限。** / Verify public and browser paths, then perform revision-checked owner activation. Platform rollout and authoritative activation are separate; the release JWT cannot activate.
5. **所有应用代码发布，包括首次 bootstrap，都走 Actions。** 本地 CLI 仅做资源、Secrets、域名/DNS、触发器及核验；Actions 不管理 DNS。已有生产服务不得重新 bootstrap 绕过就绪门禁。 / **All application code publication, including bootstrap, uses Actions.** Local CLI manages resources, secrets, DNS/domains, triggers and verification. Do not bootstrap an established production service to bypass readiness.

部署配置中的开发默认值与空来源字段不是生产事实；构建/发布工具注入真实生产来源。不要直接执行裸 `wrangler deploy`，也不要因为配置文件有绑定便宣称资源已创建。 / Development defaults and empty provenance fields are templates, not production state; build/release injects real provenance. Never deploy bare or infer resource existence from configuration.

## 7. 本地验证入口 / Local verification

工具版本与命令源于 [`package.json`](../package.json) 和 [`ci.yml`](../.github/workflows/ci.yml)：Node.js 24+、pnpm 12.4.1、Python 3.13+、stable Rust、Wasm 目标、`worker-build` 0.8.5。 / Toolchain and commands are defined in the package manifest and CI.

```sh
pnpm install --frozen-lockfile
rustup target add wasm32-unknown-unknown
cargo install worker-build --version 0.8.5 --locked
cargo fmt --all -- --check
cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
cargo test --locked --workspace

# 先构建前端，再生成真实 Worker 与产物清单。 / Build UI before Workers and inventories.
pnpm build:frontend
pnpm build:backend
cargo test --locked -p status-build -- --include-ignored
cargo test --locked -p status-release -- --include-ignored
pnpm build:rust-runtime
pnpm test
pnpm test:database
pnpm typecheck
pnpm contracts:check
pnpm openapi:lint
pnpm format:check
# 仅离线 dry-run，不发布。 / Offline dry-run only; no publication.
pnpm deploy:check
```

平台代码还需运行 CI 中的 `wasm32-unknown-unknown` Clippy；原生测试成功不能替代真实 workerd 或云端验证。Windows 上每条命令检查退出码；PowerShell 的 `;` 不自动失败即停止。全局 pnpm 不可用时可用 `npx --yes pnpm@12.4.1 <命令>`，不修改锁文件凑环境。 / Run the CI Wasm Clippy target too; native tests do not replace workerd or cloud evidence. Check each exit status on Windows because semicolon chaining is not fail-fast. A pinned npx pnpm invocation is an alternative to a broken global installation, not a reason to alter lockfiles.

## 8. 接手后的优先事项与禁区 / Next work and guardrails

- 先明确任务影响的是契约、状态还是运维配置；检查相应模块与测试，按文件区域协作，避免覆盖并发改动。 / Identify the contract, state or operations boundary; inspect its implementation and tests, and keep concurrent edits scoped.
- 用户提供首个真实服务后，再配置目标白名单（Allowlist）、协议/端口、区域绑定和监控策略，验证真实执行与证据。没有需求时不预填宽泛主机或虚假组件。 / Configure hosts, protocols, ports, regional bindings and monitor policy only for real targets, then verify execution and evidence.
- 用户确定通知/遥测目标后再启用集成，验证投递、失败、重试与死信队列（Dead-Letter Queue, DLQ）；不能把 pending 改成已发送来清空积压。 / Enable integrations only with real destinations and verified delivery/failure/retry/DLQ behavior; never relabel pending events as delivered.
- 当前证据不覆盖所有恢复演练、持续负载、实际计费或地域部署效果；这些结论需要专门实验或当前平台查询，不能从单次发布推断。 / Existing evidence does not establish every recovery scenario, sustained-load limit, billing state or geographic behavior; investigate those separately.
- 改动涉及安全、API 或状态模型时同步维护契约、测试与交接文档。不要重新引入 Access、多管理员、S3 密钥或 TypeScript 后端，除非新需求明确改变既定边界。 / Maintain contracts, tests and documentation with security/API/state changes. Do not reintroduce Access, multiple administrators, S3 credentials or a TypeScript backend without an explicit change in requirements.

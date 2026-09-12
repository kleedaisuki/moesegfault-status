# Rust 后端架构与验收 / Rust backend architecture and acceptance

## 语言边界 / Language boundary

全部后端应用逻辑使用 Rust；TypeScript 用于运维前端、前端契约和非生产测试驱动。官方 SDK 生成的 JavaScript 负责平台 ABI（Application Binary Interface）衔接，不是手写业务层。旧 TypeScript 适配器与领域调度桥不属于目标架构，也不要求保留旧实现兼容层。 / All backend application logic is Rust. TypeScript remains for the frontend, its contracts and non-production test drivers. SDK-generated JavaScript bridges the platform ABI, not business logic; legacy adapters and dispatch bridges are not part of the target architecture.

## 模块与权限 / Modules and authority

```text
TypeScript Ops UI -> Rust ops-gateway-worker
                          | Owner session + Origin/CSRF + fixed RPC method
                          v
                 same status Worker / 同一 Worker
                 +-------------------------------------+
Public HTTP ---->| status-worker: fetch/queue/scheduled |
Private binding >| admin-rpc-worker: named AdminRpc     |
                 +------------------+------------------+
                                    v
                     status-backend -> status-domain
                         | D1 / Queue / R2 / telemetry
                         v
                      Rust probe-worker (private)
```

`status-build` 将两个独立 SDK 模块组装为同一个 status Worker 的模块图（Module Graph）：公开默认入口与命名 `AdminRpc` 分别导出，不能把含管理方法的同一个类同时别名为 default。命名入口不意味着新增一个 Worker 或另设 D1 权威源；私有管理能力也不是公网 HTTP 隧道。 / `status-build` assembles separate SDK modules into one status Worker: the public default export and named `AdminRpc` are distinct. Never alias a management-bearing class as the default. Named RPC does not introduce another Worker, database authority or public HTTP tunnel. [Cloudflare RPC](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/)

| Rust 范围 / Scope                                                                 | 实现位置 / Implementation                                                                                                |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 领域规则、直接依赖计算 / Domain and dependency evaluation                         | `status-domain`                                                                                                          |
| 机器 JWT、owner 密码/会话、请求限制、游标 / Authentication and boundaries         | `status-backend/{auth,admin_auth,http,cursor,wire}`                                                                      |
| 六个公开查询 / Six public reads                                                   | `status-backend/public`                                                                                                  |
| 管理读写、审计、幂等和原子 outbox / Admin, audit, deduplication and atomic outbox | `status-backend/admin`                                                                                                   |
| 诊断、证据查询与恢复 / Diagnostics, evidence and recovery                         | `status-backend/{diagnostics,evidence}`                                                                                  |
| 租约、评估、调度与探测 / Leases, evaluation, scheduling and probes                | `status-backend/{scheduling,probes}`                                                                                     |
| 注册、上传、ready 与首次引导 / Registration, artifacts, readiness and bootstrap   | `status-backend/{deployments,bootstrap}`                                                                                 |
| 遥测与通知 / Telemetry and notifications                                          | `status-backend/{telemetry,notifications}`                                                                               |
| 平台入口 / Platform entrypoints                                                   | `status-worker`, `admin-rpc-worker`, `ops-gateway-worker`, `probe-worker`                                                |
| 原生构建与发布工具 / Native build and release tools                               | `status-build`, `status-release`                                                                                         |
| 后端诊断生产者 SDK / Backend diagnostic producer SDK                              | `diagnostic-client`（Rust；资源绑定、脱敏、有界尽力投递 / resource binding, redaction and bounded best-effort delivery） |

模块存在不是验收通过的充分条件；最终集成以当前测试与发布检查实际结果为准。 / Module presence is not proof of acceptance; current integration tests and release checks remain authoritative.

## 平台互操作风险 / Platform interoperability risks

- **RPC 不等于普通函数。** Workers RPC 返回可等待对象（Thenable），不能要求其原生 `Promise` 品牌；调用代理方法时也不能误把 `.call` 当作本地方法。必须在真实 workerd 中验证成功返回、异常、命名与默认入口隔离。 / RPC results may be thenables rather than native Promise instances; proxy invocation must not accidentally address a remote `.call`. Test successful calls, errors and entrypoint isolation in actual workerd.
- **Map 不等于 JSON 对象。** `serde_wasm_bindgen` 默认将 map 序列化为 JS Map；JSON/RPC/Queue 平台对象边界需要明确 `Serializer::json_compatible()`，否则可能丢字段。不能凭 Rust 类型检查证明跨语言载荷正确。 / Default map serialization produces JS Map, not a plain JSON object. Use explicit JSON-compatible serialization at relevant boundaries and test field preservation. [Serde serializer](https://docs.rs/serde-wasm-bindgen/latest/serde_wasm_bindgen/struct.Serializer.html)
- **重定向会改变信任目标。** 固定 JWKS、带凭据证据查询、通知和产物上传不能依赖默认重定向行为；测试须覆盖重定向拒绝、请求及响应体截止时间，避免凭据转发。 / Redirects change trust destinations. Pinned JWKS, authenticated evidence, notifications and uploads require explicit redirect handling and request/body deadlines, rather than default behavior. [Workers Request](https://developers.cloudflare.com/workers/runtime-apis/request/)
- **D1 批处理才是提交边界。** 参数类型和可失败行解码避免精度丢失及 SDK 泛型解码 panic；读取后写入需版本/评估代数门控，领域状态、audit/outbox 和成功幂等快照一批提交。 / Typed parameters and fallible decoding avoid precision loss and panics. Reads followed by writes require revision/generation guards; domain state, audit/outbox and successful replay snapshots commit atomically. [D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- **双模块不是免费隔离。** 两套 WASM 实例可能增加代码、线性内存（Linear Memory）与冷启动（Cold Start）成本；SDK 全局错误监听也不构成故障隔离承诺。必须测最终上传/压缩字节、启动时间及真实负载，不能据语言推断性能更好。 / Two WASM instances can increase code, memory and startup costs. Global SDK error listeners do not promise fault isolation. Measure final bytes, compression, startup and workload behavior rather than assuming Rust is faster.

## 构建与发布 / Build and release

`status-build` 调用固定版本的 `worker-build`，保留独立模块目录，组装声明式导出，并将真实 DWARF（Debugging With Attributed Record Formats）符号与运行 WASM 分离。`status-release` 审计实际 Wrangler dry-run 上传字节、来源和符号对应关系，之后执行注册、上传、提交、ready 门禁和部署；注册后禁止重新构建改变字节。 / The native build tool retains separate SDK module directories and genuine debug symbols. The release tool audits actual dry-run bytes and provenance before registration, upload, commit, readiness and deployment; rebuilding after registration is forbidden.

首次引导不是跳过安全检查：注册 API 仍验证机器 JWT，其余业务入口保持不可用；部署成功后还需要烟雾测试（Smoke Test）与独立 owner 管理员激活。 / Bootstrap does not bypass authentication: registration still requires machine JWT, other business entrypoints remain unavailable, and deployment requires subsequent smoke tests and separate owner activation. See [release runbook](../scripts/release/rust-release-README.md).

## 证据与尚未证明的事项 / Evidence and limits

已执行的专项验证包含 Rust `diagnostic-client` 的原生与真实 workerd 测试、最终组装 status 产物的 workerd 入口验证，以及真实 Queue → 通知 → 死信队列（Dead-Letter Queue, DLQ）路径。后端生产者 SDK 与遥测实现统一为 Rust，旧 TypeScript 对应实现已经删除，不作为备用业务层保留。这些是本地专项证据，不代表完整测试集、GitHub Actions 或云端发布均已完成。 / Executed focused checks cover the Rust diagnostic client in native and actual workerd tests, entrypoints of the assembled status artifact, and an actual local Queue → notification → DLQ path. Backend producer SDK and telemetry implementations are Rust; superseded TypeScript implementations have been removed, not retained as a fallback business layer. These local focused checks do not establish complete-suite, GitHub Actions or cloud-release completion.

| 层级 / Layer                              | 能证明 / Demonstrates                                                 | 不能替代 / Does not replace                                                          |
| ----------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Rust 原生测试 / Native tests              | 类型、纯规则和错误路径 / Types, pure rules and failures               | WASM 与平台运行 / Platform execution                                                 |
| SQLite + 全部迁移 / SQLite and migrations | SQL 约束、回滚、并发门控模型 / Constraints, rollback and guards       | 云端 D1 运行特征 / Cloud D1 behavior                                                 |
| 实际本地 workerd / Actual local workerd   | Rust/WASM、D1、JWT、Service Binding 互操作 / Runtime interoperability | 真实会话部署、地域、外部服务及云端负载 / Cloud identity, geography, vendors and load |
| Wrangler dry-run / Dry-run                | 模块可组装与真实上传字节审计 / Assembly and upload-byte audit         | 已部署、已 ready 或已激活 / Deployment, readiness or activation                      |
| 云端验收 / Cloud acceptance               | 仅实际执行并留证的路径 / Only executed, recorded paths                | 未测试的功能和配置 / Untested functionality and configuration                        |

全部 9 个远端 D1 迁移已应用，verify-d1 验证通过，foreign_key_check 与 quick_check 无异常。R2 已开通、私有 bucket 已创建，真实云端 PUT/GET/SHA-256/DELETE 验证通过；四个队列和 producer 绑定已创建；consumer 与定时器尚未启用。完整应用生产发布尚未完成；对象级云端验证不能替代应用注册/上传/ready 闭环。最终数量统一见验收记录。 / All nine remote migrations are applied; verify-d1 passed with clean foreign_key_check and quick_check results. Private R2 passed real cloud object checks, and four queues and producer bindings exist, while consumers and timers remain disabled. Full production release is incomplete; object checks do not establish the application registration/upload/readiness path. Final counts belong to the consolidated acceptance record.

## 单 owner 与发布模型更新 / Single-owner and release model update

管理认证改为 Rust `admin_auth`：预配置密码登录/退出，无 Access、setup、注册或改密 UI。Worker secret `ADMIN_PASSWORD_RECORD` 为 PBKDF2-SHA256、600,000 次迭代、16 字节盐和 32 字节哈希。D1 0009 只保存会话摘要/记录指纹和全局 30 次/10 分钟登录预算；会话 12 小时，Secure/HttpOnly/SameSite=Strict。密码记录轮换必须将新版本切换到 100% 流量，才能全部拒绝旧记录对应会话。 / Rust admin_auth uses a preconfigured owner password, not Access or account-management UI. The secret uses PBKDF2-SHA256/600,000 iterations/16-byte salt/32-byte hash. D1 stores only session digests/fingerprints and a global login budget; secure sessions last 12 hours. A complete version cutover is required for complete old-session revocation.

TypeScript Ops UI 与 Rust gateway 共用 Static Assets 部署；GitHub 仅执行版本上传与部署，本机 CLI 执行 Custom Domain/触发器配置。机器私钥和 cursor secret 已在 GitHub，公钥配置已通过 Rust well-known 端点公开并验证一致；管理员密码仅在受 OS ACL 保护的本机文件中。Worker secret 已上传并完成新版本 100% 切换；云端登录与完整 ready 发布尚未通过，不能把 bootstrap 当作正式上线。 / Ops UI and Rust gateway share Static Assets. GitHub publishes versions; local CLI manages domains/triggers. Machine/cursor secrets are in GitHub and public JWKS is served by the Rust well-known endpoint and verified against the repository; the administrator password remains local under OS ACLs. Worker-secret installation and a full version cutover are verified; cloud login and a full readiness-gated release remain unproven.

机器发布身份当前由 Rust CLI 使用 GitHub `MACHINE_JWT_PRIVATE_KEY` 在内存签发短期 JWT；没有已部署的 OIDC 交换服务。允许本机仓库外、受 OS ACL 保护的 secret bulk JSON 预置文件；禁止将其复制到仓库、GitHub 或发布产物。 / The Rust CLI signs short-lived machine JWTs in memory from the GitHub signing secret; no OIDC exchange service is deployed. Local, out-of-repository, OS-ACL-protected secret bulk JSON is permitted, but must never enter source, GitHub or release artifacts.

## 云端部分完成记录 / Partial cloud completion

Rust status bootstrap、Ops gateway/Static Assets、两个 Custom Domain 和管理员 secret 安装已实际执行。公共 JWKS HTTPS 200 且公钥一致；Ops HTML HTTPS 200 且构建 SHA-256 一致。status 查询与 Ops session 仍 503，未宣称云端登录或完整生产 ready。初始 Cron 配置因缺账户 workers.dev subdomain 报 10063，但脚本和四个 producer 已上传；后续不含 Cron 的域名配置成功。consumer/定时器未启用，S3 签名凭据与通知目标尚缺。 / Bootstrap, static UI, domains and the administrator secret are installed. JWKS and HTML match their source/build and return 200; status/session remain 503. Initial Cron configuration failed with 10063 after successful script/producer upload; domain configuration later succeeded without Cron. Consumers/timers, S3 signing credentials, notification targets and a complete ready release remain outstanding. See the operations runbook for the exact evidence boundary.

# 实现决策与验证边界 / Implementation decisions and verification boundaries

## 运行时边界 / Runtime boundaries

- Stable Rust `status-domain` 是无 I/O 领域核心；`status-backend` 以 Rust 直接调用领域规则并实现认证、D1、Queue、R2 和调度。TypeScript 只承担前端、契约与测试驱动，不承担后端平台适配。 / Rust implements both pure domain rules and backend platform I/O; TypeScript remains frontend, contracts and test drivers.
- `@moesegfault/contracts` 的严格 Zod schema 生成 OpenAPI 3.1.1，服务于前端与契约测试；Rust 后端独立执行类型和运行时验证，不能把前端校验当成安全边界。 / Zod schemas generate OpenAPI for the frontend and contract tests; the Rust backend independently enforces validation and authorization.
- `AdminRpc` 是具名 Service Binding 入口，不挂载在 status 公网 HTTP 上。Gateway 验证单一 owner 的密码会话与 CSRF，status 再执行领域授权；不使用 Access。 / AdminRpc is a named private entrypoint; Owner-session authentication and domain authorization remain separate checks; Access is not used.
- 一个 D1 数据库承载领域事务。使用 `D1Database.batch()` 原子提交，不能把跨多次 await 的读改写假装成事务。并发更新必须由数据库内的版本/幂等门控保护。 / One D1 database owns domain transactions; atomic batches require in-database revision/idempotency guards.
- 完整状态评估使用单例单调 `evaluation_generation`（评估代数）保护“读取全部输入 → 纯函数规划 → 原子提交”。所有 guard 必须排在 batch 的领域写入之前；Issue、monitor checkpoint、维护、覆盖、目录与 `current_statuses` 等真实输入通过 trigger 推进代数，audit/outbox 不推进。全局 guard 会使无关目标的并发变更保守地重试，但 D1 单写者和当前数据量下，这比易漏依赖的逐目标版本简单且可审计；若实测争用显著，再以冲突率与写负载证据演进为逐目标代数。 / Complete status evaluation uses a singleton monotonic `evaluation_generation` to protect read-all-inputs → pure planning → atomic commit. Every guard precedes domain writes; triggers advance the generation for actual inputs, not audit/outbox. This global guard may conservatively retry on an unrelated target change, but under D1's single-writer model and present volume it is simpler and safer than dependency-prone per-target epochs. Move to per-target generations only if measured conflict and write-load evidence justifies it.
- Service 的持久 `dependency_risk` 由 Rust 在同一 generation 快照的完整依赖图和各服务 `direct_status` 上计算，绝不递归读取旧 `effective_impact`。真实 effective transition 在同一事务内向反向依赖服务及 supporting component 写入持久重评 outbox；无 transition 不 fanout，因此循环依赖会收敛而不会制造事件风暴。 / Persisted service `dependency_risk` is computed by Rust from the complete graph and service `direct_status` values in the same generation snapshot, never recursively from stale `effective_impact`. A real effective transition atomically emits durable reevaluation outbox events for reverse dependents and supporting components; no transition means no fanout, so cycles converge instead of producing event storms.
- 公网新建 Correlation ID；认证后的内部调用保留可信执行标识。身份与执行上下文不得混同。 / Public ingress creates correlation IDs; authenticated internal execution propagates trusted identifiers separately from principals.
- 机器 JWT 绑定单个 service、environment 和 deployment，并有稳定 jti 和最长 15 分钟有效期。配置固定 issuer/audience/JWKS，不接受 token 指定的密钥地址。 / Machine JWTs bind service, environment, deployment, jti, and a maximum 15-minute lifetime to pinned trust configuration.
- 主动探测只声明实际执行位置，不在一个 Cron Worker 中伪造多个独立区域。配置中的区域观测不足必须得到 unknown。 / Probes report actual execution locations; missing regional quorum yields unknown rather than fabricated coverage.
- R2 上传使用同源机器 JWT 认证 PUT 和原生 binding，64 MiB artifact/8 MiB source map、600 秒 session、四个精确请求头；取消 S3 凭据和预签名传输，但保留原子注册、条件写入、commit 摘要与 ready 门禁。 / Same-origin JWT-authenticated PUT uses native R2 bindings and bounded sessions/headers; it replaces S3 credentials without weakening registration, conditional writes, commit or readiness.

## 工程依据 / Engineering evidence

- [Cloudflare Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/): use platform bindings, bounded bodies, explicit background work, generated environment types.
- [D1 batch API](https://developers.cloudflare.com/d1/worker-api/d1-database/): statement batches execute transactionally; failures roll back the batch.
- [Workers Rust support](https://developers.cloudflare.com/workers/languages/rust/): WASM modules require Workers-compatible initialization of wasm-bindgen glue.
- [Workers Service Binding RPC](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/): named entrypoints provide the internal management transport.
- [CausalMesh research preprint](https://arxiv.org/abs/2508.15647): recent research highlights causal-cache correctness for migrating serverless computations. This is a research signal, not evidence that this project needs a causal cache. The design instead keeps authority in D1 and exposes freshness explicitly; no new cache-coordination subsystem is introduced.

## 完成判据 / Completion criteria

源设计仍是完整需求，以下只是实现验收索引，不缩小范围。 / The source designs remain authoritative; this checklist does not reduce their scope.

| 范围 / Scope            | 必须检查的证据 / Required evidence                                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 数据库 / Database       | 本地 D1 迁移、外键、不可变历史、版本冲突、事务回滚、保留策略 / local D1 migrations, constraints, immutable history, OCC, rollback, retention                                                |
| 领域 / Domain           | 窗口、迟滞、多位置 quorum、stale、Issue recurrence、Incident 生命周期、循环依赖 / windows, hysteresis, quorum, freshness, recurrence, state machines, dependency cycles                     |
| HTTP 与 RPC / Contracts | OpenAPI 生成一致性、严格输入、错误格式、路径白名单、认证/授权/CSRF、签名游标 / generated consistency, strict inputs, errors, route allowlists, authentication, authorization, CSRF, cursors |
| 异步 / Async            | Queue 重复/乱序/延迟/retry/DLQ/replay，不产生重复领域副作用 / duplicate, reordered, delayed, retried and replayed deliveries without duplicate domain effects                               |
| 探测 / Probes           | 并发预算、每目标限制、deadline、SSRF 防护、真实位置、策略 revision / concurrency budgets, deadlines, SSRF, actual locations, immutable policy revisions                                     |
| 部署来源 / Provenance   | Manifest 幂等、内容冲突、认证上传、真实摘要/Build ID/source map 校验、ready 门禁 / manifests, conflicts, uploads, digests, Build IDs, source maps, readiness gate                           |
| 可观测性 / Telemetry    | 上下文传播、脱敏 canary、有界指标基数、后端故障隔离、自递归禁止 / context propagation, redaction, bounded cardinality, failure isolation, recursion prevention                              |
| Ops                     | 类型检查、生产构建、角色门控、证据查询与操作、故障和过期时不显示全绿 / typecheck, build, role gates, evidence and mutations, unavailable/stale behavior                                     |
| 发布 / Release          | CI 测试、WASM 构建、Worker dry-run、Ops Static Assets 构建、生产配置和外部集成门禁 / CI, WASM, Worker dry-runs, Static Assets build, production configuration and integration gates         |

不得因单元测试通过而宣称生产集成完成；管理员 secret/会话、遥测后端、机器 issuer 和资源绑定必须另外核验。 / Passing unit tests never proves production integration; external identity, telemetry, and resource configuration require separate verification.

## 身份与预置边界 / Identity and provisioning boundary

机器 JWT 由 Rust 发布 CLI 使用受保护 GitHub `MACHINE_JWT_PRIVATE_KEY` 在内存签发；OIDC 交换服务不是当前部署。管理员密码与密码记录不进入 GitHub；本机仓库外的受 OS ACL 保护私密 JSON 可用于 secret bulk 预置，不等于已安装 Worker secret。全部 9 个 D1 迁移和完整性检查已在远端通过；bootstrap、secret 安装与域名上线状态需独立留证。 / Rust signs machine JWTs in memory from the protected GitHub signing secret; an OIDC exchange service is not deployed. Administrator credentials never enter GitHub. An ACL-protected private JSON file outside the repository may provision secrets, but does not prove Worker-secret installation. Nine remote D1 migrations and integrity checks passed; independently verify bootstrap, secrets and domains.

云端事实已推进到 bootstrap/管理员 secret/自定义域名/静态 UI；JWKS 与 HTML 的 200 和内容校验已通过，但业务与 session 503 保留门禁。初始 Cron API 10063 属于部分失败，不因后续域名成功而抹去；当前未启用 consumer 或定时器，不能称完整发布完成。 / Cloud evidence now covers bootstrap, administrator secret, domains and static UI with matching JWKS/HTML. Business/session 503 gates remain. Initial Cron API failure 10063 remains a partial failure despite later domain success; consumers/timers and full release remain incomplete.

通知默认关闭：未配置目标时外部 outbox 保持 pending、attempts 不增，不启用 notification consumer；内部重评继续。TELEMETRY_AUTH_JSON 只在外部后端需要认证时设置。此选择避免无实际目标时制造重试风暴，不把可选外部集成变成核心服务上线前置。账户子域已初始化，历史 Cron 10063 前置解除；默认 workers.dev URL/preview 仍禁用，启用结果以真实部署为准。 / Disabled notifications retain pending external outbox without retry churn or consumers, while internal reevaluation continues. Telemetry credentials are optional. The account subdomain resolves the historical Cron prerequisite without exposing default URLs/previews.

## 应用部署唯一入口 / Exclusive application deployment path

**包括 bootstrap 在内，所有应用代码上传和部署必须经过 GitHub Actions。** 本机只执行 DNS/触发器、Secrets、D1/R2/Queue 资源初始化与测试，不再上传应用代码。早期本机上传 bootstrap/UI 的事实保留为历史记录，不是当前操作授权。 / **All application uploads and deployments, including bootstrap, must run through GitHub Actions.** Local work is limited to DNS/triggers, secrets, resource provisioning and tests. Early local application uploads are historical facts, not the current procedure.

`bootstrap.yml` 提供严格受限的引导通道：status 更新前必须确认真实远端 `BOOTSTRAP_MODE=true`，只更新原生 R2 控制面；probe 首次创建使用固定私有 Worker 名。该工作流不配置 DNS/触发器，也不能替代正式 `deploy.yml` 的 artifact commit、ready 和版本 100% 发布门禁。工作流建设/测试不等于它已在生产成功执行。 / The restricted bootstrap workflow verifies remote bootstrap mode before updating the status R2 control plane and permits first creation of a fixed private probe Worker. It does not manage DNS/triggers or replace normal commit/readiness/full-version release gates. Workflow implementation is not production execution evidence.

平台身份已通过一次 D1 原子导入建立：3 个服务、3 条审计、3 条 catalog.changed，monitor/component 均为 0；不以初始化元数据伪造健康状态。 / One atomic import created three services/audit/catalog events, zero monitors/components and no fabricated health.

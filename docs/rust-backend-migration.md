# Rust 后端迁移 / Rust backend migration

## 不可缩减的目标 / Full acceptance target

后端应用逻辑全部使用 Rust；TypeScript 保留给运维前端。生成的 Workers SDK JavaScript 胶水不是手写业务层。 / All backend application logic must be Rust; TypeScript remains for the operations frontend. SDK-generated JavaScript is not a handwritten business layer.

此前 TypeScript Worker + Rust 领域桥接的实现决策已被此要求取代。当前迁移未完成，不得以新增 Rust 库、通过原生测试或保留 TypeScript 转发层宣告完成。 / This supersedes the previous TypeScript Worker plus Rust domain bridge decision. Adding a Rust library, passing native tests, or retaining a TypeScript forwarding layer does not constitute completion.

## 覆盖清单 / Coverage inventory

| 范围 / Scope            | 必须保留的行为 / Required behavior                                                                                                    | 状态 / State                                                                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| status-domain           | 评估、生命周期、依赖、恢复、来源校验；Rust 直接调用 / evaluation, lifecycle, dependencies, recovery, provenance; direct Rust calls    | 现有库可复用；桥接待删除 / library reusable; bridge removal pending                                                                                                                                                |
| platform                | JWT、权限、请求边界、遥测、事务、通知 / JWT, authorization, request limits, telemetry, transactions, notifications                    | Rust 请求边界、机器 JWT、固定 JWKS 获取/缓存已实现并通过 workerd；其余待迁移 / Rust request boundary, machine JWT and pinned JWKS fetch/cache verified in workerd; remainder pending                               |
| public                  | 六个公开查询入口、分页、状态新鲜度、错误响应 / six public reads, pagination, freshness, errors                                        | 六个公开查询、签名分页及直接 Rust 依赖计算已通过 workerd；遥测接线待平台模块迁移 / All six reads, pagination and direct Rust dependency evaluation verified in workerd; telemetry wiring awaits platform migration |
| admin                   | 所有管理读写、原子审计/outbox、命名私有入口 / all admin reads/writes, atomic audit/outbox, named private entrypoint                   | 待迁移 / pending                                                                                                                                                                                                   |
| deployments             | 注册、产物上传/提交、可发布门禁 / registration, artifact upload/commit, readiness gates                                               | 待迁移 / pending                                                                                                                                                                                                   |
| diagnostics/evidence    | 摄入、消费、幂等、恢复证据、保留清理 / ingestion, consumption, deduplication, recovery evidence, retention                            | 待迁移 / pending                                                                                                                                                                                                   |
| scheduling              | 租约、调度、区域执行、原子评估、重评投递 / leases, scheduling, regional execution, atomic evaluation, reevaluation                    | 待迁移 / pending                                                                                                                                                                                                   |
| ops-gateway             | Access、角色映射、CSRF/origin、安全私有调用 / Access, role mapping, CSRF/origin, private calls                                        | Access 与角色映射已迁移并通过 workerd；路由/CSRF/私有调用待迁移 / Access and roles verified in workerd; routing/CSRF/private calls pending                                                                         |
| probe-executor          | HTTP/TCP/DNS/RPC/synthetic、目标策略、真实执行来源 / probes, target policy, real execution provenance                                 | 待迁移 / pending                                                                                                                                                                                                   |
| shared backend packages | 后端契约、遥测及诊断辅助逻辑 / backend contracts, telemetry, diagnostic helpers                                                       | 待迁移；前端类型不算后端 / pending; frontend types are not backend                                                                                                                                                 |
| build/release           | 三个 Rust Worker 构建、产物/符号、GitHub Actions、首次引导 / three Rust builds, artifacts/symbols, Actions, bootstrap                 | Rust WASM 编译检查已加入 CI；其余待迁移 / WASM compilation gate added; remainder pending                                                                                                                           |
| removal                 | 删除手写 TS 后端及 domain-wasm 桥，清理旧配置和说明 / remove handwritten TS backend and domain-wasm bridge, update configuration/docs | 待全部替换后执行 / pending replacement                                                                                                                                                                             |

## 验收证据 / Acceptance evidence

- API、错误码、JSON 字段、队列载荷、D1 schema 与安全边界不因语言更换而退化。 / Preserve API, errors, JSON, queue payloads, D1 schema and security boundaries.
- 保留已应用的 8 个 D1 迁移，不重建数据库，不删除触发器。 / Preserve all eight applied D1 migrations; no database rebuild or trigger removal.
- 原生测试 + WASM 构建 + 实际 workerd 集成 + 云端测试；原生通过不能证明平台行为。 / Native tests, WASM builds, actual workerd integration and cloud tests; native success does not prove platform behavior.
- 核验私有 AdminRpc、JWT 拒绝路径、D1 回滚、重复消息、超时取消和遥测关联。 / Verify private AdminRpc, JWT rejection, D1 rollback, duplicate messages, cancellation and telemetry correlation.
- 完成前扫描部署入口、依赖图和手写后端源文件；不得仅依据文件扩展名或测试数量。 / Audit deployment entrypoints, dependencies and handwritten backend sources, not just extensions or test counts.

SDK 依据 / SDK reference: [Cloudflare workers-rs](https://github.com/cloudflare/workers-rs), 当前固定 / pinned `worker = 0.8.5`.

## 已执行的认证验收 / Executed authentication acceptance

- `worker-build 0.8.5` 编译真实 Rust 测试 Worker；无手写 TS 后端入口。 / Built a real Rust test Worker, with no handwritten TS backend entrypoint.
- 5 个 workerd 测试通过；三种机器签名算法、Access 与有界请求体均调用 Rust。 / Five workerd tests pass; all three machine algorithms, Access and bounded bodies execute Rust.
- 40 个 Rust 单元/集成测试及游标文档测试通过；原生及 wasm32 Clippy 无警告。 / Forty Rust unit/integration tests and cursor doctest pass; native and wasm32 Clippy are warning-free.
- 三个生产 Worker 的入口仍未切换；不以测试 Worker 替代生产功能。 / The three production entrypoints are not yet switched; a test Worker is not a replacement for production functionality.

## D1 与 Incident 验收 / D1 and Incident acceptance

- Rust D1 参数明确区分 NULL、文本、整数、浮点与 BLOB；拒绝整数精度损失。直接使用官方 binding，不经过 REST 或 TS 业务层。 / Rust D1 parameters distinguish NULL/text/integer/real/BLOB and reject integer precision loss; direct official bindings, no REST or TS business layer.
- 使用可失败行解码，规避 worker 0.8.5 的泛型 results 内部 unwrap；错误不使 isolate panic。 / Fallible decoding avoids worker 0.8.5 generic results unwrap; type errors do not panic the isolate.
- 10 项真实 workerd 测试通过，包含全部 8 个迁移、事务回滚、参数绑定、Incident 分页、私有组件过滤、响应 schema 校验、错误路由及原有认证测试。 / Ten workerd tests pass, covering all eight migrations, rollback, parameter binding, Incident pagination/redaction/schema/errors and authentication.
- 两个 Incident 生产逻辑接口已由 Rust 测试 Worker 执行；生产入口切换仍待其余模块完成。 / Both Incident production handlers execute in a Rust test Worker; production entrypoint switch awaits remaining modules.

## 六个公开查询的 Rust 验收 / Six public Rust reads

- 已实现 `/v1/status`、`/v1/services`、`/v1/services/{service_name}`、`/v1/incidents`、`/v1/incidents/{incident_id}`、`/v1/maintenance-windows`。全部由 Rust 测试 Worker 调用真实 D1。 / All six routes execute Rust against actual local D1 through the Rust test Worker.
- 依赖图在单条 SQL 快照内读取，直接调用 `status_domain::compute_dependency_risk`；没有领域 JSON/JS 桥。保留 direct status、dependency risk 与 effective impact 的区分。 / One-statement graph snapshot calls the Rust domain function directly, preserving direct/risk/effective distinctions without a domain JSON/JS bridge.
- 新增运行时验收：循环依赖、支撑服务影响、过期健康与持久故障、服务分页、维护窗口时间下界固定和私有目标过滤。15 项 Rust workerd 测试通过。 / Runtime coverage includes cycles, supporting services, expired health versus demonstrated failures, service pagination, pinned maintenance scan time and private-target filtering; 15 Rust workerd tests pass.
- 公开逻辑迁移不等于全部后端完成：管理命令、诊断、调度、队列、产物与遥测平台模块仍未迁移，旧生产入口仍存在。 / Public logic migration is not full backend completion: admin, diagnostics, scheduling, queues, artifacts and telemetry remain, as do legacy production entrypoints.

# Rust 后端架构与验收 / Rust backend architecture and acceptance

## 语言边界 / Language boundary

全部后端应用逻辑使用 Rust；TypeScript 用于运维前端、前端契约和非生产测试驱动。官方 SDK 生成的 JavaScript 负责平台 ABI（Application Binary Interface）衔接，不是手写业务层。旧 TypeScript 适配器与领域调度桥不属于目标架构，也不要求保留旧实现兼容层。 / All backend application logic is Rust. TypeScript remains for the frontend, its contracts and non-production test drivers. SDK-generated JavaScript bridges the platform ABI, not business logic; legacy adapters and dispatch bridges are not part of the target architecture.

## 模块与权限 / Modules and authority

```text
TypeScript Ops UI -> Rust ops-gateway-worker
                          | Access + Origin/CSRF + fixed RPC method
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
| JWT、Access、请求限制、游标 / Authentication and boundaries                       | `status-backend/{auth,access,http,cursor,wire}`                                                                          |
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

首次引导不是跳过安全检查：注册 API 仍验证机器 JWT，其余业务入口保持不可用；部署成功后还需要烟雾测试（Smoke Test）与独立 Access 管理员激活。 / Bootstrap does not bypass authentication: registration still requires machine JWT, other business entrypoints remain unavailable, and deployment requires subsequent smoke tests and separate Access-admin activation. See [release runbook](../scripts/release/rust-release-README.md).

## 证据与尚未证明的事项 / Evidence and limits

已执行的专项验证包含 Rust `diagnostic-client` 的原生与真实 workerd 测试、最终组装 status 产物的 workerd 入口验证，以及真实 Queue → 通知 → 死信队列（Dead-Letter Queue, DLQ）路径。后端生产者 SDK 与遥测实现统一为 Rust，旧 TypeScript 对应实现正在清理，不作为备用业务层保留。这些是本地专项证据，不代表完整测试集、GitHub Actions 或云端发布均已完成。 / Executed focused checks cover the Rust diagnostic client in native and actual workerd tests, entrypoints of the assembled status artifact, and an actual local Queue → notification → DLQ path. Backend producer SDK and telemetry implementations are Rust; superseded TypeScript implementations have been removed, not retained as a fallback business layer. These local focused checks do not establish complete-suite, GitHub Actions or cloud-release completion.

| 层级 / Layer                              | 能证明 / Demonstrates                                                 | 不能替代 / Does not replace                                                         |
| ----------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Rust 原生测试 / Native tests              | 类型、纯规则和错误路径 / Types, pure rules and failures               | WASM 与平台运行 / Platform execution                                                |
| SQLite + 全部迁移 / SQLite and migrations | SQL 约束、回滚、并发门控模型 / Constraints, rollback and guards       | 云端 D1 运行特征 / Cloud D1 behavior                                                |
| 实际本地 workerd / Actual local workerd   | Rust/WASM、D1、JWT、Service Binding 互操作 / Runtime interoperability | 真实 Access、地域、外部服务及云端负载 / Cloud identity, geography, vendors and load |
| Wrangler dry-run / Dry-run                | 模块可组装与真实上传字节审计 / Assembly and upload-byte audit         | 已部署、已 ready 或已激活 / Deployment, readiness or activation                     |
| 云端验收 / Cloud acceptance               | 仅实际执行并留证的路径 / Only executed, recorded paths                | 未测试的功能和配置 / Untested functionality and configuration                       |

远端 D1 的 8 个迁移已应用；这不是 Worker 应用已发布的证明。R2 未开通，不能宣称真实 S3 上传闭环完成；本地多地区元数据夹具也不能证明探针真实异地执行。最终测试数量由统一验收记录收口，本文不维护易失真的累计数字。 / Eight remote D1 migrations are applied, but this does not prove application deployment. R2 is not provisioned, so real S3 delivery is not established. Synthetic regional metadata does not establish geographic execution. Final test counts belong to the consolidated acceptance record, not this evolving document.

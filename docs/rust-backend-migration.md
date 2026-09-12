# Rust 后端迁移 / Rust backend migration

## 不可缩减的目标 / Full acceptance target

后端应用逻辑全部使用 Rust；TypeScript 保留给运维前端。生成的 Workers SDK JavaScript 胶水不是手写业务层。 / All backend application logic must be Rust; TypeScript remains for the operations frontend. SDK-generated JavaScript is not a handwritten business layer.

此前 TypeScript Worker + Rust 领域桥接的实现决策已被此要求取代。当前迁移未完成，不得以新增 Rust 库、通过原生测试或保留 TypeScript 转发层宣告完成。 / This supersedes the previous TypeScript Worker plus Rust domain bridge decision. Adding a Rust library, passing native tests, or retaining a TypeScript forwarding layer does not constitute completion.

## 覆盖清单 / Coverage inventory

| 范围 / Scope            | 必须保留的行为 / Required behavior                                                                                                    | 状态 / State                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| status-domain           | 评估、生命周期、依赖、恢复、来源校验；Rust 直接调用 / evaluation, lifecycle, dependencies, recovery, provenance; direct Rust calls    | 现有库可复用；桥接待删除 / library reusable; bridge removal pending                                              |
| platform                | JWT、权限、请求边界、遥测、事务、通知 / JWT, authorization, request limits, telemetry, transactions, notifications                    | Rust 流式 JSON 边界已实现；其余待迁移 / Rust streamed JSON boundary implemented; remainder pending               |
| public                  | 六个公开查询入口、分页、状态新鲜度、错误响应 / six public reads, pagination, freshness, errors                                        | Rust 游标签名和分页 limit 已实现；路由及读取待迁移 / Rust cursor and limit implemented; routes and reads pending |
| admin                   | 所有管理读写、原子审计/outbox、命名私有入口 / all admin reads/writes, atomic audit/outbox, named private entrypoint                   | 待迁移 / pending                                                                                                 |
| deployments             | 注册、产物上传/提交、可发布门禁 / registration, artifact upload/commit, readiness gates                                               | 待迁移 / pending                                                                                                 |
| diagnostics/evidence    | 摄入、消费、幂等、恢复证据、保留清理 / ingestion, consumption, deduplication, recovery evidence, retention                            | 待迁移 / pending                                                                                                 |
| scheduling              | 租约、调度、区域执行、原子评估、重评投递 / leases, scheduling, regional execution, atomic evaluation, reevaluation                    | 待迁移 / pending                                                                                                 |
| ops-gateway             | Access、角色映射、CSRF/origin、安全私有调用 / Access, role mapping, CSRF/origin, private calls                                        | 待迁移 / pending                                                                                                 |
| probe-executor          | HTTP/TCP/DNS/RPC/synthetic、目标策略、真实执行来源 / probes, target policy, real execution provenance                                 | 待迁移 / pending                                                                                                 |
| shared backend packages | 后端契约、遥测及诊断辅助逻辑 / backend contracts, telemetry, diagnostic helpers                                                       | 待迁移；前端类型不算后端 / pending; frontend types are not backend                                               |
| build/release           | 三个 Rust Worker 构建、产物/符号、GitHub Actions、首次引导 / three Rust builds, artifacts/symbols, Actions, bootstrap                 | Rust WASM 编译检查已加入 CI；其余待迁移 / WASM compilation gate added; remainder pending                         |
| removal                 | 删除手写 TS 后端及 domain-wasm 桥，清理旧配置和说明 / remove handwritten TS backend and domain-wasm bridge, update configuration/docs | 待全部替换后执行 / pending replacement                                                                           |

## 验收证据 / Acceptance evidence

- API、错误码、JSON 字段、队列载荷、D1 schema 与安全边界不因语言更换而退化。 / Preserve API, errors, JSON, queue payloads, D1 schema and security boundaries.
- 保留已应用的 8 个 D1 迁移，不重建数据库，不删除触发器。 / Preserve all eight applied D1 migrations; no database rebuild or trigger removal.
- 原生测试 + WASM 构建 + 实际 workerd 集成 + 云端测试；原生通过不能证明平台行为。 / Native tests, WASM builds, actual workerd integration and cloud tests; native success does not prove platform behavior.
- 核验私有 AdminRpc、JWT 拒绝路径、D1 回滚、重复消息、超时取消和遥测关联。 / Verify private AdminRpc, JWT rejection, D1 rollback, duplicate messages, cancellation and telemetry correlation.
- 完成前扫描部署入口、依赖图和手写后端源文件；不得仅依据文件扩展名或测试数量。 / Audit deployment entrypoints, dependencies and handwritten backend sources, not just extensions or test counts.

SDK 依据 / SDK reference: [Cloudflare workers-rs](https://github.com/cloudflare/workers-rs), 当前固定 / pinned `worker = 0.8.5`.

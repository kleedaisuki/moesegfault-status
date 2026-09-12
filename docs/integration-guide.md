# 调用者接入指南 / Integration guide

面向读取状态、上报诊断及发布产物的调用者；项目内部交接见 [项目上下文](project-handoff.md)，完整字段以 [OpenAPI](../packages/contracts/openapi.json) 和实现为准。本文不包含真实凭据，也不提供公共注册或自动签发令牌服务。 / For status readers, diagnostic producers and release callers. See [project context](project-handoff.md) for internal handoff and [OpenAPI](../packages/contracts/openapi.json) for wire schemas. No credentials, public registration or automatic token-issuing service are provided here.

## 1. 选对入口 / Choose the boundary

| 调用者 / Caller                 | 入口 / Entry                          | 认证与边界 / Authentication and boundary                                                                                                 |
| ------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 状态读取 / Status reader        | `https://status.moesegfault.dev/v1/…` | 下表 GET 无需认证，只含公开投影；不等于内部服务目录。 / Listed GETs are anonymous public projections, not the internal catalog.          |
| 机器写入 / Machine writer       | 同一 status 域名 / Same status origin | 短期机器 JWT（JSON Web Token）；按服务、环境、部署与 scope 限权。 / Short-lived JWT bound to service, environment, deployment and scope. |
| 单管理员 / Single administrator | `https://ops.moesegfault.dev`         | 浏览器口令登录与安全会话 Cookie；不是机器集成接口。 / Browser password login and secure session cookie, not a machine integration API.   |
| 内部探针 / Internal probe       | 无公开域名 / No public domain         | Cloudflare 服务绑定（Service Binding）；不向调用者提供直接 HTTP 地址。 / Internal binding, no caller-facing HTTP endpoint.               |

管理员 RPC（Remote Procedure Call）由 ops gateway 经私有绑定调用 status Worker，不是 status 域名上的 HTTP 路由。机器 JWT 不能代替管理员身份，也不使用 Cloudflare API token 或 Access token 登录我们的 API。 / Administrative RPC is private gateway-to-status binding traffic, not HTTP routes on the status origin. Machine JWTs do not grant administrator access; Cloudflare API/Access tokens are not credentials for these APIs.

## 2. 公开读取 / Public reads

| 方法与路径 / Method and path      | 用途 / Purpose                            |
| --------------------------------- | ----------------------------------------- |
| `GET /v1/status`                  | 平台聚合状态 / Aggregate platform status  |
| `GET /v1/services`                | 公开服务列表 / Public services            |
| `GET /v1/services/{service_name}` | 指定公开服务 / Individual public service  |
| `GET /v1/incidents`               | 公开事件列表 / Public incidents           |
| `GET /v1/incidents/{incident_id}` | 指定公开事件 / Individual public incident |
| `GET /v1/maintenance-windows`     | 维护窗口 / Maintenance windows            |

```sh
# Windows PowerShell 也使用 curl.exe，避免别名差异。
# Use curl.exe on Windows PowerShell to avoid alias differences.
curl.exe --fail-with-body -i https://status.moesegfault.dev/v1/status
curl.exe --fail-with-body "https://status.moesegfault.dev/v1/services?limit=20"
```

列表使用不透明游标（Opaque Cursor）：读取 `page.next_cursor`，非空时 URL 编码后作为下一次 `cursor` 参数；保持筛选条件不变，不解码、修改或长期保存游标。`limit` 为 1–100，默认 50；事件 `states` 与维护窗口 `from`/`to` 的格式见 OpenAPI。 / Lists expose `page.next_cursor`; URL-encode a non-null cursor into the next request, retaining filters. Do not inspect, edit or retain cursors indefinitely. Limits are 1–100, default 50; see OpenAPI for incident states and maintenance date filters.

响应有 `ETag` 和 `x-moesegfault-correlation-id`，但不要假设已经支持 `If-None-Match → 304`。公开 GET 的跨源资源共享（Cross-Origin Resource Sharing, CORS）目前仅允许 `https://ops.moesegfault.dev`，不携带跨源凭据；其他网站浏览器直连不属于现有接入契约。服务端 HTTP 调用不受浏览器 CORS 限制。 / Responses expose ETag and correlation ID, but do not assume conditional 304 support. Public GET CORS currently allows only the ops origin, without credentials. Other browser origins are not enabled; server-side HTTP callers are not subject to browser CORS.

空列表、未知状态或尚未配置监控不应被解释为“所有服务健康”。 / Empty lists, unknown states and unconfigured monitors do not prove universal health.

## 3. 机器身份与接入准备 / Machine identity and onboarding

先由管理员登记真实服务及对应部署，再约定最小权限的签发方式。现有发布私钥 `MACHINE_JWT_PRIVATE_KEY` 由本仓库 GitHub Secrets 持有，**不复制给其他项目或普通调用者**。目前没有公开 token endpoint 或已部署的 GitHub OIDC 交换服务；新增生产者须先明确受控签发/刷新流程，不能把 15 分钟令牌当作长期密码。 / Register the real service and deployment, then agree on least-privilege issuance. The existing release signing key belongs to this repository's GitHub Secrets and must not be distributed. No public token endpoint or deployed GitHub OIDC exchange service exists. Establish controlled issuance/refresh before onboarding; a 15-minute token is not a permanent password.

| JWT 字段 / Claim                               | 当前约束 / Current constraint                                                                                                                 |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `iss`                                          | `https://status.moesegfault.dev`                                                                                                              |
| `aud`                                          | `moesegfault-status`                                                                                                                          |
| `sub`, `jti`                                   | 非空主体与令牌标识；发布工具使用 `sub=status-release`。 / Non-empty subject and token identifier; releaser uses `status-release`.             |
| `iat`, `exp`                                   | Unix 秒，`exp > iat` 且寿命最多 900 秒；同步时钟，不依赖容差延寿。 / Unix seconds, positive lifetime at most 900 seconds; synchronize clocks. |
| `service_name`, `environment`, `deployment_id` | 必须匹配请求资源；部署 ID 为 UUIDv7。 / Must match request resources; deployment ID is UUIDv7.                                                |
| `scope`                                        | 空格分隔字符串；诊断 `diagnostics:write`，发布 `deployments:write artifacts:write`。 / Space-separated string; use the minimal scopes shown.  |

当前发布器使用 RS256；公钥集合 JWKS（JSON Web Key Set）位于 `https://status.moesegfault.dev/.well-known/jwks.json`，来源文件为 [config/machine-jwks.json](../config/machine-jwks.json)。私钥负责签名，Worker 用公钥验签并校验声明；仅添加或公开公钥不会自动授权一个调用者。私钥轮换须同步信任公钥，不能单独覆盖 Secret。 / The releaser uses RS256 with the public JWKS above. Signing and claim validation are distinct; publishing a public key is not automatic caller authorization. Coordinate private-key rotation with trusted public keys.

## 4. 诊断上报 / Diagnostic ingestion

推荐使用实际的 Rust SDK：[crates/diagnostic-client](../crates/diagnostic-client/README.md)，而不是已无源码的旧 `packages/diagnostic-client` 路径。该 README 包含 Workers 适配器示例；原生进程需实现自己的 `publisher::Transport`。 / Use the Rust SDK and its Workers example; the old packages path has no current SDK source. Native processes supply a platform transport.

- 目标固定为 `POST https://status.moesegfault.dev/v1/diagnostic-events`，`Content-Type: application/json`，`Authorization: Bearer <short-lived-token>`。不跟随重定向，不把令牌发往响应提供的任意域名。 / Use the exact HTTPS endpoint and headers; reject redirects and arbitrary token destinations.
- 用真实构建 manifest 创建 `DiagnosticEventBuilder`，绑定服务、环境和部署来源；不要手工伪造一个“看起来有效”的事件。完整正文见 OpenAPI `DiagnosticEvent`。 / Build events from real provenance using the builder; see the full schema rather than inventing event bodies.
- **请求头 `x-moesegfault-correlation-id` 必须与事件正文 `correlation_id` 相同，且为 UUIDv7。** SDK 自动设置；只填正文而省略请求头可能触发关联标识不匹配。 / Header and body correlation IDs must be the same UUIDv7. The SDK sets the header; omitting it can cause a mismatch.
- 正文上限 64 KiB。只有 `202` 且回执 `accepted=true`、`event_id` 匹配才算摄入成功；这表示 Queue 已接收，不代表 D1 消费、事件处理或通知投递已经完成。 / Limit: 64 KiB. Only a matching accepted 202 receipt proves queue admission, not completed downstream processing.
- 重试保留相同 `event_id` 和正文；消费端永久去重。恢复信号须引用对应故障，不能把无事件/静默当恢复。 / Preserve event ID and bytes on retry; consumers deduplicate. Recovery explicitly references a fault; silence is not recovery.
- SDK 内存队列默认 64 项，是尽力而为（Best Effort），不是持久消息保证。调用 flush；不能接受进程退出丢失时，由调用应用维护持久发件箱（Transactional Outbox）。 / The default 64-event in-memory queue is best effort. Flush it; use an application-owned durable outbox where process-loss durability is required.

## 5. 发布与 R2 产物 / Releases and R2 artifacts

本项目发布应触发 [GitHub Actions](../.github/workflows/deploy.yml)，不要从本地绕过发布门禁。高级调用者实现同一协议时，以 [Rust 发布器](../crates/status-release/src/lib.rs) 为参照： / Publish this project through Actions, not a local bypass. Advanced protocol clients should follow the Rust releaser:

```text
PUT  /v1/deployments/{deployment_id}                   immutable manifest
POST /v1/deployments/{deployment_id}/artifact-uploads  scoped upload session
PUT  /v1/deployments/{deployment_id}/artifact-uploads/{upload_id}
POST /v1/deployments/{deployment_id}/artifacts         verified commit
PUT  /v1/deployments/{deployment_id}                   same manifest, recompute ready
     → recomputed ready → Actions version publication
     → smoke verification → separate administrator activation
```

注册和 ready 状态并非另外一个公开 GET 查询接口；以注册/提交回执及发布器实际协议为准。各请求完整正文见 OpenAPI `DeploymentManifest`、`CreateArtifactUploadRequest`、`CreateDeploymentArtifactRequest`，不要使用省略字段的示意 JSON 直接部署。 / Registration/readiness is not a separate public GET endpoint. Use registration/commit receipts and the implemented protocol. Use complete OpenAPI schemas, not abbreviated illustrative deployment JSON.

上传 session 需要 `Idempotency-Key`；同次尝试保留 key 与相同请求，600 秒会话过期后按发布器规则创建新尝试。PUT 携带 `artifacts:write` JWT，并精确使用会话的 `Content-Length`、`Content-Type`、`Content-MD5`、`If-None-Match: *`。上传地址必须同源且路径匹配，禁止重定向。 / Sessions require an idempotency key, reused with identical requests within an attempt. After the 600-second session expires, create a new attempt following the releaser. PUT requires a scoped JWT and all four exact session headers; enforce same origin/path and reject redirects.

每件产物最大 64 MiB，source map 最大 8 MiB。PUT `412` 只表示对象已经存在，**不是成功校验**；仍须提交并通过服务端实际摘要校验。Worker 通过原生 R2 绑定访问私有桶，调用者不需要 S3 密钥、桶访问权或公开 R2 地址。 / Artifacts are limited to 64 MiB; source maps to 8 MiB. PUT 412 is not integrity success: verified commit remains mandatory. The Worker owns private R2 access through a native binding; callers need no S3 credentials or bucket access.

`ready`、Cloudflare 版本已承接流量、业务部署指针已激活是三个不同状态。机器发布权限不包含管理员激活权限。 / Ready, traffic cut-over and application-pointer activation are separate states. Release scopes do not authorize administrator activation.

## 6. 错误、重试与支持 / Errors, retries and support

错误通常为 `application/problem+json`，包含 `type`、`title`、`status`、`detail`、`correlation_id`。先检查 HTTP 状态和媒体类型；代理/平台错误不保证符合应用 JSON。记录关联 ID、路径、时间和安全错误类型，不记录 Authorization、Cookie、私钥或完整诊断正文。 / Application problems use the listed fields. Inspect status/content type first: platform errors may differ. Record safe diagnostics, never credentials or complete event bodies.

| 结果 / Result                           | 调用方动作 / Caller action                                                                                                                                        |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400 / 413 / 415 / 422`                 | 修正结构、大小或媒体类型，不盲重试。 / Fix request/schema/size/media type.                                                                                        |
| `401 / 403`                             | 检查过期、签名、scope 与资源归属；刷新受控凭据，禁止放宽验证。 / Check token validity, scope and ownership; refresh without bypassing verification.               |
| `404`                                   | 检查路由及资源是否登记/公开；不是重建任意资源的授权。 / Check route and resource visibility/registration.                                                         |
| `409`                                   | 幂等内容或资源状态冲突；核对原请求与当前状态，不靠随机换 ID 掩盖冲突。 / Reconcile request/state conflict rather than randomizing IDs.                            |
| 上传 PUT `412` / Upload PUT 412         | 按上一节继续校验提交，不覆盖对象。 / Continue verified commit, never overwrite.                                                                                   |
| `429 / 5xx`、网络失败 / Network failure | 有限次数退避，保留请求身份；若提供有效 `Retry-After` 则尊重它，不假设一定存在。 / Use bounded backoff with stable identity; honor valid Retry-After when present. |

上表是通用调用建议；SDK 的实际永久失败集合为 `400, 404, 405, 409, 410, 413, 415, 422`，其余失败保持有界重试机会，每次尝试重新获取认证信息。这不意味着持续 `403` 会自行恢复；超出预算应定位配置或权限问题。 / This table is general guidance. The diagnostic SDK permanently rejects the listed statuses; other failures retain bounded retry opportunities with freshly obtained authorization. Persistent 403 requires a configuration/authorization fix.

接入时交接非秘密信息：服务名、环境、真实部署 ID、所需 scope、生产者身份、刷新机制、预计事件量及关联 ID 示例。没有真实待监控服务时不要登记假目标或制造健康数据；通知目标未配置也不等于诊断摄入失败。 / Handoff only non-secret identity, scope, refresh, volume and correlation details. Do not invent monitored targets/health; absent notification configuration is distinct from ingestion failure.

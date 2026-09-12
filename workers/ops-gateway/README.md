# moeSegFault Ops Gateway

实现入口为 `crates/ops-gateway-worker`，业务位于 `crates/status-backend/src/gateway`；此目录仅保留平台配置与说明。通过 `status-build --service ops` 生成 `dist/rust/ops/ops.js`，再走 Rust 发布门禁。 / Implementation lives in the Rust crates; this directory contains platform configuration and documentation. Build with `status-build --service ops`, then use the Rust release gates.

`ops-gateway` 是同源管理 HTTP 边界；UI 由同一 Worker 的 Static Assets 提供，`/api/*` 先进入 Rust。单一 owner 使用预配置密码登录/退出；没有 Access、setup、注册、账号管理或改密 UI。通过私有 Service Binding 调用 status 的命名 AdminRpc；status 仍执行领域授权。 / The same-origin gateway serves UI through Static Assets and routes API paths to Rust. One owner logs in/out with a preconfigured password, without Access or account-management UI. Named private AdminRpc calls remain domain-authorized by status.

## 信任边界 / Trust boundary

- 密码记录仅在 status Worker 的 `ADMIN_PASSWORD_RECORD` secret：PBKDF2-SHA256/600,000 次/16 字节盐/32 字节哈希。密码留在仓库外受 OS ACL 保护的本机文件，不进入 GitHub、日志或前端。 / The password record lives only in the status Worker secret; the password remains in an ACL-protected private local file.
- D1 保存会话摘要与记录指纹，12 小时 cookie 为 Secure/HttpOnly/SameSite=Strict；全局登录预算 30 次/10 分钟。退出撤销会话；密码轮换需新版本 100% 切换，避免旧版本继续认可旧会话。 / D1 stores session hashes/fingerprints. Secure sessions last 12 hours, with a global 30-attempt/10-minute login budget. Logout revokes the session; rotation needs a full version cutover.
- 不信任请求自带角色、身份或关联标识；公开入口新建关联标识，认证后的内部 RPC 传递最小 owner principal 和 trace context。 / Never trust caller-supplied identity, roles or correlation. Public ingress creates correlation; authenticated RPC forwards a minimal owner principal and trace context.
- 本机 secret bulk 已成功安装 ADMIN_PASSWORD_RECORD，最新 secret 版本已 100% 部署；`/api/session` 仍为 503，未宣称云端登录或真实会话验收通过。 / Local secret bulk installation and a full version cutover are verified; the session endpoint still returns 503, so cloud login/session acceptance is not established.

## 遥测来源 / Telemetry provenance

生产构建必须注入 `DEPLOYMENT_ID`、`GIT_COMMIT`、`ARTIFACT_DIGEST`、`STATUS_VERSION` 与 `ENVIRONMENT`。除本地 `development` 且四个来源值全部为空之外，缺失、部分填写或格式错误都会让 Gateway 以 `503` 失败关闭；代码不会捏造部署 ID、提交或产物摘要。

Production builds must inject `DEPLOYMENT_ID`, `GIT_COMMIT`, `ARTIFACT_DIGEST`, `STATUS_VERSION`, and `ENVIRONMENT`. Missing, partial, or malformed provenance fails closed with `503`, except wholly empty provenance in local `development`. The code never fabricates a deployment ID, commit, or artifact digest.

Gateway 使用 Rust `status-backend::telemetry` 建立 invocation-local W3C/Correlation context、安全结构化 LogRecord，以及可用时的 `ctx.tracing` custom span。Cloudflare 原生日志与 trace 的外部 OTLP destination 属于部署配置/runbook，不在应用内嵌凭据或引入完整 OpenTelemetry SDK。Service Binding 自身的原生 span 与共享 RPC `trace_context` 是互补证据；不要把 Cloudflare 原生 trace ID 与独立 W3C trace ID 混为一谈。

## 浏览器 mutation / Browser mutations

每个 `POST`/`PATCH` 请求必须同时满足：

1. `Origin` 与 `OPS_ORIGIN` 完全相同；
2. 若存在 `Sec-Fetch-Site`，其值必须为 `same-origin`；
3. `X-MoeSegFault-CSRF: 1`；
4. `Content-Type: application/json`；
5. 未压缩正文不超过 32 KiB；
6. 更新操作携带强 ETag，例如 `If-Match: "42"`。

The gateway emits no CORS permission and rejects preflight. These checks are defense in depth around the owner session cookie; none replaces authorization in `status`.

## 固定路由 / Fixed routes

| HTTP  | Path                                 | Private RPC                            |
| ----- | ------------------------------------ | -------------------------------------- |
| POST  | `/api/auth/login`                    | `loginAdministrator`                   |
| POST  | `/api/auth/logout`                   | `logoutAdministrator`                  |
| GET   | `/api/session`                       | Authenticated owner session projection |
| GET   | `/api/health`                        | `checkHealth`                          |
| GET   | `/api/incidents/:id`                 | `getIncident`                          |
| POST  | `/api/issues/search`                 | `searchIssues`                         |
| POST  | `/api/incidents`                     | `createIncident`                       |
| PATCH | `/api/incidents/:id`                 | `updateIncident`                       |
| POST  | `/api/issues/:id/acknowledge`        | `acknowledgeIssue`                     |
| POST  | `/api/issues/:id/suppress`           | `suppressIssue`                        |
| POST  | `/api/maintenance-windows`           | `createMaintenanceWindow`              |
| PATCH | `/api/maintenance-windows/:id`       | `updateMaintenanceWindow`              |
| POST  | `/api/diagnostic-context/query`      | `queryDiagnosticContext`               |
| POST  | `/api/services`                      | `registerService`                      |
| POST  | `/api/retention-policy-assignments`  | `registerAndAssignRetentionPolicy`     |
| POST  | `/api/deployments/:id/activate`      | `activateDeployment`                   |
| POST  | `/api/monitors`                      | `createMonitor`                        |
| PATCH | `/api/monitors/:id`                  | `updateMonitor`                        |
| POST  | `/api/evaluation-policies`           | `registerEvaluationPolicy`             |
| POST  | `/api/diagnostic-policy-assignments` | `assignDiagnosticPolicy`               |
| POST  | `/api/telemetry-backends`            | `registerBackend`                      |

路由表是 allowlist，不接受由客户端提供的 RPC 方法名。成功响应直接使用共享契约的 `{ "data": ... }`；错误为 RFC 9457 `application/problem+json`。所有响应都含 `x-moesegfault-correlation-id` 且禁止缓存。

The route table is an allowlist; no client-supplied RPC method name is accepted. Success responses use the shared `{ "data": ... }` contract directly, while failures use RFC 9457 `application/problem+json`. Every response carries `x-moesegfault-correlation-id` and is non-cacheable.

## 规范依据 / References

- [Cloudflare Access: Validate JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [Cloudflare Access application-token claims](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)
- [Cloudflare Workers Service Binding RPC](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/)
- [Cloudflare Workers custom spans](https://developers.cloudflare.com/workers/observability/traces/custom-spans/)
- [Cloudflare native OpenTelemetry export](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/)
- [Cloudflare Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [RFC 9457: Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457.html)

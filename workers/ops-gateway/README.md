# moeSegFault Ops Gateway

实现入口为 `crates/ops-gateway-worker`，业务位于 `crates/status-backend/src/gateway`；此目录仅保留平台配置与说明。通过 `status-build --service ops` 生成 `dist/rust/ops/ops.js`，再走 Rust 发布门禁。 / Implementation lives in the Rust crates; this directory contains platform configuration and documentation. Build with `status-build --service ops`, then use the Rust release gates.

`ops-gateway` 是 `ops.moesegfault.dev` 的唯一管理 HTTP 边界。它验证 Cloudflare Access assertion，把身份规范化为最小 `AdminPrincipal`，并通过私有 Service Binding 调用 `status` 的具名 `AdminRpc`。`status` 不公开管理 HTTP 路由，并在领域层再次授权。

`ops-gateway` is the sole administrative HTTP boundary for `ops.moesegfault.dev`. It verifies the Cloudflare Access assertion, normalizes identity into a minimal `AdminPrincipal`, and invokes named `AdminRpc` methods on `status` through a private Service Binding. `status` exposes no administrative HTTP routes and reauthorizes every operation in the domain layer.

## 信任边界 / Trust boundary

- 只读取 `Cf-Access-Jwt-Assertion`；不把 Access cookie 当作 origin assertion 的回退。
- 使用远程 JWKS 验证 RS256 签名，并固定 issuer、单一 audience、expiry、not-before、session age、`type=app` 与 `identity_nonce`。
- 角色只来自 `ACCESS_ROLE_MAPPING` 中以稳定 Access `sub` 为键的显式映射。JWT custom claims、组、邮箱和用户请求头都不能授予角色。
- `ACCESS_ROLE_MAPPING` 是部署配置的唯一角色事实来源。角色变更或撤销必须经配置审查后重新部署 Gateway，并保留 Cloudflare/部署审计记录；平台没有密码表、独立账号系统或虚假的“角色更新”RPC。
- Every public ingress gets a fresh RFC 9562 UUIDv7 correlation ID. A caller-supplied correlation header is ignored.
- Every RPC request carries the principal, correlation ID, and active independent W3C Trace Context. The `status` Worker validates the shared request schema and permissions again.

## 遥测来源 / Telemetry provenance

生产构建必须注入 `DEPLOYMENT_ID`、`GIT_COMMIT`、`ARTIFACT_DIGEST`、`STATUS_VERSION` 与 `ENVIRONMENT`。除本地 `development` 且四个来源值全部为空之外，缺失、部分填写或格式错误都会让 Gateway 以 `503` 失败关闭；代码不会捏造部署 ID、提交或产物摘要。

Production builds must inject `DEPLOYMENT_ID`, `GIT_COMMIT`, `ARTIFACT_DIGEST`, `STATUS_VERSION`, and `ENVIRONMENT`. Missing, partial, or malformed provenance fails closed with `503`, except wholly empty provenance in local `development`. The code never fabricates a deployment ID, commit, or artifact digest.

Gateway 使用 `@moesegfault/telemetry` 建立 invocation-local W3C/Correlation context、安全结构化 LogRecord，以及可用时的 `ctx.tracing` custom span。Cloudflare 原生日志与 trace 的外部 OTLP destination 属于部署配置/runbook，不在应用内嵌凭据或引入完整 OpenTelemetry SDK。Service Binding 自身的原生 span 与共享 RPC `trace_context` 是互补证据；不要把 Cloudflare 原生 trace ID 与独立 W3C trace ID 混为一谈。

## 浏览器 mutation / Browser mutations

每个 `POST`/`PATCH` 请求必须同时满足：

1. `Origin` 与 `OPS_ORIGIN` 完全相同；
2. 若存在 `Sec-Fetch-Site`，其值必须为 `same-origin`；
3. `X-MoeSegFault-CSRF: 1`；
4. `Content-Type: application/json`；
5. 未压缩正文不超过 32 KiB；
6. 更新操作携带强 ETag，例如 `If-Match: "42"`。

The gateway emits no CORS permission and rejects preflight. These checks are defense in depth around the Access application cookie; none replaces authorization in `status`.

## 固定路由 / Fixed routes

| HTTP  | Path                                 | Private RPC                        |
| ----- | ------------------------------------ | ---------------------------------- |
| GET   | `/api/session`                       | Gateway-local principal projection |
| GET   | `/api/health`                        | `checkHealth`                      |
| GET   | `/api/incidents/:id`                 | `getIncident`                      |
| POST  | `/api/issues/search`                 | `searchIssues`                     |
| POST  | `/api/incidents`                     | `createIncident`                   |
| PATCH | `/api/incidents/:id`                 | `updateIncident`                   |
| POST  | `/api/issues/:id/acknowledge`        | `acknowledgeIssue`                 |
| POST  | `/api/issues/:id/suppress`           | `suppressIssue`                    |
| POST  | `/api/maintenance-windows`           | `createMaintenanceWindow`          |
| PATCH | `/api/maintenance-windows/:id`       | `updateMaintenanceWindow`          |
| POST  | `/api/diagnostic-context/query`      | `queryDiagnosticContext`           |
| POST  | `/api/services`                      | `registerService`                  |
| POST  | `/api/retention-policy-assignments`  | `registerAndAssignRetentionPolicy` |
| POST  | `/api/deployments/:id/activate`      | `activateDeployment`               |
| POST  | `/api/monitors`                      | `createMonitor`                    |
| PATCH | `/api/monitors/:id`                  | `updateMonitor`                    |
| POST  | `/api/evaluation-policies`           | `registerEvaluationPolicy`         |
| POST  | `/api/diagnostic-policy-assignments` | `assignDiagnosticPolicy`           |
| POST  | `/api/telemetry-backends`            | `registerBackend`                  |

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

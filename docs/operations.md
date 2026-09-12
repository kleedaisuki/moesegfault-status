# moeSegFault Status 生产运维手册 / Production Operations Runbook

> 本文是执行清单，不是“复制后即可上线”的承诺。任何 `REPLACE_ME`、占位 ID、未创建资源、未配置 Access、未连接外部遥测或未演练恢复流程，都会阻断生产发布。
>
> This is an execution checklist, not a claim of turnkey readiness. Any placeholder, missing resource, unconfigured Access policy, absent telemetry destination, or untested recovery procedure blocks production.

## 1. 权限与职责 / Access and responsibility

| 主体 / Principal           | 最小权限 / Minimum authority                                                                                                    | 禁止事项 / Must not                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| GitHub CI                  | 仓库只读；Pages 发布 job 才有 `pages:write` 与 OIDC `id-token:write`                                                            | PR job 不得取得 Cloudflare secret                       |
| 发布 job                   | 受 GitHub Environment 审批；短期 machine JWT；范围仅含 `deployments:write artifacts:write`；Wrangler token 只管目标 Worker/绑定 | 不使用账户 Global API Key，不把 token 写入 artifact/log |
| 人类 viewer/operator/admin | Cloudflare Access 登录；角色只按稳定 `sub` 显式映射                                                                             | 不以邮箱、组 claim 或请求头自行提权                     |
| `ops-gateway`              | 验证 Access assertion，调用私有 `AdminRpc` Service Binding                                                                      | 不公开 status 管理路由，不信任 Access cookie 回退       |
| status Worker              | D1、主 Queue/DLQ、R2、Analytics Engine（AE）及必要 secret                                                                       | 不向前端返回 object key、凭据或原始遥测                 |

Cloudflare 建议 origin 验证 `Cf-Access-Jwt-Assertion`，核验签名、issuer 与 application audience；公钥从 team certs endpoint 按 `kid` 轮换读取，而不是硬编码。[Cloudflare Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)

### 1.1 Access 配置

1. 为 `ops.moesegfault.dev` 创建 **Self-hosted Access application**，默认拒绝。
2. 用 Allow policy 仅允许值班群体，并按组织策略要求 MFA/device posture。不要创建 Bypass policy。
3. 从 application 复制 64-hex AUD；team origin 必须是精确的 `https://<team>.cloudflareaccess.com`。
4. 在 `workers/ops-gateway/wrangler.jsonc` 的环境专属配置中替换：
   - `ACCESS_ISSUER`：精确 team origin；
   - `ACCESS_AUDIENCE`：单个 application AUD；
   - `ACCESS_MAX_TOKEN_AGE_SECONDS`：不得超过 Access 会话上限；
   - `OPS_ORIGIN`：精确 UI origin；
   - `ACCESS_ROLE_MAPPING`：`{"<stable-sub>":["viewer"]}` 形式，逐人审阅。
5. 用 viewer/operator/admin 三个测试身份验证正向与越权请求；删除/禁用用户后验证旧会话失效。

`ACCESS_ROLE_MAPPING` 不是密码，但包含授权决策；它必须 code review，且每季度与 IdP/值班表对账。Access 角色的粗粒度检查不能代替 status 领域层的二次授权。

### 1.2 机器 JWT（JSON Web Token）

机器 issuer 必须固定 `MACHINE_ISSUER`、`MACHINE_AUDIENCE` 与 `MACHINE_JWKS_URL`。签发服务需：

- 使用轮换的非对称签名 key，并通过固定 HTTPS JWKS 发布；JWT header 的 `jku`/`x5u` 不得改变信任地址；
- 每 token 绑定一个 `service_name`、`environment`、UUIDv7 `deployment_id`、稳定唯一 `jti`；
- `exp - iat <= 900s`，最小 scope；发布需要 `deployments:write artifacts:write`，诊断生产者仅需 `diagnostics:write`；
- 发布脚本启动时 token 至少还剩 10 分钟；先构建产物，再即时换取 token，不要让编译消耗其寿命；
- 在 CI 中优先以 GitHub OIDC 换取短期 JWT；若暂时只能保存 credential，放在受审批的 GitHub Environment secret，并设轮换/到期告警；
- issuer 故障时停止发布，不得扩大时钟偏差、延长 token 或跳过验证。

这里的 payload 预解析只是客户端的快速失败（fail-fast）；签名与 claim 的权威验证永远在 status Worker。

## 2. Cloudflare 资源初始化 / Resource provisioning

以下命令只展示资源名，不含 credential。用个人 SSO 或临时最小权限 API token 执行；记录命令输出与变更单。

```bash
pnpm exec wrangler d1 create moesegfault-status
pnpm exec wrangler queues create moesegfault-status-diagnostics
pnpm exec wrangler queues create moesegfault-status-diagnostics-dlq
pnpm exec wrangler r2 bucket create moesegfault-observability
```

随后把真实 D1 `database_id`、Queue、DLQ、R2 名称写入受审阅的环境配置。Analytics Engine 数据集无需预建：声明 binding 后第一次 `writeDataPoint` 自动创建。[Analytics Engine setup](https://developers.cloudflare.com/analytics/analytics-engine/get-started/)

必须逐项核验：

- 主 Queue 的 consumer 指向 status，`max_retries=5`，并配置 DLQ；status 还需要 `DIAGNOSTIC_DLQ` producer binding，才能保存结构化失败上下文；
- R2 bucket 为私有，禁用公共 `r2.dev`；上传只用短效、对象键/checksum/metadata 受限的 presigned URL。Presigned URL 是 bearer credential，只能短期暴露。[R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- AE binding 为 `ANALYTICS`/`moesegfault_status`；AE 不是领域状态源；
- `STATUS` Service Binding 精确指向 status 的 `AdminRpc` named entrypoint；
- production 与 staging 使用不同 D1、Queue/DLQ、R2 bucket、Worker 名与 secrets，不能只靠 `ENVIRONMENT` 字符串隔离。

### 2.1 Secret 清单

通过交互式 stdin 或受保护 CI 注入，绝不放在 `.dev.vars`、JSON、命令行参数、issue、构建 artifact 或 Pages bundle：

```bash
pnpm exec wrangler secret put CURSOR_SIGNING_KEY --config wrangler.jsonc
pnpm exec wrangler secret put R2_ACCESS_KEY_ID --config wrangler.jsonc
pnpm exec wrangler secret put R2_SECRET_ACCESS_KEY --config wrangler.jsonc
pnpm exec wrangler secret put NOTIFICATION_WEBHOOK_URL --config wrangler.jsonc
pnpm exec wrangler secret put NOTIFICATION_AUTHORIZATION --config wrangler.jsonc
pnpm exec wrangler secret put TELEMETRY_AUTH_JSON --config wrangler.jsonc
```

若 telemetry adapter 使用 credential，则只把符号名（如 `GRAFANA_QUERY_TOKEN`）写进 `auth_reference`；真实值置于 `TELEMETRY_AUTH_JSON` secret 的同名键，不能误以为任意独立 secret 都会自动被解析。非秘密端点与精确主机白名单置于 `TELEMETRY_BACKEND_CONFIG_JSON`。空配置不能查询后端。Wrangler 部署 token 使用进程环境变量 `CLOUDFLARE_API_TOKEN`，离开 job 后销毁。

Telemetry credentials are resolved from matching keys inside the `TELEMETRY_AUTH_JSON` secret, not arbitrary environment bindings. Endpoints and exact host allowlists belong in `TELEMETRY_BACKEND_CONFIG_JSON`; an empty configuration disables queries.

### 2.1.1 通知交付边界 / Notification delivery boundary

部署前创建 `moesegfault-status-notifications` 与 `moesegfault-status-notifications-dlq`，并核对 Wrangler producer/consumer 名称。通知只携带事件 ID、事件类型和领域对象 ID，不转发 outbox 私有正文、定位器或审计主体。

Create both notification queues before deployment and verify their configured names. Messages contain only event identity/type and aggregate identity, never private outbox payloads, locators, or principals.

`outbox.delivered` 表示 Queue 已接受消息，**不表示 webhook 已完成处理**。接收方必须按 `Idempotency-Key` 原子去重，再返回成功状态；网络不确定性和重放会产生重复投递。固定 HTTPS webhook 禁止重定向，每次请求 5 秒超时，非成功响应保留原事件 ID 重试；超过 8 次重试进入通知 DLQ。须独立监控通知积压与 DLQ，并以故障 canary 验证重试和去重，不能只查看 D1 outbox 清空。

`outbox.delivered` means Queue acceptance, not webhook completion. The receiver must atomically deduplicate `Idempotency-Key` before acknowledging success. Requests use a pinned HTTPS destination, reject redirects, time out after five seconds, and retain event IDs across retries. After eight retries, the configured notification DLQ retains failures. Monitor backlog and DLQ separately and test the complete failure/replay path.

通知不是公共缓存失效协议。当前读取以 D1 快照与显式 freshness 为准；不得把 webhook 成功当作所有客户端缓存已刷新。

Notifications are not a public cache invalidation protocol. Public reads rely on D1 snapshots and explicit freshness; webhook success does not prove all client caches refreshed.

### 2.2 D1 初始化与恢复点

```bash
pnpm exec wrangler d1 migrations list moesegfault-status --remote
pnpm exec wrangler d1 migrations apply moesegfault-status --remote
pnpm exec wrangler d1 execute moesegfault-status --remote --command "PRAGMA foreign_key_check; PRAGMA quick_check;"
```

在 staging 先执行并跑 smoke tests，再由 environment 审批 production。应用前记录 D1 Time Travel bookmark/当前时间与 schema version；D1 Time Travel 默认开启，可按分钟恢复，当前生产存储保留窗口最长 30 天。[D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)

不要用 dashboard/ad-hoc SQL 初始化领域行：它会绕过管理 RPC 的 schema、幂等账本和 audit log。保留策略必须通过 Access 保护的 `POST /api/retention-policy-assignments` 原子登记不可变 revision 并绑定服务；数据库 migration 只建立结构，不偷偷写入环境专属领域配置。

## 3. 目录、策略与监控 bootstrap / Catalog, policy, and monitor bootstrap

顺序是领域约束，不是偏好：

```text
无依赖 service → 被依赖 service → 依赖 service
        ↓
不可变 evaluation-policy revision
        ↓
monitor（绑定精确 policy_id + revision）
        ↓
diagnostic-policy assignment
        ↓
telemetry backend（仅保存 credential 引用）
```

使用 Access 保护的同源 Ops API；每个 mutation 带：

```bash
curl --fail-with-body 'https://ops.moesegfault.dev/api/services' \
  -H 'content-type: application/json' \
  -H 'origin: https://ops.moesegfault.dev' \
  -H 'x-moesegfault-csrf: 1' \
  --data-binary @service-command.json
```

浏览器/运维客户端必须提供 Access session；禁止把 Access JWT 复制进示例或 shell history。命令 body 以 `packages/contracts/src/admin.ts` 为唯一事实来源，并满足：

1. 每个 `command_id` 是新 UUIDv7；相同 command/body 可安全重放，相同 ID/不同 body 是冲突。
2. 先注册依赖目标；禁止 self-dependency。
3. Evaluation policy revision 不可变；修改即新 revision，再显式切换 monitor/diagnostic assignment。
4. monitor 的 `timeout_ms < interval_seconds*1000`，生产启用前先以 `enabled:false` 验证目标/allowlist，再 PATCH 并带当前 `If-Match` revision。
5. 至少演练一次过期证据：停止 test monitor，确认状态成为 `unknown` 而不是 `operational`。

Bootstrap 完成条件：`GET /api/health` 返回 dependencies 可解释；每个 enabled service 有 retention、evaluation 与 diagnostic binding；每个关键 capability 有多位置 monitor；公共 `/v1/status` 的 freshness 与目录相符。

### 3.1 Retention revision 与服务绑定

同一命令同时登记不可变策略 revision 并切换服务绑定，避免“策略存在但 consumer 仍无绑定”的半初始化状态：

```bash
curl --fail-with-body 'https://ops.moesegfault.dev/api/retention-policy-assignments' \
  -H 'content-type: application/json' \
  -H 'origin: https://ops.moesegfault.dev' \
  -H 'x-moesegfault-csrf: 1' \
  --data-binary '{
    "command_id":"0199d09a-b692-7ce0-a1c0-5138a43d7402",
    "service_name":"status",
    "policy":{
      "policy_id":"occurrences",
      "revision":1,
      "occurrence_retention_days":30,
      "cleanup_batch_size":100
    },
    "expected_assignment_revision":null
  }'
```

首次绑定必须传 `null`，明确断言当前不存在绑定；换用新策略 revision 时传上次响应的 `assignment_revision`。策略 revision 一旦存在，其天数与批量大小必须完全相同；任何差异均冲突并回滚整条命令。成功、审计、outbox 与幂等账本在同一 D1 batch 中提交。

## 4. 发布与来源证明 / Release and provenance

CI 固定 Node 24、pnpm 12.4.1、stable Rust、Cargo.lock 对应的 `wasm-bindgen-cli`，执行 native tests、fmt、Clippy、WASM、OpenAPI、SQL、TypeScript、Worker dry-run 与 Ops Vite build。第三方 GitHub Actions 均固定完整 commit SHA。

生产发布配置不得含 secret。它声明已构建入口和所有 source map；入口必须也是 artifact。每个 Manifest 恰好有一个 `binary`/`other` runtime artifact，其 digest 等于顶层 `artifact_digest`；JavaScript runtime 必须声明相邻 `<entrypoint>.map`，且入口包含对应 `sourceMappingURL`：

```json
{
  "deployment_id": "0199d09a-b692-7ce0-a1c0-5138a43d7402",
  "service_name": "status",
  "environment": "production",
  "service_version": "1.2.3",
  "repository_url": "https://github.com/OWNER/REPOSITORY",
  "git_ref": "refs/tags/v1.2.3",
  "deployed_at": "2026-09-12T08:00:00.000Z",
  "ci_provider": "github-actions",
  "ci_run_id": "1234567890",
  "release_attempt": "1",
  "region": ["global"],
  "artifacts": [
    {
      "path": "dist/worker.js",
      "kind": "other",
      "media_type": "text/javascript"
    },
    {
      "path": "dist/worker.js.map",
      "kind": "source_map",
      "media_type": "application/json"
    }
  ],
  "wrangler_config": "wrangler.jsonc",
  "wrangler_entrypoint": "dist/worker.js",
  "require_source_map": true
}
```

`deployed_at`、`ci_provider` 与 `ci_run_id` 必须在第一次注册前冻结。`release_attempt` 不进入 immutable Manifest：同一 attempt 的网络重试必须复用它；只有服务器报告 upload session 已过期时才递增并重新运行。否则相同 `deployment_id` 会因 Manifest 内容变化而正确返回 409。GitHub runner 还会强制 `repository_url` 匹配 `GITHUB_REPOSITORY`，且 `git_ref` 必须解析到当前 HEAD。

```bash
# 本地只校验并输出 canonical manifest；不访问网络、不部署。
pnpm exec tsx scripts/release/deploy.ts --config release.production.json --verify-only

# 受审批 runner：秘密只存在环境中。
export MOE_RELEASE_API_URL='https://status.moesegfault.dev'
export MOE_MACHINE_JWT='<short-lived token>'
export CLOUDFLARE_API_TOKEN='<least-privilege token>'
pnpm exec tsx scripts/release/deploy.ts --config release.production.json
```

脚本顺序固定为：SHA-256 exact bytes → 注册 immutable manifest → 为每个 artifact 建立受限上传 session → PUT → HEAD/metadata/digest commit → 幂等重读必须为 `ready` → `wrangler deploy --no-bundle --upload-source-maps --strict`。受 `If-None-Match: *` 保护的 PUT 返回 412 表示相同内容寻址 key 已存在，客户端继续 commit，由服务端 HEAD/digest 做权威验证，绝不覆盖。最后一步显式传入同一 `DEPLOYMENT_ID`、`GIT_COMMIT`、`ARTIFACT_DIGEST`、`STATUS_VERSION` 与 `ENVIRONMENT`，使 runtime telemetry 与注册表同源。任何失败都会阻止 Wrangler；不得以 `--no-bundle` 外的二次构建替换已登记字节。Cloudflare 也明确把 `--dry-run --outdir` 定位为上线前取得 bundle/source map 的阶段。[Wrangler deploy commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/)

`ready` **不代表已经部署，也绝不自动改动探针使用的 current deployment 指针**。Wrangler 成功且 smoke/canary 证据通过后，由 Access `admin` 主体执行显式 cut-over：

```bash
curl --fail-with-body \
  'https://ops.moesegfault.dev/api/deployments/0199d09a-b692-7ce0-a1c0-5138a43d7402/activate' \
  -H 'content-type: application/json' \
  -H 'origin: https://ops.moesegfault.dev' \
  -H 'x-moesegfault-csrf: 1' \
  --data-binary '{
    "command_id":"0199d09b-18ef-7b0c-94c6-e4613c47a6c8",
    "expected_deployment_revision":3,
    "expected_pointer_revision":null,
    "reason":"Wrangler deploy and production smoke checks passed"
  }'
```

`expected_deployment_revision` 必须来自 artifact commit 后的 `ready` 响应；`expected_pointer_revision` 首次激活为 `null`，后续使用上次激活响应的 `pointer_revision`。服务端在一个 D1 batch 内再次断言 deployment 仍为该 `ready` revision、切换 `(service_name, environment)` 指针、把新部署追加为 `active`，并在完整 cut-over 时把旧指针指向的 `active` deployment 追加为 `retired`，最后写 audit/outbox/幂等账本。任一 revision 已变化则整批回滚。滚动流量重叠期不要提前执行此命令；它表达的是权威探针来源已完成切换。

GitHub CI 的发布 machine JWT 没有、也不应取得该 Access admin 能力。自动化若未来确有激活需求，必须另行设计可审计的机器主体、独立 audience/scope 与审批门，而不是复用 `deployments:write artifacts:write`。

GitHub Pages 仅由 `workflow_dispatch` 触发，并经过 `github-pages` Environment；它不会随 main push 自动上线。为该 Environment 设置 required reviewers，并保护 custom domain。

## 5. DLQ 分诊与幂等重放 / DLQ triage and idempotent replay

Cloudflare 原生 DLQ 在 consumer 达到 retry 上限后接收消息；没有 active consumer 时消息只保存 **4 天**，所以 DLQ non-zero 必须即时告警，SLO 应要求 24 小时内分诊。[Cloudflare Dead Letter Queues](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/)

1. **冻结批量重放**：记录 queue backlog、首次/末次失败时间、相关 deploy 与变更。
2. **拉取但不立即 ack**：DLQ 可临时配置 HTTP pull consumer；API token 只给 Queue Read/Write。每条保存 `schema_version`、`original`、`failure.stage/problem_type/attempt/queue_message_id` 到受控 incident evidence。Pull lease 未 ack 会再次投递。[Queue pull consumers](https://developers.cloudflare.com/queues/configuration/pull-consumers/)
3. **分类**：
   - `envelope_validation`：生产者/schema 不兼容，先修生产者或写显式 migration；
   - `domain_validation`：数据不满足领域约束，不可盲重放；
   - `policy_evaluation`：核验 policy revision 与 WASM；
   - `d1_transaction`：先排除 D1/constraint/容量故障。
4. **Canary**：只把 DLQ wrapper 的 `original` 原样发布回主 Queue；不得改 `event_id`、producer、received_at 或 evidence。先 1 条，观察主 Queue ack、D1 `diagnostic_event_dedup`、Issue revision、DLQ 增量为零。
5. **扩大并核对**：10 → 100 → 剩余；同一 `event_id` 的 dedup 事务保证重复投递无第二个 occurrence/revision/audit/outbox 副作用。
6. **最后 ack DLQ lease**：只有主 Queue 已接受且结果已核验才 ack。保留 failure envelope 摘要和事件 ID；不得保留 token/raw secret。

不要把 DLQ 配置成自动回主 Queue，这会形成无限循环并掩盖 poison message（毒消息）。

## 6. 保留、备份与清理 / Retention, backup, and cleanup

| 数据 / Data                         | 权威策略 / Authoritative policy                                                     | 运维验证 / Operational check                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| D1 Issue aggregate、incident、audit | 领域历史按设计保留；不可 ad-hoc DELETE                                              | 月度 `foreign_key_check`，恢复演练                                  |
| `issue_occurrences`                 | 创建时固定 retention policy/revision 与 `purge_after`；incident pin 阻止删除        | 每日比较 eligible/purged/pinned count；清理必须条件删除并记录 audit |
| R2 manifest/artifact/source map     | 为可符号化与来源追溯保持不可变；不能覆盖                                            | 抽样 HEAD，核对 checksum、metadata、D1 digest                       |
| R2 未完成 multipart/temp prefix     | 生命周期规则清理，不得匹配 `observability/manifests/` 或 `observability/artifacts/` | `wrangler r2 bucket lifecycle list` 双人审阅                        |
| Analytics Engine                    | 平台固定约 3 个月，不能当长期证据库                                                 | 后端报表只作派生信号；需要长期则外部导出                            |
| 外部 traces/logs/metrics/profiles   | backend retention class；Incident 只存 locator 与摘要                               | 每季度验证旧 locator 的预期失效行为                                 |

R2 lifecycle 规则是 bucket 级 destructive control，修改后对象通常在到期附近 24 小时内删除；规则需前缀限定和双人审阅。[R2 object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/) Analytics Engine 当前固定保存三个月。[Analytics Engine limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/)

## 7. 外部遥测与 Cloudflare OTLP 限制 / External telemetry and Cloudflare OTLP limits

Cloudflare Workers 的 OpenTelemetry Protocol（OTLP）export 目前支持 **traces 与 logs，不支持 metrics export**；功能仍为 beta。配置独立 trace/log destinations、认证 header、采样与 `persist`，并监控 destination 的 Never run/Error 状态。[Cloudflare OTLP export](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/)

不要把下列平台限制误判为应用健康：

- 非 I/O 操作可能显示 `0 ms`；
- Cloudflare trace ID 目前不会自动传播到 Cloudflare 外部服务，跨边界必须由应用明确传播 W3C Trace Context；
- span 名/attribute 尚可能变化，跨 logs/traces 分组优先使用平台稳定 metadata，并保留自己的 service/deployment/correlation identity；
- head sampling 可能丢掉成功 trace；错误/慢请求/Incident evidence 的应用层强制保留仍需要自有策略；
- Workers metrics 用 Cloudflare dashboard/Analytics Engine/独立 exporter 补足，不得声称 OTLP metrics 已接通。

详见 [Workers tracing known limitations](https://developers.cloudflare.com/workers/observability/traces/known-limitations/)。若部署在 Cloudflare China Network，Workers Trace Events Logpush 不可用；优先验证 OTLP destination 的实际区域可达性。[Workers Logpush limitations](https://developers.cloudflare.com/workers/observability/logs/logpush/)

## 8. 故障处置 / Incident guidance

首要原则：`unknown` 不是 `operational`；控制面失败不得污染公共数据面；不能验证安全条件时 fail closed。

| 故障 / Failure                     | 立即动作 / Immediate action                                                   | 禁止 / Never do                            | 恢复证据 / Recovery evidence                      |
| ---------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------- |
| D1 unavailable                     | 冻结 mutation/deploy；保留缓存公共读；外部渠道声明状态数据可能过期            | 不把写入改成本地内存“成功”                 | health、读写 canary、Queue lag 回落、约束检查     |
| Queue publish/consumer unavailable | producer 有界退避；告警 backlog；暂停会制造更多诊断的批任务                   | 不丢事件后伪造绿色状态                     | enqueue/ack canary，重复事件无副作用              |
| R2 unavailable                     | 阻断 artifact commit 与新生产流量；已有 status read 可继续                    | 不把 deployment 强行标 ready               | PUT/HEAD checksum canary，manifest replay ready   |
| Access unavailable                 | 公共 status 保持；所有管理 mutation fail closed；使用预先审批的外部通信渠道   | 不临时公开 admin endpoint、不直改 D1       | Access assertion 验签、viewer/operator RBAC tests |
| Machine issuer/JWKS unavailable    | 停止发布和新机器会话；保留已验证请求的正常过期语义                            | 不延长 15 分钟上限、不关闭 issuer/aud 校验 | 新 key/旧 key 轮换窗口测试，claim mismatch 仍 403 |
| OTLP backend unavailable           | 使用 Workers Logs/dashboard；标记 observability degraded；保留 Correlation ID | 不因“没有 error trace”判健康               | destination status、已知 canary trace/log 可检索  |
| Analytics Engine unavailable       | 降级派生分析，D1 领域判断继续                                                 | 不从 AE 回写权威 status                    | 写入/查询 canary 与延迟恢复                       |
| Scheduler/probe region failure     | freshness 到期后显示 unknown；比对多地点与 dependency graph                   | 不用单一失败地点直接扩大 outage            | 多地点样本、policy revision、freshness 恢复       |

每次事件保留：UTC 时间线、deployment ID、git commit、Correlation/trace ID、受影响 binding、失败阶段、采取的幂等命令、恢复验证与后续 action。严禁粘贴 authorization header、Access assertion、presigned URL 或 R2 credential。

## 9. 发布前最终门禁 / Final go-live gate

- [ ] CI 所有 job 通过；OpenAPI 生成无 diff、lint 与 breaking gate 通过。
- [ ] staging 完整演练：migration、bootstrap、machine JWT、artifact upload/ready、Worker deploy、Pages 手工 deploy。
- [ ] Access audience/issuer/sub-role 映射与三种角色负向测试通过。
- [ ] D1/Queue/DLQ/R2/AE/Service Binding 均为 production 独立资源，DLQ 告警已触发测试。
- [ ] source map 能把生产 canary stack 定位到同一 git commit；R2 digest/metadata 一致。
- [ ] retention migration、cleanup、D1 restore、DLQ canary replay 已演练并有证据。
- [ ] OTLP trace/log destination 可检索；metrics 缺口有明确替代；external telemetry outage 不会显示绿色。
- [ ] GitHub `github-pages` 与 production release Environment 都有 required reviewers；secret scanning/branch protection 已启用。

任一项未完成：保持 workflow 手动、不得接 production 流量。可爱归可爱，生产事故可一点也不萌喵。

## 10. 区域探针与业务能力绑定 / Regional probes and business capability bindings

Status Cron 只负责调度，不能把自身 runtime 字符串当作多个地区。按 `workers/probe-executor/README.md` 为各区域部署独立私有执行器；在 Status 配置中声明默认 fetch Service Binding，例如：

```jsonc
{
  "services": [
    { "binding": "PROBE_EXECUTOR_ASIA", "service": "moesegfault-probe-asia" },
  ],
  "vars": {
    "PROBE_REGIONAL_CONFIG": "{\"asia\":{\"binding\":\"PROBE_EXECUTOR_ASIA\",\"executor_id\":\"probe-asia-v1\",\"allowed_colos\":[\"SIN\"],\"allowed_kinds\":[\"http\",\"tcp\",\"dns\"]}}",
  },
}
```

The Status Cron orchestrates independent private regional executors; it never uses its runtime label as proof of geography. The registry maps each enabled monitor location to a default-fetch Service binding, executor identity, accepted physical colos, and permitted probe kinds.

执行器的 `placement.region` 是放置提示，不是执行地点证明。只接收平台来源验证通过的样本；两个别名落在相同实际 colo 时不能得到两票。执行器断连不等价于被测目标超时。默认 fetch 与业务 HealthRpc 是两层不同绑定，不能用后者替代区域执行器。[Cloudflare Placement](https://developers.cloudflare.com/workers/configuration/placement/)

Placement hints are not geographic proof. Accept only verified platform provenance and do not count two aliases in one physical colo as independent votes. Executor disconnection is not target timeout. Regional default-fetch transport and business HealthRpc are separate capability layers.

需要 RPC/synthetic 时，在**执行器**中配置真实业务 Worker 的 named entrypoint，并将相应 kind 加入许可列表：

```jsonc
{
  "services": [
    {
      "binding": "PROBE_SERVICE_API",
      "service": "actual-business-worker",
      "entrypoint": "HealthRpc",
    },
  ],
  "vars": {
    "PROBE_BINDING_CONFIG": "{\"api-health\":{\"kind\":\"rpc\",\"service_binding\":\"PROBE_SERVICE_API\",\"operations\":[\"health\"],\"timeout_ms\":1000}}",
  },
}
```

Monitor 的 `binding` 是注册别名 `api-health`，不是任意 Env 字段。接收方必须校验共享请求协议并实施 `deadline_at`；synthetic 只能操作专用 `probe:*` 主体，真实清理完成后才能返回 `cleanup_completed: true`。调用方取消不保证远端回滚，不能以 `waitUntil` 的未来清理冒充当前已清理。

Monitor bindings select finite registry aliases, never arbitrary environment fields. Receivers validate the shared protocol and enforce deadlines. Synthetic operations use isolated `probe:*` subjects and acknowledge cleanup only after it actually completes; caller cancellation is not remote rollback.

空注册表明确无可执行能力。上线前需分别验证真实地域来源、不同 colo 仲裁、缺失来源拒绝、目标超时、执行器故障、合成数据清理及租约竞争。本地 workerd 证明协议和绑定执行，不证明地理分布。

An empty registry exposes no executable capability. Before enabling production monitors, validate real geographic provenance, independent-colo quorum, missing-provenance rejection, target timeouts, executor failures, synthetic cleanup, and lease races. Local workerd validates protocol execution, not geographic distribution.

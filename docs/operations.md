# moeSegFault Status 生产运维手册 / Production Operations Runbook

> 本文是执行清单，不是上线证明。资源、代码、Worker secrets 和真实生产验收必须分别核验；已准备本机文件不等于已上传 Worker secret。 / This is a checklist, not deployment evidence. Verify resources, code, Worker secrets and production behavior independently; a prepared local file is not an uploaded Worker secret.

## 当前云端事实 / Current cloud evidence

- 本机 Wrangler 已部署最终 Rust status 的 bootstrap 版本；`ADMIN_PASSWORD_RECORD` secret bulk 成功，平台列表类型为 `secret_text`，secret 更新后的版本已切换 100% 流量。 / Local Wrangler deployed the Rust bootstrap and installed the administrator secret, confirmed as secret_text with a full version cutover.
- Rust Ops gateway 与 Static Assets 版本已上传；本机 `triggers deploy` 成功绑定 `status.moesegfault.dev` 和 `ops.moesegfault.dev`。HTTPS 公共 JWKS 返回 200 且与仓库公钥完全一致；Ops HTML 返回 200 且 SHA-256 与构建产物一致。 / Both custom domains are bound. HTTPS JWKS matches the repository public keys; served Ops HTML matches the built SHA-256, both returning 200.
- `/v1/status` 与 `/api/session` 仍返回 503，符合 bootstrap/provenance 门禁；这不是绿色健康或成功登录的证据。 / Status and session APIs still return 503 under bootstrap/provenance gates, not successful health or login.
- 初次 status 部署在更新空 Cron 配置时遇到 Cloudflare `10063`：账户缺少 workers.dev subdomain。该次脚本与四个 Queue producer 已成功，后续不含 Cron 的域名配置成功；不可把这次部分成功记录成整个部署命令成功。定时器和 Queue consumer 尚未启用。 / Initial deployment partially succeeded: script/producers uploaded, but empty-Cron configuration failed with 10063 because the account lacks a workers.dev subdomain. Subsequent domain configuration without Cron succeeded. Timers and queue consumers remain disabled.
- S3 签名凭据、通知目标与完整注册/上传/ready 发布仍待完成。R2 对象级验证和静态页面可访问不能替代这些验收。 / S3 signing credentials, notification destinations and the complete registration/upload/readiness release remain outstanding; object checks and reachable static HTML do not replace them.

## 1. 权限与职责 / Authority and responsibility

| 主体 / Principal                    | 最小权限 / Minimum authority                                                                               | 禁止事项 / Must not                                                                                               |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| GitHub CI / release                 | 测试及受控 Worker 版本上传、部署 / Tests and controlled Worker version upload/deployment                   | 不授予 DNS 或 Access 管理权限；不接收管理员密码 / No DNS/Access administration or administrator password          |
| 单一 owner / Sole owner             | 预配置密码登录与退出，执行管理操作 / Preconfigured password login/logout and administration                | 无公开注册、setup 或改密 UI / No registration, setup or password-change UI                                        |
| Rust ops-gateway                    | 验证 D1 会话和 Origin/CSRF，调用私有 AdminRpc / Validate sessions and Origin/CSRF, invoke private AdminRpc | 不信任身份请求头，不公开通用 RPC 隧道 / No trusted identity headers or generic RPC tunnel                         |
| 本机运维 CLI / Local operations CLI | 配置 Worker secret、Custom Domain 与触发器 / Configure secrets, domains and triggers                       | 不把本机管理员密码复制到仓库、GitHub 或聊天 / Never copy the local password into source, GitHub or chat           |
| status Worker                       | D1、Queue/DLQ、私有 R2 与所需 secret / Domain state, queues, private artifacts and required secrets        | 不向前端返回 object key、凭据或原始遥测 / No credentials, private locators or raw telemetry in frontend responses |

### 1.1 单管理员密码 / Single-administrator password

管理员审计标识 `ADMIN_EMAIL` 与密码记录一样，只通过 Cloudflare Worker Secret 配置，不得写入仓库 vars、公开页面或未认证响应。该标识仅用于认证后的内部业务协议，不承担身份验证；身份验证仍依赖预置密码。缺少或无效标识时认证失败关闭。 / Configure the administrator audit identity `ADMIN_EMAIL` exclusively as a Cloudflare Worker Secret, like the password record; never place it in repository vars, public pages, or unauthenticated responses. It exists only for authenticated internal business contracts and is not proof of identity. Authentication still requires the preconfigured password and fails closed if the identity is missing or invalid.

2026-09-12 隐私修复已将该标识迁入真实 `secret_text`，从登录前后 UI 和当前浏览器产物移除邮箱。bootstrap 维护版本仅通过 `versions upload` / `versions deploy` 全量切换，未更改 DNS、触发器或绕过生产就绪门禁。HTTPS 核验当前页面、JS、CSS 与本地构建摘要相同，旧 JS/source map 地址不再返回含邮箱的旧内容。 / The privacy remediation moved this identity into an actual `secret_text` and removed the email from UI and current browser artifacts. Bootstrap maintenance used only version upload/deploy at 100%, without changing DNS/triggers or bypassing production readiness. HTTPS checks matched current HTML/JS/CSS to build hashes and confirmed old JS/map URLs no longer return the identity-bearing content.

经所有者明确批准，随后清理了含邮箱的 Git 历史，并通过显式远端旧版本租约强推 `main`。全新远端克隆及本机全部 Git 对象扫描无目标邮箱残留，重写前后工作树摘要相同；本机快照引用保留并脱敏。22 次历史 Actions 日志中有 2 次含邮箱，已仅删除对应日志，保留运行记录。原始备份只存于仓库外受保护目录。本仓库使用 GitHub noreply 提交邮箱防止再次引入。 / With explicit owner approval, the email-bearing history was rewritten and main was force-pushed using an exact old-head lease. Fresh remote-clone and local all-object scans found no target identity; the working-tree hash was unchanged by rewriting. Local snapshot refs were retained and sanitized. Two of 22 historical Actions logs contained the identity; only those logs were removed, preserving run records. Original backups remain exclusively in protected storage outside the repository. Repository-local commit identity uses GitHub noreply.

旧克隆应重新克隆或严格变基，不要合并旧历史后推回。强推不能撤回第三方副本，也不能保证 GitHub 旧 SHA 缓存已删除；缓存与不可写内部引用需按 GitHub Support 的政策处理。 / Re-clone or carefully rebase old clones; never merge and repush the tainted history. Force-pushing cannot recall third-party copies or guarantee removal of GitHub old-SHA caches; cached views and unwritable internal references require GitHub Support policy handling.

运维 UI 使用官方 `moesegfault-style v0.1.2` 静态分发，固定来源提交与 SHA-256，详情见 `apps/ops/vendor/README.md`。 / The operations UI consumes the official pinned `moesegfault-style v0.1.2` static release; see `apps/ops/vendor/README.md` for source and integrity details.

不使用 Cloudflare Access。管理员只有一个 owner，密码事先生成并保存在受操作系统访问控制列表（Access Control List, ACL）保护的本机私密文件中；仓库不记录该文件路径、密码或密码记录。前端只提供登录和退出，没有 setup、注册、账号管理或修改密码入口。 / Cloudflare Access is not used. A single owner uses a pre-generated password retained in an OS-ACL-protected local private file. Neither its path nor the password/record belongs in source. The UI provides login/logout only.

- `ADMIN_PASSWORD_RECORD` 是 Worker secret：PBKDF2-SHA256（Password-Based Key Derivation Function 2），600,000 次迭代、16 字节随机盐、32 字节派生哈希。密码明文不进入 D1、GitHub、构建产物或日志。 / The Worker secret stores a PBKDF2-SHA256 record with 600,000 iterations, a 16-byte random salt and a 32-byte derived hash. Plaintext never enters D1, GitHub, build artifacts or logs.
- 迁移 `0009_single_administrator.sql` 只增加会话令牌摘要/密码记录指纹/有效期和登录全局预算；不建账号表、不存密码记录。登录预算是全局 10 分钟最多 30 次，不能通过切换 IP 绕过；攻击者耗尽预算仍可造成暂时无法登录，必须监控该可用性风险。 / Migration 0009 stores token hashes, record fingerprints, expiry and a global login budget, not accounts or password records. The 30-attempt/10-minute global budget prevents IP-rotation bypass but can temporarily deny legitimate login if exhausted.
- 会话有效期 12 小时，cookie 使用 `Secure`、`HttpOnly`、`SameSite=Strict`；退出撤销对应 D1 会话，所有管理 API 仍执行 Origin/CSRF 检查。 / Sessions last 12 hours with Secure, HttpOnly, SameSite=Strict cookies; logout revokes the D1 session, and administrative APIs enforce Origin/CSRF.
- 改密是本机受控 secret 轮换，不是 UI 操作。将新记录配置到新 Worker 版本后执行 **100% 流量切换**，旧记录指纹对应的会话即失效；渐进混跑旧版本会保留旧会话可用窗口，不能用于即时撤销。 / Password changes are controlled local secret rotations. Deploy the new record/version to 100% of traffic to invalidate old-fingerprint sessions; mixed-version rollouts leave an old-session acceptance window.
- 本机已完成 status bootstrap 后的 secret bulk 上传；平台 secret list 确认 `ADMIN_PASSWORD_RECORD` 为 `secret_text`，包含该 secret 的最新版本已 100% 部署。此证据不等于云端登录已通过。 / Local secret bulk installation is complete after status bootstrap. The platform lists ADMIN_PASSWORD_RECORD as secret_text and deploys the updated version to 100%; this does not establish successful cloud login.

### 1.2 机器 JWT（JSON Web Token）

机器 issuer 必须固定 `MACHINE_ISSUER`、`MACHINE_AUDIENCE` 与 `MACHINE_JWKS_URL`。签发服务需：

- 使用轮换的非对称签名 key，并通过固定 HTTPS JWKS 发布；JWT header 的 `jku`/`x5u` 不得改变信任地址；
- 每 token 绑定一个 `service_name`、`environment`、UUIDv7 `deployment_id`、稳定唯一 `jti`；
- `exp - iat <= 900s`，最小 scope；发布需要 `deployments:write artifacts:write`，诊断生产者仅需 `diagnostics:write`；
- 发布脚本启动时 token 至少还剩 10 分钟；先构建产物，再即时换取 token，不要让编译消耗其寿命；
- 当前 Rust CLI 从 GitHub secret `MACHINE_JWT_PRIVATE_KEY` 在内存签发短期 JWT；私钥和 JWT 不写 artifact/log。GitHub OIDC 交换身份服务并未部署，不把未来方案描述为当前流程。私钥保留在受控 secret 中并安排轮换； / The Rust CLI currently signs short-lived JWTs in memory from MACHINE_JWT_PRIVATE_KEY. Neither key nor JWT is emitted to artifacts/logs. An OIDC exchange service is not deployed; protect and rotate the signing secret.
- issuer 故障时停止发布，不得扩大时钟偏差、延长 token 或跳过验证。

机器签名私钥与游标签名密钥已生成并保存在 GitHub secrets；文档与审阅只记录名称，不读取或输出值。`config/machine-jwks.json` 只含公钥，将由 Rust 的 well-known 端点公开；公钥公开不是私钥泄漏，也不能替代 issuer/audience 校验。管理员密码独立保存在本机，不存 GitHub。 / Machine signing and cursor secrets are generated and retained in GitHub secrets; record names only. The public-only JWKS file is intended for a Rust well-known endpoint; publishing public keys does not disclose private keys or replace issuer/audience checks. The administrator password remains local, not in GitHub.

这里的 payload 预解析只是客户端的快速失败（fail-fast）；签名与 claim 的权威验证永远在 status Worker。

## 2. Cloudflare 资源初始化 / Resource provisioning

远端 D1 已真实应用全部 9 个迁移；`verify-d1` 的 `target/d1-auth-verification.json` 记录验证通过，`PRAGMA foreign_key_check` 与 `PRAGMA quick_check` 均无异常。R2 已开通，私有 bucket 已创建，并已执行真实云端 PUT → GET → SHA-256 校验 → DELETE。四个诊断/通知主队列与 DLQ 已创建，四个 producer 绑定已上传；consumer 与定时器尚未启用。应用尚未完成完整生产发布。 / All nine remote D1 migrations are applied; verify-d1 recorded success in target/d1-auth-verification.json, with clean foreign_key_check and quick_check results. R2 is enabled and its private bucket passed an actual cloud PUT/GET/SHA-256/DELETE check. Four diagnostic/notification queues and DLQs exist and four producer bindings are uploaded; consumers and timers are not enabled. Full production application release is not complete.

不要重复创建这些资源。新增资源或更改计费必须另行审阅；真实 R2 对象检查不等于应用的带 JWT 注册、预签名上传及 ready 闭环已在生产验收。 / Do not recreate existing resources. Review new provisioning/billing separately; the R2 object check does not establish the application's authenticated registration/upload/readiness path.

随后把真实 D1 `database_id`、Queue、DLQ、R2 名称写入受审阅的环境配置。Analytics Engine 数据集无需预建：声明 binding 后第一次 `writeDataPoint` 自动创建。[Analytics Engine setup](https://developers.cloudflare.com/analytics/analytics-engine/get-started/)

必须逐项核验：

- 主 Queue 的 consumer 指向 status，`max_retries=5`，并配置 DLQ；status 还需要 `DIAGNOSTIC_DLQ` producer binding，才能保存结构化失败上下文；
- R2 bucket 为私有，禁用公共 `r2.dev`；上传只用短效、对象键/checksum/metadata 受限的 presigned URL。Presigned URL 是 bearer credential，只能短期暴露。[R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- AE binding 为 `ANALYTICS`/`moesegfault_status`；AE 不是领域状态源；
- `STATUS` Service Binding 精确指向 status 的 `AdminRpc` named entrypoint；
- production 与 staging 使用不同 D1、Queue/DLQ、R2 bucket、Worker 名与 secrets，不能只靠 `ENVIRONMENT` 字符串隔离。

### 2.1 Secret 清单

通过交互式 stdin、受保护 CI 或本机 secret bulk 注入。禁止把生产 secret 放入仓库内 `.dev.vars`、仓库/可发布 JSON、命令行参数、issue、构建 artifact 或前端 bundle；受 OS ACL 保护、位于仓库外且不上传 GitHub 的私密 JSON bulk 文件允许作为本机预置材料。 / Inject through stdin, protected CI or local secret bulk input. Production secrets must not enter repository/publishable files, CLI arguments, issues, build artifacts or frontend bundles. An OS-ACL-protected secret bulk JSON file outside the repository and never uploaded to GitHub is permitted for local provisioning.

```bash
pnpm exec wrangler secret put ADMIN_PASSWORD_RECORD --config wrangler.jsonc
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

`outbox.delivered` 表示 Queue 已接受消息，**不表示 webhook 已完成处理**。接收方必须按 `Idempotency-Key` 原子去重，再返回成功状态；网络不确定性和重放会产生重复投递。固定 HTTPS webhook 禁止重定向，每次请求 5 秒超时，非成功响应保留原事件 ID 重试；达到配置的总尝试上限（当前 5 次，即最多 4 次重试）进入通知 DLQ。须独立监控通知积压与 DLQ，并以故障 canary 验证重试和去重，不能只查看 D1 outbox 清空。

`outbox.delivered` means Queue acceptance, not webhook completion. The receiver must atomically deduplicate `Idempotency-Key` before acknowledging success. Requests use a pinned HTTPS destination, reject redirects, time out after five seconds, and retain event IDs across retries. At the configured total-attempt limit (currently five attempts, at most four retries), the notification DLQ retains failures. Monitor backlog and DLQ separately and test the complete failure/replay path.

通知不是公共缓存失效协议。当前读取以 D1 快照与显式 freshness 为准；不得把 webhook 成功当作所有客户端缓存已刷新。

Notifications are not a public cache invalidation protocol. Public reads rely on D1 snapshots and explicit freshness; webhook success does not prove all client caches refreshed.

### 2.2 D1 初始化与恢复点

```bash
pnpm exec wrangler d1 migrations list moesegfault-status --remote
pnpm exec wrangler d1 migrations apply moesegfault-status --remote
pnpm exec wrangler d1 execute moesegfault-status --remote --command "PRAGMA foreign_key_check; PRAGMA quick_check;"
```

在 staging 先执行并跑 smoke tests，再由 environment 审批 production。应用前记录 D1 Time Travel bookmark/当前时间与 schema version；D1 Time Travel 默认开启，可按分钟恢复，当前生产存储保留窗口最长 30 天。[D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)

不要用 dashboard/ad-hoc SQL 初始化领域行：它会绕过管理 RPC 的 schema、幂等账本和 audit log。保留策略必须通过 owner 会话保护的 `POST /api/retention-policy-assignments` 原子登记不可变 revision 并绑定服务；数据库 migration 只建立结构，不偷偷写入环境专属领域配置。

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

使用 owner 会话保护的同源 Ops API；每个 mutation 带：

```bash
curl --fail-with-body 'https://ops.moesegfault.dev/api/services' \
  -H 'content-type: application/json' \
  -H 'origin: https://ops.moesegfault.dev' \
  -H 'x-moesegfault-csrf: 1' \
  --data-binary @service-command.json
```

浏览器/运维客户端必须提供 owner session；禁止把密码或 session cookie 复制进示例或 shell history。命令 body 参照 `packages/contracts/src/admin.ts` 和生成的 OpenAPI；Rust 服务端独立执行权威校验，并满足：

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

构建与发布业务由原生 Rust `status-build` / `status-release` 执行；Node 仅运行官方 Wrangler 与前端工具。状态后端入口为 `dist/rust/status/status.js`，包含公开和私有 AdminRpc 两套 SDK 模块。 / Native Rust owns build/release orchestration; Node runs official Wrangler and frontend tools. The status entrypoint assembles public and private SDK modules.

发布配置不含 secret，必须包含所有实际运行模块、对应 JavaScript source map 与 WASM 调试符号。不要手写只含一个 JS 文件的旧清单；通过构建工具合并非秘密 metadata 与真实 artifact inventory。 / Release configuration contains no secrets and inventories every runtime module plus genuine source maps/debug symbols. Generate the inventory instead of copying a single-JavaScript-artifact example.

```sh
# metadata 包含独立部署 ID、服务/环境、Git/CI 来源及固定时间；不含密钥。
# Metadata contains deployment/service/environment, Git/CI provenance and fixed timestamps, never secrets.
cargo run --locked -p status-build -- --service status --release-template release.metadata.json
cargo run --locked -p status-release -- --config release.status.json --verify-only
cargo run --locked -p status-release -- --config release.status.json --dry-run
```

完整配置与首次双阶段引导见 [Rust 发布说明](../scripts/release/rust-release-README.md)。这些命令不是已执行云端部署的记录。 / See the Rust release runbook for configuration and two-stage bootstrap; these commands are instructions, not deployment evidence.

`deployed_at`、`ci_provider` 与 `ci_run_id` 必须在第一次注册前冻结。`release_attempt` 不进入 immutable Manifest：同一 attempt 的网络重试必须复用它；只有服务器报告 upload session 已过期时才递增并重新运行。否则相同 `deployment_id` 会因 Manifest 内容变化而正确返回 409。GitHub runner 还会强制 `repository_url` 匹配 `GITHUB_REPOSITORY`，且 `git_ref` 必须解析到当前 HEAD。

```bash
# 本地只校验并输出 canonical manifest；不访问网络、不部署。
cargo run --locked -p status-release -- --config release.status.json --verify-only

# 受审批 runner：秘密只存在环境中。
export MOE_RELEASE_API_URL='https://status.moesegfault.dev'
# MACHINE_JWT_PRIVATE_KEY 由受保护 runner 环境注入；Rust CLI 内存签发。
# Inject MACHINE_JWT_PRIVATE_KEY through the protected runner environment; Rust signs in memory.
export CLOUDFLARE_API_TOKEN='<least-privilege token>'
cargo run --locked -p status-release -- --config release.status.json
```

脚本顺序固定为：SHA-256 exact bytes → 注册 immutable manifest → 为每个 artifact 建立受限上传 session → PUT → HEAD/metadata/digest commit → 幂等重读必须为 `ready` → `wrangler versions upload` → 审核版本 ID → `wrangler versions deploy`。受 `If-None-Match: *` 保护的 PUT 返回 412 表示相同内容寻址 key 已存在，客户端继续 commit，由服务端 HEAD/digest 做权威验证，绝不覆盖。最后一步显式传入同一 `DEPLOYMENT_ID`、`GIT_COMMIT`、`ARTIFACT_DIGEST`、`STATUS_VERSION` 与 `ENVIRONMENT`，使 runtime telemetry 与注册表同源。任何失败都会阻止 Wrangler；不得以 `--no-bundle` 外的二次构建替换已登记字节。Cloudflare 也明确把 `--dry-run --outdir` 定位为上线前取得 bundle/source map 的阶段。[Wrangler deploy commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/)

`ready` **不代表已经部署，也绝不自动改动探针使用的 current deployment 指针**。Wrangler 成功且 smoke/canary 证据通过后，由登录后的单一 owner执行显式 cut-over：

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

GitHub CI 的发布 machine JWT 没有、也不应取得该 owner 管理能力。自动化若未来确有激活需求，必须另行设计可审计的机器主体、独立 audience/scope 与审批门，而不是复用 `deployments:write artifacts:write`。

Ops 前端与 Rust gateway 使用同一个 Worker 的静态资源（Static Assets）部署：平台提供 UI，`/api/*` 先进入 Rust；撤下旧 GitHub Pages 发布链。前后端作为同一版本发布，不能让 SPA fallback 吞掉 API 的认证或错误响应。 / Ops UI and Rust gateway share one Static Assets deployment: the platform serves UI while `/api/*` enters Rust first. Retire the GitHub Pages pipeline and prevent SPA fallback from swallowing API responses. [Static Assets routing](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/)

GitHub 仅执行受控 `wrangler versions upload` 和 `wrangler versions deploy`，不改 DNS/Access。Custom Domain 与 Cron/路由触发器由本机 CLI `wrangler triggers deploy` 管理；Custom Domain 由 Cloudflare 自动创建 DNS 和证书，不在 GitHub 另写 DNS 记录。版本上传本身不代表触发器已更新。 / GitHub uploads/deploys versions only. Local CLI manages domains/triggers; Cloudflare creates Custom Domain DNS and certificates. Version upload does not update triggers. [Versions](https://developers.cloudflare.com/workers/versions-and-deployments/), [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/), [Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/)

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

| 故障 / Failure                     | 立即动作 / Immediate action                                                         | 禁止 / Never do                                                    | 恢复证据 / Recovery evidence                                               |
| ---------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| D1 unavailable                     | 冻结 mutation/deploy；保留缓存公共读；外部渠道声明状态数据可能过期                  | 不把写入改成本地内存“成功”                                         | health、读写 canary、Queue lag 回落、约束检查                              |
| Queue publish/consumer unavailable | producer 有界退避；告警 backlog；暂停会制造更多诊断的批任务                         | 不丢事件后伪造绿色状态                                             | enqueue/ack canary，重复事件无副作用                                       |
| R2 unavailable                     | 阻断 artifact commit 与新生产流量；已有 status read 可继续                          | 不把 deployment 强行标 ready                                       | PUT/HEAD checksum canary，manifest replay ready                            |
| Owner authentication unavailable   | 公共 status 保持；管理失败关闭 / Public status remains, administration fails closed | 不临时公开管理入口或直改 D1 / No public bypass or ad-hoc D1 writes | 登录、会话、CSRF 与全局预算恢复 / Login, session, CSRF and budget recovery |
| Machine issuer/JWKS unavailable    | 停止发布和新机器会话；保留已验证请求的正常过期语义                                  | 不延长 15 分钟上限、不关闭 issuer/aud 校验                         | 新 key/旧 key 轮换窗口测试，claim mismatch 仍 403                          |
| OTLP backend unavailable           | 使用 Workers Logs/dashboard；标记 observability degraded；保留 Correlation ID       | 不因“没有 error trace”判健康                                       | destination status、已知 canary trace/log 可检索                           |
| Analytics Engine unavailable       | 降级派生分析，D1 领域判断继续                                                       | 不从 AE 回写权威 status                                            | 写入/查询 canary 与延迟恢复                                                |
| Scheduler/probe region failure     | freshness 到期后显示 unknown；比对多地点与 dependency graph                         | 不用单一失败地点直接扩大 outage                                    | 多地点样本、policy revision、freshness 恢复                                |

每次事件保留：UTC 时间线、deployment ID、git commit、Correlation/trace ID、受影响 binding、失败阶段、采取的幂等命令、恢复验证与后续 action。严禁粘贴 authorization header、密码/session cookie、presigned URL 或 R2 credential。

## 9. 发布前最终门禁 / Final go-live gate

- [ ] CI 所有 job 通过；OpenAPI 生成无 diff、lint 与 breaking gate 通过。
- [ ] staging 完整演练：migration、bootstrap、machine JWT、artifact upload/ready、Worker 版本发布、同版本 Ops Static Assets 与本机触发器配置。
- [ ] owner 登录/退出、错误密码、全局预算、CSRF、会话过期与密码轮换后旧会话拒绝测试通过。
- [ ] D1/Queue/DLQ/R2/AE/Service Binding 均为 production 独立资源，DLQ 告警已触发测试。
- [ ] source map 能把生产 canary stack 定位到同一 git commit；R2 digest/metadata 一致。
- [ ] retention migration、cleanup、D1 restore、DLQ canary replay 已演练并有证据。
- [ ] OTLP trace/log destination 可检索；metrics 缺口有明确替代；external telemetry outage 不会显示绿色。
- [ ] 受控 production release 有 required reviewers；GitHub 无 DNS/Access 权限、无管理员密码；secret scanning/branch protection 已启用。

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

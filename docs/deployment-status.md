# 云端执行记录 / Cloud execution record

## 最终生产验收 / Final production acceptance

2026-09-12 23:27 +08:00：以下结果取代下方早期截点的待办状态。 / These results supersede the outstanding state at the earlier cutoff below.

| Service      | Actions release                                                                           | Cloudflare version                     | Registry state |
| ------------ | ----------------------------------------------------------------------------------------- | -------------------------------------- | -------------- |
| status 0.1.2 | [34701836331](https://github.com/kleedaisuki/moesegfault-status/actions/runs/34701836331) | `34a0409d-b360-4890-a4f2-833fbb1caa60` | active         |
| ops 0.1.0    | [34700970772](https://github.com/kleedaisuki/moesegfault-status/actions/runs/34700970772) | `89f187e1-e2e0-46d9-b666-bdef8e27b29e` | active         |
| probe 0.1.0  | [34700972438](https://github.com/kleedaisuki/moesegfault-status/actions/runs/34700972438) | `713fb233-0ee5-48c7-8cb0-06a33ab99d8e` | active         |

- 三次均取得真实 `release-completed` 回执，产物上传、摘要验证和 ready 门禁后才发布；管理员随后通过实际上下文修订号激活，D1 三个生产指针均为 active。 / All runs produced actual release receipts after artifact verification and readiness; authenticated revision-checked activation established three active production pointers.
- 四个公开 GET 返回 200，固定运维来源 CORS 正确。真实 Chrome 表单登录、管理接口和跨域读取成功，页面不展示邮箱；注销及旧 Cookie 重放均返回 401。 / Four public reads return 200 with fixed-origin CORS. Real Chrome login, private reads and cross-origin reads passed without rendering the email; logout and revoked-cookie replay return 401.
- 平台原生密码派生拒绝原先的参数；改为仅供本地生成的 192-bit 随机管理员凭据使用的 PBKDF2-SHA256/100000，原口令不变、记录仅存 Worker Secret，实际生产登录验证通过。此策略不是人工低熵密码的通用建议。 / The native password derivation path rejected the former parameters. The generated 192-bit operator credential now uses PBKDF2-SHA256/100000 with the same password and a Worker Secret verifier; real production login passed. This is not a general policy for low-entropy human passwords.
- 本机仅配置资源：每分钟 Cron、diagnostics consumer（batch 10 / timeout 5s / retries 5 / diagnostics DLQ）。域名未改动，默认地址与预览仍禁用。 / Local operations configured only resources: per-minute Cron and the diagnostics consumer with its DLQ; domains were preserved and default URLs/previews remain disabled.
- 通知消费者未启用；监控与公开组件均为零。私有 probe 已发布，但没有登记主机或证明真实地域探测；不将平台上线解释为外部服务健康。 / Notifications remain disabled and no monitors or public components exist. The private probe is published, but no target hosts or real geographic probe execution are asserted.
- 工单草稿已按要求删除；不再推进旧 SHA 缓存工单。 / The support draft was deleted as requested; no old-SHA cache ticket is pursued.
- 发布源提交 `c4fe6d4` 的 [完整 CI 34701836178](https://github.com/kleedaisuki/moesegfault-status/actions/runs/34701836178) 全部成功。最终 D1 外键检查为空、quick_check 为 ok、退出后会话数为零。 / All CI jobs passed for release source c4fe6d4; final D1 foreign-key checks are empty, quick_check is ok and no sessions remain after logout.

核验截点：2026-09-12 22:55 UTC+08:00。资源已初始化，正式发布仍在修复和验证中；不得把工作流绿色状态或引导部署当成生产上线证明。 / Verification cutoff: 2026-09-12 22:55 UTC+08:00. Resources are initialized, but production release remains under repair and verification. Neither a green workflow nor a bootstrap deployment proves production readiness.

## 当前资源与边界 / Current resources and boundaries

| 项目 / Item                        | 已核验状态 / Verified state                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1                                 | `moesegfault-status`（`40674161-5e59-470c-bb1c-33bc612d7e6b`）已应用全部 9 个迁移；外键检查无违规，`quick_check` 为 `ok`。 / All nine migrations applied; foreign-key checks clean and `quick_check` returns `ok`.                                                                                                                                            |
| 服务目录 / Service catalog         | 仅登记 `status`、`ops-gateway`、`probe-executor` 三个内部软件身份，用于发布溯源；附三条登记审计记录。监控器和公开组件均为零，不代表任何服务健康。 / Three internal software identities registered for release provenance, with three registration audit entries; zero monitors and public components, with no implied health claim.                           |
| R2                                 | 私有桶 `moesegfault-observability` 已创建，读写、摘要核验和删除已验证；禁用公开访问。产物通过经过鉴权的 Rust Worker 使用原生 R2 绑定上传，无需 S3 凭据或 AWS S3。 / Private bucket created; put/get/digest/delete verified and public access disabled. Authenticated Rust Worker uploads use native R2 bindings, requiring neither S3 credentials nor AWS S3. |
| 管理员 / Administrator             | 单管理员登录表单；身份与密码记录存放于 Worker Secrets，不写入源码或页面。无需 Cloudflare Access，也不存在首次访问者注册管理员的流程。 / Single-administrator login uses identity and password records in Worker Secrets, never source or rendered pages. No Cloudflare Access or first-visitor administrator registration.                                    |
| 域名 / Domains                     | `status.moesegfault.dev` 与 `ops.moesegfault.dev` 已配置；探针 Worker 保持私有。默认 Worker URL 和预览 URL 不作为公开入口。 / Status and operations custom domains configured; probe Worker remains private, without public default or preview URLs.                                                                                                          |
| 调度与队列 / Scheduling and queues | 队列资源已创建，但 Cron 与消费者配置已回滚为空，等待正式发布核验后再启用。通知显式禁用，待发送事件保留；没有登记探针目标主机。 / Queues exist, but Cron and consumers have been rolled back to empty pending verified production release. Notifications are explicitly disabled with pending events retained; no probe target hosts are registered.           |

代码发布统一通过 GitHub Actions，包括引导更新和首次创建私有探针 Worker。本地 CLI 只管理资源、DNS、Secrets 及执行核验，不承担代码发布；Actions 不改 DNS。Cloudflare 平台部署 Token 与应用机器 JWT 属于不同信任边界。 / All code publication goes through GitHub Actions, including bootstrap updates and initial private probe creation. Local CLI manages resources, DNS, Secrets and verification, not code publication; Actions does not modify DNS. The Cloudflare deployment token and application machine JWT have distinct trust boundaries.

## 按时间排列的证据 / Chronological evidence

1. **早期阻塞已解决。** 最初 D1 授权不足、R2 未开通的记录属于历史状态，不再是待办；远端迁移和私有桶现已完成。 / **Initial blockers resolved.** Earlier D1 authorization failures and disabled R2 describe historical conditions, not outstanding requirements; remote migrations and the private bucket are now complete.
2. **引导发布成功，但不等于正式上线。** [Status 引导更新 / status bootstrap](https://github.com/kleedaisuki/moesegfault-status/actions/runs/34699676845) 与 [首次私有探针创建 / initial private probe](https://github.com/kleedaisuki/moesegfault-status/actions/runs/34699678766) 均通过 Actions 完成；引导模式不能替代正式发布和真实登录验证。 / **Bootstrap succeeded, not production acceptance.** Both actions completed through Actions; bootstrap mode does not replace formal release and real login verification.
3. **三次正式发布曾错误显示绿色。** [Status 34699959523](https://github.com/kleedaisuki/moesegfault-status/actions/runs/34699959523)、[Ops 34699961729](https://github.com/kleedaisuki/moesegfault-status/actions/runs/34699961729)、[Probe 34699963708](https://github.com/kleedaisuki/moesegfault-status/actions/runs/34699963708) 的实际发布命令遇到 HTTP 401，但 `tee` 管道掩盖了失败退出码。这些运行**不是生产部署成功的证据**。 / **Three formal runs falsely appeared green.** Their release commands encountered HTTP 401, but the `tee` pipeline masked the failing exit status. These runs are **not evidence of successful production deployment**.
4. **失败传播与鉴权路径已修复。** `7a0b1c5` 为发布管道启用 `set -euo pipefail`；`04916fc` 让发布 CLI 报告有界、白名单化的注册接口错误；`c0435d9` 为严格匹配的自身签发方使用编译内置的固定 JWKS，避免依赖 HTTP 自请求，未关闭 JWT 校验。 / **Failure propagation and authentication path repaired.** The pipeline now propagates failures; the release CLI reports bounded, allowlisted registry errors; an exactly matched own issuer uses compiled, pinned JWKS rather than an HTTP self-fetch, without disabling JWT validation.
5. **修复后的引导更新正在运行。** 截点时 [34700655486](https://github.com/kleedaisuki/moesegfault-status/actions/runs/34700655486) 基于 `c0435d9`，状态为 `in_progress`，尚无最终结论。 / **Corrected bootstrap update running.** At the cutoff, run 34700655486 targets `c0435d9` and is `in_progress`, with no final conclusion.

## 尚待验收 / Outstanding acceptance

必须在修复后的 Actions 发布完成后，核验真实产物登记与完整性、就绪门禁、实际 Worker 版本、公开 API、管理员登录与退出、管理页面跨域读取以及正式激活记录，再启用需要的调度和消费者。没有监控目标时，不伪造监控数据或健康结果。 / After corrected Actions releases complete, verify actual artifact registration and integrity, readiness gates, deployed Worker versions, public APIs, administrator login/logout, operations UI cross-origin reads and formal activation records before enabling required scheduling and consumers. Do not fabricate monitoring data or health results when no targets exist.

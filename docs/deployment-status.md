# 云端执行记录 / Cloud execution record

2026-09-12。以下是实际执行结果，不代表生产应用已上线。 / Actual execution results, not a production launch claim.

| 项目 / Item | 已核验状态 / Verified state                                                                                                                                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository  | `kleedaisuki/moesegfault-status`，实现代码已推送 main / implementation pushed to main                                                                                                                                            |
| Worker      | `moesegfault-status`，ID `fd8e808de9c14c4db796da1980ce5392`；资源已创建但无代码部署，workers.dev/preview 禁用 / created without deployment, public subdomains disabled                                                           |
| D1          | `40674161-5e59-470c-bb1c-33bc612d7e6b`，尚未应用远端迁移 / remote migrations not yet applied                                                                                                                                     |
| CI          | [实现基线 CI 成功 / baseline CI succeeded](https://github.com/kleedaisuki/moesegfault-status/actions/runs/34685823376)                                                                                                           |
| Migration   | [迁移运行 / migration run](https://github.com/kleedaisuki/moesegfault-status/actions/runs/34685985752) 在读取恢复 bookmark 时收到 Cloudflare `10000 Authentication error`；apply 步骤未运行 / authorization failed before writes |
| R2          | Cloudflare 返回 `10042 Please enable R2 through the Cloudflare Dashboard`；未开通或创建 bucket / not enabled; no bucket created                                                                                                  |

## 下一步所需配置 / Required configuration

只读凭据复验：[Actions run 34686277840](https://github.com/kleedaisuki/moesegfault-status/actions/runs/34686277840)。Token 已注入且无首尾空白，账户 secret 与仓库配置一致，没有 environment secret 覆盖；同一 Token 读取 Worker 返回 200，D1 列表和目标数据库均返回 401 / Cloudflare 10000。这排除了凭据未注入和账户值不一致，证据指向 D1 授权/资源范围不足，不是整枚 Token 无效。 / Read-only checks confirm secret injection and account equality: Worker access succeeds, but D1 access is denied. No credentials were printed or changed.

- 核对 GitHub `CLOUDFLARE_API_TOKEN` 对目标账户 `07109e406d4e1ab7a0997dd399db6fd5` 的 D1 编辑权限和资源范围，并核对 `CLOUDFLARE_ACCOUNT_ID`。不把本地 Wrangler OAuth 凭据复制到 CI。 / Verify D1 edit permission and account scope for the GitHub token and account ID; never copy local OAuth credentials into CI.
- 若采用当前产物设计，账户所有者需先在 Cloudflare 控制台开通 R2。这里使用的是 R2 的 S3 兼容 API，不是 AWS S3 服务。 / The account owner must enable R2 for the artifact design; S3 refers to R2's compatible API, not AWS hosting.
- 机器接口 JWT 与人类 Access 是应用鉴权，独立于平台部署 Token。首次引导与后续发布需要明确的受审信任路径，不能通过关闭校验解决初始化依赖。 / Machine JWT and human Access authentication are separate from platform deployment credentials. Bootstrap requires an explicit reviewed trust path, not disabled validation.

迁移工作流记录变更前 Time Travel bookmark，应用编号 SQL，再核验 `foreign_key_check`、D1 支持的 `quick_check` 和完整 migration ledger。失败时保留原有保护，不使用另一身份绕过 CI 权限限制。 / The workflow records a pre-change bookmark, applies numbered SQL, and verifies foreign keys, supported quick checks, and the exact migration ledger; failures do not bypass CI permissions.

依据：[D1 支持的 SQL / supported SQL](https://developers.cloudflare.com/d1/sql-api/sql-statements/)、[GitHub deployment environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)。

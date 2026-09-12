# Rust 发布与来源证明 / Rust release and provenance

`status-release` 负责发布事务；Node 只运行官方 Wrangler。GitHub 只发布已有 Worker 的版本，不管理 DNS、域名、routes 或 triggers。首次引导与 Custom Domain 由操作者在本机 CLI 独立完成；已删除 `--bootstrap-only`，发布器没有绕过 ready 的入口。
`status-release` owns the release transaction; Node runs only official Wrangler. GitHub publishes versions of existing Workers and never manages DNS, domains, routes or triggers. Initial bootstrap and Custom Domains are separate local operator CLI tasks. `--bootstrap-only` was removed: the releaser has no readiness bypass.

## 用法 / Usage

```sh
# 先编译 Vite，再冻结其路径/MIME/字节清单。 / Build Vite before freezing its path/MIME/byte inventory.
pnpm --filter @moesegfault/ops build
cargo run --locked -p status-build -- --service all
# 每个服务使用独立 deployment_id 和冻结的 metadata。 / Use independent deployment IDs and frozen metadata per service.
cargo run --locked -p status-build -- --service ops --release-template release-metadata.json

# 不联网、不读取签名私钥。 / No network or signing-key access.
cargo run --locked -p status-release -- --config release.ops.json --verify-only
# 真正 Wrangler versions upload dry-run；不上传、不部署。 / Actual Wrangler versions upload dry-run; no upload or deployment.
cargo run --locked -p status-release -- --config release.ops.json --dry-run
# 受审批发布 runner。 / Approved release runner.
cargo run --locked -p status-release -- --config release.ops.json
```

配置文件放在仓库根，所有产物、公共 JWKS 和 Wrangler 工具入口必须位于该目录内，symlink 不能逃逸。已有冻结 release 配置不会被构建器以不同 metadata 覆写。
Keep configuration at the repository root. Artifacts, public JWKS and the Wrangler entrypoint must remain beneath it after symlink resolution. The builder refuses to overwrite a frozen release configuration with different metadata.

## 凭据与原生 JWT 签发 / Credentials and native JWT minting

真实发布必需 `CLOUDFLARE_API_TOKEN` 与 HTTPS `MOE_RELEASE_API_URL`。机器凭据二选一：
Real release requires `CLOUDFLARE_API_TOKEN` and HTTPS `MOE_RELEASE_API_URL`. Choose one machine credential:

1. `MOE_MACHINE_JWT`：使用已签发令牌，预检查 deployment/service/environment、两个 write scope、最多 15 分钟寿命及至少 10 分钟剩余有效期；服务端仍负责验签。
   `MOE_MACHINE_JWT`: use a pre-issued token, prechecking deployment/service/environment, both write scopes, a maximum 15-minute lifetime and over 10 minutes remaining. The server still verifies signatures.
2. 否则从 `MACHINE_JWT_PRIVATE_KEY` 读取 RSA PEM，只在内存内签发。配置需显式提供 `status_origin`，默认公共 JWKS 为 `config/machine-jwks.json`，可用 `machine_jwks` 指定仓库内路径。
   Otherwise read an RSA PEM from `MACHINE_JWT_PRIVATE_KEY` and mint only in memory. Configuration must explicitly set `status_origin`; public JWKS defaults to `config/machine-jwks.json`, overridable with a repository-local `machine_jwks` path.

```json
{
  "status_origin": "https://status.moesegfault.dev",
  "machine_jwks": "config/machine-jwks.json"
}
```

这些字段追加到常规 release metadata，不是完整配置示例。签发前要求 `status_origin` 为无路径/尾斜杠的规范 HTTPS origin，且与 `MOE_RELEASE_API_URL` origin 严格一致。私钥导出的 RSA n/e 必须匹配公共 JWKS 中唯一的 RS256/sig kid；拒绝重复 kid、含私钥成员的 JWKS、不匹配密钥与小于 RSA-3072 的 modulus。签名后用固定公共密钥再次验签。固定 audience 为 `moesegfault-status`，subject 为 `status-release`，权限仅 `deployments:write artifacts:write`，携带配置 deployment/service/environment、随机 UUID jti、当前 iat 与 `exp=iat+900`。
These fields extend normal release metadata and are not a complete configuration. Minting requires a canonical HTTPS `status_origin` without a path/trailing slash, exactly matching the API origin. RSA n/e derived from the private key must match exactly one RS256/sig kid in the public JWKS. Duplicate kids, private JWK members, mismatched keys and moduli below RSA-3072 are rejected. The signed token is self-verified against the pinned public key. Audience is `moesegfault-status`, subject is `status-release`, scopes are only `deployments:write artifacts:write`, with configured deployment/service/environment, a random UUID jti, current iat and `exp=iat+900`.

令牌与私钥不打印、不写文件、不传给 Wrangler 或 esbuild/worker-build。网络错误体、预签名 URL 和 Wrangler stdout/stderr 不输出；只报告安全阶段与 HTTP 状态。公共密钥文件不包含秘密。
Tokens/private keys are never printed, written to files or passed to Wrangler/esbuild/worker-build. Network error bodies, presigned URLs and Wrangler stdout/stderr are suppressed; only safe phase/status information is reported. Public key files contain no secrets.

## 固定事务 / Fixed transaction

```text
clean Git + CI identity + exact SHA-256/MD5 + maps/DWARF + static manifest
  -> private runtime/config/assets snapshot
  -> versions upload --dry-run + runtime byte audit + static set/byte audit
  -> immutable manifest registration
  -> each artifact: scoped session -> immutable PUT -> server-verified commit
  -> require recomputed ready
  -> versions upload --no-bundle --upload-source-maps --strict
  -> unique version_id from this invocation's structured JSONL receipt
  -> versions deploy <exact-version-id>@100% --yes
  -> smoke/canary -> separate authenticated administrator activation
```

上传 SHA-256 来自真实字节；Base64 MD5 只用于传输校验。预签名请求不带 machine bearer，拒绝重定向、不匹配 headers 与过期 session，并要求 `If-None-Match: *`。PUT 412 只允许继续服务端 digest commit 验证。同 attempt 重试复用幂等 key；会话过期后才递增 `release_attempt`。ready 失败不执行云版本上传；上传失败/receipt 缺失、多个或非法不切换流量。发布不查询可能竞争的 latest version。
SHA-256 hashes actual bytes; Base64 MD5 is only a transport check. Presigned requests never carry machine bearers; redirects, mismatched headers and expired sessions are rejected, and `If-None-Match: *` is required. PUT 412 only permits server-side digest commit verification. Reuse idempotency keys within an attempt; increment the attempt after session expiry. Failed readiness prevents cloud version upload; failed uploads or missing/ambiguous/invalid receipts prevent traffic cut-over. Never query a racing latest version.

快照移除 `route`、`routes`、`triggers`、`workers_dev`、`preview_urls`、`zone_id`；工具仅调用 `versions upload` 和 `versions deploy`，不调用完整 `deploy`、`triggers deploy` 或 DNS/domain 命令。100% 版本切换不意味着业务 current-deployment 指针已经激活；后者仍需独立管理员审批。
Snapshots remove `route`, `routes`, `triggers`, `workers_dev`, `preview_urls`, and `zone_id`. The tool invokes only `versions upload` and `versions deploy`, never full `deploy`, `triggers deploy`, or DNS/domain commands. A 100% version cut-over does not activate the application's current-deployment pointer; that remains a separately approved administrator action.

## 静态资产与冻结集合 / Static assets and frozen sets

Ops 配置只允许下列已审核资产策略，不是无条件开放任意 `assets`：
Ops accepts only this reviewed asset policy, not an unrestricted `assets` escape hatch:

```json
{
  "assets": {
    "directory": "../../apps/ops/dist",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*"]
  }
}
```

`status-build` 枚举已构建 `apps/ops/dist`，为每个文件保留真实 MIME，并添加 `asset_path`。JS 使用 `other` + `text/javascript`，其 Vite map 使用 `source_map` + `application/json`，既有 map 门禁不变。另写 `dist/rust/ops.assets-manifest.json`，逐项绑定静态 URL 路径、MIME、大小和 SHA-256，并作为 `manifest` 产物登记；release 配置以 `asset_manifest` 引用它。文件 basename 冲突、未知 MIME、隐藏文件、symlink、`_headers`/`_redirects` 与超过 25 MiB 的单文件明确失败，不能通过错标二进制绕过。
`status-build` inventories built `apps/ops/dist`, preserving real MIME types and adding `asset_path`. JS uses `other` plus `text/javascript`, and its Vite map uses `source_map` plus `application/json`; existing map gates remain. `dist/rust/ops.assets-manifest.json` binds static URL paths, MIME, sizes and SHA-256, is registered as a manifest artifact, and is referenced by `asset_manifest`. Duplicate basenames, unknown MIME types, hidden files, symlinks, `_headers`/`_redirects`, and files above 25 MiB fail explicitly rather than bypassing gates through binary mislabeling.

Snapshot 将 Worker modules 和 static assets 放入不同目录，保留 import/map 相对布局；只复制登记字节。原静态目录必须与登记集合完全一致，快照的 `assets.directory` 指向私有目录。workspace 后续增加文件或修改原文件不会混入部署；快照内增加文件也被集合审计拒绝。前端 `.map` 是静态发布集合的一部分，会被公开服务；Rust DWARF 只进入私有 R2 产物集合，不作为静态或 Worker 模块部署。
Snapshots separate Worker modules from static assets, preserve relative imports/maps, and copy only registered bytes. The original asset directory must exactly match the declared set; `assets.directory` is rewritten to the private directory. Later workspace additions or mutations cannot enter deployment, and additions inside the snapshot fail set auditing. Frontend maps are public static assets; Rust DWARF stays in the private R2 artifact set and is deployed neither as static files nor Worker modules.

## Rust 符号与信任边界 / Rust symbols and trust boundary

JS map 由真正的 esbuild/Vite 生成，映射到实际 JS 输入；不伪称 Rust source map。`split_wasm` 只移除最终 SDK Wasm 的 `.debug_*` custom sections，保留 name/producers；原模块作为 DWARF 符号保存。runtime/symbols 的全部非 custom section 字节必须相同，build_id 为它们的 SHA-256；符号必须含非空 `.debug_info`。
JS maps come from actual esbuild/Vite transformations and describe real JS inputs, not fabricated Rust maps. `split_wasm` removes only `.debug_*` custom sections from final SDK Wasm, preserving name/producers; the original module is retained as DWARF symbols. All non-custom runtime/symbol sections must match, their SHA-256 is the build ID, and symbols must contain nonempty `.debug_info`.

顶层 `artifact_digest` 仅指实际 Wrangler 入口字节，不是整个模块图；固定声明式 `status.js` 跨 Rust 实现变更可以保持相同摘要，完整 immutable manifest 仍绑定全部模块、符号和静态路径清单。受审批 runner、固定工具链和公共 JWKS 仍受信；不声称抵御恶意编译器或同用户进程主动篡改私有临时目录。
Top-level `artifact_digest` identifies only actual Wrangler entry bytes, not the whole module graph. A fixed declarative `status.js` may retain its digest across Rust changes; the full immutable manifest binds every module, symbol and static path inventory. Approved runners, pinned tools and public JWKS remain trusted; malicious compilers or same-user processes actively modifying private temporary directories are outside this protection claim.

## 验证 / Validation

```sh
cargo test -p status-release -- --include-ignored
cargo test -p status-build -- --include-ignored
cargo clippy -p status-release -p status-build --all-targets -- -D warnings
```

覆盖真实 HTTPS register/session/PUT/commit/ready（含 412 与失败）、真实 Wrangler versions dry-run（含静态快照）、精确 version receipt/100% 调用、路径/MIME/集合篡改、RSA-3072 公钥匹配/错误 origin。`dry-run` 不上传 Cloudflare 静态字节：测试证明本地快照和模块输入，不能冒称已完成云上传或 DNS 验证；真实平台发布仍需授权后的独立结果。
Coverage includes real HTTPS register/session/PUT/commit/ready (412 and failure cases), real Wrangler versions dry-runs with static snapshots, exact receipt/100% invocation, path/MIME/set tampering, and RSA-3072 matching/wrong-origin checks. Dry-run does not upload Cloudflare static bytes: tests establish local snapshots/module inputs, not completed cloud uploads or DNS validation. Actual platform publication requires separate authorized results.

依据 / References: [Cloudflare versions](https://developers.cloudflare.com/workers/versions-and-deployments/), [Static asset bindings](https://developers.cloudflare.com/workers/static-assets/binding/), [esbuild API](https://esbuild.github.io/api/), [jsonwebtoken](https://docs.rs/jsonwebtoken/10.4.0/jsonwebtoken/), [in-toto, USENIX Security 2019](https://www.usenix.org/conference/usenixsecurity19/presentation/torres-arias).

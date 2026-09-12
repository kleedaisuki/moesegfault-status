# Rust 发布编排 / Rust release orchestration

`status-release` 是发布事务唯一业务实现。Node 仅运行平台官方 Wrangler；不执行 TypeScript 发布业务。
`status-release` owns the release transaction. Node runs only the official Wrangler platform tool, not TypeScript release logic.

## 用法 / Usage

发布配置应位于仓库根；所有文件包括 Wrangler JS 都必须在配置目录内，符号链接不能逃逸。
Place the release configuration at the repository root. All files, including Wrangler JS, must remain beneath that directory after symlink resolution.

```sh
# 无网络；严格校验干净 Git、CI 来源、真实文件和符号。 / Offline provenance validation.
cargo run --locked -p status-release -- --config release.production.json --verify-only
# 真正运行 Wrangler 本地 dry-run，并逐字节检查上传模块。 / Actual local Wrangler dry-run with byte-for-byte module audit.
cargo run --locked -p status-release -- --config release.production.json --dry-run
# 受保护的 GitHub Environment 审批后运行；秘密由环境注入。 / Run after protected GitHub Environment approval with injected secrets.
cargo run --locked -p status-release -- --config release.production.json
```

必需秘密：`MOE_MACHINE_JWT`、`CLOUDFLARE_API_TOKEN`；平台账户可由 `CLOUDFLARE_ACCOUNT_ID` 提供。`MOE_RELEASE_API_URL` 必须为无用户名、密码、fragment/query 的 HTTPS URL。
Required secrets: `MOE_MACHINE_JWT`, `CLOUDFLARE_API_TOKEN`; `CLOUDFLARE_ACCOUNT_ID` can supply the platform account. `MOE_RELEASE_API_URL` must be credential-free HTTPS without fragment/query.

JWT 预检查 deployment/service/environment、两个 write scope、最多 15 分钟寿命、至少 10 分钟剩余有效期；**客户端预检查不是验签**，注册器仍负责验签、issuer/audience、授权及时间校验。
JWT preflight checks deployment/service/environment, both write scopes, a maximum 15-minute lifetime and over 10 minutes remaining. **Client preflight does not verify signatures**: the registry remains responsible for signature, issuer/audience, authorization and time validation.

## 事务与失败语义 / Transaction and failure semantics

```text
clean Git/CI + exact bytes + JS map/Wasm DWARF matching
    -> Wrangler local dry-run -> compare actual output bytes
    -> PUT immutable manifest
    -> for each artifact: session -> If-None-Match PUT -> server-verified commit
    -> PUT manifest -> require ready
    -> deploy from the same private frozen runtime/config snapshot
    -> Wrangler deploy --no-bundle --upload-source-maps --strict
    -> smoke/canary + explicit Access admin activation (separate approval)
```

- 上传 SHA-256 是真实内容摘要；MD5 是真实字节的 Base64 传输校验，不用来承担安全哈希职责。
  Upload SHA-256 identifies actual bytes; Base64 MD5 is only a transport checksum, not a security hash.
- 预签名上传不带 machine JWT；禁止 HTTP 重定向、URL 内凭据、过期 session、不匹配的 content length/MD5/metadata，以及缺失 `If-None-Match: *`。
  Presigned uploads never carry the machine JWT. Redirects, URL credentials, expired sessions, mismatched length/MD5/metadata and absent `If-None-Match: *` are rejected.
- PUT 的 412 仅允许进入服务端 commit 检查，不当作上传成功证据。同 attempt 重试复用幂等 key；session 过期后才递增 `release_attempt`。CLI 不盲目自动重试。
  PUT 412 only permits server-side commit verification; it is not upload-success evidence. Reuse attempt/idempotency keys on retry; increment `release_attempt` only after expiry. No blind automatic retry.
- 最后 ready 检查失败不会部署；部署失败不会激活；部署成功也不会用 machine JWT 冒充 Access admin 激活。遵循 `docs/operations.md` 的带 revision/CSRF/Origin 的 admin cut-over。
  Failed readiness prevents deployment; failed deployment prevents activation; successful deployment never impersonates an Access admin with a machine JWT. Follow the revision/CSRF/Origin-bound admin cut-over in `docs/operations.md`.
- Wrangler 配置不得含 `build` 节，以免注册后重建。入口和所有运行模块必须已经构建，dry-run 输出每个模块必须能在 artifact 清单中逐字节找到。
  Wrangler configuration must not contain `build`, preventing rebuilding after registration. The entrypoint and all runtime modules must be prebuilt, and every dry-run module must byte-match a declaration.
- CLI 不打印 bearer、预签名 URL、服务器错误体或 Wrangler 子进程输出（可能含秘密）；失败仅提供阶段和 HTTP 状态。
  The CLI never prints bearers, presigned URLs, server error bodies or potentially secret-bearing Wrangler output; failures expose only phase/status.

## 首次双阶段引导 / First-deployment two-stage bootstrap

1. 人工完成 R2 开通、D1 迁移和最小权限配置；工具不会开通计费或自动创建这些资源。
   Manually provision R2, apply D1 migrations and configure least privilege; this tool does not enable billing or create these resources.
2. 仅首次注册器部署，在受审批环境设置 `MOE_BOOTSTRAP_ACK=I_ACKNOWLEDGE_FIRST_DEPLOYMENT_ONLY`，运行 `--bootstrap-only`。部署 `BOOTSTRAP_MODE:true`，业务入口保持不可用，注册 API 仍需正常 JWT 鉴权。
   For the first registry deployment only, set `MOE_BOOTSTRAP_ACK=I_ACKNOWLEDGE_FIRST_DEPLOYMENT_ONLY` in an approved environment and run `--bootstrap-only`. `BOOTSTRAP_MODE:true` keeps business endpoints unavailable while registry APIs still require normal JWT authentication.
3. 配置验证密钥、R2 上传签名秘密和短期发布 JWT，使用同一冻结配置执行普通发布。只有上传、commit、ready 全部成功，才部署 `BOOTSTRAP_MODE:false`。
   Provision verification keys, R2 signing secrets and a short-lived release JWT, then run normal release with the same frozen configuration. Only successful uploads, commits and readiness permit deployment with `BOOTSTRAP_MODE:false`.
4. smoke/canary 通过后，由 Access admin 单独激活。`ready` 与 `active` 不等价。
   After smoke/canary approval, an Access admin activates separately. `ready` is not `active`.

当前 R2 尚未开通：真实云上传、部署和激活仍是外部 pending，不能用本地测试冒称上线完成。
R2 is currently unprovisioned: actual cloud upload, deployment and activation remain external pending work; local tests do not establish production completion.

## Rust/Wasm 符号契约 / Rust/Wasm symbol contract

- JS 使用 bundler 生成的相邻 `<entrypoint>.map`，入口尾部实际引用 `//# sourceMappingURL=<entrypoint>.map`；不能伪造 Rust source map。
  JS uses a bundler-produced adjacent `<entrypoint>.map` referenced by an actual trailing `//# sourceMappingURL=<entrypoint>.map`; do not fabricate Rust source maps.
- Rust 原生栈使用最终 wasm-bindgen 处理模块中的 DWARF；编译保留 debug 信息，必须验证 wasm-bindgen 未移除 `.debug_info`。
  Rust native frames use DWARF from the final wasm-bindgen-processed module; preserve compiler debug information and verify `.debug_info` survived wasm-bindgen.
- `status_release::split_wasm(&bytes)` 返回 `(runtime_bytes, build_id)`，只移除 `.debug_*` custom sections，保留 `name`、`producers` 等；原始输入作为 `debug_symbols`。`build_id` 为去除所有 custom sections 后完整 Wasm 的 `sha256:<hex>`。
  `status_release::split_wasm(&bytes)` returns `(runtime_bytes, build_id)`, removing only `.debug_*` custom sections while retaining `name`, `producers`, etc. Save the original input as `debug_symbols`. `build_id` is `sha256:<hex>` of the complete Wasm after excluding all custom sections.
- `binary` runtime 和 `debug_symbols` 声明相同 build_id；CLI 验证二者完整可执行 section 字节相同且 symbols 含非空 `.debug_info`。符号不应作为 Worker runtime 模块上传，但仍需进入 R2 注册表。
  Declare the same build ID for `binary` runtime and `debug_symbols`. The CLI compares all executable section bytes and requires nonempty `.debug_info` in symbols. Symbols should not be deployed as runtime modules but must be registered in R2.

## 验证与边界 / Verification and boundaries

`cargo test -p status-release` 使用真实临时文件、SHA/MD5 已知答案、Wasm section fixture 和本地真实 TLS 服务器覆盖 register/session/PUT/commit/ready，包括不可变 PUT 的 412 路径。`cargo clippy -p status-release --all-targets -- -D warnings` 检查所有 target。
`cargo test -p status-release` uses actual temporary files, known-answer SHA/MD5 tests, Wasm section fixtures and a real local TLS server for register/session/PUT/commit/ready, including immutable PUT 412. `cargo clippy -p status-release --all-targets -- -D warnings` checks all targets.

信任边界：受审批 runner、固定版本构建工具与 Git checkout 仍受信任；此工具没有实现完整的独立签名构建证明，也不能证明 source map 的 mappings 在语义上准确。DWARF 配对和逐字节 manifest 解决产物错配，不证明编译器无恶意。
Trust boundary: the approved runner, pinned build tools and Git checkout remain trusted. This tool does not implement independently signed build attestations and cannot prove semantic accuracy of map mappings. DWARF pairing and exact manifests prevent mismatches, not malicious compilers.

## 依据 / References

- [Cloudflare bundling](https://developers.cloudflare.com/workers/wrangler/bundling/): prebuilt Workers can use `--no-bundle`; Wasm remains a separate module.
- [Cloudflare source maps](https://developers.cloudflare.com/workers/observability/source-maps/): generated source maps are uploaded using Wrangler support.
- [Cloudflare Wrangler deploy](https://developers.cloudflare.com/workers/wrangler/commands/workers/): local dry-run supplies inspectable pre-deployment output.
- [in-toto, USENIX Security 2019](https://www.usenix.org/conference/usenixsecurity19/presentation/torres-arias): end-to-end supply-chain integrity motivates explicit ordered steps and byte binding; this CLI does not claim full in-toto assurance.

### 冻结部署目录 / Frozen deployment directory

发布器把已声明 runtime/map 复制到私有临时目录，保留相对 import/map 结构；平台配置同时冻结，`main`、`base_dir` 和模块扫描根指向快照。注册前 dry-run 与最终正常/bootstrap 部署都只读取同一快照，因此注册网络请求期间 workspace 新增 `extra.js`/`extra.wasm` 或修改原文件不会混入部署。实际已安装 Wrangler 的测试覆盖这个场景。
The releaser copies only declared runtime/maps into a private temporary directory while preserving relative imports/maps. Platform configuration is frozen with `main`, `base_dir` and module scanning rooted in that snapshot. Pre-registration dry-run and final normal/bootstrap deployment read the same snapshot; workspace additions such as `extra.js`/`extra.wasm` or original-file mutations during registry requests cannot enter deployment. A test using the installed Wrangler covers this scenario.

当前只支持独立 backend Worker 配置；拒绝 `build`、`env`、`assets`、`site`、`wasm_modules`、`text_blobs`、`data_blobs` 外部文件/覆盖通道。D1/R2/service bindings 保留。平台工具链仍属于受信 runner，不声称抵御同用户权限主动篡改私有临时目录的恶意进程。
Only standalone backend Worker configurations are supported. `build`, `env`, `assets`, `site`, `wasm_modules`, `text_blobs`, and `data_blobs` external-file/override channels are rejected. D1/R2/service bindings are retained. The toolchain remains part of the trusted runner; protection against a malicious same-user process actively modifying private temporary directories is not claimed.

### 顶层摘要语义 / Top-level digest semantics

`artifact_digest` 是真实 Wrangler 入口文件的 SHA-256，不是整个模块图的摘要。`status.js` 是固定声明式组合器，因此 Rust 实现变化时该摘要可能保持不变；完整不可变 manifest 的 `artifacts` 列表仍逐一绑定 public/admin Wasm、glue 和符号字节。不能把顶层字段单独用作整个 release 的内容身份。
`artifact_digest` is the SHA-256 of the actual Wrangler entrypoint, not the whole module graph. Because `status.js` is a fixed declarative composition, its digest may remain unchanged when Rust implementation changes. The complete immutable manifest still binds each public/admin Wasm, glue and symbol artifact individually. Never use the top-level field alone as the content identity of the entire release.

# status-build

原生 Rust 构建组装工具；不调用云部署 API，不创建 R2 或开通计费。
Native Rust build assembler; never invokes cloud deployment APIs, creates R2 or enables billing.

## 使用 / Usage

```sh
# 安装仓库固定版本工具和 pnpm 依赖后执行。 / Run after installing pinned tooling and pnpm dependencies.
cargo run --locked -p status-build -- --service all
cargo run --locked -p status-build -- --service status
cargo run --locked -p status-build -- --service ops
cargo run --locked -p status-build -- --service probe

# 将非秘密 CI 元数据合并为可供 status-release 使用的配置。 / Merge non-secret CI metadata into a status-release configuration.
cargo run --locked -p status-build -- --service status --release-template release-metadata.json
cargo run --locked -p status-release -- --config release.status.json --verify-only
cargo run --locked -p status-release -- --config release.status.json --dry-run
```

必需 `worker-build 0.8.5`、工作区锁定的 Rust/Wasm 工具链、Node 及 `node_modules/esbuild`。每个 Worker crate 必须配置：
Requires `worker-build 0.8.5`, the workspace-pinned Rust/Wasm toolchain, Node and `node_modules/esbuild`. Every Worker crate must configure:

```toml
[package.metadata.wasm-pack.profile.release.wasm-bindgen]
dwarf-debug-info = true
```

工具实际运行 `worker-build <crate> --release --no-opt -- --locked`，设置 `CARGO_PROFILE_RELEASE_DEBUG=2`、`CARGO_PROFILE_RELEASE_STRIP=none`、`NO_MINIFY=1`，不允许继承 `CUSTOM_SHIM` 覆盖入口。平台/发布 bearer 不传入构建子进程。
The tool runs `worker-build <crate> --release --no-opt -- --locked` with `CARGO_PROFILE_RELEASE_DEBUG=2`, `CARGO_PROFILE_RELEASE_STRIP=none`, and `NO_MINIFY=1`. Inherited `CUSTOM_SHIM` cannot override entrypoints. Platform/release bearers are removed from build subprocesses.

## 输出 / Outputs

| 服务 / Service | 运行入口 / Runtime entry     | SDK 模块 / SDK modules                                                               |
| -------------- | ---------------------------- | ------------------------------------------------------------------------------------ |
| status         | `dist/rust/status/status.js` | `public/public.js`, `public/public_bg.wasm`, `admin/admin.js`, `admin/admin_bg.wasm` |
| ops            | `dist/rust/ops/ops.js`       | `ops_bg.wasm`                                                                        |
| probe          | `dist/rust/probe/probe.js`   | `probe_bg.wasm`                                                                      |

每个 JS 文件都有真正 esbuild transform 产生的相邻 `.map` 和 `sourceMappingURL`。完整 SDK Wasm 作为 `dist/rust/symbols/<service>/<module>.debug.wasm` 保存，运行 Wasm 只剔除 `.debug_*` sections；`name`/`producers` 保留。运行和符号的非 custom sections SHA-256 必须一致，DWARF `.debug_info` 必须存在。
Every JS file has an adjacent `.map` and `sourceMappingURL` produced by a real esbuild transform. Complete SDK Wasm is retained as `dist/rust/symbols/<service>/<module>.debug.wasm`; runtime Wasm loses only `.debug_*` sections, retaining `name`/`producers`. Runtime and symbols must share the SHA-256 of non-custom sections, and DWARF `.debug_info` must exist.

**JS map 映射到 SDK 生成的 JavaScript glue，不伪称映射到 Rust 源码。Rust 栈由匹配的 DWARF 解释。** Map 的 `sourcesContent` 保存被映射的真实中间输入，不需要在部署目录保留中间 JS；因此不会意外上传未登记模块。
**JS maps point to SDK-generated JavaScript glue, not falsely to Rust source. Rust frames use matched DWARF.** `sourcesContent` embeds the actual mapped intermediate input, so intermediate JS need not remain in deployment directories and cannot become an accidentally uploaded undeclared module.

`status.js` 只由以下声明式组合经 esbuild 格式化产生，不包含手写鉴权、路由或业务代码：
`status.js` is produced solely by esbuild formatting this declarative composition, without handwritten authentication, routing or business logic:

```js
export { default } from "./public/public.js";
export { default as AdminRpc } from "./admin/admin.js";
```

## 发布配置 / Release configuration

每项完成后生成 `dist/rust/<service>.artifacts.json`，字段为 `wrangler_config`、`wrangler_entrypoint`、`require_source_map`、`artifacts`。文件路径相对仓库根；所有文件 basename 唯一，避免注册表 basename 身份冲突。
Each completed service produces `dist/rust/<service>.artifacts.json` containing `wrangler_config`, `wrangler_entrypoint`, `require_source_map`, and `artifacts`. Paths are relative to the repository root, with unique basenames to avoid registry identity collisions.

`--release-template` 只用于单项服务；它需要提供以下非秘密 metadata，并生成根目录 `release.<service>.json`。同一个文件已存在但字节不同会失败，防止无意改写首次冻结的发布时间、CI run 或 deployment identity。
`--release-template` supports one service only. Supply the following non-secret metadata to generate root `release.<service>.json`. A different existing file causes failure, preventing accidental rewriting of frozen timestamps, CI runs or deployment identities.

```json
{
  "deployment_id": "0199d09a-b692-7ce0-a1c0-5138a43d7402",
  "service_name": "status",
  "environment": "production",
  "service_version": "1.0.0",
  "repository_url": "https://github.com/OWNER/REPOSITORY",
  "git_ref": "refs/tags/v1.0.0",
  "deployed_at": "2026-09-12T00:00:00.000Z",
  "ci_provider": "github-actions",
  "ci_run_id": "123456789",
  "release_attempt": "1",
  "region": ["global"]
}
```

模板不能包含秘密或未知字段；合并后通过 `status-release` 的严格 serde 配置和文件/DWARF/source-map 检查。Git HEAD、干净 tracked worktree 与 CI 绑定由随后 `status-release` 再验证；构建成功不代表来源门禁已通过。
Templates cannot contain secrets or unknown fields. Merged configurations pass `status-release`'s strict serde and file/DWARF/source-map checks. The subsequent release CLI validates HEAD, clean tracked worktree and CI bindings; build success does not imply provenance-gate success.

## 失败与验证 / Failure and validation

- 在临时目录完整组装后，逐目录原子替换 runtime 和 symbols；不保留上次构建的过期模块。Inventory 最后写入。CLI 失败禁止继续发布；runtime 与 symbols 是两个独立 rename，不宣称跨目录事务原子性。
  Assemble completely in temporary directories, then atomically replace runtime and symbols directories independently, removing stale modules. Write inventory last. Never release after a failed build; two directory renames are not claimed to be a cross-directory atomic transaction.
- `worker-build` 自身的 SDK 输出锁和 Cargo 正常构建锁仍存在；工具不创建全仓锁。
  SDK output locks and ordinary Cargo locks remain; this tool creates no repository-wide lock.
- `cargo test -p status-build` 验证精确 Wasm 导入重定位、声明式入口和无残留目录替换；真实构建及 Wrangler dry-run 是额外集成验证。
  `cargo test -p status-build` checks exact Wasm import relocation, declarative entrypoints and stale-free directory replacement. Real builds and Wrangler dry-runs are additional integration checks.

依据 / References: [Cloudflare Rust](https://developers.cloudflare.com/workers/languages/rust/), [Wrangler bundling](https://developers.cloudflare.com/workers/wrangler/bundling/), [esbuild source maps](https://esbuild.github.io/api/#sourcemap).

Windows 平台通过 stage-relative esbuild 输入与输出参数避免 `\\?\` canonical 路径被序列化成不安全的绝对 `file:` source URL；已加入真实 esbuild 回归测试。`cargo test -p status-build -- --include-ignored` 需要先完成三项真实构建，随后会用发布器对所有 inventory 的真实文件重新校验。
On Windows, stage-relative esbuild input/output arguments prevent canonical extended paths from becoming unsafe absolute `file:` source URLs; a real esbuild regression test covers this. `cargo test -p status-build -- --include-ignored` requires all three real builds first, then revalidates every inventory's actual files using the releaser.

跨平台 esbuild 调用使用官方 Node `buildSync` API（固定表达式，包路径及 JSON 选项通过独立进程参数传递），不把 `bin/esbuild` 当作 JavaScript：npm 在 Linux 可以将该文件替换为原生 ELF。回归测试提供 ELF-header CLI fixture，同时使用真实已安装 API 验证生成文件和相对 source map；不会修改共享 node_modules。
Cross-platform esbuild invocation uses the official Node `buildSync` API: a fixed expression receives the package path and JSON options as separate process arguments. It never assumes `bin/esbuild` is JavaScript; npm may replace that file with native ELF on Linux. A regression supplies an ELF-header CLI fixture while exercising the real installed API to verify generated files and relative source maps, without modifying shared node_modules. See [esbuild JavaScript API](https://esbuild.github.io/api/#sync).

## Ops 静态资产发布 / Ops static asset release

构建顺序现为 `pnpm --filter @moesegfault/ops build` → `status-build --service all`。Ops 组装只枚举已编译 Vite dist，不执行新的前端业务脚本。它为静态文件添加 `asset_path` 与真实 MIME，Vite `.map` 继续作为 `source_map` 注册，另生成 `dist/rust/ops.assets-manifest.json` 绑定完整 URL 路径/MIME/SHA256/size 集合。发布器将 module 和 assets 分目录冻结，严格拒绝未登记文件；发布只走 Workers versions，不管理 DNS。完整凭据、签发与门禁说明见 `scripts/release/rust-release-README.md`。
Build order is now `pnpm --filter @moesegfault/ops build` → `status-build --service all`. Ops assembly only inventories compiled Vite dist; it adds no frontend business script. Static declarations gain `asset_path` and real MIME types, Vite maps remain `source_map`, and `dist/rust/ops.assets-manifest.json` binds the complete URL/MIME/SHA256/size set. The releaser freezes modules/assets separately and rejects undeclared files; deployment uses Worker versions only, never DNS management. See `scripts/release/rust-release-README.md` for credentials, minting and release gates.

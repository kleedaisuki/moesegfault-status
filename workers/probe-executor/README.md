# Regional probe executor / 区域探针执行器

This Worker is private: do not enable `workers_dev`, preview URLs, routes, or custom domains. Invoke its **default fetch** handler through an explicitly configured Service Binding. Placement does not apply to named RPC entrypoints.

此 Worker 仅通过显式 Service Binding 的默认 `fetch` 调用；不得开放公开路由。命名 RPC 入口不适用 placement。

## Configuration / 配置

- Deploy one separately named Worker per desired region. The supplied config uses `aws:ap-southeast-1` as a placement hint, **not** a geographic assertion.
- Configure executor identity, logical location, exact host allowlist, TCP ports, permitted kinds, and optional pre-registered RPC/synthetic capabilities. Defaults deny all target egress.
- In the status Worker, declare `PROBE_EXECUTOR_ASIA` and configure `PROBE_REGIONAL_CONFIG`, for example:

```json
{
  "asia": {
    "binding": "PROBE_EXECUTOR_ASIA",
    "executor_id": "probe-asia-v1",
    "allowed_colos": ["SIN"],
    "allowed_kinds": ["http", "tcp", "dns"]
  }
}
```

每个区域部署独立命名实例；配置中的逻辑 location 不是实际地理来源。运行位置只来自平台 `cf-placement: remote-SIN` / `local-SIN`。调用方从不发送该头；只信任部署权限控制下的私有 Service Binding。禁止把此处理器暴露到可以伪造该头的公开入口。

The dispatcher validates executor identity, requested location, run ID, scheduled timestamp, monitor ID, correlation ID, observed timestamp, and the independently configured colo allowlist. Timeout/unreachable/malformed executor responses contribute **no target sample**. An executor that successfully observes a target timeout returns a typed `timeout` sample instead. Strict bounded JSON, independent deadline races, and executor-side SSRF revalidation protect the boundary. The dispatcher supplies trace context; the executor propagates that same context to the target.

分派器验证完整调用身份与实际 colo；执行器不可达不是被测服务故障。合法目标超时才产生 `timeout` 样本。输入输出都严格限长，并使用独立等待截止时间；执行器重新检查 SSRF，传播原始 trace context。

## Geographic acceptance gate / 地理验收门槛

Local workerd tests verify real default-fetch Service Binding routing and fail-closed behavior when platform placement metadata is absent. Unit tests use explicitly synthetic platform metadata only to exercise protocol validation. **Neither proves execution in distinct real regions.**

Before production enablement, invoke each deployed private binding and record returned `actual_colo` against its allowlist. Exercise multiple independent colos and unavailable/mismatched placement. Confirm quorum ignores unavailable executors and duplicate physical colos. Missing `cf-placement` must remain unavailable, never fall back to a configured location or `request.cf.colo` (which can describe ingress rather than execution). If Cloudflare removes the beta header, stop counting these samples until a replacement trusted platform signal is integrated.

上线前必须通过各真实私有绑定验证不同实际 colo、缺失来源、错误区域与执行器不可达。未验证地域部署时不能声称多地区仲裁已完成。beta 来源头消失时保持失败关闭，绝不根据配置伪造地域。

## Sources / 依据

- [Cloudflare placement](https://developers.cloudflare.com/workers/configuration/placement/): default fetch limitation, placement hints, platform header, and beta removal warning.
- [Service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/): explicit private Worker-to-Worker capability configuration.

## Immutable executor release / 执行器不可变发布

The executor uses resource service name `probe-executor`, independently of the monitored service. Its registered `DEPLOYMENT_ID`, actual `GIT_COMMIT`, runtime `ARTIFACT_DIGEST`, `STATUS_VERSION`, and `ENVIRONMENT` are mandatory outside wholly unregistered development. Invalid/partial provenance returns 503 **before any probe runs**. Empty development emits no invented resource. `WORKER_VERSION` is native Cloudflare version metadata, never a substitute for the domain deployment ID.

执行器使用独立服务名 `probe-executor`。生产来源缺失时在执行前返回 503；只有全部来源为空的明确 development 可以不生成资源遥测。本地默认配置不是生产发布配置。日志与原生 invocation span 绑定上述真实资源；日志只含固定事件、结果和校验后的 correlation/trace，不包含目标 URL、探针正文或凭证。

Run from the repository root, on the clean committed revision to be released:

```powershell
pnpm exec esbuild workers/probe-executor/src/index.ts --bundle --format=esm --platform=browser '--external:cloudflare:*' --sourcemap=external --outfile=workers/probe-executor/dist/executor.mjs
pnpm exec tsx scripts/release/deploy.ts --config executor-release.json --verify-only
# Explicit production operation, only after reviewing manifest and deployment authorization:
pnpm exec tsx scripts/release/deploy.ts --config executor-release.json
```

`executor-release.json` is a release input at the repository root, with the same schema as the main service release: `service_name: "probe-executor"`, a new UUIDv7 `deployment_id`, intended `environment`, `service_version`, actual `repository_url`, immutable `git_ref`, fixed `deployed_at`, `ci_provider`, `ci_run_id`, fixed `release_attempt`, and `region`. Set:

```json
{
  "wrangler_config": "workers/probe-executor/wrangler.jsonc",
  "wrangler_entrypoint": "workers/probe-executor/dist/executor.mjs",
  "require_source_map": true,
  "artifacts": [
    {
      "path": "workers/probe-executor/dist/executor.mjs",
      "kind": "other",
      "media_type": "application/javascript"
    },
    {
      "path": "workers/probe-executor/dist/executor.mjs.map",
      "kind": "source_map",
      "media_type": "application/json"
    }
  ]
}
```

The fragment above supplies file declarations, not the complete release config. Register the `probe-executor` service and retention policy first. Supply `MOE_RELEASE_API_URL`, a short-lived `MOE_MACHINE_JWT` scoped to this exact service/environment/deployment, and authorized Cloudflare credentials through CI secrets. The release command registers the immutable manifest, uploads exact bytes with MD5 transport integrity, commits and verifies SHA-256, requires authoritative `ready`, and only then deploys the already-built file using `--no-bundle` and injects provenance vars. Never rebuild between readiness and deployment, bypass this gate with direct `wrangler deploy`, or copy another region's runtime provenance. Each separately built/released regional instance needs its own honest manifest and deployment identity. The source-map size limit remains 8 MiB.

上面的 JSON 仅为完整发布配置中的文件声明片段。先登记服务与保留策略，再使用同一不可变 manifest 流程完成上传、摘要验证、ready 门槛与精确字节部署；严禁绕过发布脚本或在校验后重新构建。各区域发布必须持有与实际运行字节一致的独立部署来源。此前的本地 dry-run 不执行此生产发布过程。

# Rust deployment provenance / Rust 部署来源

## Routes and trust / 路由与信任

- `PUT /v1/deployments/{uuidv7}` requires `deployments:write`.
- `POST /v1/deployments/{uuidv7}/artifact-uploads` requires `artifacts:write`, an 8–256 character `Idempotency-Key`, and artifact fields plus canonical Base64 `content_md5`.
- `POST /v1/deployments/{uuidv7}/artifacts` requires `artifacts:write` and the same artifact fields plus `upload_id`.

All routes verify the configured machine JWT issuer/audience/JWKS and exact service, environment, deployment claims. HTTP headers cannot activate bootstrap mode. Public URLs, repository URLs and filenames never cause server-side fetches. Signing only targets the configured account's R2 endpoint and bucket. 所有路由使用正常机器 JWT 认证，并精确校验 service/environment/deployment 授权；不会抓取用户提供的 URL。

## Immutable writes / 不可变写入

Manifest canonical JSON uses sorted object keys, normalized domain serialization and SHA-256. The server conditionally writes its R2 object (`If-None-Match: *`), re-reads and proves its digest before the D1 registration transaction. Registration always records `registered → artifacts_pending`, never ready. 同一 ID 不同内容冲突；相同内容可重放。R2/D1 不共享事务，因此先验证 R2 再提交 D1。

Artifact keys are `observability/artifacts/sha256/<prefix>/<digest>/<deployment>/<kind>/<encoded-filename>`. SigV4 covers the key, size, media type, transport MD5, provenance metadata and `If-None-Match: *`. A client receiving R2 412 should proceed to commit, not overwrite. URLs expire after ten minutes; idempotent replay of an expired session returns 410. 签名 URL 是短期 bearer 凭据，不得记录到日志。

Commit independently reads and incrementally hashes the actual R2 bytes with Rust SHA-256, verifies length and all metadata, then compares the object version again. Hashing uses bounded memory; maps alone are buffered, limited to 8 MiB. MD5 is only transport protection, never provenance authority. Source maps require UTF-8 JSON revision 3, string sources/mappings, and matching optional `file`. This is structural verification, not proof of every mapping's correctness. 提交依赖真实 SHA-256 字节证据，而不是客户端声明或 MD5。

Artifact insertion and audit are one D1 transaction. The INSERT itself excludes retired/failed states, preventing a retirement/cleanup race even when HTTP authorization happened earlier. Every successful replay reconciles readiness; readiness occurs only when all immutable requirements exactly match committed rows. Concurrent revision conflicts are re-read, not treated as automatic success. 管理员激活由独立管理路由执行，本模块不会自动切换流量。

## Rust and JS debug artifacts / Rust 与 JS 调试产物

Every `binary` requires a `debug_symbols` declaration with the same nonempty Build ID. Every JavaScript runtime, including secondary platform glue, requires `<runtime-file>.map`. Rust release tooling must preserve matching debug Wasm/ELF and upload it separately; JS glue is `other`, not a native binary. All these requirements participate in readiness. 所有调试产物都必须实际上传并通过摘要校验。

Matching signed Build ID metadata and immutable digests establish the declared provenance relation, **not** semantic proof that a DWARF file can symbolize a given instruction. A consuming symbolizer must verify embedded Build IDs and report unverified when it cannot; it must not invent source permalinks. This module does not claim to implement DWARF symbolization. 本模块不伪造已完成符号化的结论。

## Controlled first deployment / 受控首次部署

1. An account-authorized operator explicitly deploys the same Rust Worker with `BOOTSTRAP_MODE=true`, real JWT trust configuration, D1 and approved R2 bindings/secrets. This is a control-plane installation, **not** an activated application release.
2. The root router applies `bootstrap::allows` **before all business routes**. Only the three machine deployment endpoints are reachable; health/status/admin/telemetry return 503. Their JWT checks remain unchanged.
3. The release machine registers the production manifest, uploads every runtime/debug artifact, commits each and observes ready.
4. The operator deploys the normal configuration with `BOOTSTRAP_MODE=false`; the normal readiness/activation gate applies. An administrator activates through the ordinary protected activation API.

首次引导不是绕过鉴权，也不是给未验证业务流量开门。首次部署的控制平面由现有 Cloudflare 账户权限明确授权；不需要先有运行中的已登记业务实例。未开通 R2 时必须由账户所有者另行批准，本实现不启用计费产品。

## Retention / 保留

`cleanup(env)` processes at most 100 expired uncommitted object keys from **retired** deployments. It never deletes a registered artifact or manifest. Retired is SQL-enforced terminal; failed alone is not sufficient for safe physical deletion. All renewed sessions for a key must have expired. A durable post-delete audit tombstone excludes already processed keys so bounded batches make progress. Deployment/session rows are immutable and retained. 重复清理幂等；永久保留的产物不会因诊断事件清理而失去符号化证据。No public download route exists; authorized evidence readers must resolve keys from D1, never accept an arbitrary user object key.

## Validation / 验证

- `cargo check -p status-backend --target wasm32-unknown-unknown`
- `cargo test -p status-backend --lib deployments`
- `cargo test -p status-backend --lib bootstrap`
- `python crates/status-backend/src/deployments/test_sql.py`
- `worker-build tests/rust-runtime --release --no-opt -- --locked`
- `node node_modules/vitest/vitest.mjs run tests/artifacts-rust.test.ts`

The SigV4 fixed vector was independently generated with the migration baseline's aws4fetch 1.0.20 (the old runtime dependency has since been removed). SQLite tests extract production Rust SQL and apply every real migration; they test immutable sessions and retirement/cleanup races without a database stub. The workerd integration suite uses real Rust handlers, independent RSA-signed JWTs, local JWKS, migrated D1 and local R2. It proves manifest persistence, byte-hash rejection, per-artifact readiness and replay auditing. Tests inject object bytes through the real R2 binding; they do not claim live S3 presigned-URL acceptance. 当前账户 R2 尚未开通，因此未声称线上 R2 上传成功。

References / 官方参考:

- [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/)

## Security boundary and research / 安全边界与研究

[In-toto (USENIX Security 2019)](https://www.usenix.org/conference/usenixsecurity19/presentation/torres-arias) treats supply-chain integrity as linked, authenticated steps. This implementation proves release identity and stored bytes, not a trusted compiler or an uncompromised CI runner. Future in-toto attestations or reproducible-build verification must add independently verifiable build-step evidence rather than treating a CI-signed digest as proof that source produced those bytes. 本实现明确区分内容完整性、发布者授权和构建过程可信性，不把三者混为一谈。

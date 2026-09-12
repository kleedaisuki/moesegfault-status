# Deployment provenance domain / 部署来源领域

## Object-key invariant / 对象键不变量

Artifact keys use this immutable, digest-prefixed form:

```text
observability/artifacts/sha256/<first-2-hex>/<64-hex>/<deployment-id>/<kind>/<encoded-file-name>
```

产物键使用上述不可变、摘要前缀形式。`If-None-Match: *` is part of the signed PUT request, so a session cannot overwrite an existing object. `If-None-Match: *` 是签名 PUT 的一部分，因此上传会话不能覆盖已有对象。

When a renewed session uploads bytes already left by an earlier session, R2 returns `412 Precondition Failed`. The caller should proceed to artifact commit rather than attempt an overwrite; commit independently proves all metadata and bytes before accepting the object. 续签会话遇到旧会话已留下的对象时，R2 会返回 `412`；调用方应继续提交 artifact，由 commit 独立验证，而不是尝试覆盖。

The design document's `symbols/`, `sourcemaps/`, and `sbom/` paths are illustrative categories, not separate mutable storage rules. This implementation intentionally includes deployment identity after the content digest because immutable object metadata must be verified against exactly one `deployment_id` and Git commit. 文档中的分类路径是示意，不是可变存储规则；本实现有意在内容摘要后加入部署身份，因为不可变对象 metadata 必须精确绑定一个部署 ID 与 Git commit。

The D1 schema permits future physical reuse, but this version makes no cross-deployment deduplication claim. D1 模式为未来物理复用保留空间，但本版本不宣称跨部署去重。

## Commit verification / 提交校验

Every manifest must designate exactly one `binary` or `other` artifact whose digest equals the top-level runtime digest. A JavaScript runtime additionally requires a source map. Registration always starts at `artifacts_pending`; an empty or unrelated-only manifest can never become ready. 每个 manifest 必须用恰好一个 `binary` 或 `other` artifact 对应顶层 runtime digest；JavaScript runtime 还必须声明 source map。注册始终从 `artifacts_pending` 开始，空清单或仅含无关产物的清单绝不会 ready。

The signed `Content-MD5` is a transport-integrity guard supported by R2 PutObject, not the provenance authority. `HEAD` first verifies key, size, media type, Build ID, deployment, commit, digest declaration, kind, and file name. Metadata and MD5 are not accepted as SHA-256 content proof. If R2 exposes a stored SHA-256 checksum it is compared directly; otherwise the Worker reads the object through the R2 binding and hashes it with `crypto.DigestStream("SHA-256")`. 只有真实字节 SHA-256 摘要相符时才登记 artifact；只有所有 manifest requirements 都已登记时才追加 `ready` 状态。

Source maps have an 8 MiB raw-byte engineering limit so the Worker can safely perform bounded semantic validation. A committed map must be UTF-8 Source Map Revision 3 JSON with a string `mappings`, a string `sources` array, and—when present—a `file` equal to the linked runtime filename. `sourcesContent` remains optional; this proves the immutable map's structure and bundle linkage, not that every mapping is semantically correct. Source map 原始字节上限为 8 MiB；提交时验证 v3 结构及 bundle 关联，但不夸大为对每条 mapping 的语义证明。

R2 and D1 do not share a transaction. Manifest storage is therefore completed and re-read before the atomic D1 registration batch. Artifact verification is completed before an atomic artifact-plus-audit batch; readiness is a separate status-plus-audit batch and is reconciled on every idempotent commit replay. R2 与 D1 不共享事务；这些顺序与重放规则用于避免假就绪状态。

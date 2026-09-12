# `@moesegfault/contracts`

`moeSegFault Status` 的唯一 TypeScript 合同来源。运行时校验使用 Zod v4；`openapi.json` 由相同 schema 通过 `z.toJSONSchema` 生成。

The single TypeScript contract source for `moeSegFault Status`. Runtime validation uses Zod v4, and `openapi.json` is generated from the same schemas through `z.toJSONSchema`.

## 关键不变量 / Key invariants

- 写入对象为严格对象，未知字段会被拒绝。 / Write objects are strict and reject unknown fields.
- 平台领域 ID 与 Correlation ID 为小写 UUIDv7。 / Platform domain and correlation IDs are lowercase UUIDv7 values.
- 所有时间是带 `Z` 的 RFC 3339 UTC 字符串。 / Every timestamp is an RFC 3339 UTC string ending in `Z`.
- Diagnostic attributes 是低基数许可列表；原始 telemetry 不得内嵌。 / Diagnostic attributes use a bounded low-cardinality allowlist; raw telemetry cannot be embedded.
- 后端证据使用结构化 locator，公开响应只返回脱敏摘要。 / Backend evidence uses structured locators, while public responses expose only redacted summaries.
- 管理 RPC 请求在 `principal` 之外携带执行 `correlation_id`，结果显式联合为 `{ data } | { problem }`。 / Administrative RPC requests carry an execution `correlation_id` beside `principal`, and results are explicit `{ data } | { problem }` unions.

## 运行时校验 / Runtime validation

```ts
import {
  DiagnosticEventSchema,
  type DiagnosticEvent,
} from "@moesegfault/contracts";

const result = DiagnosticEventSchema.safeParse(await request.json());
if (!result.success) {
  // Map the validation failure to RFC 9457 application/problem+json.
  throw new Error("invalid diagnostic event");
}
const event: DiagnosticEvent = result.data;
```

## 管理 RPC / Administrative RPC

```ts
import {
  UpdateIncidentRpcRequestSchema,
  UpdateIncidentRpcResultSchema,
} from "@moesegfault/contracts";

const request = UpdateIncidentRpcRequestSchema.parse(untrustedInput);
const result = UpdateIncidentRpcResultSchema.parse(
  await status.updateIncident(request),
);
if ("problem" in result) {
  // Preserve the RFC 9457 problem instead of treating it as success.
  throw new Error(result.problem.title);
}
```

## OpenAPI 生成 / OpenAPI generation

```sh
pnpm --filter @moesegfault/contracts generate:openapi
pnpm --filter @moesegfault/contracts test
```

生成器仅声明 `docs/status-design.md` 中的十一条公共/机器 HTTP 路由。管理能力通过 Service Binding typed RPC 提供，不会进入公网 OpenAPI。

The generator declares only the eleven public/machine HTTP routes in `docs/status-design.md`. Administrative capabilities use typed Service Binding RPC and never enter the public OpenAPI document.

## 原生上传边界 / Native upload boundary

未正式发布的 S3 预签名协议已替换，不保留兼容入口。D1 上传会话有效期为 600 秒；客户端只能向 API 同源 URL 发送携带 `artifacts:write` JWT 的 PUT，拒绝跨域和重定向。`required_headers` 只有 Content-Type、Content-Length、Content-MD5、If-None-Match；对象元数据由服务端读取声明设置。每件上限 64 MiB，source map 仍为 8 MiB。R2 原生条件写禁止覆盖，412 后继续 commit 核验，不得伪造 ready。

The unreleased S3 presigning protocol is replaced without a compatibility endpoint. D1 upload sessions expire after 600 seconds. PUT requires an `artifacts:write` JWT, an API-same-origin URL, and no redirects. The four predefined headers bind media type, length, checksum, and create-only semantics; object metadata is server-owned. Artifacts are capped at 64 MiB, source maps at 8 MiB. A 412 permits verification through commit, never overwrite or bypass of registry readiness.

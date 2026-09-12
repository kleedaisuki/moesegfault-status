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

生成器仅声明 `docs/status-design.md` 中的十条公共/机器 HTTP 路由。管理能力通过 Service Binding typed RPC 提供，不会进入公网 OpenAPI。

The generator declares only the ten public/machine HTTP routes in `docs/status-design.md`. Administrative capabilities use typed Service Binding RPC and never enter the public OpenAPI document.

# `@moesegfault/diagnostic-client`

安全、无阻塞且来源固定的 Diagnostic producer 参考 SDK。它把 `service_name`、`environment`、`deployment_id` 绑定到已登记的 deployment manifest，构建时清理展示文本，并在有界内存中以同一 `event_id`、同一 JSON bytes 重试单事件 `POST`。

Safe, non-blocking, provenance-pinned reference SDK for Diagnostic producers. It binds `service_name`, `environment`, and `deployment_id` to the registered deployment manifest, scrubs display text at build time, and retries one-event `POST` requests from bounded memory with the same `event_id` and JSON bytes.

## 使用 / Usage

```ts
import {
  createDiagnosticClient,
  logQueryEvidence,
  resourceFromManifest,
} from "@moesegfault/diagnostic-client";

const resource = resourceFromManifest(deploymentManifest);

function createProducer(env: Env) {
  return createDiagnosticClient({
    endpoint: "https://status.example/v1/diagnostic-events",
    resource,
    manifest: deploymentManifest,
    // 每次尝试即时读取 secret binding；不要在 callback 中记录 token。
    // Read the secret binding just in time; do not log the token in this callback.
    authorization: () => `Bearer ${env.DIAGNOSTIC_TOKEN}`,
  });
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response {
    const client = createProducer(env);
    const event = client.fault({
      kind: "dependency.http_error",
      severity: "error",
      // 只给已分类的展示文案，不传 exception、body、headers 或用户输入。
      // Supply classified display text, never exceptions, bodies, headers, or user input.
      summary: "Inventory dependency returned an error",
      fingerprint: {
        dependency: "inventory-api",
        operation: "reserve",
        error_type: "upstream_5xx",
        protocol: "http",
      },
      attributes: {
        "dependency.name": "inventory-api",
        "operation.name": "reserve",
        "http.response.status_code": 503,
      },
      evidence: [
        logQueryEvidence({
          backend: "cloudflare-logs",
          query: { service: "checkout-api", severity: "ERROR" },
          timeRange: {
            start: "2026-09-12T08:00:00Z",
            end: "2026-09-12T08:05:00Z",
          },
        }),
      ],
    });

    // publish/fault/recovery 只在内存入队；网络工作不阻塞业务响应。
    // publish/fault/recovery only enqueue in memory; network work does not block the response.
    client.flush(ctx);
    return new Response(event === undefined ? "diagnostic dropped" : "ok");
  },
};
```

恢复不是“没有继续收到故障”的推断，而是引用既有故障的显式正向证据：

Recovery is positive evidence referencing an existing fault, never an inference from silence:

```ts
client.recovery({
  kind: "dependency.http_error",
  severity: "info",
  summary: "Inventory dependency recovered",
  fingerprint: { dependency: "inventory-api", operation: "reserve" },
  recoveryOfEventId: previousFault.event.event_id,
});
```

## 隐私与安全边界 / Privacy and security boundary

- `summary`、fingerprint、attributes 与 locator 字符串经过 `@moesegfault/telemetry` 的 `sanitizeText`/允许列表处理。未知 attribute 和任意 query key 不会进入 payload。
- Locator 是有限 builder：没有任意 URL query、headers 或 token 字段。源码 URL 还拒绝 credentials、query 与 fragment。
- Endpoint 固定为无 credentials/query/fragment 的 HTTPS `/v1/diagnostic-events`，并禁用 redirect。
- `authorization` callback 每次尝试才调用；返回值不会进入队列、统计、日志或 SDK 错误。SDK 本身不调用 console。
- 单事件 JSON 在入队前验证 64 KiB 上限；队列容量、超时、尝试次数和指数退避均有硬上限。

- `summary`, fingerprint, attributes, and locator strings pass through `@moesegfault/telemetry` sanitization and allowlists. Unknown attributes and arbitrary query keys cannot enter the payload.
- Locators use finite builders with no arbitrary URL query, header, or token field. Source URLs additionally reject credentials, query strings, and fragments.
- The endpoint is pinned to credential/query/fragment-free HTTPS `/v1/diagnostic-events`, and redirects are disabled.
- The `authorization` callback is invoked per attempt; its return value never enters queues, stats, logs, or SDK errors. The SDK never calls console.
- Every single-event JSON body is checked against 64 KiB before enqueue; queue capacity, timeout, attempt count, and exponential backoff all have hard bounds.

### 不能保证的事情 / What this cannot guarantee

清理器只能识别常见凭据形态，**不是任意 PII/秘密检测器**。调用方必须先分类数据：仅传稳定、低基数、非用户来源的枚举或标识；绝不能把原始 exception/message、stack、HTTP body、headers、URL query、SQL、日志行或用户输入交给 SDK。一个形如普通单词的秘密不可能被通用 sanitizer 可靠识别。

The scrubber recognizes common credential shapes; it is **not a general PII/secret detector**. Callers must classify inputs first and pass only stable, low-cardinality, non-user-derived enums or identifiers. Never pass raw exceptions/messages, stacks, HTTP bodies, headers, URL queries, SQL, log lines, or user input. No general sanitizer can reliably detect a secret that looks like an ordinary word.

## 交付语义 / Delivery semantics

这是进程内 best-effort 队列，不是 durable queue。`publish` 返回 `false` 或 `fault`/`recovery` 返回 `undefined` 表示容量保护触发；进程终止仍可能丢失已入队事件。HTTP retry 依赖 `event_id` 幂等，并复用预序列化 body。若需要崩溃级 durability，应在业务边界之外接入平台队列，而不是让业务请求等待 Diagnostic backend。

This is an in-process best-effort queue, not a durable queue. `false` from `publish`, or `undefined` from `fault`/`recovery`, means capacity protection fired; process termination can still lose queued events. HTTP retries rely on `event_id` idempotency and reuse the pre-serialized body. For crash-level durability, use a platform queue outside the business critical path rather than awaiting the Diagnostic backend.

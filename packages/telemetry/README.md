# `@moesegfault/telemetry`

面向 Cloudflare Workers 的最小共享遥测层。它不引入完整 OpenTelemetry SDK：Workers 的原生
`console` 日志和 tracing 已可由 Cloudflare 导出为 OTLP，而高频自定义指标由 Analytics Engine
承载。

Minimal shared telemetry for Cloudflare Workers. It intentionally does not ship a full OpenTelemetry
SDK: Cloudflare can export native `console` logs and tracing as OTLP, while Analytics Engine carries
high-frequency custom metrics.

## 使用 / Usage

```ts
import { createTelemetry, defineResource } from "@moesegfault/telemetry";

const RESOURCE = defineResource({
  "service.namespace": "moeSegFault",
  "service.name": "status-api",
  "service.version": "1.2.3",
  "deployment.environment.name": "production",
  "moesegfault.deployment.id": "0199d09a-b692-7ce0-a1c0-5138a43d7402",
  "moesegfault.build.revision": "0123456789abcdef0123456789abcdef01234567",
  "moesegfault.artifact.digest": `sha256:${"a".repeat(64)}`,
});

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    // Invocation-scoped: request context never lives in module globals.
    const telemetry = createTelemetry({
      resource: RESOURCE,
      instrumentation: { name: "status-worker", version: "1.0.0" },
      attributePolicy: {
        allowed: new Set(["http.request.method", "error.type"]),
      },
      metricsDataset: env.TELEMETRY_METRICS,
    });
    const boundary = telemetry.beginBoundary(request, {
      kind: "public",
      sampleRate: 0.1,
    });
    return telemetry.withSpan(ctx.tracing, "status.read", {}, async () => {
      telemetry.logger.emit(
        {
          eventName: "status.read.completed",
          severity: "INFO",
          body: "Status read completed",
        },
        { trace: boundary.trace, correlationId: boundary.correlationId },
      );
      const headers = boundary.inject(new Headers());
      return new Response("ok", { headers });
    });
  },
};
```

## 能力边界 / Honest limits

- Cloudflare Workers tracing 会自动记录 `fetch`、binding 与 handler，并支持官方
  [`ctx.tracing.enterSpan`](https://developers.cloudflare.com/workers/observability/traces/custom-spans/)。
  当前 custom span API 不暴露 `spanContext()`，因此本包无法读取或手工传播 Cloudflare 原生
  trace/span ID。
- 原生 trace 采用部署配置中的 head sampling；在请求结束前才能知道的 error/slow 条件无法由
  本包反向改变平台的既有采样决定。`shouldSample()` 能让独立 W3C 上下文和应用日志确定性保留
  错误证据，但它不等价于 Cloudflare 原生 trace 的 tail sampling。若必须完整保留错误 trace，
  应把原生 trace sampling 配为 1，或在外部后端采用平台支持的方案。
- Cloudflare 当前不会把其原生 trace ID 自动传播到 Cloudflare 外部服务。这里的 W3C
  `TraceContext` 是**独立的外部链路上下文**；`moesegfault.correlation.id` 才是跨原生 trace
  与外部 trace 的稳定连接键。不要把两者误称为同一条 trace。参见
  [Workers tracing known limitations](https://developers.cloudflare.com/workers/observability/traces/known-limitations/)。
- Cloudflare 的 OTLP destination 当前支持原生 traces 与 logs，但不支持 custom metrics。
  因此本包把指标送入 [Workers Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/)，
  且每个 invocation 适配器最多写 250 点。参见
  [OTel export](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/) 与
  [Analytics Engine limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/)。
- `LogRecord` 是经安全策略处理的结构化 console payload，不是本包直接发送的 OTLP wire
  envelope。Cloudflare 的原生 exporter 负责把 console event 与当前原生 span 关联并转换为
  OTLP；本包记录中的 `TraceId`/`SpanId` 明确属于上述独立 W3C 上下文。
- `BoundedBatchExporter` 只提供通用的显式 transport。业务路径必须调用 `schedule(ctx)`，不得
  `await flush()`；超时依赖 transport 遵守 `AbortSignal`。失败后的指数退避存在于该实例中，
  因此实例生命周期结束后不保证内存队列存活。需要持久可靠交付时应使用 Cloudflare Queue，
  而不是把内存 exporter 伪装成消息队列。

安全不是“猜出所有秘密”。自定义 attributes 默认全部拒绝，只有显式 allowlist 可通过；正文
清理只是一道纵深防御，调用方仍不得把凭据、正文、SQL 或未清理异常交给 telemetry。

Security is not secret guessing. Custom attributes are denied unless explicitly allowlisted; body
scrubbing is defense in depth, not permission to pass credentials, payloads, SQL, or raw exceptions.

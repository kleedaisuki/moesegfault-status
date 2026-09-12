import { sanitizeAttributes } from "./privacy.js";
import type { AttributePolicy } from "./types.js";

/**
 * Cloudflare 官方自定义 Span 的兼容子集。
 * Compatible subset of Cloudflare's official custom Span.
 */
export interface WorkersSpan {
  /** 当前 invocation 是否被原生 head sampling 采中。/ Whether native head sampling selected this invocation. */
  readonly isTraced: boolean;
  /** 设置单个原生 span 属性。/ Sets one native span attribute. */
  setAttribute(key: string, value: string | number | boolean | undefined): void;
  /** 手工 span 生命周期结束；本包的自动 wrapper 不调用它。/ Ends a manual span; the automatic wrapper does not call it. */
  end(): void;
}

/**
 * `ctx.tracing` 或 `cloudflare:workers` tracing 的兼容子集。
 * Compatible subset of `ctx.tracing` or `cloudflare:workers` tracing.
 */
export interface WorkersTracing {
  /** 在当前原生 async context 内建立自动结束的 span。/ Creates an automatically ended span in the native async context. */
  enterSpan<T, A extends unknown[]>(
    name: string,
    callback: (span: WorkersSpan, ...args: A) => T,
    ...args: A
  ): T;
}

/**
 * 使用官方 Workers custom spans API 包裹操作；旧 runtime 没有 API 时透明执行。
 * Wraps an operation with the official Workers custom-spans API and transparently runs on older runtimes.
 *
 * 注意：当前 API 不暴露 spanContext，不能把 Cloudflare trace ID 手工传播到外部服务。
 * Note: the current API exposes no spanContext, so a Cloudflare trace ID cannot be manually propagated externally.
 */
export function withWorkerSpan<T>(
  tracing: WorkersTracing | undefined,
  name: string,
  attributes: Readonly<Record<string, unknown>>,
  policy: AttributePolicy,
  operation: (span: WorkersSpan | undefined) => T,
): T {
  if (name.length === 0 || name.length > 128 || /[\r\n]/.test(name)) {
    throw new TypeError(
      "span name must contain 1..128 characters without newlines",
    );
  }
  if (tracing === undefined) return operation(undefined);

  return tracing.enterSpan(name, (span) => {
    if (span.isTraced) {
      const safe = sanitizeAttributes(attributes, policy);
      for (const [key, value] of Object.entries(safe)) {
        if (
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean"
        ) {
          span.setAttribute(key, value);
        }
      }
    }
    return operation(span);
  });
}

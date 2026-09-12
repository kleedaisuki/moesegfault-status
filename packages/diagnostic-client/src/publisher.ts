import { DiagnosticAcceptedSchema } from "@moesegfault/contracts";

import { DiagnosticEventBuilder } from "./builder.js";
import { assertOwnedPrepared } from "./prepared.js";
import type {
  DiagnosticClientOptions,
  DiagnosticDropReason,
  DiagnosticEventInput,
  DiagnosticPublisherStats,
  DiagnosticRecoveryInput,
  DiagnosticWaitUntil,
  PreparedDiagnosticEvent,
} from "./types.js";

const DEFAULT_CAPACITY = 64;
const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_BACKOFF_MS = 100;
const DEFAULT_MAX_BACKOFF_MS = 2_000;

type AttemptResult = "ok" | "failure" | "timeout" | "permanent";

/**
 * 业务路径非阻塞、有界且重试稳定字节的 Diagnostic 客户端。
 * Non-blocking, bounded Diagnostic client whose retries use stable bytes.
 *
 * `publish` 只同步入队；请在请求尾部调用 `flush(ctx)`，不要 await 后端。
 * `publish` only enqueues synchronously; call `flush(ctx)` at the request tail instead of awaiting the backend.
 */
export class DiagnosticClient {
  /** 与客户端相同 deployment 身份绑定的事件构建器。/ Event builder bound to the client's deployment identity. */
  readonly builder: DiagnosticEventBuilder;

  readonly #endpoint: string;
  readonly #authorization: () => string | Promise<string>;
  readonly #fetch: typeof fetch;
  readonly #capacity: number;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;
  readonly #baseBackoffMs: number;
  readonly #maxBackoffMs: number;
  readonly #onDrop:
    ((count: number, reason: DiagnosticDropReason) => void) | undefined;
  readonly #now: () => number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #identity: Readonly<{
    serviceName: string;
    environment: string;
    deploymentId: string;
  }>;
  readonly #queue: PreparedDiagnosticEvent[] = [];

  #flushPromise: Promise<DiagnosticPublisherStats> | undefined;
  #enqueued = 0;
  #published = 0;
  #dropped = 0;
  #failedAttempts = 0;
  #timeouts = 0;
  #consecutiveFailures = 0;
  #lastSuccessAt: number | undefined;
  #nextAttemptAt: number | undefined;

  /** 验证固定 endpoint、资源与所有内存/时间边界。/ Validates the pinned endpoint, resource, and all memory/time bounds. */
  constructor(options: DiagnosticClientOptions) {
    this.#endpoint = safeEndpoint(options.endpoint);
    this.#authorization = options.authorization;
    this.#fetch = options.fetch ?? fetch;
    this.#capacity = boundedInteger(
      "capacity",
      options.capacity ?? DEFAULT_CAPACITY,
      1,
      10_000,
    );
    this.#timeoutMs = boundedInteger(
      "timeoutMs",
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      1,
      60_000,
    );
    this.#maxAttempts = boundedInteger(
      "maxAttempts",
      options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      1,
      10,
    );
    this.#baseBackoffMs = boundedInteger(
      "baseBackoffMs",
      options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS,
      1,
      60_000,
    );
    this.#maxBackoffMs = boundedInteger(
      "maxBackoffMs",
      options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
      1,
      300_000,
    );
    if (this.#baseBackoffMs > this.#maxBackoffMs) {
      throw new RangeError("baseBackoffMs must not exceed maxBackoffMs");
    }
    this.#onDrop = options.onDrop;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? delay;
    this.builder = new DiagnosticEventBuilder(options.resource, {
      ...(options.manifest === undefined ? {} : { manifest: options.manifest }),
      now: this.#now,
    });
    this.#identity = Object.freeze({
      serviceName: options.resource["service.name"],
      environment: options.resource["deployment.environment.name"],
      deploymentId: options.resource["moesegfault.deployment.id"],
    });
  }

  /** 当前队列深度。/ Current queue depth. */
  get depth(): number {
    return this.#queue.length;
  }

  /** 不含敏感内容的发布状态快照。/ Publisher status snapshot without sensitive content. */
  get stats(): DiagnosticPublisherStats {
    return this.#snapshot();
  }

  /**
   * 同步入队一个本 SDK 构建的事件；满队列立即返回 false。
   * Synchronously enqueues an SDK-built event; returns false immediately when full.
   */
  publish(event: PreparedDiagnosticEvent): boolean {
    assertOwnedPrepared(event);
    if (
      event.event.service_name !== this.#identity.serviceName ||
      event.event.environment !== this.#identity.environment ||
      event.event.deployment_id !== this.#identity.deploymentId
    ) {
      throw new TypeError("event provenance does not match this client");
    }
    if (this.#queue.length >= this.#capacity) {
      this.#recordDrop("queue_full");
      return false;
    }
    this.#queue.push(event);
    this.#enqueued += 1;
    return true;
  }

  /** 构建并同步入队故障事件。/ Builds and synchronously enqueues a fault event. */
  fault(input: DiagnosticEventInput): PreparedDiagnosticEvent | undefined {
    const event = this.builder.fault(input);
    return this.publish(event) ? event : undefined;
  }

  /** 构建并同步入队恢复事件。/ Builds and synchronously enqueues a recovery event. */
  recovery(
    input: DiagnosticRecoveryInput,
  ): PreparedDiagnosticEvent | undefined {
    const event = this.builder.recovery(input);
    return this.publish(event) ? event : undefined;
  }

  /** 直接排空（适合测试或进程关闭）。/ Directly drains the queue for tests or process shutdown. */
  flush(): Promise<DiagnosticPublisherStats>;
  /** 通过 waitUntil 非阻塞排空（业务请求推荐）。/ Drains non-blockingly through waitUntil (recommended for business requests). */
  flush(scheduler: DiagnosticWaitUntil): void;
  flush(
    scheduler?: DiagnosticWaitUntil,
  ): Promise<DiagnosticPublisherStats> | void {
    const work = this.#startFlush();
    if (scheduler !== undefined) {
      scheduler.waitUntil(work);
      return;
    }
    return work;
  }

  /** 合并并发 flush，防止重复发送同一队首。/ Coalesces concurrent flushes to prevent duplicate sends of the queue head. */
  #startFlush(): Promise<DiagnosticPublisherStats> {
    if (this.#flushPromise !== undefined) return this.#flushPromise;
    this.#flushPromise = this.#drain().finally(() => {
      this.#flushPromise = undefined;
    });
    return this.#flushPromise;
  }

  /** 串行处理 flush 开始时的有限快照。/ Serially processes the finite snapshot present when flush began. */
  async #drain(): Promise<DiagnosticPublisherStats> {
    const now = this.#clock();
    if (this.#nextAttemptAt !== undefined && now < this.#nextAttemptAt) {
      return this.#snapshot();
    }

    let remaining = this.#queue.length;
    while (remaining > 0) {
      const event = this.#queue[0];
      if (event === undefined) break;
      const result = await this.#sendWithRetries(event);
      if (result === "ok") {
        this.#queue.shift();
        remaining -= 1;
        this.#published += 1;
        this.#consecutiveFailures = 0;
        this.#nextAttemptAt = undefined;
        this.#lastSuccessAt = this.#clock();
        continue;
      }
      if (result === "permanent") {
        this.#queue.shift();
        remaining -= 1;
        this.#recordDrop("permanent_rejection");
        continue;
      }

      this.#consecutiveFailures += 1;
      this.#nextAttemptAt =
        this.#clock() + this.#backoff(this.#consecutiveFailures);
      break;
    }
    return this.#snapshot();
  }

  /** 在一轮内进行有界重试。/ Performs bounded retries within one flush round. */
  async #sendWithRetries(
    event: PreparedDiagnosticEvent,
  ): Promise<AttemptResult> {
    for (let attempt = 0; attempt < this.#maxAttempts; attempt += 1) {
      if (attempt > 0) {
        try {
          await this.#sleep(this.#backoff(attempt));
        } catch {
          this.#failedAttempts += 1;
          return "failure";
        }
      }
      const result = await this.#attempt(event);
      if (result === "ok" || result === "permanent") return result;
      this.#failedAttempts += 1;
      if (result === "timeout") this.#timeouts += 1;
    }
    return "failure";
  }

  /**
   * 即时取得 Authorization 并发送单事件 POST；凭据不会写入对象字段、队列或错误。
   * Obtains Authorization just in time and sends a single-event POST; credentials never enter fields, queues, or errors.
   */
  async #attempt(event: PreparedDiagnosticEvent): Promise<AttemptResult> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve("timeout");
      }, this.#timeoutMs);
    });
    const transport = Promise.resolve()
      .then(async (): Promise<AttemptResult> => {
        const authorization = await this.#authorization();
        // 认证可能晚于墙钟超时完成；绝不能让它触发迟到的自定义 fetch。
        // Authorization may finish after the wall-clock timeout; never let it trigger a late custom fetch.
        controller.signal.throwIfAborted();
        requireAuthorization(authorization);
        const headers = new Headers({
          authorization,
          "content-type": "application/json",
          "x-moesegfault-correlation-id": event.propagation.correlationId,
          traceparent: event.propagation.traceparent,
        });
        if (event.propagation.tracestate !== undefined) {
          headers.set("tracestate", event.propagation.tracestate);
        }
        const response = await this.#fetch(this.#endpoint, {
          method: "POST",
          headers,
          body: event.wireBody,
          signal: controller.signal,
          redirect: "error",
        });
        if (controller.signal.aborted) {
          await cancelResponseBody(response);
          controller.signal.throwIfAborted();
        }
        if (response.status === 202) {
          const receipt = DiagnosticAcceptedSchema.safeParse(
            await readBoundedJson(response, 4 * 1024, controller.signal),
          );
          return receipt.success &&
            receipt.data.event_id === event.event.event_id
            ? "ok"
            : "failure";
        }
        const result = isPermanentStatus(response.status)
          ? "permanent"
          : "failure";
        await cancelResponseBody(response);
        return result;
      })
      .catch((): AttemptResult =>
        controller.signal.aborted ? "timeout" : "failure",
      );
    const result = await Promise.race([transport, timeout]);
    if (timer !== undefined) clearTimeout(timer);
    return result;
  }

  /** 计算封顶指数退避。/ Computes capped exponential backoff. */
  #backoff(failureCount: number): number {
    const exponent = Math.min(Math.max(failureCount - 1, 0), 30);
    return Math.min(this.#maxBackoffMs, this.#baseBackoffMs * 2 ** exponent);
  }

  /** 安全计数丢弃，不让自观测回调击穿业务。/ Safely counts drops without letting self-observation break business logic. */
  #recordDrop(reason: DiagnosticDropReason): void {
    this.#dropped += 1;
    try {
      this.#onDrop?.(1, reason);
    } catch {
      // 自观测不得递归击穿生产者。/ Self-observation must not recursively fail the producer.
    }
  }

  /** 读取并验证测试时钟。/ Reads and validates the testable clock. */
  #clock(): number {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(
        "now must return a non-negative safe epoch millisecond",
      );
    }
    return value;
  }

  /** 建立不可变统计快照。/ Builds an immutable statistics snapshot. */
  #snapshot(): DiagnosticPublisherStats {
    return Object.freeze({
      depth: this.#queue.length,
      enqueued: this.#enqueued,
      published: this.#published,
      dropped: this.#dropped,
      failedAttempts: this.#failedAttempts,
      timeouts: this.#timeouts,
      consecutiveFailures: this.#consecutiveFailures,
      ...(this.#lastSuccessAt === undefined
        ? {}
        : { lastSuccessAt: this.#lastSuccessAt }),
      ...(this.#nextAttemptAt === undefined
        ? {}
        : { nextAttemptAt: this.#nextAttemptAt }),
    });
  }
}

/** 创建生产可用的 manifest-bound Diagnostic 客户端。/ Creates a production-ready manifest-bound Diagnostic client. */
export function createDiagnosticClient(
  options: DiagnosticClientOptions,
): DiagnosticClient {
  return new DiagnosticClient(options);
}

/** 严格固定 ingress，避免 URL 凭据与重定向泄露。/ Strictly pins ingress to prevent URL-credential and redirect leakage. */
function safeEndpoint(value: string | URL): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value.toString());
  } catch {
    throw new TypeError("endpoint must be an absolute HTTPS URL");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== "" ||
    endpoint.pathname !== "/v1/diagnostic-events"
  ) {
    throw new TypeError(
      "endpoint must be credential-free HTTPS /v1/diagnostic-events without query or fragment",
    );
  }
  return endpoint.href;
}

/** 验证 Authorization header，错误不回显值。/ Validates the Authorization header without echoing its value. */
function requireAuthorization(value: string): void {
  if (
    value.length === 0 ||
    value.length > 8_192 ||
    value.includes("\r") ||
    value.includes("\n")
  ) {
    throw new TypeError("authorization callback returned an invalid header");
  }
}

/** 有界读取小型 202 回执，避免错误后端返回无限响应。/ Reads a small 202 receipt with a hard bound so a faulty backend cannot return an unbounded response. */
async function readBoundedJson(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await cancelResponseBody(response);
    throw new RangeError("diagnostic acknowledgement exceeds its size limit");
  }
  if (response.body === null) {
    throw new TypeError("diagnostic acknowledgement body is required");
  }

  const reader = response.body.getReader();
  const cancelOnAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancelOnAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    signal.throwIfAborted();
    while (true) {
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RangeError(
          "diagnostic acknowledgement exceeds its size limit",
        );
      }
      chunks.push(part.value);
    }
  } finally {
    signal.removeEventListener("abort", cancelOnAbort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

/** 释放无需读取的响应流；取消失败不会改变已经确定的 HTTP 结果。/ Releases an unread response stream; cancellation failure does not change the established HTTP result. */
async function cancelResponseBody(response: Response): Promise<void> {
  if (response.body === null) return;
  await response.body.cancel().catch(() => undefined);
}

/** 区分不会被重试修复的请求/路由错误。/ Distinguishes request/route errors that retries cannot repair. */
function isPermanentStatus(status: number): boolean {
  return [400, 404, 405, 409, 410, 413, 415, 422].includes(status);
}

/** 校验有硬上限的整数配置。/ Validates an integer configuration with hard bounds. */
function boundedInteger(
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${name} must be an integer in ${minimum}..${maximum}`,
    );
  }
  return value;
}

/** 默认可替换睡眠。/ Default replaceable sleep. */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

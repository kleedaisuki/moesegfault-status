import type { SeverityText, WaitUntilLike } from "./types.js";

const PRIORITY: Readonly<Record<SeverityText, number>> = Object.freeze({
  TRACE: 0,
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  FATAL: 4,
});

/**
 * 有界队列丢弃原因。/ Bounded-queue drop reason.
 */
export type DropReason = "queue_full" | "retry_queue_full";

/**
 * Exporter 自可观测性快照。/ Exporter self-observability snapshot.
 */
export interface ExportStats {
  /** 当前队列深度。/ Current queue depth. */
  readonly depth: number;
  /** 成功入队数。/ Successfully enqueued count. */
  readonly enqueued: number;
  /** 成功导出数。/ Successfully exported count. */
  readonly exported: number;
  /** 为维持内存边界而丢弃的数量。/ Count dropped to preserve the memory bound. */
  readonly dropped: number;
  /** 导出调用失败次数。/ Failed export-call count. */
  readonly failures: number;
  /** 导出超时次数。/ Timed-out export-call count. */
  readonly timeouts: number;
  /** 连续失败次数。/ Consecutive failure count. */
  readonly consecutiveFailures: number;
  /** 最近一次成功的 epoch 毫秒时间。/ Epoch milliseconds of the latest success. */
  readonly lastSuccessAt?: number;
  /** 退避后允许再次尝试的 epoch 毫秒时间。/ Earliest retry time after backoff, in epoch milliseconds. */
  readonly nextAttemptAt?: number;
}

/**
 * 批量导出器配置。/ Batch exporter configuration.
 */
export interface BatchExporterOptions<T> {
  /** 内存中最多保留的记录数。/ Maximum number of records retained in memory. */
  readonly capacity: number;
  /** 每个导出请求的最大记录数。/ Maximum records per export call. */
  readonly batchSize: number;
  /** 单个导出调用超时。/ Per-call export timeout. */
  readonly timeoutMs: number;
  /** 首次失败退避。/ Initial failure backoff. */
  readonly baseBackoffMs: number;
  /** 退避上限。/ Maximum backoff. */
  readonly maxBackoffMs: number;
  /** 可取消的批量传输。/ Abortable batch transport. */
  readonly exportBatch: (
    items: readonly T[],
    signal: AbortSignal,
  ) => Promise<void>;
  /** 丢弃计数回调；不得抛异常。/ Drop counter callback; must not throw. */
  readonly onDrop?: (count: number, reason: DropReason) => void;
  /** 用于满队列优先级的严重级别。/ Severity used for full-queue priority. */
  readonly severity?: (item: T) => SeverityText;
  /** 可测试时钟。/ Testable clock. */
  readonly now?: () => number;
}

/**
 * 无全局状态、内存有界的批量导出器。
 * Batch exporter with bounded memory and no global request state.
 *
 * 调用方必须把 flush() 交给 ctx.waitUntil()，不能让业务请求等待后端。
 * Callers must pass flush() to ctx.waitUntil(); business requests must not await the backend.
 */
export class BoundedBatchExporter<T> {
  readonly #options: BatchExporterOptions<T>;
  readonly #queue: T[] = [];
  #flushPromise: Promise<ExportStats> | undefined;
  #enqueued = 0;
  #exported = 0;
  #dropped = 0;
  #failures = 0;
  #timeouts = 0;
  #consecutiveFailures = 0;
  #lastSuccessAt: number | undefined;
  #nextAttemptAt: number | undefined;

  /** 创建并验证有界 exporter。/ Creates and validates a bounded exporter. */
  constructor(options: BatchExporterOptions<T>) {
    requirePositiveInteger("capacity", options.capacity);
    requirePositiveInteger("batchSize", options.batchSize);
    requirePositiveInteger("timeoutMs", options.timeoutMs);
    requirePositiveInteger("baseBackoffMs", options.baseBackoffMs);
    requirePositiveInteger("maxBackoffMs", options.maxBackoffMs);
    if (options.batchSize > options.capacity) {
      throw new RangeError("batchSize must not exceed capacity");
    }
    if (options.baseBackoffMs > options.maxBackoffMs) {
      throw new RangeError("baseBackoffMs must not exceed maxBackoffMs");
    }
    this.#options = options;
  }

  /** 当前队列深度。/ Current queue depth. */
  get depth(): number {
    return this.#queue.length;
  }

  /** 当前统计快照。/ Current statistics snapshot. */
  get stats(): ExportStats {
    return this.#snapshot();
  }

  /**
   * 同步且非阻塞地入队；满队列仅用更高严重级别替换最低级别。
   * Enqueues synchronously without blocking; a full queue replaces its lowest severity only with a higher one.
   */
  enqueue(item: T): boolean {
    if (this.#queue.length < this.#options.capacity) {
      this.#queue.push(item);
      this.#enqueued += 1;
      return true;
    }

    const replaceAt = this.#lowestPriorityIndex();
    const incoming = this.#priority(item);
    const existing = this.#priority(this.#queue[replaceAt] as T);
    if (incoming <= existing) {
      this.#recordDrop("queue_full");
      return false;
    }

    this.#queue.splice(replaceAt, 1);
    this.#recordDrop("queue_full");
    this.#queue.push(item);
    this.#enqueued += 1;
    return true;
  }

  /**
   * 在 waitUntil 中安排 flush，避免调用方误把遥测放进关键路径。
   * Schedules flush through waitUntil so callers do not put telemetry on the critical path.
   */
  schedule(scheduler: WaitUntilLike): void {
    scheduler.waitUntil(this.flush());
  }

  /**
   * 串行排空当前队列；失败批次回队并进入指数退避。
   * Serially drains the current queue; a failed batch is restored and enters exponential backoff.
   */
  flush(): Promise<ExportStats> {
    if (this.#flushPromise !== undefined) return this.#flushPromise;
    this.#flushPromise = this.#drain().finally(() => {
      this.#flushPromise = undefined;
    });
    return this.#flushPromise;
  }

  /** 执行串行排空。/ Performs a serial drain. */
  async #drain(): Promise<ExportStats> {
    const now = this.#now();
    if (this.#nextAttemptAt !== undefined && now < this.#nextAttemptAt) {
      return this.#snapshot();
    }

    let remaining = this.#queue.length;
    while (remaining > 0) {
      const batch = this.#queue.splice(
        0,
        Math.min(this.#options.batchSize, remaining),
      );
      remaining -= batch.length;
      const result = await this.#exportWithTimeout(batch);
      if (result === "ok") {
        this.#exported += batch.length;
        this.#consecutiveFailures = 0;
        this.#nextAttemptAt = undefined;
        this.#lastSuccessAt = this.#now();
        continue;
      }

      this.#failures += 1;
      if (result === "timeout") this.#timeouts += 1;
      this.#consecutiveFailures += 1;
      const exponent = Math.min(this.#consecutiveFailures - 1, 30);
      const delay = Math.min(
        this.#options.maxBackoffMs,
        this.#options.baseBackoffMs * 2 ** exponent,
      );
      this.#nextAttemptAt = this.#now() + delay;
      this.#restore(batch);
      break;
    }
    return this.#snapshot();
  }

  /** 对一个批次应用 AbortSignal 与墙钟超时。/ Applies AbortSignal and wall-clock timeout to one batch. */
  async #exportWithTimeout(
    batch: readonly T[],
  ): Promise<"ok" | "failure" | "timeout"> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        controller.abort(new Error("telemetry export timed out"));
        resolve("timeout");
      }, this.#options.timeoutMs);
    });
    const transport = Promise.resolve()
      .then(() =>
        this.#options.exportBatch(Object.freeze([...batch]), controller.signal),
      )
      .then<"ok">(() => "ok")
      .catch<"failure">(() => "failure");
    const result = await Promise.race([transport, timeout]);
    if (timer !== undefined) clearTimeout(timer);
    return result;
  }

  /** 将失败批次放回队首，同时保持容量硬上限。/ Restores a failed batch to the front while preserving the hard capacity bound. */
  #restore(batch: readonly T[]): void {
    for (let index = batch.length - 1; index >= 0; index -= 1) {
      const item = batch[index];
      if (item === undefined) continue;
      if (this.#queue.length < this.#options.capacity) {
        this.#queue.unshift(item);
        continue;
      }

      const lowestAt = this.#lowestPriorityIndex();
      if (this.#priority(item) < this.#priority(this.#queue[lowestAt] as T)) {
        this.#recordDrop("retry_queue_full");
        continue;
      }
      this.#queue.splice(lowestAt, 1);
      this.#recordDrop("retry_queue_full");
      this.#queue.unshift(item);
    }
  }

  /** 寻找最早的最低优先级项。/ Finds the earliest lowest-priority item. */
  #lowestPriorityIndex(): number {
    let result = 0;
    let priority = this.#priority(this.#queue[0] as T);
    for (let index = 1; index < this.#queue.length; index += 1) {
      const candidate = this.#priority(this.#queue[index] as T);
      if (candidate < priority) {
        result = index;
        priority = candidate;
      }
    }
    return result;
  }

  /** 解析缺省 INFO 优先级。/ Resolves severity with INFO as the default. */
  #priority(item: T): number {
    return PRIORITY[this.#options.severity?.(item) ?? "INFO"];
  }

  /** 安全记录丢弃，不允许监控回调击穿业务。/ Records a drop without allowing monitoring callbacks to escape. */
  #recordDrop(reason: DropReason): void {
    this.#dropped += 1;
    try {
      this.#options.onDrop?.(1, reason);
    } catch {
      // Self-observability must never recursively fail the application.
    }
  }

  /** 返回当前时间。/ Returns the current time. */
  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  /** 建立不可变统计。/ Builds immutable statistics. */
  #snapshot(): ExportStats {
    return Object.freeze({
      depth: this.#queue.length,
      enqueued: this.#enqueued,
      exported: this.#exported,
      dropped: this.#dropped,
      failures: this.#failures,
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

/** 验证正整数设置。/ Validates a positive integer setting. */
function requirePositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

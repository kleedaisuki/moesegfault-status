import { afterEach, describe, expect, it, vi } from "vitest";
import { BoundedBatchExporter } from "../src/index.js";

interface Item {
  readonly id: number;
  readonly severity: "DEBUG" | "INFO" | "WARN" | "ERROR";
}

const options = (
  exportBatch: (items: readonly Item[], signal: AbortSignal) => Promise<void>,
) => ({
  capacity: 3,
  batchSize: 2,
  timeoutMs: 100,
  baseBackoffMs: 10,
  maxBackoffMs: 100,
  exportBatch,
  severity: (item: Item) => item.severity,
});

describe("BoundedBatchExporter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps memory bounded and evicts lower severity first", async () => {
    const exported: Item[] = [];
    const exporter = new BoundedBatchExporter<Item>(
      options(async (batch) => {
        exported.push(...batch);
      }),
    );
    expect(exporter.enqueue({ id: 1, severity: "DEBUG" })).toBe(true);
    exporter.enqueue({ id: 2, severity: "INFO" });
    exporter.enqueue({ id: 3, severity: "WARN" });
    exporter.enqueue({ id: 4, severity: "ERROR" });
    expect(exporter.depth).toBe(3);
    expect(exporter.stats.dropped).toBe(1);

    await exporter.flush();
    expect(exported.map((item) => item.id)).toEqual([2, 3, 4]);
    expect(exporter.depth).toBe(0);
  });

  it("isolates an outage, restores the batch, and respects backoff", async () => {
    let now = 1_000;
    let failing = true;
    const exporter = new BoundedBatchExporter<Item>({
      ...options(async () => {
        if (failing) throw new Error("backend unavailable");
      }),
      now: () => now,
    });
    exporter.enqueue({ id: 1, severity: "ERROR" });
    const failed = await exporter.flush();
    expect(failed).toMatchObject({
      depth: 1,
      failures: 1,
      consecutiveFailures: 1,
      nextAttemptAt: 1_010,
    });

    failing = false;
    await exporter.flush();
    expect(exporter.depth).toBe(1);
    now = 1_010;
    const recovered = await exporter.flush();
    expect(recovered).toMatchObject({
      depth: 0,
      exported: 1,
      consecutiveFailures: 0,
    });
  });

  it("preserves the hard bound when new traffic fills space during an outage", async () => {
    let rejectExport: ((reason?: unknown) => void) | undefined;
    const exporter = new BoundedBatchExporter<Item>(
      options(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectExport = reject;
          }),
      ),
    );
    exporter.enqueue({ id: 1, severity: "ERROR" });
    exporter.enqueue({ id: 2, severity: "ERROR" });
    exporter.enqueue({ id: 3, severity: "ERROR" });
    const flush = exporter.flush();
    exporter.enqueue({ id: 4, severity: "DEBUG" });
    exporter.enqueue({ id: 5, severity: "DEBUG" });
    rejectExport?.(new Error("outage"));
    await flush;
    expect(exporter.depth).toBeLessThanOrEqual(3);
    expect(exporter.stats.failures).toBe(1);
    expect(exporter.stats.dropped).toBeGreaterThan(0);
  });

  it("aborts and restores a timed-out batch", async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    const exporter = new BoundedBatchExporter<Item>({
      ...options((_batch, signal) => {
        observedSignal = signal;
        return new Promise<void>(() => undefined);
      }),
      timeoutMs: 25,
    });
    exporter.enqueue({ id: 1, severity: "WARN" });
    const flush = exporter.flush();
    await vi.advanceTimersByTimeAsync(25);
    const stats = await flush;
    expect(observedSignal?.aborted).toBe(true);
    expect(stats).toMatchObject({ depth: 1, failures: 1, timeouts: 1 });
  });
});

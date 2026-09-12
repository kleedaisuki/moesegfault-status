import { describe, expect, it } from "vitest";
import { mapWithKeyConcurrency, withDeadline } from "./concurrency.js";

describe("bounded concurrency", () => {
  it("enforces global and per-target limits", async () => {
    const items = ["a1", "a2", "a3", "b1", "b2", "c1"];
    let global = 0;
    let maximumGlobal = 0;
    const perKey = new Map<string, number>();
    let maximumPerKey = 0;
    await mapWithKeyConcurrency(
      items,
      (item) => item[0]!,
      3,
      1,
      async (item) => {
        const key = item[0]!;
        global += 1;
        perKey.set(key, (perKey.get(key) ?? 0) + 1);
        maximumGlobal = Math.max(maximumGlobal, global);
        maximumPerKey = Math.max(maximumPerKey, perKey.get(key)!);
        await new Promise((resolve) => setTimeout(resolve, 2));
        global -= 1;
        perKey.set(key, perKey.get(key)! - 1);
      },
    );
    expect(maximumGlobal).toBeLessThanOrEqual(3);
    expect(maximumPerKey).toBe(1);
  });

  it("rejects at the deadline even when a dependency ignores AbortSignal", async () => {
    await expect(
      withDeadline(
        5,
        new AbortController().signal,
        async () => new Promise<never>(() => undefined),
      ),
    ).rejects.toThrow("deadline_exceeded");
  });
});

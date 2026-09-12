/** 在全局和每 key 限制下执行，且不会为单个慢目标阻塞其他目标。 / Run under global and per-key limits without letting one slow target block others. */
export async function mapWithKeyConcurrency<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  globalLimit: number,
  perKeyLimit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (
    !Number.isInteger(globalLimit) ||
    globalLimit < 1 ||
    !Number.isInteger(perKeyLimit) ||
    perKeyLimit < 1
  ) {
    throw new RangeError("concurrency limits must be positive integers");
  }
  const pending = [...items];
  const activeByKey = new Map<string, number>();
  const active = new Set<Promise<void>>();
  let firstError: unknown;

  while (pending.length > 0 || active.size > 0) {
    let started = false;
    for (let index = 0; index < pending.length && active.size < globalLimit;) {
      const item = pending[index]!;
      const key = keyOf(item);
      const keyActive = activeByKey.get(key) ?? 0;
      if (keyActive >= perKeyLimit) {
        index += 1;
        continue;
      }
      pending.splice(index, 1);
      activeByKey.set(key, keyActive + 1);
      let promise!: Promise<void>;
      promise = worker(item)
        .catch((error: unknown) => {
          firstError ??= error;
        })
        .finally(() => {
          active.delete(promise);
          const remaining = (activeByKey.get(key) ?? 1) - 1;
          if (remaining === 0) activeByKey.delete(key);
          else activeByKey.set(key, remaining);
        });
      active.add(promise);
      started = true;
    }
    if (
      active.size > 0 &&
      (!started || active.size >= globalLimit || pending.length === 0)
    ) {
      await Promise.race(active);
    }
  }
  if (firstError !== undefined) throw firstError;
}

/** 在 deadline 内执行任务，并把父取消传播给子任务。 / Run a task within a deadline while propagating parent cancellation. */
export async function withDeadline<T>(
  deadlineMs: number,
  parent: AbortSignal,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (parent.aborted) throw parent.reason ?? new Error("parent_aborted");
  const controller = new AbortController();
  let rejectDeadline!: (reason: unknown) => void;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const abortFromParent = (): void => {
    const reason = parent.reason ?? new Error("parent_aborted");
    controller.abort(reason);
    rejectDeadline(reason);
  };
  parent.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(
    () => {
      const reason = new Error("deadline_exceeded");
      controller.abort(reason);
      rejectDeadline(reason);
    },
    Math.max(0, deadlineMs),
  );
  try {
    return await Promise.race([task(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
    parent.removeEventListener("abort", abortFromParent);
  }
}

import { mapWithKeyConcurrency, withDeadline } from "./concurrency.js";
import type { OutboxEvent, OutboxStore, RetentionStore } from "./store.js";

/** Outbox deliverer 上下文。 / Context passed to a trusted outbox deliverer. */
export interface OutboxDeliveryContext {
  /** 稳定幂等键；下游必须按它去重。 / Stable idempotency key that downstream must deduplicate. */
  readonly idempotencyKey: string;
  readonly signal: AbortSignal;
}

/** 可信 outbox binding。 / Trusted outbox binding. */
export interface OutboxDeliverer {
  /** 投递结构化事件，不接收任意 URL。 / Deliver a structured event; arbitrary URLs are never accepted. */
  deliver(event: OutboxEvent, context: OutboxDeliveryContext): Promise<void>;
}

/** 到期后聚合 service/component 状态的领域边界。 / Domain boundary for aggregating service/component state after expiry. */
export interface TargetReevaluator {
  /** 使用 Rust `aggregate_status` 基于当前 D1 facts 重算。 / Recompute from current D1 facts through Rust `aggregate_status`. */
  reevaluate(
    target: { readonly type: "service" | "component"; readonly id: string },
    source: { readonly type: string; readonly id: string },
    signal: AbortSignal,
  ): Promise<void>;
}

/**
 * 为到期与显式状态重评事件创建真实内部 deliverer，而非外部 webhook。
 * Create real internal deliverers for expiry and explicit status-reevaluation
 * events, never an external webhook.
 */
export function createExpiryDeliverers(
  reevaluator: TargetReevaluator,
): Readonly<Record<string, OutboxDeliverer>> {
  const deliverer: OutboxDeliverer = {
    async deliver(event, context): Promise<void> {
      const payload = event.payload;
      const targetType = payload.target_type;
      const targetId = payload.target_id;
      const sourceType = payload.source_type;
      const sourceId = payload.source_id;
      if (
        (targetType !== "service" && targetType !== "component") ||
        typeof targetId !== "string" ||
        typeof sourceType !== "string" ||
        typeof sourceId !== "string"
      ) {
        throw new Error("invalid_expiry_payload");
      }
      await reevaluator.reevaluate(
        { type: targetType, id: targetId },
        { type: sourceType, id: sourceId },
        context.signal,
      );
    },
  };
  return {
    "maintenance.started": deliverer,
    "maintenance.expired": deliverer,
    "override.expired": deliverer,
    "suppression.expired": deliverer,
    "status.reevaluation_requested": deliverer,
  };
}

/** Outbox retry 策略。 / Outbox retry policy. */
export interface OutboxPolicy {
  readonly maxAttempts: number;
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly deliveryDeadlineMs: number;
  readonly concurrency: number;
}

/** 投递一批 outbox，提供稳定幂等键和指数退避。 / Deliver an outbox batch with stable idempotency keys and exponential backoff. */
export async function deliverOutboxBatch(
  events: readonly OutboxEvent[],
  store: OutboxStore,
  owner: string,
  deliverers: Readonly<Record<string, OutboxDeliverer>>,
  policy: OutboxPolicy,
  now: () => number,
  parentSignal: AbortSignal,
): Promise<{ delivered: number; retried: number }> {
  let delivered = 0;
  let retried = 0;
  await mapWithKeyConcurrency(
    events,
    (event) => event.aggregateId,
    policy.concurrency,
    1,
    async (event) => {
      const deliverer = deliverers[event.eventType] ?? deliverers["*"];
      if (!deliverer) {
        const dead = event.attempt >= policy.maxAttempts;
        await store.markOutboxFailed(
          event.outboxId,
          owner,
          new Date(now() + retryDelayMs(event.outboxId, event.attempt, policy)),
          "deliverer_not_configured",
          dead,
        );
        retried += 1;
        return;
      }
      try {
        await withDeadline(policy.deliveryDeadlineMs, parentSignal, (signal) =>
          deliverer.deliver(event, {
            idempotencyKey: event.outboxId,
            signal,
          }),
        );
        await store.markOutboxDelivered(event.outboxId, owner, new Date(now()));
        delivered += 1;
      } catch (error) {
        const dead = event.attempt >= policy.maxAttempts;
        const next = new Date(
          now() + retryDelayMs(event.outboxId, event.attempt, policy),
        );
        await store.markOutboxFailed(
          event.outboxId,
          owner,
          next,
          classifyDeliveryError(error, parentSignal),
          dead,
        );
        retried += 1;
      }
    },
  );
  return { delivered, retried };
}

/** 计算有界指数退避；稳定 jitter 避免重试同步且不依赖随机全局状态。 / Compute bounded exponential backoff with stable jitter to avoid retry synchronization. */
export function retryDelayMs(
  idempotencyKey: string,
  attempt: number,
  policy: Pick<OutboxPolicy, "baseBackoffMs" | "maxBackoffMs">,
): number {
  const exponent = Math.min(Math.max(attempt - 1, 0), 20);
  const raw = Math.min(
    policy.maxBackoffMs,
    policy.baseBackoffMs * 2 ** exponent,
  );
  let hash = 2166136261;
  for (let index = 0; index < idempotencyKey.length; index += 1) {
    hash ^= idempotencyKey.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const jitter = 0.8 + ((hash >>> 0) % 401) / 1_000;
  return Math.max(1, Math.round(raw * jitter));
}

/** 删除一个 revisioned candidate batch，并保留 Incident pins。 / Delete one revisioned candidate batch while retaining Incident pins. */
export async function runRetentionBatch(
  store: RetentionStore,
  now: Date,
  limit: number,
): Promise<number> {
  const candidates = await store.selectRetentionCandidates(now, limit);
  return store.purgeRetentionCandidates(candidates, now);
}

function classifyDeliveryError(error: unknown, signal: AbortSignal): string {
  if (signal.aborted) return "invocation_deadline";
  if (error instanceof Error && error.message === "deadline_exceeded")
    return "delivery_deadline";
  return "delivery_failed";
}

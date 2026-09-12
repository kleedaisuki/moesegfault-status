import { z } from "zod";
import { UuidV7Schema } from "@moesegfault/contracts";
import type { OutboxDeliverer } from "../scheduling/jobs.js";
import type { QueueBatchLike } from "../diagnostics/types.js";

/** 通知只携带领域标识，不复制私有正文、locator 或审计主体。 / Notifications carry domain IDs, never private bodies, locators, or audit principals. */
export const NotificationSchema = z.strictObject({
  schema_version: z.literal("1.0"),
  event_id: UuidV7Schema,
  event_type: z
    .string()
    .max(128)
    .regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/),
  aggregate_type: z.string().min(1).max(64),
  aggregate_id: z.string().min(1).max(256),
});

/** 真实 Queue binding 的最小公开面。 / Minimal surface of a real Queue binding. */
export interface NotificationQueue {
  /** 成功表示平台已接受，而不是收件方已经阅读。 / Success means platform acceptance, not recipient delivery. */
  send(body: z.infer<typeof NotificationSchema>): Promise<unknown>;
}

/** 把 outbox 非内部事件移交持久 Queue，后者独立重试 webhook。 / Transfer non-internal outbox events to a durable Queue that retries the webhook independently. */
export function queueNotifications(queue: NotificationQueue): OutboxDeliverer {
  return {
    async deliver(event, context) {
      context.signal.throwIfAborted();
      const body = NotificationSchema.parse({
        schema_version: "1.0",
        event_id: event.outboxId,
        event_type: event.eventType,
        aggregate_type: event.aggregateType,
        aggregate_id: event.aggregateId,
      });
      await queue.send(body);
    },
  };
}

/** Webhook 目标及凭据均来自 Secrets，不由领域消息决定。 / Webhook destination and authorization come from Secrets, never domain messages. */
export interface NotificationConfig {
  /** 固定 HTTPS webhook。 / Pinned HTTPS webhook. */
  NOTIFICATION_WEBHOOK_URL: string;
  /** 完整授权头，不写日志。 / Complete authorization header, never logged. */
  NOTIFICATION_AUTHORIZATION: string;
}

/** 批次有界顺序发送；成功单独 ack，故障保留原 event_id 重试。 / Send a bounded batch sequentially, acknowledging success and retrying failures with unchanged IDs. */
export async function consumeNotifications(
  batch: QueueBatchLike<unknown>,
  config: NotificationConfig,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      const body = NotificationSchema.parse(message.body);
      const endpoint = new URL(config.NOTIFICATION_WEBHOOK_URL);
      if (
        endpoint.protocol !== "https:" ||
        endpoint.username ||
        endpoint.password ||
        endpoint.hash
      )
        throw new Error("invalid_notification_endpoint");
      if (
        !config.NOTIFICATION_AUTHORIZATION ||
        config.NOTIFICATION_AUTHORIZATION.length > 8192
      )
        throw new Error("invalid_notification_auth");
      const response = await fetcher(endpoint, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(5000),
        headers: {
          "content-type": "application/json",
          authorization: config.NOTIFICATION_AUTHORIZATION,
          "idempotency-key": body.event_id,
          "x-moesegfault-correlation-id": body.event_id,
        },
        body: JSON.stringify(body),
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error("notification_receiver_rejected");
      message.ack();
    } catch {
      // 队列 max_retries 和 DLQ 是最终保留边界；不把内部失败递归提交给自己。 / Queue retry/DLQ configuration owns final retention; never recursively diagnose our own failure.
      message.retry({
        delaySeconds: Math.min(300, 2 ** Math.min(message.attempts, 8)),
      });
    }
  }
}

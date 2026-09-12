import { describe, expect, it, vi } from "vitest";
import { consumeNotifications, queueNotifications } from "./notifications.js";
import { deliverOutboxBatch } from "../scheduling/jobs.js";
import type { OutboxEvent, OutboxStore } from "../scheduling/store.js";

const event: OutboxEvent = {
  outboxId: "0199d0a8-2e12-7a59-a51e-44aa9b6d1001",
  aggregateId: "identity",
  aggregateType: "service",
  eventType: "catalog.changed",
  schemaVersion: "1.0",
  attempt: 1,
  payload: { password: "never-forward", summary: "private" },
};

describe("production notification path", () => {
  it("durably publishes non-internal outbox events without forwarding private payloads", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const delivered = vi.fn();
    const store: OutboxStore = {
      claimOutbox: async () => [],
      markOutboxDelivered: delivered,
      markOutboxFailed: vi.fn(),
    };
    const result = await deliverOutboxBatch(
      [event],
      store,
      "owner",
      { "*": queueNotifications({ send }) },
      {
        maxAttempts: 8,
        baseBackoffMs: 1000,
        maxBackoffMs: 300000,
        deliveryDeadlineMs: 5000,
        concurrency: 1,
      },
      Date.now,
      new AbortController().signal,
    );
    expect(result.delivered).toBe(1);
    expect(delivered).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      event_id: event.outboxId,
      event_type: event.eventType,
    });
    expect(JSON.stringify(send.mock.calls)).not.toContain("private");
    expect(JSON.stringify(send.mock.calls)).not.toContain("never-forward");
  });

  it("retains a failed publish for retry rather than claiming delivery", async () => {
    const send = vi.fn().mockRejectedValue(new Error("queue unavailable"));
    await expect(
      queueNotifications({ send }).deliver(event, {
        idempotencyKey: event.outboxId,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("queue unavailable");
  });

  it("sends a stable idempotency key and only acknowledges accepted webhook delivery", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await queueNotifications({ send }).deliver(event, {
      idempotencyKey: event.outboxId,
      signal: new AbortController().signal,
    });
    const message = {
      id: "message",
      attempts: 1,
      body: send.mock.calls[0]?.[0],
      ack: vi.fn(),
      retry: vi.fn(),
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    await consumeNotifications(
      { messages: [message] },
      {
        NOTIFICATION_WEBHOOK_URL: "https://notifications.example/events",
        NOTIFICATION_AUTHORIZATION: "Bearer secret",
      },
      fetcher,
    );
    expect(message.ack).toHaveBeenCalledOnce();
    const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
    expect(headers.get("idempotency-key")).toBe(event.outboxId);
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("error");
    expect(String(fetcher.mock.calls[0]?.[1]?.body)).not.toContain("secret");

    message.ack.mockClear();
    fetcher.mockResolvedValue(new Response(null, { status: 503 }));
    await consumeNotifications(
      { messages: [message] },
      {
        NOTIFICATION_WEBHOOK_URL: "https://notifications.example/events",
        NOTIFICATION_AUTHORIZATION: "Bearer secret",
      },
      fetcher,
    );
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledOnce();
  });

  it("rejects credential URLs and malformed messages without egress", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const message = {
      id: "message",
      attempts: 1,
      body: {},
      ack: vi.fn(),
      retry: vi.fn(),
    };
    await consumeNotifications(
      { messages: [message] },
      {
        NOTIFICATION_WEBHOOK_URL: "https://secret@example.com",
        NOTIFICATION_AUTHORIZATION: "secret",
      },
      fetcher,
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledOnce();
  });
});

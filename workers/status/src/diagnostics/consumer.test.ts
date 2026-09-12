import { describe, expect, it, vi } from "vitest";
import { consume, processDiagnosticEnvelope } from "./consumer.js";
import type {
  D1DatabaseLike,
  D1StatementLike,
  DiagnosticConsumerEnv,
  QueueMessageLike,
} from "./types.js";

const EVENT = {
  event_id: "0199d0a8-2e12-7a59-a51e-44aa9b6d1001",
  schema_version: "1.0",
  kind: "dependency.unavailable",
  severity: "error",
  service_name: "identity",
  environment: "production",
  deployment_id: "0199d09a-b692-7ce0-a1c0-5138a43d7402",
  occurred_at: "2026-09-08T15:51:02.314Z",
  correlation_id: "0199d0a7-d771-7435-a388-bb6fa5d533fc",
  trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
  summary: "D1 query exceeded the dependency deadline",
  fingerprint: {
    dependency: "d1",
    operation: "identity.lookup",
    error_type: "timeout",
  },
  evidence: [],
  attributes: {},
} as const;

const ENVELOPE = {
  schema_version: "1.0",
  message_id: "0199d0a8-3e12-7a59-a51e-44aa9b6d1001",
  event: EVENT,
  received_at: "2026-09-08T15:51:03.000Z",
  producer: {
    subject: "spiffe://moesegfault.dev/service/identity",
    service_name: "identity",
    environment: "production",
    deployment_id: EVENT.deployment_id,
    scopes: ["diagnostics:write"],
    token_id: "token-1",
    auth_method: "jwt",
  },
  trace_context: { correlation_id: EVENT.correlation_id },
} as const;

/** 可检查的 D1 statement。 / Inspectable D1 statement. */
class FakeStatement implements D1StatementLike {
  /** 绑定值。 / Bound values. */
  values: unknown[] = [];
  /** 创建语句。 / Create a statement. */
  constructor(readonly sql: string) {}
  /** 记录参数。 / Record parameters. */
  bind(...values: unknown[]): FakeStatement {
    this.values = values;
    return this;
  }
}

/** 构造能分别快照读和原子写 batch 的假 D1。 / Build a fake D1 separating snapshot read and atomic write batches. */
function fakeDatabase(
  owner = true,
  storedDigest?: string,
): D1DatabaseLike & { batches: FakeStatement[][] } {
  const batches: FakeStatement[][] = [];
  return {
    batches,
    prepare: (sql) => new FakeStatement(sql),
    batch: async (statements) => {
      const captured = statements as FakeStatement[];
      batches.push(captured);
      if (batches.length === 1) {
        return [
          {
            results: [
              {
                assignment_id: "0199d0a8-4e12-7a59-a51e-44aa9b6d1001",
                policy_id: "diagnostic-default",
                policy_revision: 1,
                diagnostic_rules_json: JSON.stringify({
                  minimum_occurrences: 2,
                  status_by_severity: {
                    info: "operational",
                    warning: "degraded",
                    error: "partial_outage",
                    critical: "major_outage",
                  },
                }),
                stale_after_seconds: 300,
                policy_binding_revision: 1,
                policy_from_issue: 0,
                retention_policy_id: "occurrences",
                retention_policy_revision: 1,
                occurrence_retention_days: 30,
                retention_binding_revision: 1,
              },
            ],
          },
          { results: [] },
          { results: [] },
        ];
      }
      const claim = captured[0]!.values;
      return captured.map((_, index) =>
        index === captured.length - 1
          ? {
              results: [
                {
                  event_id: EVENT.event_id,
                  payload_digest: storedDigest ?? claim[10],
                  processing_token: owner
                    ? claim[12]
                    : "another-delivery-token",
                },
              ],
            }
          : { results: [] },
      );
    },
  };
}

/** 构造只执行约定纯操作的假 Rust 调度器。 / Build a fake Rust dispatcher implementing only the agreed pure operations. */
function fakeCore() {
  return {
    dispatchJson(requestJson: string): string {
      const request = JSON.parse(requestJson) as { operation: string };
      if (request.operation === "validate_diagnostic_event")
        return JSON.stringify({ valid: true });
      if (request.operation === "canonical_fingerprint")
        return JSON.stringify({ hash: "a".repeat(64), canonical: "[]" });
      if (request.operation === "evaluate_diagnostic")
        return JSON.stringify({
          fingerprint_hash: "a".repeat(64),
          policy_revision: 1,
          issue_state: "observed",
          severity: "error",
          direct_status: "unknown",
          action: "create_observed",
          occurrence_count: 1,
          last_seen_at: EVENT.occurred_at,
          expected_revision: null,
        });
      throw new Error(`unexpected operation ${request.operation}`);
    },
  };
}

/** 构造消费者环境。 / Build a consumer environment. */
function environment(database = fakeDatabase()): DiagnosticConsumerEnv {
  return {
    DB: database,
    DIAGNOSTIC_CORE: fakeCore(),
    now: () => new Date("2026-09-08T15:51:04.000Z"),
  };
}

describe("diagnostic consumer", () => {
  it("gates every domain mutation behind the transaction-owned dedup token", async () => {
    const database = fakeDatabase();
    await expect(
      processDiagnosticEnvelope(ENVELOPE, environment(database)),
    ).resolves.toBe("processed");

    expect(database.batches[0]![0]!.sql).toContain("WHEN 'monitor' THEN 0");
    const writes = database.batches[1]!;
    expect(writes[0]!.sql).toContain("ON CONFLICT(event_id) DO NOTHING");
    expect(writes[1]!.sql).toContain("transaction_assertions");
    for (const write of writes.slice(1)) {
      expect(write.sql).toContain("processing_token");
    }
    expect(
      writes.some((write) => write.sql.includes("issue_occurrences")),
    ).toBe(true);
    expect(writes.some((write) => write.sql.includes("audit_log"))).toBe(true);
    expect(writes.some((write) => write.sql.includes("outbox"))).toBe(true);
  });

  it("reports a concurrently delivered duplicate without downstream side effects", async () => {
    const database = fakeDatabase(false);
    await expect(
      processDiagnosticEnvelope(ENVELOPE, environment(database)),
    ).resolves.toBe("duplicate");
  });

  it("rejects event-id reuse with different immutable bytes", async () => {
    const database = fakeDatabase(false, `sha256:${"f".repeat(64)}`);
    await expect(
      processDiagnosticEnvelope(ENVELOPE, environment(database)),
    ).rejects.toThrow("diagnostic-event-id-conflict");
  });

  it("moves a poison envelope to explicit DLQ with its provenance and failure stage", async () => {
    const ack = vi.fn();
    const retry = vi.fn();
    const send = vi.fn(async () => undefined);
    const message: QueueMessageLike<unknown> = {
      id: "queue-1",
      attempts: 5,
      body: { bad: true },
      ack,
      retry,
    };
    const env = {
      ...environment(),
      DIAGNOSTIC_MAX_ATTEMPTS: 5,
      DIAGNOSTIC_DLQ: { send },
    };

    await consume({ messages: [message] }, env);

    expect(send).toHaveBeenCalledOnce();
    expect((send.mock.calls as unknown[][])[0]![0]).toMatchObject({
      schema_version: "1.0",
      original: { bad: true },
      failure: {
        stage: "envelope_validation",
        attempt: 5,
        queue_message_id: "queue-1",
      },
    });
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });

  it("retries with the original body before the configured attempt limit", async () => {
    const message: QueueMessageLike<unknown> = {
      id: "queue-1",
      attempts: 2,
      body: { bad: true },
      ack: vi.fn(),
      retry: vi.fn(),
    };
    await consume({ messages: [message] }, environment());
    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";
import { ingest } from "./ingest.js";
import type {
  DiagnosticIngestContext,
  DiagnosticIngestEnv,
  MachinePrincipal,
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

const PRINCIPAL: MachinePrincipal = {
  subject: "spiffe://moesegfault.dev/service/identity",
  serviceNames: new Set(["identity"]),
  environments: new Set(["production"]),
  deploymentIds: new Set([EVENT.deployment_id]),
  scopes: new Set(["diagnostics:write"]),
  tokenId: "token-1",
  authMethod: "jwt",
};

const CONTEXT: DiagnosticIngestContext = {
  correlationId: EVENT.correlation_id,
  now: () => new Date("2026-09-08T15:51:03.000Z"),
};

/** 构造可检查 Queue 发送的 ingest 环境。 / Build an ingest environment with an inspectable Queue sender. */
function queueEnv(
  send = vi.fn(async () => undefined),
): DiagnosticIngestEnv & { DIAGNOSTIC_QUEUE: { send: typeof send } } {
  return { DIAGNOSTIC_QUEUE: { send } };
}

describe("diagnostic ingest", () => {
  it("adds only authenticated producer metadata and enqueues without touching D1", async () => {
    const env = queueEnv();
    const response = await ingest(
      new Request("https://status.moesegfault.dev/v1/diagnostic-events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(EVENT),
      }),
      env,
      PRINCIPAL,
      CONTEXT,
    );

    expect(response.status).toBe(202);
    expect(env.DIAGNOSTIC_QUEUE.send).toHaveBeenCalledOnce();
    const envelope = (
      env.DIAGNOSTIC_QUEUE.send.mock.calls as unknown[][]
    )[0]![0];
    expect(envelope).toMatchObject({
      schema_version: "1.0",
      received_at: "2026-09-08T15:51:03.000Z",
      event: EVENT,
      producer: {
        subject: PRINCIPAL.subject,
        service_name: "identity",
        environment: "production",
        deployment_id: EVENT.deployment_id,
        token_id: "token-1",
        auth_method: "jwt",
      },
      trace_context: { correlation_id: EVENT.correlation_id },
    });
    expect((envelope as { message_id?: string }).message_id).toMatch(
      /^[0-9a-f-]{36}$/,
    );
  });

  it.each([
    ["serviceNames", { ...PRINCIPAL, serviceNames: new Set(["billing"]) }],
    ["environments", { ...PRINCIPAL, environments: new Set(["staging"]) }],
    [
      "deploymentIds",
      {
        ...PRINCIPAL,
        deploymentIds: new Set(["0199d09a-b692-7ce0-a1c0-5138a43d7403"]),
      },
    ],
    ["scopes", { ...PRINCIPAL, scopes: new Set(["deployment:write"]) }],
  ])(
    "rejects a %s claim mismatch without enqueueing",
    async (_claim, principal) => {
      const env = queueEnv();
      const response = await ingest(
        new Request("https://status.moesegfault.dev/v1/diagnostic-events", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(EVENT),
        }),
        env,
        principal,
        CONTEXT,
      );

      expect(response.status).toBe(403);
      expect(env.DIAGNOSTIC_QUEUE.send).not.toHaveBeenCalled();
    },
  );

  it("rejects a body larger than 64 KiB before queue publication", async () => {
    const env = queueEnv();
    const response = await ingest(
      new Request("https://status.moesegfault.dev/v1/diagnostic-events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "x".repeat(65_537),
      }),
      env,
      PRINCIPAL,
      CONTEXT,
    );

    expect(response.status).toBe(413);
    expect(env.DIAGNOSTIC_QUEUE.send).not.toHaveBeenCalled();
  });

  it("returns retryable 503 while preserving producer retry semantics", async () => {
    const env = queueEnv(
      vi.fn(async () => {
        throw new Error("queue unavailable");
      }),
    );
    const response = await ingest(
      new Request("https://status.moesegfault.dev/v1/diagnostic-events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(EVENT),
      }),
      env,
      PRINCIPAL,
      CONTEXT,
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
  });
});

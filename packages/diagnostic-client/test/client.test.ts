import { describe, expect, it, vi } from "vitest";

import {
  DiagnosticClient,
  logQueryEvidence,
  propagationFromHeaders,
  resourceFromManifest,
  sourceEvidence,
  type DiagnosticManifestIdentity,
} from "../src/index.js";

const DEPLOYMENT_ID = "0199d09a-b692-7ce0-a1c0-5138a43d7402";
const CORRELATION_ID = "0199d09a-b692-7ce0-a1c0-5138a43d7403";
const FAULT_ID = "0199d09a-b692-7ce0-a1c0-5138a43d7404";
const manifest: DiagnosticManifestIdentity = {
  deployment_id: DEPLOYMENT_ID,
  service_name: "checkout-api",
  environment: "production",
  service_version: "1.2.3",
  git_commit: "0123456789abcdef0123456789abcdef01234567",
  artifact_digest: `sha256:${"a".repeat(64)}`,
};

/** 建立测试客户端。/ Creates a test client. */
function client(
  fetchImpl: typeof fetch,
  options: Readonly<{
    capacity?: number;
    timeoutMs?: number;
    maxAttempts?: number;
    now?: () => number;
  }> = {},
): DiagnosticClient {
  return new DiagnosticClient({
    endpoint: "https://status.example/v1/diagnostic-events",
    resource: resourceFromManifest(manifest),
    manifest,
    authorization: () => "Bearer top-secret-auth-canary",
    fetch: fetchImpl,
    sleep: async () => undefined,
    baseBackoffMs: 1,
    maxBackoffMs: 1,
    ...options,
  });
}

/** 建立最小故障输入。/ Creates minimal fault input. */
function faultInput() {
  return {
    kind: "dependency.http_error",
    severity: "error" as const,
    summary: "Inventory dependency failed",
    fingerprint: {
      dependency: "inventory-api",
      error_type: "upstream_5xx",
      protocol: "http" as const,
    },
  };
}

describe("Diagnostic producer privacy", () => {
  it("scrubs canary secrets from every JSON text surface and drops unknown attributes", () => {
    const sdk = client(vi.fn<typeof fetch>());
    const event = sdk.builder.fault({
      ...faultInput(),
      summary: "token=canary-summary",
      fingerprint: {
        dependency: "password=canary-fingerprint",
        protocol: "http",
      },
      attributes: {
        "dependency.name": "secret=canary-attribute",
        authorization: "Bearer canary-unknown-attribute",
      },
      evidence: [
        logQueryEvidence({
          backend: "cloudflare-logs",
          query: { operation: "api_key=canary-locator" },
          timeRange: {
            start: "2026-09-12T08:00:00Z",
            end: "2026-09-12T08:01:00Z",
          },
        }),
        sourceEvidence({
          backend: "github",
          repositoryUrl: "https://example.com/org/repo",
          gitCommit: manifest.git_commit,
          path: "src/token=canary-source-path.ts",
        }),
      ],
    });

    expect(event.wireBody).not.toContain("canary");
    expect(event.wireBody).not.toContain("authorization");
    expect(event.wireBody).toContain("[REDACTED]");
  });

  it("keeps Authorization out of payload, stats, errors, and console", async () => {
    const bodies: string[] = [];
    const auth: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      bodies.push(String(init?.body));
      auth.push(new Headers(init?.headers).get("authorization") ?? "");
      const eventId = JSON.parse(String(init?.body)).event_id as string;
      return new Response(
        JSON.stringify({ event_id: eventId, accepted: true }),
        {
          status: 202,
        },
      );
    });
    const consoleSpies = [
      vi.spyOn(console, "debug").mockImplementation(() => undefined),
      vi.spyOn(console, "info").mockImplementation(() => undefined),
      vi.spyOn(console, "log").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
    ];
    const sdk = client(fetchImpl);
    sdk.fault(faultInput());
    const stats = await sdk.flush();

    expect(auth).toEqual(["Bearer top-secret-auth-canary"]);
    expect(bodies[0]).not.toContain("top-secret-auth-canary");
    expect(JSON.stringify(stats)).not.toContain("top-secret-auth-canary");
    for (const spy of consoleSpies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });
});

describe("Diagnostic delivery", () => {
  it("reuses the exact event ID and body across a retry", async () => {
    const bodies: string[] = [];
    const ids: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const body = String(init?.body);
      bodies.push(body);
      const id = JSON.parse(body).event_id as string;
      ids.push(id);
      if (bodies.length === 1) return new Response(null, { status: 503 });
      return new Response(JSON.stringify({ event_id: id, accepted: true }), {
        status: 202,
      });
    });
    const sdk = client(fetchImpl);
    const prepared = sdk.fault(faultInput());
    const stats = await sdk.flush();

    expect(prepared).toBeDefined();
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).toBe(prepared?.event.event_id);
    expect(stats).toMatchObject({ depth: 0, published: 1, failedAttempts: 1 });
  });

  it("bounds capacity and retains a timed-out event for a later flush", async () => {
    const never = new Promise<Response>(() => undefined);
    const sdk = client(
      vi.fn<typeof fetch>(() => never),
      {
        capacity: 1,
        timeoutMs: 1,
        maxAttempts: 1,
      },
    );
    expect(sdk.fault(faultInput())).toBeDefined();
    expect(sdk.fault(faultInput())).toBeUndefined();

    const stats = await sdk.flush();
    expect(stats).toMatchObject({
      depth: 1,
      enqueued: 1,
      dropped: 1,
      failedAttempts: 1,
      timeouts: 1,
      consecutiveFailures: 1,
    });
  });

  it("schedules flush with waitUntil without returning backend work", async () => {
    let work: Promise<unknown> | undefined;
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const id = JSON.parse(String(init?.body)).event_id as string;
      return new Response(JSON.stringify({ event_id: id, accepted: true }), {
        status: 202,
      });
    });
    const sdk = client(fetchImpl);
    sdk.fault(faultInput());
    const result = sdk.flush({
      waitUntil(promise) {
        work = promise;
      },
    });
    expect(result).toBeUndefined();
    await work;
    expect(sdk.depth).toBe(0);
  });

  it("cancels unread non-202 and oversized acknowledgement bodies", async () => {
    const nonAcceptedCancel = vi.fn();
    const oversizedCancel = vi.fn();
    const responses = [
      new Response(
        new ReadableStream<Uint8Array>({ cancel: nonAcceptedCancel }),
        { status: 503 },
      ),
      new Response(
        new ReadableStream<Uint8Array>({ cancel: oversizedCancel }),
        { status: 202, headers: { "content-length": "4097" } },
      ),
    ];
    const fetchImpl = vi.fn<typeof fetch>(async () => responses.shift()!);
    const sdk = client(fetchImpl, { maxAttempts: 1 });

    sdk.fault(faultInput());
    await sdk.flush();
    expect(nonAcceptedCancel).toHaveBeenCalledOnce();

    // 测试时钟退避后再投递第二个响应。/ Move past test backoff before delivering the second response.
    const retrySdk = client(fetchImpl, { maxAttempts: 1 });
    retrySdk.fault(faultInput());
    await retrySdk.flush();
    expect(oversizedCancel).toHaveBeenCalledOnce();
  });

  it("cancels a pending 202 body when its wall-clock timeout fires", async () => {
    const cancel = vi.fn();
    const pendingBody = new ReadableStream<Uint8Array>({ cancel });
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Promise.resolve(new Response(pendingBody, { status: 202 })),
    );
    const sdk = client(fetchImpl, { timeoutMs: 1, maxAttempts: 1 });
    sdk.fault(faultInput());

    const stats = await sdk.flush();
    expect(stats).toMatchObject({ depth: 1, timeouts: 1 });
    expect(cancel).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(pendingBody.locked).toBe(false);
  });

  it("does not call an injected fetch when Authorization resolves after timeout", async () => {
    vi.useFakeTimers();
    let resolveAuthorization: ((value: string) => void) | undefined;
    const authorization = new Promise<string>((resolve) => {
      resolveAuthorization = resolve;
    });
    const fetchImpl = vi.fn<typeof fetch>();
    const sdk = new DiagnosticClient({
      endpoint: "https://status.example/v1/diagnostic-events",
      resource: resourceFromManifest(manifest),
      manifest,
      authorization: () => authorization,
      fetch: fetchImpl,
      timeoutMs: 10,
      maxAttempts: 1,
      baseBackoffMs: 1,
      maxBackoffMs: 1,
    });
    sdk.fault(faultInput());

    const flushing = sdk.flush();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);
    const stats = await flushing;
    resolveAuthorization?.("Bearer late-secret");
    await Promise.resolve();
    await Promise.resolve();

    expect(stats).toMatchObject({ depth: 1, timeouts: 1 });
    expect(fetchImpl).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe("identity and locator safety", () => {
  it("parses W3C/correlation identity and emits explicit recovery", () => {
    const headers = new Headers({
      traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
      tracestate: "vendor=value",
      "x-moesegfault-correlation-id": CORRELATION_ID,
    });
    const propagation = propagationFromHeaders(headers, "internal", {
      nowMs: 1_789_200_000_000,
    });
    const sdk = client(vi.fn<typeof fetch>());
    const event = sdk.builder.recovery({
      ...faultInput(),
      severity: "info",
      summary: "Inventory dependency recovered",
      propagation,
      recoveryOfEventId: FAULT_ID,
    });

    expect(event.event).toMatchObject({
      signal: "recovery",
      recovery_of_event_id: FAULT_ID,
      correlation_id: CORRELATION_ID,
      trace_id: "0123456789abcdef0123456789abcdef",
    });
    expect(event.event.span_id).not.toBe("0123456789abcdef");
    expect(event.propagation.tracestate).toBe("vendor=value");
  });

  it("rejects credential-bearing endpoint and source URLs", () => {
    expect(
      () =>
        new DiagnosticClient({
          endpoint: "https://user:canary@status.example/v1/diagnostic-events",
          resource: resourceFromManifest(manifest),
          authorization: () => "Bearer safe",
        }),
    ).toThrow(/endpoint/);
    expect(() =>
      sourceEvidence({
        backend: "github",
        repositoryUrl: "https://user:canary@example.com/org/repo",
        gitCommit: manifest.git_commit,
        path: "src/index.ts",
      }),
    ).toThrow(/repositoryUrl/);
    expect(() =>
      logQueryEvidence({
        backend: "logs",
        query: { token: "canary" } as never,
        timeRange: {
          start: "2026-09-12T08:00:00Z",
          end: "2026-09-12T08:01:00Z",
        },
      }),
    ).toThrow(/not allowed/);
  });

  it("rejects publishing an event bound to another deployment", () => {
    const sdk = client(vi.fn<typeof fetch>());
    const otherManifest = {
      ...manifest,
      deployment_id: "0199d09a-b692-7ce0-a1c0-5138a43d7411",
    };
    const other = new DiagnosticClient({
      endpoint: "https://status.example/v1/diagnostic-events",
      resource: resourceFromManifest(otherManifest),
      authorization: () => "Bearer safe",
      fetch: vi.fn<typeof fetch>(),
    });
    expect(() => sdk.publish(other.builder.fault(faultInput()))).toThrow(
      /provenance/,
    );
  });
});

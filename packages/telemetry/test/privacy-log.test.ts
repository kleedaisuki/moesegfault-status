import { describe, expect, it, vi } from "vitest";
import {
  createLogger,
  createTraceContext,
  defineResource,
  sanitizeAttributes,
} from "../src/index.js";

const resource = defineResource({
  "service.namespace": "moeSegFault",
  "service.name": "status-api",
  "service.version": "1.0.0",
  "deployment.environment.name": "test",
  "moesegfault.deployment.id": "0199d09a-b692-7ce0-a1c0-5138a43d7402",
  "moesegfault.build.revision": "0123456789abcdef0123456789abcdef01234567",
  "moesegfault.artifact.digest": `sha256:${"a".repeat(64)}`,
});

describe("privacy", () => {
  it("copies only registered resource fields", () => {
    const injected = defineResource({
      ...resource,
      runtime_secret: "canary-resource-secret",
    } as typeof resource);
    expect(JSON.stringify(injected)).not.toContain("canary-resource-secret");
    expect(injected).not.toHaveProperty("runtime_secret");
  });

  it("passes only explicit attributes and redacts secret-shaped allowed keys", () => {
    const safe = sanitizeAttributes(
      {
        "http.request.method": "GET",
        "http.request.header.authorization": "Bearer canary-secret",
        password: "canary-password",
      },
      {
        allowed: new Set([
          "http.request.method",
          "http.request.header.authorization",
        ]),
      },
    );
    expect(safe).toEqual({
      "http.request.method": "GET",
      "http.request.header.authorization": "[REDACTED]",
    });
    expect(JSON.stringify(safe)).not.toContain("canary-secret");
    expect(JSON.stringify(safe)).not.toContain("canary-password");
  });

  it("scrubs body canaries and emits a stable OTel-shaped record", () => {
    const info = vi.fn();
    const logger = createLogger({
      resource,
      instrumentation: { name: "test-suite", version: "1.0.0" },
      attributePolicy: { allowed: new Set(["http.request.method"]) },
      console: { debug: vi.fn(), info, warn: vi.fn(), error: vi.fn() },
      now: () => new Date("2026-09-12T00:00:00.000Z"),
      policyRevision: "sampling-v1",
    });
    const trace = createTraceContext(true);
    const record = logger.emit(
      {
        eventName: "status.request.completed",
        severity: "INFO",
        body: "authorization=canary-secret password:canary-password",
        attributes: { "http.request.method": "GET", ignored: "canary-ignored" },
      },
      { trace, correlationId: "0199d09a-b692-7ce0-a1c0-5138a43d7402" },
    );

    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("canary-secret");
    expect(serialized).not.toContain("canary-password");
    expect(serialized).not.toContain("canary-ignored");
    expect(record).toMatchObject({
      Timestamp: "2026-09-12T00:00:00.000Z",
      ObservedTimestamp: "2026-09-12T00:00:00.000Z",
      SeverityNumber: 9,
      SeverityText: "INFO",
      EventName: "status.request.completed",
      TraceId: trace.traceId,
    });
    expect(info).toHaveBeenCalledOnce();
  });

  it("does not emit forged trace fields", () => {
    const info = vi.fn();
    const logger = createLogger({
      resource,
      instrumentation: { name: "test-suite" },
      attributePolicy: { allowed: new Set() },
      console: { debug: vi.fn(), info, warn: vi.fn(), error: vi.fn() },
    });
    const record = logger.emit(
      { eventName: "status.request.completed", severity: "INFO", body: "ok" },
      {
        trace: {
          traceId: "11111111111111111111111111111111",
          spanId: "canary-span-secret",
          traceFlags: 1,
          traceparent:
            "00-11111111111111111111111111111111-2222222222222222-01",
        },
      },
    );
    expect(JSON.stringify(record)).not.toContain("canary-span-secret");
    expect(record).not.toHaveProperty("TraceId");
  });
});

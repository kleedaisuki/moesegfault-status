import { describe, expect, it, vi } from "vitest";
import { createTelemetry, defineResource } from "../src/index.js";

const resource = defineResource({
  "service.namespace": "moeSegFault",
  "service.name": "status-api",
  "service.version": "1.0.0",
  "deployment.environment.name": "test",
  "moesegfault.deployment.id": "0199d09a-b692-7ce0-a1c0-5138a43d7402",
  "moesegfault.build.revision": "0123456789abcdef0123456789abcdef01234567",
  "moesegfault.artifact.digest": `sha256:${"a".repeat(64)}`,
});

describe("telemetry facade", () => {
  it("rotates public correlation and injects explicit outbound context", () => {
    const attackerId = "0199d09a-b692-7ce0-a1c0-5138a43d7402";
    const telemetry = createTelemetry({
      resource,
      instrumentation: { name: "test" },
      attributePolicy: { allowed: new Set() },
      console: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const boundary = telemetry.beginBoundary(
      new Request("https://example.test", {
        headers: { "x-moesegfault-correlation-id": attackerId },
      }),
      { kind: "public", sampleRate: 1 },
    );
    const outgoing = boundary.inject(new Headers());

    expect(boundary.correlationId).not.toBe(attackerId);
    expect(outgoing.get("x-moesegfault-correlation-id")).toBe(
      boundary.correlationId,
    );
    expect(outgoing.get("traceparent")).toBe(boundary.trace.traceparent);
    expect(boundary.trace.traceFlags & 1).toBe(1);
  });
});

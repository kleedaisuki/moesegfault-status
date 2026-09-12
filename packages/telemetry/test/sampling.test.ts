import { describe, expect, it, vi } from "vitest";
import { createLogger, defineResource, shouldSample } from "../src/index.js";

describe("deterministic sampling", () => {
  it("is deterministic and honors exact rate edges", () => {
    const id = "80000000000000000000000000000000";
    expect(shouldSample(id, 0)).toBe(false);
    expect(shouldSample(id, 1)).toBe(true);
    expect(shouldSample(id, 0.5)).toBe(false);
    expect(shouldSample("7fffffffffffffffffffffffffffffff", 0.5)).toBe(true);
    expect(shouldSample(id, 0.5)).toBe(shouldSample(id, 0.5));
  });

  it("always keeps errors, slow traces, and incident evidence", () => {
    const id = "ffffffffffffffffffffffffffffffff";
    expect(shouldSample(id, 0, { error: true })).toBe(true);
    expect(shouldSample(id, 0, { slow: true })).toBe(true);
    expect(shouldSample(id, 0, { incident: true })).toBe(true);
  });

  it("keeps ERROR console records even when the normal log rate is zero", () => {
    const output = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const logger = createLogger({
      resource: defineResource({
        "service.namespace": "moeSegFault",
        "service.name": "status-api",
        "service.version": "1",
        "deployment.environment.name": "test",
        "moesegfault.deployment.id": "0199d09a-b692-7ce0-a1c0-5138a43d7402",
        "moesegfault.build.revision":
          "0123456789abcdef0123456789abcdef01234567",
        "moesegfault.artifact.digest": `sha256:${"a".repeat(64)}`,
      }),
      instrumentation: { name: "test" },
      attributePolicy: { allowed: new Set() },
      console: output,
      sampleRate: 0,
    });
    const trace = {
      traceId: "ffffffffffffffffffffffffffffffff",
      spanId: "1111111111111111",
      traceFlags: 0,
      traceparent: "00-ffffffffffffffffffffffffffffffff-1111111111111111-00",
    };
    logger.emit(
      { eventName: "status.request.completed", severity: "INFO", body: "ok" },
      { trace },
    );
    logger.emit(
      { eventName: "status.request.failed", severity: "ERROR", body: "failed" },
      { trace },
    );
    expect(output.info).not.toHaveBeenCalled();
    expect(output.error).toHaveBeenCalledOnce();
    expect(logger.sampledOut).toBe(1);
  });
});

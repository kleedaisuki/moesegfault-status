import type { WorkersTracing } from "@moesegfault/telemetry";
import { describe, it, expect, vi } from "vitest";
import { executorTelemetry, withExecutorInvocation } from "./telemetry.js";
const production = {
  ENVIRONMENT: "production",
  DEPLOYMENT_ID: "01991c00-0000-7000-8000-000000000001",
  GIT_COMMIT: "a".repeat(40),
  ARTIFACT_DIGEST: `sha256:${"b".repeat(64)}`,
  STATUS_VERSION: "1.0.0",
};
describe("executor provenance gate", () => {
  it("cannot produce any valid sample without production provenance", async () => {
    const execute = vi.fn(async () => Response.json({ outcome: "success" }));
    expect(
      (
        await withExecutorInvocation(
          { ...production, DEPLOYMENT_ID: "" },
          undefined,
          execute,
        )
      ).status,
    ).toBe(503);
    expect(execute).not.toHaveBeenCalled();
  });
  it("allows only wholly empty development without inventing an identity", () => {
    expect(
      executorTelemetry({
        ...production,
        ENVIRONMENT: "development",
        DEPLOYMENT_ID: "",
        GIT_COMMIT: "",
        ARTIFACT_DIGEST: "",
      }),
    ).toBeUndefined();
    expect(() =>
      executorTelemetry({
        ...production,
        ENVIRONMENT: "development",
        DEPLOYMENT_ID: "",
      }),
    ).toThrow();
  });
  it("binds resource identity to native invocation span", async () => {
    const attributes: Record<string, unknown> = {};
    const tracing: WorkersTracing = {
      enterSpan(name, callback, ...args) {
        expect(name).toBe("probe.executor.invocation");
        return callback(
          {
            isTraced: true,
            setAttribute: (key, value) => {
              attributes[key] = value;
            },
            end: () => {},
          },
          ...args,
        );
      },
    };
    const response = await withExecutorInvocation(
      production,
      tracing,
      async (telemetry) => {
        expect(telemetry?.resource["service.name"]).toBe("probe-executor");
        return new Response(null, { status: 200 });
      },
    );
    expect(response.status).toBe(200);
    expect(attributes["moesegfault.deployment.id"]).toBe(
      production.DEPLOYMENT_ID,
    );
    expect(attributes["moesegfault.artifact.digest"]).toBe(
      production.ARTIFACT_DIGEST,
    );
  });
});

it("emits resource-bound logs without target attributes", () => {
  const sink = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    const telemetry = executorTelemetry(production)!;
    telemetry.logger.emit({
      eventName: "probe.executor.completed",
      severity: "INFO",
      body: "Regional probe completed",
      attributes: {
        "operation.name": "probe.execute",
        "target.url": "https://secret.invalid/?token=canary",
      },
    });
    const serialized = JSON.stringify(sink.mock.calls);
    expect(serialized).toContain(production.DEPLOYMENT_ID);
    expect(serialized).toContain("probe-executor");
    expect(serialized).not.toContain("canary");
  } finally {
    sink.mockRestore();
  }
});

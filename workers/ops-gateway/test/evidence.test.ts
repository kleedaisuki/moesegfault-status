import { describe, expect, it, vi } from "vitest";

import type {
  AdminPrincipal,
  QueryTelemetryReferenceRpcResult,
} from "@moesegfault/contracts";
import type { TraceContext } from "@moesegfault/telemetry";
import { routeApiRequest, type AdminRpcClient } from "../src/router.js";

const REFERENCE = "018f0000-0000-7000-8000-000000000001";
const DEPLOYMENT = "018f0000-0000-7000-8000-000000000002";
const CORRELATION = "018f0000-0000-7000-8000-000000000003";
const NOW = "2026-09-12T00:00:00.000Z";

const principal: AdminPrincipal = {
  subject: "viewer-subject",
  email: "viewer@example.com",
  roles: ["viewer"],
  authenticated_at: NOW,
  access_application: "ops",
};

const trace: TraceContext = {
  traceId: "0123456789abcdef0123456789abcdef",
  spanId: "0123456789abcdef",
  traceFlags: 1,
  traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
};

function result(): Extract<
  QueryTelemetryReferenceRpcResult,
  { data: unknown }
> {
  return {
    data: {
      telemetry_reference: {
        id: REFERENCE,
        kind: "trace",
        backend: "traces",
        locator: { trace_id: trace.traceId },
        trace_id: trace.traceId,
        service_name: "api",
        deployment_id: DEPLOYMENT,
      },
      status: "ok",
      ui_url: `https://grafana.example/explore?trace_id=${trace.traceId}`,
      records: [
        {
          timestamp: NOW,
          title: "GET /health",
          attributes: { span_id: trace.spanId },
        },
      ],
      truncated: false,
      queried_at: NOW,
    },
  };
}

function context() {
  return {
    principal,
    correlationId: CORRELATION,
    allowedOrigin: "https://ops.moesegfault.dev",
    trace,
  };
}

describe("evidence gateway route", () => {
  it("lets a viewer query one known reference through the named RPC", async () => {
    const queryTelemetryReference = vi.fn(async () => result());
    const status = { queryTelemetryReference } as unknown as AdminRpcClient;
    const response = await routeApiRequest(
      new Request(`https://ops.moesegfault.dev/api/evidence/${REFERENCE}`),
      status,
      context(),
    );
    expect(response.status).toBe(200);
    expect(queryTelemetryReference).toHaveBeenCalledWith(
      expect.objectContaining({
        telemetry_reference_id: REFERENCE,
        principal,
        correlation_id: CORRELATION,
        trace_context: { traceparent: trace.traceparent },
      }),
    );
    await expect(response.json()).resolves.toEqual(result());
  });

  it("rejects a malformed downstream result instead of passing it through", async () => {
    const status = {
      queryTelemetryReference: async () => ({
        data: { ...result().data, ui_url: "http://metadata.internal" },
      }),
    } as unknown as AdminRpcClient;
    await expect(
      routeApiRequest(
        new Request(`https://ops.moesegfault.dev/api/evidence/${REFERENCE}`),
        status,
        context(),
      ),
    ).rejects.toMatchObject({
      problem: {
        status: 502,
        type: expect.stringContaining("invalid-rpc-response"),
      },
    });
  });
});

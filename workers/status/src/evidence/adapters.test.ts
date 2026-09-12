import { describe, expect, it, vi } from "vitest";
import type { TelemetryReference } from "@moesegfault/contracts";

import {
  logQueryEvidence,
  metricQueryEvidence,
  profileEvidence,
} from "../../../../packages/diagnostic-client/src/evidence.js";
import type { TelemetryQueryAdapter } from "../../../../packages/contracts/src/backend-query.js";
import { executeAdapter } from "./adapters.js";
import type { AdapterContext } from "./types.js";

const ID = "018f0000-0000-7000-8000-000000000001";
const DEPLOYMENT = "018f0000-0000-7000-8000-000000000002";
const TRACE = "0123456789abcdef0123456789abcdef";
const START = "2026-09-12T00:00:00.000Z";
const END = "2026-09-12T00:10:00.000Z";

/** 构造只含固定 HTTPS 后端的测试上下文 / Build a test context containing only a pinned HTTPS backend. */
function context(
  adapter: TelemetryQueryAdapter,
  reference: TelemetryReference,
  fetch: typeof globalThis.fetch,
): AdapterContext {
  return {
    adapter,
    resolved: {
      reference,
      adapterText: adapter,
      capabilities: [reference.kind],
      uiUrlTemplate: "https://telemetry.example/explore",
      authReference: "QUERY_TOKEN",
      enabled: true,
      repositoryUrl: "https://github.com/moesegfault/status.git",
      gitCommit: "a".repeat(40),
    },
    config: {
      endpoint: "https://telemetry.example/base",
      allowed_hosts: ["telemetry.example", "github.com"],
      auth_scheme: "bearer",
      timeout_ms: 1_000,
      max_response_bytes: 64_000,
    },
    credential: "secret-token",
    fetch,
    now: new Date(END),
  };
}

function common<const Kind extends TelemetryReference["kind"]>(kind: Kind) {
  return {
    id: ID,
    kind,
    backend: "primary",
    service_name: "api",
    deployment_id: DEPLOYMENT,
  } as const;
}

describe("telemetry evidence adapters", () => {
  it("uses Tempo v2 trace API and normalizes spans without exposing credentials", async () => {
    const outbound = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe(`/base/api/v2/traces/${TRACE}`);
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer secret-token",
      );
      return Response.json({
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    name: "GET /health",
                    spanId: "0123456789abcdef",
                    startTimeUnixNano: "1789171200000000000",
                    attributes: [],
                  },
                ],
              },
            ],
          },
        ],
      });
    });
    const reference: TelemetryReference = {
      ...common("trace"),
      locator: { trace_id: TRACE },
      trace_id: TRACE,
    };
    const result = await executeAdapter(context("tempo", reference, outbound));
    expect(result.status).toBe("ok");
    expect(result.records[0]?.title).toBe("GET /health");
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it("uses Loki query_range with URLSearchParams and hard result limit", async () => {
    const expression = `{service_name="api",deployment_id="${DEPLOYMENT}",operation="bad & worse"}`;
    const outbound = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/base/loki/api/v1/query_range");
      expect(url.searchParams.get("query")).toBe(expression);
      expect(url.searchParams.get("limit")).toBe("100");
      return Response.json({
        data: {
          result: [
            {
              stream: { level: "error" },
              values: [["1789171200000000000", "failure"]],
            },
          ],
        },
      });
    });
    const reference: TelemetryReference = {
      ...common("log_query"),
      locator: {
        query: {
          service: "api",
          deployment_id: DEPLOYMENT,
          operation: "bad & worse",
        },
      },
      time_range: { start: START, end: END },
    };
    const result = await executeAdapter(context("loki", reference, outbound));
    expect(result.records).toEqual([
      {
        timestamp: "2026-09-12T00:00:00.000Z",
        title: "failure",
        attributes: { level: "error" },
      },
    ]);
  });

  it("uses Prometheus query_range and bounds samples", async () => {
    const outbound = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/base/api/v1/query_range");
      expect(url.searchParams.get("query")).toBe(
        `http_requests_total{service_name="api",deployment_id="${DEPLOYMENT}"}`,
      );
      expect(Number(url.searchParams.get("step"))).toBeGreaterThanOrEqual(6);
      return Response.json({
        data: {
          result: [{ metric: { method: "GET" }, values: [[1789171200, "3"]] }],
        },
      });
    });
    const reference: TelemetryReference = {
      ...common("metric_query"),
      locator: {
        metric_name: "http_requests_total",
        query: { service: "api", deployment_id: DEPLOYMENT },
      },
      time_range: { start: START, end: END },
    };
    const result = await executeAdapter(
      context("prometheus", reference, outbound),
    );
    expect(result.records[0]?.title).toBe("http_requests_total = 3");
  });

  it("uses Pyroscope render API with fixed JSON format and maxNodes", async () => {
    const outbound = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/base/pyroscope/render");
      expect(url.searchParams.get("query")).toBe(
        `process_cpu:cpu:nanoseconds:cpu:nanoseconds{service_name="api",deployment_id="${DEPLOYMENT}"}`,
      );
      expect(url.searchParams.get("maxNodes")).toBe("100");
      expect(url.searchParams.get("format")).toBe("json");
      return Response.json({ flamebearer: { names: ["main", "serve"] } });
    });
    const reference: TelemetryReference = {
      ...common("profile"),
      locator: {
        profile_type: "cpu",
        query: { service: "api", deployment_id: DEPLOYMENT },
      },
      time_range: { start: START, end: END },
    };
    const result = await executeAdapter(
      context("pyroscope", reference, outbound),
    );
    expect(result.records.map((item) => item.title)).toEqual(["main", "serve"]);
  });

  it("builds a commit-pinned encoded source link without making HTTP requests", async () => {
    const outbound = vi.fn<typeof fetch>();
    const reference: TelemetryReference = {
      ...common("source"),
      locator: {
        repository_url: "https://github.com/moesegfault/status.git",
        git_commit: "a".repeat(40),
        path: "src/空 格.ts",
        line: 7,
      },
    };
    const result = await executeAdapter(
      context("source-commit", reference, outbound),
    );
    expect(result.ui_url).toBe(
      `https://github.com/moesegfault/status/blob/${"a".repeat(40)}/src/%E7%A9%BA%20%E6%A0%BC.ts#L7`,
    );
    expect(outbound).not.toHaveBeenCalled();
  });

  it("rejects an oversized response before JSON normalization", async () => {
    const outbound = vi.fn<typeof fetch>(
      async () =>
        new Response("x", { headers: { "content-length": "999999" } }),
    );
    const reference: TelemetryReference = {
      ...common("trace"),
      locator: { trace_id: TRACE },
      trace_id: TRACE,
    };
    const result = await executeAdapter(context("tempo", reference, outbound));
    expect(result.status).toBe("unavailable");
    expect(result.detail).toMatch(/byte limit/u);
  });

  it("compiles an SDK log locator into scoped, escaped LogQL and scrubs vendor output", async () => {
    const outbound = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("query")).toBe(
        `{service_name="api",deployment_id="${DEPLOYMENT}",severity="ERROR",operation="read\\\"\\\\\\nline"}`,
      );
      return Response.json({
        data: {
          result: [
            {
              stream: {
                authorization: "Bearer canary-label-token",
                note: "password=canary-attribute",
              },
              values: [["1789171200000000000", "token=canary-title-secret"]],
            },
          ],
        },
      });
    });
    const sdkEvidence = logQueryEvidence({
      backend: "primary",
      query: {
        service: "api",
        deployment_id: DEPLOYMENT,
        severity: "ERROR",
        operation: 'read"\\\nline',
      },
      timeRange: { start: START, end: END },
    });
    const reference: TelemetryReference = {
      ...common("log_query"),
      ...sdkEvidence,
    };

    const result = await executeAdapter(context("loki", reference, outbound));
    expect(result.status).toBe("ok");
    expect(JSON.stringify(result)).not.toContain("canary");
    expect(result.records[0]).toMatchObject({
      title: "[REDACTED]",
      attributes: {
        authorization: "[REDACTED]",
        note: "[REDACTED]",
      },
    });
  });

  it("compiles every SDK metric selector with authoritative identity scope", async () => {
    const outbound = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("query")).toBe(
        `http_requests_total{service_name="api",deployment_id="${DEPLOYMENT}",environment="production",region="ap-southeast-1",operation="checkout",component="gateway",dependency="inventory"}`,
      );
      return Response.json({ data: { result: [] } });
    });
    const sdkEvidence = metricQueryEvidence({
      backend: "primary",
      metricName: "http_requests_total",
      query: {
        service: "api",
        deployment_id: DEPLOYMENT,
        environment: "production",
        region: "ap-southeast-1",
        operation: "checkout",
        component: "gateway",
        dependency: "inventory",
      },
      timeRange: { start: START, end: END },
    });
    const reference: TelemetryReference = {
      ...common("metric_query"),
      ...sdkEvidence,
    };

    const result = await executeAdapter(
      context("prometheus", reference, outbound),
    );
    expect(result.status).toBe("ok");
    expect(outbound).toHaveBeenCalledOnce();
  });

  it("compiles an SDK profile locator into a scoped Pyroscope selector and rejects identity conflict", async () => {
    const outbound = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("query")).toBe(
        `process_cpu:cpu:nanoseconds:cpu:nanoseconds{service_name="api",deployment_id="${DEPLOYMENT}",region="ap-southeast-1"}`,
      );
      return Response.json({ flamebearer: { names: [] } });
    });
    const sdkEvidence = profileEvidence({
      backend: "primary",
      profileType: "cpu",
      query: {
        service: "api",
        deployment_id: DEPLOYMENT,
        region: "ap-southeast-1",
      },
      timeRange: { start: START, end: END },
    });
    const reference: TelemetryReference = {
      ...common("profile"),
      ...sdkEvidence,
    };
    const result = await executeAdapter(
      context("pyroscope", reference, outbound),
    );
    expect(result.status).toBe("ok");

    const conflicting = profileEvidence({
      backend: "primary",
      profileType: "cpu",
      query: { service: "other-service", region: "ap-southeast-1" },
      timeRange: { start: START, end: END },
    });
    const rejected = await executeAdapter(
      context("pyroscope", { ...common("profile"), ...conflicting }, outbound),
    );
    expect(rejected.status).toBe("unsupported");
    expect(outbound).toHaveBeenCalledOnce();
  });

  it("rejects unknown keys and every arbitrary legacy query path without backend egress", async () => {
    const outbound = vi.fn<typeof fetch>();
    const unknown: TelemetryReference = {
      ...common("log_query"),
      locator: { query: { token: "must-not-become-logql" } },
      time_range: { start: START, end: END },
    };
    const mixed: TelemetryReference = {
      ...common("metric_query"),
      locator: {
        metric_name: "http_requests_total",
        query: { expression: "up", region: "ap-southeast-1" },
      },
      time_range: { start: START, end: END },
    };
    const legacyExpression: TelemetryReference = {
      ...common("log_query"),
      locator: { query: { expression: `{service_name=~".*"}` } },
      time_range: { start: START, end: END },
    };
    const legacyProfileId: TelemetryReference = {
      ...common("profile"),
      locator: {
        profile_type: "cpu",
        profile_id: `process_cpu:cpu:nanoseconds:cpu:nanoseconds{service_name=~".*"}`,
      },
      time_range: { start: START, end: END },
    };

    expect(
      (await executeAdapter(context("loki", unknown, outbound))).status,
    ).toBe("unsupported");
    expect(
      (await executeAdapter(context("prometheus", mixed, outbound))).status,
    ).toBe("unsupported");
    expect(
      (await executeAdapter(context("loki", legacyExpression, outbound)))
        .status,
    ).toBe("unsupported");
    expect(
      (await executeAdapter(context("pyroscope", legacyProfileId, outbound)))
        .status,
    ).toBe("unsupported");
    expect(outbound).not.toHaveBeenCalled();
  });
});

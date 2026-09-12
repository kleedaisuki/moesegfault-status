// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { renderEvidenceResult } from "./evidence-view";

/** 不含供应商原始 JSON 的结构化证据夹具。 / Structured evidence fixture without raw vendor JSON. */
const result = {
  telemetry_reference: {
    id: "0199d0a8-2e12-7000-8000-000000000001",
    service_name: "api",
    deployment_id: "0199d0a8-2e12-7000-8000-000000000002",
    kind: "trace",
    backend: "tempo",
    locator: { trace_id: "12345678901234567890123456789012" },
    expires_at: "2026-10-12T00:00:00Z",
  },
  status: "ok",
  ui_url: "https://grafana.example/trace/123",
  records: [
    {
      title: "<img src=x onerror=alert(1)>",
      attributes: { operation: "<script>bad()</script>" },
    },
  ],
  truncated: false,
  queried_at: "2026-09-12T00:00:00Z",
};

describe("evidence rendering", () => {
  it("renders untrusted text without markup and isolates external navigation", () => {
    const view = renderEvidenceResult(result);
    expect(view.querySelector("img,script")).toBeNull();
    expect(view.textContent).toContain("<img");
    expect(view.querySelector("a")?.rel).toBe("noopener noreferrer");
  });
  it.each(["expired", "unavailable", "unsupported", "not_found"])(
    "exposes %s without presenting healthy service state",
    (status) => {
      const view = renderEvidenceResult({
        ...result,
        status,
        ui_url: null,
        records: [],
        truncated: true,
      });
      expect(view.dataset.evidenceStatus).toBe(status);
      expect(view.textContent).toContain("结果已截断");
      expect(view.querySelector("a")).toBeNull();
    },
  );
  it("rejects executable URLs rather than trusting a server response", () => {
    expect(() =>
      renderEvidenceResult({ ...result, ui_url: "javascript:alert(1)" }),
    ).toThrow();
  });
});

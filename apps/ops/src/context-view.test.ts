// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  renderDiagnosticContext,
  refreshDiagnosticFreshness,
} from "./context-view";

const id = "0199d0a8-2e12-7000-8000-000000000001";
const start = "2026-09-12T00:00:00Z";
const end = "2026-09-12T00:05:00Z";
/** 有界、严格的 §13 响应夹具。 / Bounded strict §13 response fixture. */
const context = {
  issues: [],
  incidents: [],
  evidence: [],
  deployments: [],
  affected_services: [
    {
      service_name: "api",
      relations: [{ kind: "locator" }],
      current_status: {
        direct_status: "operational",
        dependency_risk: "none",
        effective_impact: "operational",
        evaluated_at: start,
        fresh_until: end,
        revision: 1,
      },
    },
  ],
  dependency_paths: [
    {
      root_service: "api",
      leaf_service: "db",
      edges: [
        {
          source_service: "api",
          target_service: "db",
          capability: "read",
          kind: "required",
          criticality: "critical",
        },
      ],
    },
  ],
  source_locations: [
    {
      telemetry_reference_id: id,
      deployment_id: id,
      repository_url: "https://github.com/example/api",
      git_commit: "a".repeat(40),
      path: "<img src=x onerror=alert(1)>",
      line: 42,
      provenance_verified: false,
    },
  ],
  status_transitions: [
    {
      transition_id: id,
      target_type: "service",
      target_id: "api",
      service_name: "api",
      sequence: 2,
      from_status: "degraded",
      to_status: "operational",
      source_type: "issue",
      source_id: id,
      policy: null,
      correlation_id: id,
      occurred_at: start,
    },
  ],
  audit_summary: {
    event_count: 1,
    first_occurred_at: start,
    last_occurred_at: start,
    actions: [{ action: "issue.resolved", count: 1 }],
    actors: [
      { actor_type: "system", actor_subject: "evaluator", event_count: 1 },
    ],
  },
  truncated: true,
};

describe("diagnostic context view", () => {
  it("renders all required typed relationships and marks partial evidence and unverified provenance", () => {
    const view = renderDiagnosticContext(context, Date.parse(start));
    expect(view.textContent).toContain("上下文已截断");
    expect(view.textContent).toContain("api → db [read; required; critical]");
    expect(view.textContent).toContain("未验证，禁止据此推断来源");
    expect(view.textContent).toContain("degraded → operational");
    expect(view.textContent).toContain("issue.resolved");
    expect(view.querySelector("img,script")).toBeNull();
    expect(view.querySelector("pre")).toBeNull();
    expect(
      view.querySelector<HTMLElement>(".diagnostic-table-scroll")?.tabIndex,
    ).toBe(0);
    expect(
      view
        .querySelector(".diagnostic-table-scroll")
        ?.getAttribute("aria-label"),
    ).toContain("横向滚动");
  });
  it("does not display stale service state as current health", () => {
    const view = renderDiagnosticContext(context, Date.parse(end));
    const cells = view.querySelector("tbody tr")!.querySelectorAll("td");
    expect(cells[2]?.textContent).toContain("unknown");
    expect(cells[3]?.textContent).toBe("unknown");
    expect(cells[4]?.textContent).toBe("unknown");
  });
  it("downgrades freshness while the page remains open without rewriting transition history", () => {
    const host = document.createElement("div");
    host.append(renderDiagnosticContext(context, Date.parse(start)));
    refreshDiagnosticFreshness(host, Date.parse(end));
    expect(host.querySelector("tbody tr")?.textContent).toContain(
      "unknown（证据已过期）",
    );
    expect(host.textContent).toContain("degraded → operational");
  });
  it("rejects raw audit/details fields outside the projection", () => {
    expect(() =>
      renderDiagnosticContext({
        ...context,
        audit_log: [{ payload: "SECRET_CANARY" }],
      }),
    ).toThrow();
  });
});

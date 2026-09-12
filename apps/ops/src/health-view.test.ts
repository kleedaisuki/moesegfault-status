// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  gateControl,
  renderHealthBanner,
  type ControlPlaneChecks,
} from "./health-view";

/** 构建全健康基线，单项测试只改变一个信号 / Build an all-healthy baseline so each test changes one signal. */
function healthyChecks(): ControlPlaneChecks {
  return {
    access: { state: "healthy", detail: "authenticated" },
    rpc: { state: "healthy", detail: "available" },
    freshness: { state: "healthy", detail: "fresh" },
  };
}

describe("control-plane health banner", () => {
  it.each(["access", "rpc", "freshness"] as const)(
    "fails closed when only %s fails",
    (key) => {
      const checks = {
        ...healthyChecks(),
        [key]: { state: "failed" as const, detail: `${key} failed` },
      };
      const banner = renderHealthBanner(checks);
      expect(banner.dataset.state).toBe("failed");
      expect(banner.textContent).toContain(`${key} failed`);
    },
  );
});

describe("role-gated controls", () => {
  it("disables viewer controls and enables operator/admin controls", () => {
    const button = document.createElement("button");
    gateControl(button, ["viewer"]);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    gateControl(button, ["operator"]);
    expect(button.disabled).toBe(false);
    gateControl(button, ["admin"]);
    expect(button.disabled).toBe(false);
  });
});

// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  login: vi.fn(),
  health: vi.fn(),
  logout: vi.fn(),
}));
vi.mock("./api", () => ({
  ApiError: class extends Error {},
  api: {
    ...mocks,
    platform: async () => {
      throw new Error("offline");
    },
    services: async () => ({ data: [] }),
    incidents: async () => ({ data: [] }),
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.session.mockRejectedValue(new Error("unauthorized"));
  mocks.login.mockResolvedValue(undefined);
  mocks.health.mockResolvedValue({ data: { status: "ok", dependencies: [] } });
  vi.spyOn(window, "setInterval").mockReturnValue(setTimeout(() => {}, 0));
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => vi.restoreAllMocks());

it("requires login before reading management data and preserves the empty catalog", async () => {
  await import("./main");
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("管理员登录"),
  );
  expect(mocks.health).not.toHaveBeenCalled();
  expect(document.querySelector(".tabs")).toBeNull();
  mocks.session.mockResolvedValue({
    data: {
      subject: "owner",
      email: "redacted@example.invalid",
      roles: ["admin"],
    },
  });
  const form = document.querySelector("form")!;
  form.querySelector("input")!.value = " exact password unchanged ";
  form.dispatchEvent(new Event("submit", { cancelable: true }));
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("退出登录"),
  );
  expect(mocks.login).toHaveBeenCalledWith(" exact password unchanged ");
  expect(document.body.textContent).toContain("暂无可验证服务数据");
  expect(document.body.textContent).not.toMatch(
    /Cloudflare Access|设置管理员密码|修改密码/,
  );
});

it("never enables first-visitor registration from a setup fragment", async () => {
  window.history.replaceState(null, "", "/#setup=" + "a".repeat(43));
  await import("./main");
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("管理员登录"),
  );
  expect(document.body.textContent).not.toMatch(/设置管理员密码|保存密码/);
  window.history.replaceState(null, "", "/");
});

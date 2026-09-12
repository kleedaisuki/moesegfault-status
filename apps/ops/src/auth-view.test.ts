// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { authForm } from "./auth-view";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("single administrator authentication", () => {
  it("shows only password login and submits exact password without storage", async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const view = authForm(submit);
    document.body.append(view);
    const form = view.querySelector("form")!;
    const password = form.elements.namedItem("password") as HTMLInputElement;
    expect(form.querySelectorAll("input")).toHaveLength(1);
    expect(password.autocomplete).toBe("current-password");
    expect(view.textContent).toContain("redacted@example.invalid");
    expect(view.textContent).not.toMatch(/注册|设置密码|修改密码/);
    password.value = "  correct horse battery staple  ";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() =>
      expect(submit).toHaveBeenCalledWith("  correct horse battery staple  "),
    );
    expect(password.value).toBe("");
    expect(storage).not.toHaveBeenCalled();
  });
  it("never reflects backend errors and clears failed passwords", async () => {
    const view = authForm(vi.fn().mockRejectedValue(new Error("secret token")));
    document.body.append(view);
    const form = view.querySelector("form")!;
    const input = form.querySelector("input")!;
    input.value = "password";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(view.textContent).toContain("验证失败"));
    expect(view.textContent).not.toContain("secret token");
    expect(input.value).toBe("");
  });
});

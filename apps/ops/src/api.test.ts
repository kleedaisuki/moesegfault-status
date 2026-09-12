import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("UI transport boundary", () => {
  it("fails a typed domain Problem even when an upstream incorrectly returns HTTP 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            problem: {
              type: "https://status.moesegfault.dev/problems/conflict",
              title: "Conflict",
              status: 409,
              detail: "Revision changed",
              correlation_id: "0199d0a8-2e12-7000-8000-000000000001",
            },
          }),
          { status: 200 },
        ),
      ),
    );
    await expect(
      api.write("/api/services/api", {}, "PATCH", 3),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("sends same-origin CSRF and a strong If-Match without storing credentials", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 409 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(
      api.write("/api/services/api", {}, "PATCH", 3),
    ).rejects.toBeInstanceOf(ApiError);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      credentials: "same-origin",
      method: "PATCH",
      headers: { "if-match": '"3"', "x-moesegfault-csrf": "1" },
    });
    expect(fetcher.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
  });
  it("rejects unknown writes before network access", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(() => api.write("https://attacker.example", {})).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

/** 所有认证写入使用相同 CSRF 和同源会话边界。 / All auth mutations share the CSRF and same-origin session boundary. */
describe("authentication transport", () => {
  it("sends login/logout JSON with no secret URL", async () => {
    const fetcher = vi
      .fn()
      .mockImplementation(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    await api.login(" password unchanged ");
    await api.logout();
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "/api/auth/login",
      "/api/auth/logout",
    ]);
    for (const [, init] of fetcher.mock.calls)
      expect(init).toMatchObject({
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "content-type": "application/json",
          "x-moesegfault-csrf": "1",
        },
      });
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({
      password: " password unchanged ",
    });
  });
  it("does not reflect authentication error responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("private auth diagnostics", { status: 401 }),
        ),
    );
    await expect(api.login("wrong")).rejects.toMatchObject({
      message: "身份验证失败，请重试",
      status: 401,
    });
  });
});

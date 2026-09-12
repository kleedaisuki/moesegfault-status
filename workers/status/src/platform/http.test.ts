import { describe, expect, it } from "vitest";
import {
  HttpError,
  problemResponse,
  readJson,
  uuidv7,
  withResponseHeaders,
} from "./http.js";

describe("bounded public HTTP boundary", () => {
  it("creates canonical UUIDv7 identifiers", () => {
    expect(uuidv7()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(uuidv7()).not.toBe(uuidv7());
  });

  it("accepts bounded JSON and rejects unknown media types", async () => {
    const request = new Request("https://status.example/v1/diagnostic-events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"ok":true}',
    });
    expect(await readJson(request, 32)).toEqual({ ok: true });
    await expect(
      readJson(new Request(request.url, { method: "POST", body: "{}" })),
    ).rejects.toMatchObject({ status: 415 });
  });

  it("enforces actual streamed size even if Content-Length is absent", async () => {
    const request = new Request("https://status.example/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ large: "a".repeat(128) }),
    });
    await expect(readJson(request, 64)).rejects.toMatchObject({ status: 413 });
  });

  it("never leaks internal exceptions", async () => {
    const request = new Request("https://status.example/?token=secret");
    const response = problemResponse(
      new Error("SQL secret-password"),
      request,
      uuidv7(),
    );
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).not.toContain("secret");
    expect(body).not.toContain("SQL");
    expect(
      problemResponse(
        new HttpError(409, "revision-conflict", "Revision conflict"),
        request,
        uuidv7(),
      ).status,
    ).toBe(409);
  });

  it("overrides producer-controlled response correlation", () => {
    const id = uuidv7();
    expect(
      withResponseHeaders(
        new Response("ok", {
          headers: { "x-moesegfault-correlation-id": "spoofed" },
        }),
        id,
      ).headers.get("x-moesegfault-correlation-id"),
    ).toBe(id);
  });
});

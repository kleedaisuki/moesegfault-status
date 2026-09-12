import { afterAll, beforeAll, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { readFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";

/** 测试最终发布模块字节，不重建组合器或使用带测试路由的 driver。 / Test final release module bytes without reconstructing a compositor or using a test-route driver. */
let runtime: Miniflare;
/** 完整迁移集合，避免用不完整假 schema 隐藏执行错误。 / The complete migration set avoids hiding execution errors behind a fake schema. */
beforeAll(async () => {
  const modules: Record<
    string,
    { type: "esm"; contents: string } | { type: "wasm"; contents: Buffer }
  > = {};
  for (const filename of await readdir("dist/rust/status", {
    recursive: true,
  })) {
    const name = filename.replaceAll("\\", "/");
    if (name.endsWith(".wasm"))
      modules[name] = {
        type: "wasm",
        contents: await readFile(`dist/rust/status/${name}`),
      };
    else if (name.endsWith(".js"))
      modules[name] = {
        type: "esm",
        contents: await readFile(`dist/rust/status/${name}`, "utf8"),
      };
  }
  expect(Object.keys(modules)).toContain("status.js");
  const manifest = { mainModule: "status.js", modules };
  runtime = new Miniflare({
    workers: [
      {
        config: {
          type: "worker",
          name: "status",
          compatibilityDate: "2026-09-12",
          manifest,
          env: {
            ENVIRONMENT: { type: "json", value: "development" },
            CURSOR_SIGNING_KEY: {
              type: "json",
              value: "runtime-cursor-secret",
            },
            DB: { type: "d1", id: "actual-status-default" },
          },
        },
      },
      {
        config: {
          type: "worker",
          name: "bootstrap",
          compatibilityDate: "2026-09-12",
          manifest,
          env: {
            BOOTSTRAP_MODE: { type: "json", value: "true" },
          },
        },
      },
    ],
  });
  const db = await runtime.getD1Database("DB", "status");
  for (const name of (await readdir("migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    const statements: string[] = JSON.parse(
      execFileSync("python", ["tests/runtime/split_sql.py"], {
        input: await readFile(`migrations/${name}`, "utf8"),
        encoding: "utf8",
        windowsHide: true,
      }),
    );
    await db.batch(statements.map((sql) => db.prepare(sql)));
  }
}, 60_000);
afterAll(async () => {
  await runtime?.dispose();
});

it("publishes only public signing keys even during bootstrap", async () => {
  const expected = JSON.parse(
    await readFile("config/machine-jwks.json", "utf8"),
  );
  for (const name of ["status", "bootstrap"]) {
    const worker = await runtime.getWorker(name);
    const response = await worker.fetch(
      "https://status.test/.well-known/jwks.json",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/jwk-set+json",
    );
    const keys = (await response.json()) as { keys: Record<string, unknown>[] };
    expect(keys).toEqual(expected);
    for (const key of keys.keys) {
      expect(key.alg).toBe("RS256");
      expect(key.use).toBe("sig");
      for (const privateField of ["d", "p", "q", "dp", "dq", "qi", "k"]) {
        expect(key).not.toHaveProperty(privateField);
      }
    }
  }
});

it("executes public Rust reads and refuses forged public correlation identities", async () => {
  const forged = "0199d0a8-2e12-7a59-a51e-000000000001";
  for (const path of [
    "/v1/status",
    "/v1/services",
    "/v1/incidents",
    "/v1/maintenance-windows",
  ]) {
    const response = await runtime.dispatchFetch(`https://status.test${path}`, {
      headers: { "x-moesegfault-correlation-id": forged },
    });
    expect(response.status, path).toBe(200);
    expect(response.headers.get("x-moesegfault-correlation-id")).not.toBe(
      forged,
    );
    expect(response.headers.get("x-moesegfault-correlation-id")).toMatch(
      /^[0-9a-f-]{36}$/,
    );
    expect(response.headers.get("content-type")).toContain("application/json");
    await response.json();
  }
});

it("has no public administrator, generic RPC, or test route", async () => {
  for (const path of [
    "/v1/admin/services",
    "/rpc/checkHealth",
    "/__test/diagnostics",
    "/health",
  ]) {
    const response = await runtime.dispatchFetch(`https://status.test${path}`);
    expect(response.status, path).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
});

it("bootstrap refuses public business before touching any missing database or secret", async () => {
  const worker = await runtime.getWorker("bootstrap");
  for (const path of [
    "/v1/status",
    "/v1/admin/services",
    "/v1/diagnostic-events",
    "/health",
  ]) {
    const response = await worker.fetch(`https://status.test${path}`);
    expect(response.status, path).toBe(503);
    const body = (await response.json()) as { correlation_id: string };
    expect(body.correlation_id).toBe(
      response.headers.get("x-moesegfault-correlation-id"),
    );
  }
});

it("deployment rejection carries one correlation identity across body and headers", async () => {
  const correlation = "0199d0a8-2e12-7a59-a51e-000000000099";
  const response = await runtime.dispatchFetch(
    "https://status.test/v1/deployments/0199d0a8-2e12-7a59-a51e-000000000001",
    {
      method: "PUT",
      headers: { "x-moesegfault-correlation-id": correlation },
    },
  );
  expect(response.status).toBeGreaterThanOrEqual(400);
  const body = (await response.json()) as { correlation_id: string };
  expect(body.correlation_id).toBe(correlation);
  expect(response.headers.get("x-moesegfault-correlation-id")).toBe(
    correlation,
  );
  expect(response.headers.get("x-correlation-id")).toBeNull();
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { readFile } from "node:fs/promises";
import { createHash, pbkdf2Sync } from "node:crypto";

/** 本地公开测试向量，不是生产凭据。 / Public local test vector, never production credentials. */
const password = "test-only password with 空白";
const salt = Buffer.alloc(16, 7);
const record = JSON.stringify({
  algorithm: "PBKDF2-SHA256",
  iterations: 600000,
  salt: salt.toString("base64url"),
  hash: pbkdf2Sync(password, salt, 600000, 32, "sha256").toString("base64url"),
});
let mf: Miniflare;
const correlation_id = "0199d0a8-2e12-7a59-a51e-000000000001";
/** 真实服务绑定，不模拟 Rust 或密码算法。 / Real service binding, no Rust or password-algorithm mock. */
async function call(
  method: string,
  fields: Record<string, unknown>,
  target = "NORMAL",
) {
  return (
    await mf.dispatchFetch(`https://test/${target}/${method}`, {
      method: "POST",
      body: JSON.stringify({ correlation_id, ...fields }),
    })
  ).json() as Promise<any>;
}
/** 清零独立测试预算，不修改生产逻辑。 / Reset isolated test budget without modifying production logic. */
async function reset() {
  const db = await mf.getD1Database("DB", "admin");
  await db
    .prepare("UPDATE administrator_login_budget SET attempts=0,window_start=0")
    .run();
}
beforeAll(async () => {
  const manifest = {
    mainModule: "main.js",
    modules: {
      "main.js": {
        type: "esm" as const,
        contents:
          "export {default as AdminRpc} from './admin.js'; export default {fetch(){return new Response('not found',{status:404})}}",
      },
      "admin.js": {
        type: "esm" as const,
        contents: await readFile(
          "crates/admin-rpc-worker/build/index.js",
          "utf8",
        ),
      },
      "index_bg.wasm": {
        type: "wasm" as const,
        contents: await readFile("crates/admin-rpc-worker/build/index_bg.wasm"),
      },
    },
  };
  const env = {
    ENVIRONMENT: { type: "json" as const, value: "development" },
    ADMIN_EMAIL: { type: "json" as const, value: "redacted@example.invalid" },
    ADMIN_PASSWORD_RECORD: { type: "json" as const, value: record },
    DB: { type: "d1" as const, id: "single-admin-test" },
  };
  mf = new Miniflare({
    workers: [
      {
        config: {
          type: "worker",
          name: "caller",
          compatibilityDate: "2026-09-12",
          manifest: {
            mainModule: "caller.js",
            modules: {
              "caller.js": {
                type: "esm",
                contents: `export default {async fetch(r,e){const [,target,method]=new URL(r.url).pathname.split('/');try{return Response.json(await e[target][method](await r.json()))}catch{return Response.json({transport:404})}}}`,
              },
            },
          },
          env: {
            NORMAL: { type: "worker", worker: "admin", exportName: "AdminRpc" },
            ROTATED: {
              type: "worker",
              worker: "rotated",
              exportName: "AdminRpc",
            },
            MISSING: {
              type: "worker",
              worker: "missing",
              exportName: "AdminRpc",
            },
            BOOTSTRAP: {
              type: "worker",
              worker: "bootstrap",
              exportName: "AdminRpc",
            },
            DEFAULT: { type: "worker", worker: "admin" },
          },
        },
      },
      ...[
        { name: "admin", env },
        {
          name: "rotated",
          env: {
            ...env,
            ADMIN_PASSWORD_RECORD: {
              type: "json" as const,
              value: record + " ",
            },
          },
        },
        {
          name: "missing",
          env: {
            ENVIRONMENT: env.ENVIRONMENT,
            ADMIN_EMAIL: env.ADMIN_EMAIL,
            DB: env.DB,
          },
        },
        {
          name: "bootstrap",
          env: {
            ...env,
            BOOTSTRAP_MODE: { type: "json" as const, value: "true" },
          },
        },
      ].map((item) => ({
        config: {
          type: "worker" as const,
          name: item.name,
          compatibilityDate: "2026-09-12",
          manifest,
          env: item.env,
        },
      })),
    ],
  });
  const db = await mf.getD1Database("DB", "admin");
  const sql = (
    await readFile("migrations/0009_single_administrator.sql", "utf8")
  ).replace(/^--.*$/gm, "");
  await db.batch(
    sql
      .split(";")
      .filter((s) => s.trim())
      .map((s) => db.prepare(s)),
  );
}, 60000);
afterAll(async () => {
  await mf?.dispose();
});
describe("Rust single-administrator native WebCrypto and D1", () => {
  it("has no setup/change capability and default has no login", async () => {
    expect(await call("initializeAdministrator", {})).toEqual({
      transport: 404,
    });
    expect(await call("changeAdministratorPassword", {})).toEqual({
      transport: 404,
    });
    expect(await call("loginAdministrator", { password }, "DEFAULT")).toEqual({
      transport: 404,
    });
  });
  it("fails closed without secret and during bootstrap", async () => {
    expect(
      (await call("loginAdministrator", { password }, "MISSING")).problem
        .status,
    ).toBe(503);
    expect(
      (await call("loginAdministrator", { password }, "BOOTSTRAP")).problem
        .status,
    ).toBe(503);
  });
  it("rejects extra fields and malformed credentials", async () => {
    expect(
      (await call("loginAdministrator", { password, role: "admin" })).problem
        .status,
    ).toBe(400);
    expect(
      (await call("loginAdministrator", { password: "short" })).problem.status,
    ).toBe(400);
    expect(
      (await call("authenticateAdministrator", { session_token: "bad" }))
        .problem.status,
    ).toBe(400);
  });
  it("matches independent Node PBKDF2 and stores only token digest", async () => {
    await reset();
    expect(
      (await call("loginAdministrator", { password: password + "wrong" }))
        .problem.status,
    ).toBe(401);
    const result = await call("loginAdministrator", { password });
    expect(result.data.session_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.data.principal).toMatchObject({
      subject: "single-admin",
      email: "redacted@example.invalid",
      roles: ["admin"],
      access_application: "single-admin-password",
    });
    const db = await mf.getD1Database("DB", "admin");
    const row = await db
      .prepare("SELECT * FROM administrator_sessions WHERE token_hash=?")
      .bind(
        createHash("sha256").update(result.data.session_token).digest("hex"),
      )
      .first();
    expect(row).not.toBeNull();
    expect(JSON.stringify(row)).not.toContain(result.data.session_token);
    expect(Number(row!.expires_at) - Number(row!.created_at)).toBe(43200000);
    expect(
      (
        await call("authenticateAdministrator", {
          session_token: result.data.session_token,
        })
      ).data.principal,
    ).toEqual(result.data.principal);
    expect(
      (
        await call(
          "authenticateAdministrator",
          { session_token: result.data.session_token },
          "ROTATED",
        )
      ).problem.status,
    ).toBe(401);
    expect(
      (
        await call("logoutAdministrator", {
          session_token: result.data.session_token,
        })
      ).data,
    ).toEqual({ ok: true });
    expect(
      (
        await call("authenticateAdministrator", {
          session_token: result.data.session_token,
        })
      ).problem.status,
    ).toBe(401);
  });
  it("expires sessions without sliding refresh", async () => {
    await reset();
    const login = await call("loginAdministrator", { password });
    const db = await mf.getD1Database("DB", "admin");
    await db
      .prepare("UPDATE administrator_sessions SET created_at=1,expires_at=2")
      .run();
    expect(
      (
        await call("authenticateAdministrator", {
          session_token: login.data.session_token,
        })
      ).problem.status,
    ).toBe(401);
  });
  it("atomically limits concurrent global attempts before KDF", async () => {
    await reset();
    const db = await mf.getD1Database("DB", "admin");
    await db
      .prepare(
        "UPDATE administrator_login_budget SET window_start=?,attempts=29",
      )
      .bind(Date.now())
      .run();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        call("loginAdministrator", { password: password + "wrong" }),
      ),
    );
    expect(results.filter((r) => r.problem.status === 401)).toHaveLength(1);
    expect(results.filter((r) => r.problem.status === 429)).toHaveLength(7);
    expect(
      (await db
        .prepare("SELECT attempts FROM administrator_login_budget")
        .first())!.attempts,
    ).toBe(30);
    await db
      .prepare("UPDATE administrator_login_budget SET window_start=0")
      .run();
    expect(
      (await call("loginAdministrator", { password })).data.session_token,
    ).toBeTruthy();
  });
});

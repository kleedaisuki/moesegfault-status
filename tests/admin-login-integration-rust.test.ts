import { afterAll, beforeAll, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash, pbkdf2Sync, randomBytes } from "node:crypto";

/** 仅内存测试凭据，不读取本机管理员密码。 / In-memory test credentials; never read the local administrator password. */
const password = randomBytes(32).toString("base64url");
const salt = randomBytes(16);
const record = JSON.stringify({
  algorithm: "PBKDF2-SHA256",
  iterations: 600000,
  salt: salt.toString("base64url"),
  hash: pbkdf2Sync(password, salt, 600000, 32, "sha256").toString("base64url"),
});
let mf: Miniflare;

/** 原样加载最终发布模块图，既不重写导出也不模拟 RPC。 / Load the final release graph unchanged, without export rewriting or RPC mocks. */
async function modules(service: string) {
  const root = `dist/rust/${service}`;
  const result: Record<
    string,
    { type: "esm"; contents: string } | { type: "wasm"; contents: Buffer }
  > = {};
  for (const name of await readdir(root, { recursive: true })) {
    const key = name.replaceAll("\\", "/");
    if (name.endsWith(".js"))
      result[key] = {
        type: "esm",
        contents: await readFile(join(root, name), "utf8"),
      };
    if (name.endsWith(".wasm"))
      result[key] = {
        type: "wasm",
        contents: await readFile(join(root, name)),
      };
  }
  return result;
}

beforeAll(async () => {
  const common = {
    ENVIRONMENT: { type: "json" as const, value: "development" },
  };
  mf = new Miniflare({
    workers: [
      {
        config: {
          type: "worker",
          name: "gateway",
          compatibilityDate: "2026-09-12",
          manifest: { mainModule: "ops.js", modules: await modules("ops") },
          env: {
            ...common,
            OPS_ORIGIN: { type: "json", value: "https://ops.example" },
            STATUS: {
              type: "worker",
              worker: "status",
              exportName: "AdminRpc",
            },
          },
        },
      },
      {
        config: {
          type: "worker",
          name: "status",
          compatibilityDate: "2026-09-12",
          manifest: {
            mainModule: "status.js",
            modules: await modules("status"),
          },
          env: {
            ...common,
            ADMIN_EMAIL: { type: "json", value: "redacted@example.invalid" },
            ADMIN_PASSWORD_RECORD: { type: "json", value: record },
            DB: { type: "d1", id: "admin-login-integration" },
          },
        },
      },
    ],
  });
  const db = await mf.getD1Database("DB", "status");
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

/** 模拟浏览器请求头；不自动伪造任何身份。 / Browser-equivalent headers without fabricated identity. */
function post(path: string, body: unknown, cookie = "") {
  return mf.dispatchFetch(`https://ops.example/api/auth/${path}`, {
    method: "POST",
    headers: {
      origin: "https://ops.example",
      "content-type": "application/json",
      "x-moesegfault-csrf": "1",
      cookie,
    },
    body: JSON.stringify(body),
  });
}

it("runs final Rust gateway → named AdminRpc → D1 login and revocation without leaking credentials", async () => {
  const forged = await mf.dispatchFetch("https://ops.example/api/session", {
    headers: { "cf-access-jwt-assertion": "forged" },
  });
  expect(forged.status).toBe(401);
  const rejected = await post("login", { password: password + "wrong" });
  expect(rejected.status).toBe(401);
  expect(rejected.headers.get("set-cookie")).toBeNull();
  expect(await rejected.text()).not.toContain(password);

  const login = await post("login", { password });
  expect(login.status).toBe(200);
  const cookie = login.headers.get("set-cookie")!;
  expect(cookie).toMatch(/^__Host-moe_session=[A-Za-z0-9_-]{43};/);
  for (const attribute of [
    "Secure",
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    "Max-Age=43200",
  ])
    expect(cookie).toContain(attribute);
  expect(cookie).not.toContain("Domain=");
  const pair = cookie.split(";")[0];
  const token = pair.slice(pair.indexOf("=") + 1);
  const body = await login.text();
  for (const secret of [password, token, record, "session_token"])
    expect(body).not.toContain(secret);
  expect(JSON.parse(body).data.principal.subject).toBe("single-admin");
  const db = await mf.getD1Database("DB", "status");
  const hash = createHash("sha256").update(token).digest("hex");
  const stored = await db
    .prepare("SELECT * FROM administrator_sessions WHERE token_hash=?")
    .bind(hash)
    .first();
  expect(stored).not.toBeNull();
  expect(JSON.stringify(stored)).not.toContain(token);
  const session = await mf.dispatchFetch("https://ops.example/api/session", {
    headers: { cookie: pair },
  });
  expect(session.status).toBe(200);
  expect(((await session.json()) as any).data.roles).toEqual(["admin"]);

  const logout = await post("logout", {}, pair);
  expect(logout.status).toBe(200);
  expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
  expect(
    await db
      .prepare(
        "SELECT token_hash FROM administrator_sessions WHERE token_hash=?",
      )
      .bind(hash)
      .first(),
  ).toBeNull();
  const replay = await mf.dispatchFetch("https://ops.example/api/session", {
    headers: { cookie: pair, "cf-access-jwt-assertion": "forged" },
  });
  expect(replay.status).toBe(401);
}, 30000);

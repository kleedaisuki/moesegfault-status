import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { Miniflare } from "miniflare";
import { build } from "esbuild";
import { readFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

const issuer = "https://runtime-fixture.cloudflareaccess.com";
const audience = "a".repeat(64);
const origin = "https://ops.moesegfault.dev";
const command = {
  command_id: "018f0000-0000-7000-8000-000000009001",
  service_name: "runtime-api",
  display_name: "Runtime API",
  description: "Actual workerd acceptance",
  owner: "runtime",
  criticality: "high",
  enabled: true,
  components: [],
  dependencies: [],
};
let mf: Miniflare;
let admin: string;
let viewer: string;
let machine: string;

/** 绑定真实生产模块与编译 Rust 字节，不替换领域核心。 / Bundle production modules and compiled Rust bytes without replacing the core. */
async function manifest(entry: string) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:*", "node:*"],
    plugins: [
      {
        name: "wasm-module",
        setup(build) {
          build.onResolve({ filter: /\.wasm$/ }, () => ({
            path: "./domain.wasm",
            external: true,
          }));
        },
      },
    ],
  });
  return {
    mainModule: "worker.mjs",
    modules: {
      "worker.mjs": {
        type: "esm" as const,
        contents: result.outputFiles[0].text,
      },
      "domain.wasm": {
        type: "wasm" as const,
        contents: await readFile(
          "packages/domain-wasm/pkg/status_domain_bg.wasm",
        ),
      },
    },
  };
}

/** 使用标准 RSA-SHA256 生成测试 JWT，不模拟认证结果。 / Sign fixture JWTs using standard RSA-SHA256, never mock authentication outcomes. */
function signedToken(key: KeyObject, claims: Record<string, unknown>): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: "runtime" }),
  ).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const input = `${header}.${payload}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), key).toString("base64url")}`;
}
/** 本地固定 JWKS 使用临时密钥，签名与 claim 验证仍在生产认证路径内。 / Ephemeral pinned JWKS preserves production signature and claim verification. */
async function setup() {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = {
    ...pair.publicKey.export({ format: "jwk" }),
    kid: "runtime",
    alg: "RS256",
    use: "sig",
  };
  const now = Math.floor(Date.now() / 1000);
  const token = (subject: string) =>
    signedToken(pair.privateKey, {
      iss: issuer,
      aud: audience,
      sub: subject,
      iat: now,
      nbf: now,
      exp: now + 600,
      email: `${subject}@example.test`,
      type: "app",
      identity_nonce: "runtime-session",
    });
  admin = token("runtime-admin");
  viewer = token("runtime-viewer");
  machine = signedToken(pair.privateKey, {
    iss: issuer,
    aud: "runtime-machine",
    sub: "runtime-ci",
    jti: "runtime-token",
    iat: now,
    exp: now + 300,
    service_name: "runtime-api",
    environment: "production",
    deployment_id: "018f0000-0000-7000-8000-000000009002",
    scope: "unrelated:scope",
  });
  const vars = {
    ENVIRONMENT: "development",
    DEPLOYMENT_ID: "",
    GIT_COMMIT: "",
    ARTIFACT_DIGEST: "",
    STATUS_VERSION: "",
    CURSOR_SIGNING_KEY: "runtime-cursor-signing-key-more-than-32-bytes",
    MACHINE_ISSUER: issuer,
    MACHINE_AUDIENCE: "runtime-machine",
    MACHINE_JWKS_URL: `${issuer}/.well-known/jwks.json`,
    ACCESS_ISSUER: issuer,
    ACCESS_AUDIENCE: audience,
    ACCESS_MAX_TOKEN_AGE_SECONDS: "3600",
    ACCESS_ROLE_MAPPING: JSON.stringify({
      "runtime-admin": ["admin"],
      "runtime-viewer": ["viewer"],
    }),
    OPS_ORIGIN: origin,
  };
  const bindings = Object.fromEntries(
    Object.entries(vars).map(([key, value]) => [
      key,
      { type: "json" as const, value },
    ]),
  );
  mf = new Miniflare({
    workers: [
      {
        config: {
          type: "worker",
          name: "gateway",
          compatibilityDate: "2026-09-12",
          manifest: await manifest("workers/ops-gateway/src/index.ts"),
          env: {
            ...bindings,
            STATUS: {
              type: "worker",
              worker: "status",
              exportName: "AdminRpc",
            },
          },
        },
        dev: { outboundService: { type: "worker", worker: "jwks" } },
      },
      {
        config: {
          type: "worker",
          name: "status",
          compatibilityDate: "2026-09-12",
          compatibilityFlags: ["nodejs_compat"],
          manifest: await manifest("workers/status/src/index.ts"),
          env: { ...bindings, DB: { type: "d1", id: "runtime-db" } },
        },
        dev: { outboundService: { type: "worker", worker: "jwks" } },
      },
      {
        config: {
          type: "worker",
          name: "jwks",
          compatibilityDate: "2026-09-12",
          manifest: {
            mainModule: "jwks.mjs",
            modules: {
              "jwks.mjs": {
                type: "esm",
                contents: `export default {fetch(r){const u=new URL(r.url);if(u.origin!==${JSON.stringify(issuer)}||!["/cdn-cgi/access/certs","/.well-known/jwks.json"].includes(u.pathname)) return new Response("Denied",{status:403});return Response.json({keys:[${JSON.stringify(jwk)}]});}}`,
              },
            },
          },
        },
      },
    ],
  });
  const db = await mf.getD1Database("DB", "status");
  for (const file of (await readdir("migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const sql = await readFile(`migrations/${file}`, "utf8");
    // D1 exec accepts complete SQL; preserve trigger bodies in one statement.
    // D1 exec 接受完整 SQL；保留触发器语句体。
    const statements = JSON.parse(
      execFileSync("python", ["tests/runtime/split_sql.py"], {
        input: sql,
        encoding: "utf8",
      }),
    );
    for (const statement of statements) await db.prepare(statement).run();
  }
}
/** 通过真正 gateway fetch 发送浏览器同源请求。 / Send same-origin browser requests through the actual gateway fetch. */
async function gateway(path: string, token?: string, body?: unknown) {
  return mf.dispatchFetch(`${origin}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      ...(token ? { "cf-access-jwt-assertion": token } : {}),
      origin,
      "content-type": "application/json",
      "x-moesegfault-csrf": "1",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

describe("production workerd + D1 + Rust + Access + named AdminRpc", () => {
  beforeAll(setup, 60000);
  afterAll(async () => {
    await mf?.dispose();
  });
  it("keeps empty platform unknown, evidence private and validates actual machine JWT", async () => {
    const status = await mf.getWorker("status");
    const response = await status.fetch(
      "https://status.moesegfault.dev/v1/status",
    );
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.data.status).toBe("unknown");
    for (const path of [
      "/admin/login",
      "/api/health",
      "/v1/issues",
      "/v1/evidence",
    ]) {
      expect(
        (await status.fetch(`https://status.moesegfault.dev${path}`)).status,
      ).toBe(404);
    }
    expect(
      (
        await status.fetch(
          "https://status.moesegfault.dev/v1/diagnostic-events",
          { method: "POST" },
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await status.fetch(
          "https://status.moesegfault.dev/v1/diagnostic-events",
          { method: "POST", headers: { authorization: `Bearer ${machine}` } },
        )
      ).status,
    ).toBe(403);
  });
  it("rejects anonymous and viewer mutations before writes", async () => {
    expect((await gateway("/api/health")).status).toBe(401);
    expect((await gateway("/api/services", viewer, command)).status).toBe(403);
  });
  it("registers a service through signed Access and real named RPC", async () => {
    const response = await gateway("/api/services", admin, command);
    const body = await response.json();
    expect(body).toBeDefined();
    expect(response.status, JSON.stringify(body)).toBe(201);
    const db = await mf.getD1Database("DB", "status");
    expect(
      await db
        .prepare("SELECT service_name FROM services WHERE service_name=?")
        .bind(command.service_name)
        .first("service_name"),
    ).toBe(command.service_name);
  });
  it("bootstraps retention through gateway and publishes maintenance projection", async () => {
    const retention = await gateway(
      "/api/retention-policy-assignments",
      admin,
      {
        command_id: "018f0000-0000-7000-8000-000000009003",
        service_name: command.service_name,
        policy: {
          policy_id: "runtime-retention",
          revision: 1,
          occurrence_retention_days: 30,
          cleanup_batch_size: 100,
        },
        expected_assignment_revision: null,
      },
    );
    expect(retention.status, await retention.text()).toBe(200);
    const response = await gateway("/api/maintenance-windows", admin, {
      command_id: "018f0000-0000-7000-8000-000000009004",
      title: "Runtime maintenance",
      description: "Public maintenance notice",
      starts_at: new Date(Date.now() - 60000).toISOString(),
      ends_at: new Date(Date.now() + 3600000).toISOString(),
      expected_impact: "degraded",
      target_services: [command.service_name],
      target_components: [],
    });
    expect(response.status, await response.text()).toBe(201);
    const status = await mf.getWorker("status");
    const read = await status.fetch(
      `https://status.moesegfault.dev/v1/services/${command.service_name}`,
    );
    const body = await read.json();
    expect(read.status, JSON.stringify(body)).toBe(200);
    expect(body.data.direct_status, JSON.stringify(body)).toBe("maintenance");
    expect(JSON.stringify(body)).not.toContain("runtime-admin");
  });
});

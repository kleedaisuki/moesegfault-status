import { beforeAll, afterAll, it, expect } from "vitest";
import { Miniflare } from "miniflare";
import { readFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";

/** 真实Rust业务、D1和R2；仅JWKS服务作为本地信任源。 / Real Rust business/D1/R2; only JWKS is locally hosted. */
let mf: Miniflare;
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const issuer = "https://artifact-test.example";
const deployment = "0199d0a8-2e12-7a59-a51e-000000000001";
const runtime = Buffer.from(
  "export default {};\n//# sourceMappingURL=index.js.map\n",
);
const map = Buffer.from(
  JSON.stringify({
    version: 3,
    sources: ["src/index.ts"],
    mappings: "",
    file: "index.js",
  }),
);
/** Node独立计算内容摘要。 / Independently compute content digests with Node. */
const digest = (bytes: Buffer) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
/** 每个测试请求签发真实JWT。 / Issue a real JWT for each test request. */
function token(changes: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const input = [
    { alg: "RS256", kid: "test" },
    {
      iss: issuer,
      aud: "status-artifacts",
      sub: "release-ci",
      iat: now,
      exp: now + 300,
      jti: "test-token",
      service_name: "status-api",
      environment: "production",
      deployment_id: deployment,
      scope: "deployments:write artifacts:write",
      ...changes,
    },
  ]
    .map((v) => Buffer.from(JSON.stringify(v)).toString("base64url"))
    .join(".");
  return `${input}.${sign("sha256", Buffer.from(input), pair.privateKey).toString("base64url")}`;
}
/** 构造实际wire artifact。 / Construct an actual wire artifact. */
function artifact(
  bytes: Buffer,
  kind: string,
  file_name: string,
  media_type: string,
) {
  return {
    kind,
    file_name,
    media_type,
    size_bytes: bytes.length,
    artifact_digest: digest(bytes),
    build_id: null,
  };
}
const entry = artifact(runtime, "other", "index.js", "application/javascript");
const sourceMap = artifact(
  map,
  "source_map",
  "index.js.map",
  "application/json",
);
const manifest = {
  deployment_id: deployment,
  service_name: "status-api",
  environment: "production",
  service_version: "1",
  repository_url: "https://github.com/example/status",
  git_commit: "a".repeat(40),
  git_ref: "refs/heads/main",
  artifact_digest: entry.artifact_digest,
  ci_provider: "github",
  ci_run_id: "1",
  deployed_at: "2026-09-12T00:00:00.000Z",
  region: ["global"],
  artifacts: [entry, sourceMap],
};
/** 只调用实际HTTP接口。 / Call the actual HTTP API only. */
async function request(
  suffix: string,
  method: string,
  body: unknown,
  claims: Record<string, unknown> = {},
  key = "stable-key",
) {
  return mf.dispatchFetch(
    `https://status.test/v1/deployments/${deployment}${suffix}`,
    {
      method,
      headers: {
        authorization: `Bearer ${token(claims)}`,
        "content-type": "application/json",
        "idempotency-key": key,
      },
      body: JSON.stringify(body),
    },
  );
}
/** 从真实D1读取生命周期。 / Read lifecycle from real D1. */
async function state() {
  const db = await mf.getD1Database("DB", "rust");
  return db
    .prepare(
      "SELECT state FROM deployment_current_status WHERE deployment_id=?",
    )
    .bind(deployment)
    .first("state");
}
beforeAll(async () => {
  mf = new Miniflare({
    workers: [
      {
        config: {
          type: "worker",
          name: "rust",
          compatibilityDate: "2026-09-12",
          manifest: {
            mainModule: "index.js",
            modules: {
              "index.js": {
                type: "esm",
                contents: await readFile(
                  "tests/rust-runtime/build/index.js",
                  "utf8",
                ),
              },
              "index_bg.wasm": {
                type: "wasm",
                contents: await readFile(
                  "tests/rust-runtime/build/index_bg.wasm",
                ),
              },
            },
          },
          env: {
            DB: { type: "d1", id: "rust-artifacts" },
            ARTIFACTS: { type: "r2", name: "rust-artifacts" },
            ...Object.fromEntries(
              Object.entries({
                MACHINE_ISSUER: issuer,
                MACHINE_AUDIENCE: "status-artifacts",
                MACHINE_JWKS_URL: `${issuer}/jwks`,
                R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
                R2_BUCKET_NAME: "rust-artifacts",
                R2_ACCESS_KEY_ID: "test-access",
                R2_SECRET_ACCESS_KEY: "test-secret",
              }).map(([k, value]) => [k, { type: "json", value }]),
            ),
          },
        },
        dev: { outboundService: { type: "worker", worker: "jwks" } },
      },
      {
        config: {
          type: "worker",
          name: "jwks",
          compatibilityDate: "2026-09-12",
          manifest: {
            mainModule: "jwks.js",
            modules: {
              "jwks.js": {
                type: "esm",
                contents: `export default {fetch(){return Response.json({keys:[${JSON.stringify({ ...pair.publicKey.export({ format: "jwk" }), alg: "RS256", kid: "test", use: "sig" })}]})}}`,
              },
            },
          },
        },
      },
    ],
  });
  const db = await mf.getD1Database("DB", "rust");
  for (const name of (await readdir("migrations"))
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    const statements: string[] = JSON.parse(
      execFileSync("python", ["tests/runtime/split_sql.py"], {
        input: await readFile(`migrations/${name}`, "utf8"),
        encoding: "utf8",
        windowsHide: true,
      }),
    );
    for (const sql of statements) await db.prepare(sql).run();
  }
  await db
    .prepare(
      "INSERT INTO services(service_name,display_name,owner,criticality,created_at,updated_at) VALUES('status-api','Status','platform','high',?,?)",
    )
    .bind("2026-09-12T00:00:00.000Z", "2026-09-12T00:00:00.000Z")
    .run();
}, 60_000);
afterAll(async () => {
  await mf?.dispose();
});

it("rejects missing authentication and wrong machine claims", async () => {
  const unauthenticated = await mf.dispatchFetch(
    `https://status.test/v1/deployments/${deployment}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(manifest),
    },
  );
  expect(unauthenticated.status).toBe(401);
  expect(
    (await request("", "PUT", manifest, { environment: "staging" })).status,
  ).toBe(403);
});
it("registers immutable R2 manifest without falsely becoming ready", async () => {
  const response = await request("", "PUT", manifest);
  expect(response.status, await response.clone().text()).toBe(201);
  const envelope: any = await response.clone().json();
  const correlation = response.headers.get("x-moesegfault-correlation-id");
  expect(correlation).toBe(envelope.meta.correlation_id);
  expect(response.headers.has("x-correlation-id")).toBe(false);
  const database = await mf.getD1Database("DB", "rust");
  expect(
    await database
      .prepare(
        "SELECT correlation_id FROM audit_log WHERE action='deployment.registered' AND target_id=?",
      )
      .bind(deployment)
      .first("correlation_id"),
  ).toBe(correlation);
  expect(await state()).toBe("artifacts_pending");
  expect((await request("", "PUT", manifest)).status).toBe(200);
  expect(
    (await request("", "PUT", { ...manifest, git_ref: "other" })).status,
  ).toBe(409);
  const bucket = await mf.getR2Bucket("ARTIFACTS", "rust");
  const object = await bucket.get(`observability/manifests/${deployment}.json`);
  expect(JSON.parse(await object!.text()).deployment_id).toBe(deployment);
});
it("verifies real R2 bytes, all requirements, and idempotent ready reconciliation", async () => {
  const bucket = await mf.getR2Bucket("ARTIFACTS", "rust");
  for (const [index, [a, bytes]] of (
    [
      [entry, runtime],
      [sourceMap, map],
    ] as const
  ).entries()) {
    const input = {
      ...a,
      content_md5: createHash("md5").update(bytes).digest("base64"),
    };
    const response = await request(
      "/artifact-uploads",
      "POST",
      input,
      {},
      `stable-key-${index}`,
    );
    expect(response.status, await response.clone().text()).toBe(201);
    const session: any = ((await response.json()) as any).data;
    const replay: any = await (
      await request(
        "/artifact-uploads",
        "POST",
        input,
        {},
        `stable-key-${index}`,
      )
    ).json();
    expect(replay.data.upload_id).toBe(session.upload_id);
    expect(session.required_headers["if-none-match"]).toBe("*");
    const url = new URL(session.upload_url);
    const key = url.pathname
      .split("/")
      .slice(2)
      .map(decodeURIComponent)
      .join("/");
    const metadata = Object.fromEntries(
      Object.entries(session.required_headers as Record<string, string>)
        .filter(([k]) => k.startsWith("x-amz-meta-"))
        .map(([k, v]) => [k.slice(11), v]),
    );
    const commit = { ...a, upload_id: session.upload_id };
    expect((await request("/artifacts", "POST", commit)).status).toBe(422);
    if (index === 0) {
      await bucket.put(key, Buffer.alloc(bytes.length, 120), {
        httpMetadata: { contentType: a.media_type },
        customMetadata: metadata,
      });
      expect((await request("/artifacts", "POST", commit)).status).toBe(422);
    }
    await bucket.put(key, bytes, {
      httpMetadata: { contentType: a.media_type },
      customMetadata: metadata,
    });
    const committed = await request("/artifacts", "POST", commit);
    expect(committed.status, await committed.clone().text()).toBe(201);
    expect((await request("/artifacts", "POST", commit)).status).toBe(200);
    expect(await state()).toBe(index === 0 ? "artifacts_pending" : "ready");
  }
  const registration: any = await (await request("", "PUT", manifest)).json();
  expect(registration.data.state).toBe("ready");
  const db = await mf.getD1Database("DB", "rust");
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action='deployment.ready'",
      )
      .first("n"),
  ).toBe(1);
});

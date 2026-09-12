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
    expect(
      (
        await request(
          "/artifact-uploads",
          "POST",
          input,
          { sub: "other-release" },
          `stable-key-${index}`,
        )
      ).status,
    ).toBe(403);
    expect(session.required_headers["if-none-match"]).toBe("*");
    const url = new URL(session.upload_url);
    expect(url.origin).toBe("https://status.test");
    expect(url.pathname).toBe(
      `/v1/deployments/${deployment}/artifact-uploads/${session.upload_id}`,
    );
    expect(Object.keys(session.required_headers).sort()).toEqual([
      "content-length",
      "content-md5",
      "content-type",
      "if-none-match",
    ]);
    const put = (
      data: Buffer,
      claims: Record<string, unknown> = {},
      headers: Record<string, string> = {},
    ) =>
      mf.dispatchFetch(url, {
        method: "PUT",
        headers: {
          ...session.required_headers,
          authorization: `Bearer ${token(claims)}`,
          ...headers,
        },
        body: data,
      });
    const commit = { ...a, upload_id: session.upload_id };
    expect((await request("/artifacts", "POST", commit)).status).toBe(422);
    expect((await put(bytes, { sub: "other-release" })).status).toBe(403);
    expect((await put(bytes, { scope: "deployments:write" })).status).toBe(403);
    expect((await put(bytes, {}, { authorization: "" })).status).toBe(401);
    expect(
      (await put(bytes, {}, { "content-type": "text/plain" })).status,
    ).toBe(422);
    expect((await put(bytes, {}, { "if-none-match": "other" })).status).toBe(
      422,
    );
    expect(
      (await put(bytes, {}, { "content-md5": "AAAAAAAAAAAAAAAAAAAAAA==" }))
        .status,
    ).toBe(422);
    expect(
      (
        await put(
          bytes.subarray(1),
          {},
          { "content-length": String(bytes.length - 1) },
        )
      ).status,
    ).toBe(422);
    expect((await put(Buffer.alloc(bytes.length, 120))).status).toBe(422);
    expect((await request("/artifacts", "POST", commit)).status).toBe(422);
    const uploaded = await Promise.all([put(bytes), put(bytes)]);
    expect(uploaded.map((r) => r.status).sort()).toEqual([201, 412]);
    expect((await put(bytes)).status).toBe(412);
    expect(
      (await request("/artifacts", "POST", commit, { sub: "other-release" }))
        .status,
    ).toBe(403);
    if (index === 0) {
      // 模拟具有独立存储权限者篡改；commit 仍必须验证实际字节。
      // Simulate an independently authorized storage writer; commit must still prove bytes.
      const db = await mf.getD1Database("DB", "rust");
      const key = await db
        .prepare(
          "SELECT object_key FROM artifact_upload_sessions WHERE upload_id=?",
        )
        .bind(session.upload_id)
        .first<string>("object_key");
      const bucket = await mf.getR2Bucket("ARTIFACTS", "rust");
      const original = await bucket.get(key!);
      const metadata = {
        httpMetadata: original!.httpMetadata,
        customMetadata: original!.customMetadata,
      };
      await bucket.put(key!, Buffer.alloc(bytes.length, 120), metadata);
      expect((await request("/artifacts", "POST", commit)).status).toBe(422);
      await bucket.put(key!, bytes, metadata);
    }
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

it("rejects expired sessions, wrong deployment scope and retired deployment uploads", async () => {
  const db = await mf.getD1Database("DB", "rust");
  const session: any = await db
    .prepare(
      "SELECT * FROM artifact_upload_sessions WHERE deployment_id=? ORDER BY created_at LIMIT 1",
    )
    .bind(deployment)
    .first();
  const expiredId = "0199d0a8-2e12-7a59-a51e-000000000099";
  await db
    .prepare(
      "INSERT INTO artifact_upload_sessions(upload_id,deployment_id,idempotency_key,request_digest,object_key,kind,file_name,media_type,size_bytes,artifact_digest,content_md5,build_id,expires_at,created_at,created_by) SELECT ?,deployment_id,'expired-key',request_digest,object_key,kind,file_name,media_type,size_bytes,artifact_digest,content_md5,build_id,'2026-01-01T00:10:00.000Z','2026-01-01T00:00:00.000Z',created_by FROM artifact_upload_sessions WHERE upload_id=?",
    )
    .bind(expiredId, session.upload_id)
    .run();
  const put = (uploadId: string, claims: Record<string, unknown> = {}) =>
    mf.dispatchFetch(
      `https://status.test/v1/deployments/${deployment}/artifact-uploads/${uploadId}`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${token(claims)}`,
          "content-type": session.media_type,
          "content-length": String(runtime.length),
          "content-md5": session.content_md5,
          "if-none-match": "*",
        },
        body: runtime,
      },
    );
  expect((await put(expiredId)).status).toBe(410);
  expect(
    (await put(session.upload_id, { deployment_id: expiredId })).status,
  ).toBe(403);
  await db
    .prepare(
      "INSERT INTO deployment_status_history(deployment_id,sequence,state,reason,actor_subject,correlation_id,occurred_at) SELECT deployment_id,revision+1,'retired','test retirement','test-admin',?,'2026-09-12T23:00:00.000Z' FROM deployment_current_status WHERE deployment_id=?",
    )
    .bind(expiredId, deployment)
    .run();
  expect((await put(session.upload_id)).status).toBe(409);
});

it("rejects artifacts above the 64 MiB transport bound before registration", async () => {
  expect(
    (
      await request("", "PUT", {
        ...manifest,
        artifacts: [{ ...entry, size_bytes: 64 * 1024 * 1024 + 1 }, sourceMap],
      })
    ).status,
  ).toBe(422);
});

it("streams and independently commits a 46 MiB artifact through native R2 and DigestStream", async () => {
  const largeId = "0199d0a8-2e12-7a59-a51e-000000000100";
  const bytes = Buffer.alloc(46 * 1024 * 1024, 0x5a);
  const a = artifact(bytes, "other", "large.blob", "application/octet-stream");
  const endpoint = `https://status.test/v1/deployments/${largeId}`;
  const authorization = `Bearer ${token({ deployment_id: largeId })}`;
  const jsonRequest = (suffix: string, method: string, body: unknown) =>
    mf.dispatchFetch(`${endpoint}${suffix}`, {
      method,
      headers: {
        authorization,
        "content-type": "application/json",
        "idempotency-key": "large-upload-key",
      },
      body: JSON.stringify(body),
    });
  const registered = await jsonRequest("", "PUT", {
    ...manifest,
    deployment_id: largeId,
    artifact_digest: a.artifact_digest,
    artifacts: [a],
  });
  expect(registered.status, await registered.clone().text()).toBe(201);
  const session: any = (
    await (
      await jsonRequest("/artifact-uploads", "POST", {
        ...a,
        content_md5: createHash("md5").update(bytes).digest("base64"),
      })
    ).json()
  ).data;
  const uploaded = await mf.dispatchFetch(session.upload_url, {
    method: "PUT",
    headers: { ...session.required_headers, authorization },
    body: bytes,
  });
  expect(uploaded.status, await uploaded.clone().text()).toBe(201);
  const committed = await jsonRequest("/artifacts", "POST", {
    ...a,
    upload_id: session.upload_id,
  });
  expect(committed.status, await committed.clone().text()).toBe(201);
  const db = await mf.getD1Database("DB", "rust");
  expect(
    await db
      .prepare(
        "SELECT state FROM deployment_current_status WHERE deployment_id=?",
      )
      .bind(largeId)
      .first("state"),
  ).toBe("ready");
}, 60_000);

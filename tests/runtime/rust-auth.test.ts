import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { readFile } from "node:fs/promises";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

const issuer = "https://rust-runtime.cloudflareaccess.com";
const audience = "a".repeat(64);
let mf: Miniflare;
const privateKeys = new Map<string, KeyObject>();

/** 用独立 Node 密码学实现生成真实签名。 / Produce real signatures using independent Node cryptography. */
function token(
  changes: Record<string, unknown> = {},
  access = false,
  alg = "RS256",
  kid = alg,
) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: issuer,
    aud: audience,
    sub: access ? "runtime-human" : "runtime-ci",
    iat: now,
    exp: now + 300,
    jti: "runtime-id",
    service_name: "identity",
    environment: "production",
    deployment_id: "0199d0a8-2e12-7a59-a51e-000000000001",
    scope: "diagnostics:write",
    nbf: now,
    email: "human@example.com",
    type: "app",
    identity_nonce: "nonce",
    ...changes,
  };
  const input = [{ alg, kid }, claims]
    .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
    .join(".");
  return `${input}.${sign(alg === "EdDSA" ? null : "sha256", Buffer.from(input), { key: privateKeys.get(alg)!, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

beforeAll(async () => {
  const jwks = ["RS256", "ES256", "EdDSA"].map((alg) => {
    const pair =
      alg === "RS256"
        ? generateKeyPairSync("rsa", { modulusLength: 2048 })
        : alg === "ES256"
          ? generateKeyPairSync("ec", { namedCurve: "P-256" })
          : generateKeyPairSync("ed25519");
    privateKeys.set(alg, pair.privateKey);
    return {
      ...pair.publicKey.export({ format: "jwk" }),
      kid: alg,
      alg,
      use: "sig",
    };
  });
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
            ISSUER: { type: "json", value: issuer },
            AUDIENCE: { type: "json", value: audience },
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
            mainModule: "jwks.mjs",
            modules: {
              "jwks.mjs": {
                type: "esm",
                contents: `let count=0; export default {fetch(r){const u=new URL(r.url);if(u.pathname==='/count')return Response.json({count});if(u.origin!==${JSON.stringify(issuer)}||!['/jwks','/cdn-cgi/access/certs'].includes(u.pathname))return new Response('denied',{status:403});count++;return Response.json({keys:${JSON.stringify(jwks)}});}}`,
              },
            },
          },
        },
      },
    ],
  });
});
afterAll(async () => {
  await mf?.dispose();
});

describe("Rust authentication in actual workerd", () => {
  it("fetches pinned keys and reuses cache for machine requests", async () => {
    for (const alg of ["RS256", "ES256", "EdDSA", "RS256"]) {
      const response = await mf.dispatchFetch(
        "https://status.example/machine",
        { headers: { authorization: `Bearer ${token({}, false, alg)}` } },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ subject: "runtime-ci" });
    }
    const keyWorker = await mf.getWorker("jwks");
    expect(await (await keyWorker.fetch(`${issuer}/count`)).json()).toEqual({
      count: 1,
    });
  });
  it("does not refetch for an attacker-controlled unknown kid during cooldown", async () => {
    const response = await mf.dispatchFetch("https://status.example/machine", {
      headers: {
        authorization: `Bearer ${token({}, false, "RS256", "unknown")}`,
      },
    });
    expect(response.status).toBe(401);
    const keyWorker = await mf.getWorker("jwks");
    expect(await (await keyWorker.fetch(`${issuer}/count`)).json()).toEqual({
      count: 1,
    });
  });
  it("rejects bad audience, expired tokens, missing tokens, and missing scopes", async () => {
    for (const [changes, expected] of [
      [{ aud: "other" }, 401],
      [{ exp: 1 }, 401],
      [{ scope: "other:scope" }, 403],
    ] as const) {
      const response = await mf.dispatchFetch(
        "https://status.example/machine",
        { headers: { authorization: `Bearer ${token(changes)}` } },
      );
      expect(response.status).toBe(expected);
    }
    expect(
      (await mf.dispatchFetch("https://status.example/machine")).status,
    ).toBe(401);
  });
  it("verifies Access and maps roles from trusted configuration", async () => {
    const response = await mf.dispatchFetch("https://status.example/access", {
      headers: { "cf-access-jwt-assertion": token({}, true) },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      subject: "runtime-human",
      roles: ["operator"],
      access_application: audience,
    });
  });
  it("reads bounded JSON through the Rust SDK stream", async () => {
    const options = {
      method: "POST",
      headers: { "content-type": "application/json" },
    };
    expect(
      (
        await mf.dispatchFetch("https://status.example/json", {
          ...options,
          body: '{"x":1}',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await mf.dispatchFetch("https://status.example/json", {
          ...options,
          body: JSON.stringify({ x: "x".repeat(17) }),
        })
      ).status,
    ).toBe(413);
  });
});

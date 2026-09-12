import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import {
  authenticateMachine,
  identityFromClaims,
  requireScope,
} from "./auth.js";
import { uuidv7 } from "./http.js";

/** 构造短期绑定 claim，不使用真实秘密。 / Build short-lived bound claims without real secrets. */
function claims() {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: "ci",
    jti: uuidv7(),
    iat: now,
    exp: now + 300,
    service_name: "identity",
    environment: "production",
    deployment_id: uuidv7(),
    scope: "diagnostics:write",
  };
}

describe("machine trust domain", () => {
  it("reuses the pinned JWKS resolver across requests", async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const jwk = await exportJWK(publicKey);
    const config = {
      MACHINE_ISSUER: "https://cache-test.example",
      MACHINE_AUDIENCE: "status",
      MACHINE_JWKS_URL: "https://cache-test.example/jwks",
    };
    const token = await new SignJWT(claims())
      .setProtectedHeader({ alg: "ES256", kid: "cached" })
      .setIssuer(config.MACHINE_ISSUER)
      .setAudience("status")
      .sign(privateKey);
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        Response.json({ keys: [{ ...jwk, alg: "ES256", kid: "cached" }] }),
      );
    try {
      for (let index = 0; index < 2; index++) {
        await authenticateMachine(
          new Request("https://status.example/", {
            headers: { authorization: `Bearer ${token}` },
          }),
          config,
        );
      }
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      fetcher.mockRestore();
    }
  });
  it("requires service, environment and deployment binding", () => {
    const payload = claims();
    const identity = identityFromClaims(payload);
    expect(identity.serviceNames.has("identity")).toBe(true);
    expect(identity.deploymentIds.has(payload.deployment_id)).toBe(true);
    expect(() =>
      identityFromClaims({ ...payload, deployment_id: "unbound" }),
    ).toThrow();
    expect(() =>
      identityFromClaims({ ...payload, environment: "other" }),
    ).toThrow();
    expect(() => requireScope(identity, "deployments:write")).toThrow();
  });

  it("rejects long-lived or future-issued credentials", () => {
    const payload = claims();
    expect(() =>
      identityFromClaims({ ...payload, exp: payload.iat + 901 }),
    ).toThrow();
    expect(() =>
      identityFromClaims({
        ...payload,
        iat: payload.iat + 100,
        exp: payload.exp + 100,
      }),
    ).toThrow();
  });

  it("cryptographically verifies issuer, audience and signature", async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const jwk = await exportJWK(publicKey);
    const key = createLocalJWKSet({
      keys: [{ ...jwk, alg: "ES256", kid: "test" }],
    });
    const config = {
      MACHINE_ISSUER: "https://issuer.example",
      MACHINE_AUDIENCE: "status",
      MACHINE_JWKS_URL: "https://issuer.example/jwks",
    };
    const token = await new SignJWT(claims())
      .setProtectedHeader({ alg: "ES256", kid: "test" })
      .setIssuer(config.MACHINE_ISSUER)
      .setAudience("status")
      .sign(privateKey);
    const request = new Request("https://status.example/", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect((await authenticateMachine(request, config, key)).subject).toBe(
      "ci",
    );
    await expect(
      authenticateMachine(
        request,
        { ...config, MACHINE_AUDIENCE: "wrong" },
        key,
      ),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      authenticateMachine(new Request(request.url), config, key),
    ).rejects.toMatchObject({ status: 401 });
  });
});

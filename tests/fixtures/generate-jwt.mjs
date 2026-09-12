/** 生成公开测试向量；私钥仅存在内存。 / Generate public test vectors; private keys exist only in memory. */
import { generateKeyPairSync, sign } from "node:crypto";
import { writeFileSync } from "node:fs";

/** 使用固定历史时间，向量不能作为实际部署凭据。 / Fixed historical time makes vectors unusable as deployment credentials. */
const claims = {
  iss: "https://issuer.example",
  aud: "status",
  sub: "ci",
  jti: "test-token",
  iat: 1700000000,
  exp: 1700000300,
  service_name: "identity",
  environment: "production",
  deployment_id: "0199d0a8-2e12-7a59-a51e-000000000001",
  scope: "diagnostics:write deployments:write",
};
const vectors = [];
for (const alg of ["RS256", "ES256", "EdDSA"]) {
  const pair =
    alg === "RS256"
      ? generateKeyPairSync("rsa", { modulusLength: 2048 })
      : alg === "ES256"
        ? generateKeyPairSync("ec", { namedCurve: "P-256" })
        : generateKeyPairSync("ed25519");
  const jwk = {
    ...pair.publicKey.export({ format: "jwk" }),
    alg,
    kid: alg,
    use: "sig",
  };
  /** 签名真实 JWT，而非测试中绕过密码学验证。 / Sign real JWTs instead of bypassing cryptography in tests. */
  const token = (payload, extra = {}) => {
    const body = [{ alg, kid: alg, ...extra }, payload]
      .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
      .join(".");
    const signature = sign(
      alg === "EdDSA" ? null : "sha256",
      Buffer.from(body),
      {
        key: pair.privateKey,
        dsaEncoding: "ieee-p1363",
      },
    );
    return `${body}.${signature.toString("base64url")}`;
  };
  vectors.push({
    alg,
    jwk,
    tokens: {
      valid: token(claims),
      bad_issuer: token({ ...claims, iss: "https://attacker.example" }),
      bad_audience: token({ ...claims, aud: "other" }),
      long_lived: token({ ...claims, exp: claims.iat + 901 }),
      future: token({
        ...claims,
        iat: claims.iat + 100,
        exp: claims.exp + 100,
      }),
      not_before: token({ ...claims, nbf: claims.iat + 100 }),
      bad_scope: token({ ...claims, scope: "*" }),
      bad_deployment: token({ ...claims, deployment_id: "unbound" }),
      missing_subject: token({ ...claims, sub: undefined }),
      critical: token(claims, { crit: ["unknown"], unknown: true }),
      remote_url: token(claims, { jku: "https://attacker.example/jwks" }),
      access: token({
        iss: "https://team.cloudflareaccess.com",
        aud: "a".repeat(64),
        sub: "human-1",
        email: "user@example.com",
        type: "app",
        identity_nonce: "nonce",
        iat: claims.iat,
        nbf: claims.iat,
        exp: claims.exp,
      }),
    },
  });
}
writeFileSync(
  new URL("./jwt-vectors.json", import.meta.url),
  JSON.stringify(vectors, null, 2) + "\n",
);

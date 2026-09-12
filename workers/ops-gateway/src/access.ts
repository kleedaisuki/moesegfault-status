import {
  AdminPrincipalSchema,
  type AdminPrincipal,
} from "@moesegfault/contracts";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

/** 角色只能来自受控 subject 映射 / Roles can only originate from the controlled subject mapping. */
export type AdminRole = "viewer" | "operator" | "admin";

/**
 * 实现文档中的角色包含关系：`admin` ⊇ `operator` ⊇ `viewer`。
 * Implements the documented role inclusion: `admin` ⊇ `operator` ⊇ `viewer`.
 */
export function hasRequiredRole(
  roles: readonly AdminRole[],
  required: AdminRole,
): boolean {
  const rank = { viewer: 0, operator: 1, admin: 2 } as const;
  return roles.some((role) => rank[role] >= rank[required]);
}

/** 已校验的 Access 配置 / Validated Access configuration. */
export interface AccessConfig {
  readonly issuer: string;
  readonly audience: string;
  readonly maxTokenAgeSeconds: number;
  readonly rolesBySubject: ReadonlyMap<string, readonly AdminRole[]>;
}

let cachedKeySet:
  | {
      readonly issuer: string;
      readonly keySet: ReturnType<typeof createRemoteJWKSet>;
    }
  | undefined;

/**
 * 解析并严格验证部署提供的 Access 配置。
 * Parses and strictly validates deployment-provided Access configuration.
 */
export function parseAccessConfig(input: {
  readonly issuer: string;
  readonly audience: string;
  readonly maxTokenAgeSeconds: string;
  readonly roleMapping: string;
}): AccessConfig {
  let issuer: URL;
  try {
    issuer = new URL(input.issuer);
  } catch {
    throw new Error("ACCESS_ISSUER must be an absolute URL");
  }
  if (
    issuer.protocol !== "https:" ||
    issuer.origin !== input.issuer ||
    !issuer.hostname.endsWith(".cloudflareaccess.com")
  ) {
    throw new Error(
      "ACCESS_ISSUER must be an exact Cloudflare Access team origin",
    );
  }
  if (!/^[0-9a-f]{64}$/i.test(input.audience)) {
    throw new Error("ACCESS_AUDIENCE must be one Access application AUD tag");
  }
  const maxTokenAgeSeconds = Number(input.maxTokenAgeSeconds);
  if (
    !Number.isInteger(maxTokenAgeSeconds) ||
    maxTokenAgeSeconds < 60 ||
    maxTokenAgeSeconds > 2_592_000
  ) {
    throw new Error(
      "ACCESS_MAX_TOKEN_AGE_SECONDS must be between 60 and 2592000",
    );
  }

  return {
    issuer: issuer.origin,
    audience: input.audience,
    maxTokenAgeSeconds,
    rolesBySubject: parseRoleMapping(input.roleMapping),
  };
}

/**
 * 解析 subject 到角色的显式映射；不支持通配符、邮箱或请求头回退。
 * Parses the explicit subject-to-role map; wildcards, emails, and header fallbacks are unsupported.
 */
export function parseRoleMapping(
  serialized: string,
): ReadonlyMap<string, readonly AdminRole[]> {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    throw new Error("ACCESS_ROLE_MAPPING must be valid JSON");
  }
  if (!isRecord(value) || Object.keys(value).length > 256) {
    throw new Error(
      "ACCESS_ROLE_MAPPING must be an object with at most 256 subjects",
    );
  }

  const result = new Map<string, readonly AdminRole[]>();
  for (const [subject, rawRoles] of Object.entries(value)) {
    if (
      !isSubject(subject) ||
      !Array.isArray(rawRoles) ||
      rawRoles.length === 0 ||
      rawRoles.length > 3
    ) {
      throw new Error(
        "ACCESS_ROLE_MAPPING contains an invalid subject or role list",
      );
    }
    const roles = rawRoles.filter(isAdminRole);
    if (
      roles.length !== rawRoles.length ||
      new Set(roles).size !== roles.length
    ) {
      throw new Error(
        "ACCESS_ROLE_MAPPING contains an unknown or duplicate role",
      );
    }
    result.set(subject, Object.freeze([...roles]));
  }
  return result;
}

/**
 * 验证 Cloudflare Access assertion 并产生最小化管理主体。
 * Verifies a Cloudflare Access assertion and produces a minimal administrative principal.
 */
export async function verifyAccessJwt(
  token: string,
  config: AccessConfig,
  now = new Date(),
): Promise<AdminPrincipal> {
  const keySet = remoteKeySet(config.issuer);
  const { payload } = await jwtVerify(token, keySet, {
    algorithms: ["RS256"],
    audience: config.audience,
    issuer: config.issuer,
    requiredClaims: [
      "aud",
      "email",
      "exp",
      "iat",
      "identity_nonce",
      "iss",
      "nbf",
      "sub",
      "type",
    ],
  });
  const principal = normalizeAccessClaims(
    payload,
    config,
    Math.floor(now.getTime() / 1000),
  );
  return AdminPrincipalSchema.parse(principal);
}

/**
 * 校验身份/会话 claims，并仅按稳定 `sub` 查找本地角色。
 * Validates identity/session claims and resolves local roles only by stable `sub`.
 */
export function normalizeAccessClaims(
  payload: JWTPayload,
  config: AccessConfig,
  nowSeconds: number,
): AdminPrincipal {
  const subject = payload.sub;
  const email = payload.email;
  const issuedAt = payload.iat;
  const expiresAt = payload.exp;
  const notBefore = payload.nbf;
  const identityNonce = payload.identity_nonce;
  if (
    !isSubject(subject) ||
    typeof email !== "string" ||
    email.length > 320 ||
    !email.includes("@")
  ) {
    throw new Error("Access token does not represent a human identity");
  }
  if (
    payload.type !== "app" ||
    typeof identityNonce !== "string" ||
    identityNonce.length < 1 ||
    identityNonce.length > 512
  ) {
    throw new Error("Access application session claims are missing");
  }
  if (
    typeof issuedAt !== "number" ||
    !Number.isInteger(issuedAt) ||
    typeof expiresAt !== "number" ||
    !Number.isInteger(expiresAt) ||
    typeof notBefore !== "number" ||
    !Number.isInteger(notBefore)
  ) {
    throw new Error("Access token timestamps are missing");
  }
  if (
    issuedAt > nowSeconds + 60 ||
    notBefore > nowSeconds + 60 ||
    notBefore < issuedAt - 60 ||
    expiresAt <= nowSeconds ||
    nowSeconds - issuedAt > config.maxTokenAgeSeconds
  ) {
    throw new Error("Access application session is outside its allowed age");
  }
  if (expiresAt - issuedAt > config.maxTokenAgeSeconds + 60) {
    throw new Error("Access application session lifetime is too long");
  }

  const roles = config.rolesBySubject.get(subject);
  if (roles === undefined || roles.length === 0) {
    throw new Error("Access subject has no administrative role mapping");
  }

  return {
    subject,
    email,
    roles: [...roles],
    authenticated_at: new Date(issuedAt * 1000).toISOString(),
    access_application: config.audience,
  };
}

/** 为单一部署 issuer 复用 jose 的有界 JWKS 缓存 / Reuses jose's bounded JWKS cache for one deployment issuer. */
function remoteKeySet(issuer: string): ReturnType<typeof createRemoteJWKSet> {
  if (cachedKeySet?.issuer === issuer) return cachedKeySet.keySet;
  const keySet = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  cachedKeySet = { issuer, keySet };
  return keySet;
}

/** 检查 JSON object 且拒绝数组/null / Checks for a JSON object while rejecting arrays/null. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** subject 是有界不透明标识，而不是邮箱 / A subject is a bounded opaque ID, not an email. */
function isSubject(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  );
}

/** 角色 allowlist 检查 / Role allowlist check. */
function isAdminRole(value: unknown): value is AdminRole {
  return value === "viewer" || value === "operator" || value === "admin";
}

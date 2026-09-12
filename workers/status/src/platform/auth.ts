import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
  type JWTPayload,
} from "jose";
import { HttpError } from "./http.js";
import { EnvironmentSchema, type Environment } from "@moesegfault/contracts";

/** 仅缓存固定信任配置的公钥解析器，不保存请求/token。 / Cache only the pinned public-key resolver, never requests or tokens. */
let cachedKeys: { url: string; resolver: JWTVerifyGetKey } | undefined;

/** 复用 jose 缓存和 cooldown；配置切换替换唯一缓存。 / Reuse jose's cache and cooldown; configuration changes replace the sole cache. */
function machineKeys(url: URL): JWTVerifyGetKey {
  if (cachedKeys?.url !== url.href) {
    cachedKeys = {
      url: url.href,
      resolver: createRemoteJWKSet(url, { timeoutDuration: 5000 }),
    };
  }
  return cachedKeys.resolver;
}

/** 机器身份配置来自部署配置；密钥只从固定 HTTPS issuer 获取。 / Machine trust configuration pins the HTTPS issuer and JWKS endpoint. */
export interface MachineAuthConfig {
  /** JWT 发行者 / JWT issuer. */
  MACHINE_ISSUER: string;
  /** 本服务受众 / This service's audience. */
  MACHINE_AUDIENCE: string;
  /** 固定 JWKS 地址，绝不读取 token jku。 / Pinned JWKS URL, never token-controlled jku. */
  MACHINE_JWKS_URL: string;
}

/** 已验证授权集合，不直接序列化到 Queue。 / Verified authorization sets; not serialized directly onto Queues. */
export interface MachineIdentity {
  /** 安全主体 / Security subject. */
  subject: string;
  /** 允许服务 / Allowed service names. */
  serviceNames: ReadonlySet<string>;
  /** 允许环境 / Allowed environments. */
  environments: ReadonlySet<Environment>;
  /** 允许部署 / Allowed deployment identities. */
  deploymentIds: ReadonlySet<string>;
  /** 允许操作 / Allowed operation scopes. */
  scopes: ReadonlySet<string>;
  /** 稳定 token 身份 / Stable token identity. */
  tokenId: string;
  /** 认证机制 / Authentication mechanism. */
  authMethod: "jwt";
}

/** 检查机器 claim，包括短有效期和部署绑定。 / Validate machine claims, including short lifetime and deployment binding. */
export function identityFromClaims(payload: JWTPayload): MachineIdentity {
  const invalid = () =>
    new HttpError(
      403,
      "invalid-machine-claims",
      "Machine claims are insufficient",
    );
  if (
    !payload.sub ||
    !payload.jti ||
    !payload.iat ||
    !payload.exp ||
    payload.exp <= payload.iat ||
    payload.exp - payload.iat > 900
  )
    throw invalid();
  if (payload.iat > Date.now() / 1000 + 5) throw invalid();
  if (
    typeof payload.service_name !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(payload.service_name)
  )
    throw invalid();
  const environment = EnvironmentSchema.safeParse(payload.environment);
  if (!environment.success) throw invalid();
  if (
    typeof payload.deployment_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      payload.deployment_id,
    )
  )
    throw invalid();
  if (typeof payload.scope !== "string" || payload.scope.length > 2048)
    throw invalid();
  const scopes = payload.scope.split(" ").filter(Boolean);
  if (
    scopes.length === 0 ||
    scopes.some((scope) => !/^[a-z][a-z0-9:_-]*$/.test(scope))
  )
    throw invalid();
  return {
    subject: payload.sub,
    tokenId: payload.jti,
    serviceNames: new Set([payload.service_name]),
    environments: new Set([environment.data]),
    deploymentIds: new Set([payload.deployment_id]),
    scopes: new Set(scopes),
    authMethod: "jwt",
  };
}

/** 验证签名、issuer、audience 和期限；测试可注入本地 JWKS。 / Verify signature, issuer, audience, and lifetime; tests may inject a local JWKS. */
export async function authenticateMachine(
  request: Request,
  config: MachineAuthConfig,
  key?: JWTVerifyGetKey,
): Promise<MachineIdentity> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ") || authorization.length > 8192) {
    throw new HttpError(
      401,
      "authentication-required",
      "A machine bearer token is required",
    );
  }
  const issuer = new URL(config.MACHINE_ISSUER);
  const jwks = new URL(config.MACHINE_JWKS_URL);
  if (
    issuer.protocol !== "https:" ||
    jwks.protocol !== "https:" ||
    jwks.origin !== issuer.origin ||
    !config.MACHINE_AUDIENCE
  ) {
    throw new HttpError(
      503,
      "authentication-unavailable",
      "Machine authentication is not configured",
    );
  }
  try {
    const verified = await jwtVerify(
      authorization.slice(7),
      key ?? machineKeys(jwks),
      {
        issuer: config.MACHINE_ISSUER,
        audience: config.MACHINE_AUDIENCE,
        algorithms: ["RS256", "ES256", "EdDSA"],
        requiredClaims: ["sub", "jti", "iat", "exp"],
        clockTolerance: 5,
        maxTokenAge: "15m",
      },
    );
    return identityFromClaims(verified.payload);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(
      401,
      "invalid-machine-token",
      "Machine token verification failed",
    );
  }
}

/** 在解析 body 前检查 operation scope。 / Check operation scope before body processing. */
export function requireScope(identity: MachineIdentity, scope: string): void {
  if (!identity.scopes.has(scope))
    throw new HttpError(
      403,
      "insufficient-scope",
      "Machine scope does not authorize this operation",
    );
}

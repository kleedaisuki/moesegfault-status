import type {
  CreateArtifactUploadRequest,
  DeploymentArtifact,
  ArtifactUploadSession,
  DeploymentManifest,
  DeploymentRegistration,
  Environment,
} from "@moesegfault/contracts";

/** 机器调用方的最小授权投影 / Minimal authorization projection for a machine caller. */
export interface DeploymentPrincipal {
  /** JWT subject / JWT 主体。 */
  readonly subject: string;
  /** 允许的 OTel service names / Allowed OTel service names. */
  readonly serviceNames: ReadonlySet<string>;
  /** 允许的部署环境 / Allowed deployment environments. */
  readonly environments: ReadonlySet<Environment>;
  /** 允许的不可变 deployment IDs / Allowed immutable deployment IDs. */
  readonly deploymentIds: ReadonlySet<string>;
  /** 已验证操作权限 / Verified operation scopes. */
  readonly scopes: ReadonlySet<string>;
}

/** D1 所需最小真实接口；保持平台泛型结果，组合根可直接传 binding / Minimal real D1 surface preserving platform result generics for direct binding use. */
export type DeploymentDatabase = Pick<D1Database, "prepare" | "batch">;

/** R2 HEAD/PUT 使用的强校验字段 / Strong verification fields used by R2 HEAD and PUT. */
export interface ArtifactObject {
  /** 完整 R2 key / Complete R2 key. */
  readonly key: string;
  /** R2 object version，用于 TOCTOU 检查 / R2 object version used for TOCTOU checks. */
  readonly version?: string;
  /** 对象 ETag 备用版本证据 / Object ETag as fallback version evidence. */
  readonly etag?: string;
  /** 真实对象字节数 / Actual object byte length. */
  readonly size: number;
  /** R2 HTTP metadata 投影 / R2 HTTP metadata projection. */
  readonly httpMetadata?: { readonly contentType?: string };
  /** 已签名 provenance metadata / Signed provenance metadata. */
  readonly customMetadata?: Readonly<Record<string, string>>;
  /** R2 已验证 checksum（若 S3 路径提供）/ R2-verified checksum when supplied by the S3 path. */
  readonly checksums?: {
    /** R2 校验的传输 MD5 / R2-verified transport MD5. */
    readonly md5?: ArrayBuffer;
    /** R2 校验的 provenance SHA-256 / R2-verified provenance SHA-256. */
    readonly sha256?: ArrayBuffer;
  };
  /** 流式 fallback hash 的对象 body / Object body for streaming fallback hashing. */
  readonly body?: ReadableStream;
  /** 小型 manifest 的 UTF-8 读取器 / UTF-8 reader for small manifests. */
  readonly text?: () => Promise<string>;
}

/** R2 的最小对象存储接口 / Minimal R2 object-storage surface. */
export interface ArtifactBucket {
  /** 只读 metadata，不代理 artifact body / Read metadata without proxying the artifact body. */
  head(key: string): Promise<ArtifactObject | null>;
  /** 仅用于 manifest 重读与 checksum fallback / Used only for manifest re-read and checksum fallback. */
  get(key: string): Promise<ArtifactObject | null>;
  /** 仅服务端写 manifest；artifact 由客户端直传 / Server-side manifest write only; clients upload artifacts directly. */
  put(
    key: string,
    value: string | ArrayBuffer | ReadableStream,
    options?: {
      readonly onlyIf?: { readonly etagDoesNotMatch?: string };
      readonly httpMetadata?: { readonly contentType?: string };
      readonly customMetadata?: Readonly<Record<string, string>>;
      readonly sha256?: ArrayBuffer;
    },
  ): Promise<ArtifactObject | null>;
}

/** 签名后客户端必须原样发送的请求 / A signed request the client must reproduce exactly. */
export interface SignedArtifactPut {
  /** 短效 bearer URL / Short-lived bearer URL. */
  readonly url: string;
  /** 调用方必须原样发送的 SigV4 headers / SigV4 headers the caller must reproduce exactly. */
  readonly headers: ArtifactUploadSession["required_headers"];
}

/** 仅签发单个受约束对象的 PUT URL / Sign exactly one constrained object PUT URL. */
export type ArtifactPutSigner = (input: {
  readonly objectKey: string;
  readonly contentLength: number;
  readonly contentType: string;
  readonly contentMd5Base64: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly expiresInSeconds: number;
}) => Promise<SignedArtifactPut>;

/** 三个 deployment HTTP 处理器共享的显式依赖 / Explicit dependencies shared by all three deployment HTTP handlers. */
export interface DeploymentHttpContext {
  /** 权威领域数据库 / Authoritative domain database. */
  readonly db: DeploymentDatabase;
  /** 私有 observability bucket / Private observability bucket. */
  readonly artifacts: ArtifactBucket;
  /** 已验证机器身份 / Verified machine identity. */
  readonly principal: DeploymentPrincipal;
  /** 可信内部 Correlation ID / Trusted internal correlation ID. */
  readonly correlationId: string;
  /** 可测试 UTC clock / Testable UTC clock. */
  readonly now: () => Date;
  /** 受限 R2 signer / Restricted R2 signer. */
  readonly signArtifactPut: ArtifactPutSigner;
}

/** HTTP 处理器稳定返回形状 / Stable HTTP handler result shape. */
export interface DeploymentHttpResult<T> {
  /** 成功 HTTP status / Successful HTTP status. */
  readonly status: number;
  /** 未包 envelope 的契约 payload / Contract payload before the HTTP envelope. */
  readonly body: T;
}

export type PutDeploymentResult = DeploymentHttpResult<DeploymentRegistration>;
export type CreateArtifactUploadInput = CreateArtifactUploadRequest;
export type CommitArtifactResult = DeploymentHttpResult<DeploymentArtifact>;
export type PutDeploymentInput = DeploymentManifest;

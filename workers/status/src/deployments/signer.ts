import { AwsClient } from "aws4fetch";

import type { ArtifactPutSigner } from "./types.js";

/** R2 S3 API 签名配置；凭据只能来自 Worker secret / R2 S3 signing configuration; credentials must come from Worker secrets. */
export interface R2ArtifactSignerConfig {
  /** Cloudflare account ID / Cloudflare 账户 ID。 */
  readonly accountId: string;
  /** 私有 R2 bucket 名 / Private R2 bucket name. */
  readonly bucketName: string;
  /** 仅 PutObject 的 S3 access key / PutObject-only S3 access key. */
  readonly accessKeyId: string;
  /** Worker secret 中的 S3 secret / S3 secret stored as a Worker secret. */
  readonly secretAccessKey: string;
}

/**
 * 创建仅允许指定 key、长度、media type 与 provenance metadata 的短效 PUT 签名器。
 * Create a short-lived PUT signer bound to one key, length, media type, and provenance metadata.
 *
 * @example
 * ```ts
 * const sign = createR2ArtifactSigner({ accountId, bucketName, accessKeyId, secretAccessKey });
 * const signed = await sign({ objectKey, contentLength, contentType, contentMd5Base64, metadata, expiresInSeconds: 600 });
 * ```
 */
export function createR2ArtifactSigner(
  config: R2ArtifactSignerConfig,
): ArtifactPutSigner {
  if (!/^[0-9a-f]{32}$/.test(config.accountId))
    throw new TypeError(
      "R2 accountId must be 32 lowercase hexadecimal characters.",
    );
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.bucketName))
    throw new TypeError("R2 bucketName is invalid.");
  if (config.accessKeyId.length === 0 || config.secretAccessKey.length === 0)
    throw new TypeError("R2 signing credentials are required.");
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: "s3",
    region: "auto",
  });

  return async (input) => {
    if (
      !Number.isInteger(input.expiresInSeconds) ||
      input.expiresInSeconds < 1 ||
      input.expiresInSeconds > 3600
    ) {
      throw new RangeError(
        "Artifact upload expiry must be an integer between 1 and 3600 seconds.",
      );
    }
    const url = new URL(
      `${encodeURIComponent(config.bucketName)}/${input.objectKey.split("/").map(encodeURIComponent).join("/")}`,
      `https://${config.accountId}.r2.cloudflarestorage.com/`,
    );
    url.searchParams.set("X-Amz-Expires", String(input.expiresInSeconds));
    const headers = new Headers({
      "content-length": String(input.contentLength),
      "content-md5": input.contentMd5Base64,
      "content-type": input.contentType,
      "if-none-match": "*",
    });
    for (const [name, value] of Object.entries(input.metadata)) {
      headers.set(`x-amz-meta-${name}`, value);
    }
    const signed = await client.sign(
      new Request(url, { method: "PUT", headers }),
      {
        aws: { signQuery: true, allHeaders: true },
      },
    );
    return {
      url: signed.url,
      headers: {
        "content-type": headers.get("content-type")!,
        "content-length": headers.get("content-length")!,
        "content-md5": headers.get("content-md5")!,
        "x-amz-meta-deployment-id": headers.get("x-amz-meta-deployment-id")!,
        "x-amz-meta-git-commit": headers.get("x-amz-meta-git-commit")!,
        "x-amz-meta-artifact-digest": headers.get(
          "x-amz-meta-artifact-digest",
        )!,
        "x-amz-meta-artifact-kind": headers.get("x-amz-meta-artifact-kind")! as
          | "binary"
          | "debug_symbols"
          | "source_map"
          | "sbom"
          | "manifest"
          | "other",
        "x-amz-meta-artifact-file-name": headers.get(
          "x-amz-meta-artifact-file-name",
        )!,
        "x-amz-meta-build-id": headers.get("x-amz-meta-build-id")!,
        "if-none-match": "*",
      },
    };
  };
}

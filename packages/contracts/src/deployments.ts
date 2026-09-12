import { z } from "zod";
import {
  EnvironmentSchema,
  GitCommitSchema,
  HttpsUrlSchema,
  ServiceNameSchema,
  Sha256DigestSchema,
  UtcDateTimeSchema,
  UuidV7Schema,
} from "./primitives.js";

/** Deployment Manifest 的 HTTP body 上限 / HTTP body limit for a Deployment Manifest. */
export const DEPLOYMENT_MANIFEST_MAX_BODY_BYTES = 1024 * 1024;
/** Artifact 会话/提交请求的 HTTP body 上限 / HTTP body limit for artifact session and commit requests. */
export const ARTIFACT_REQUEST_MAX_BODY_BYTES = 16 * 1024;

/** S3-compatible Content-MD5（16-byte digest 的 Base64）/ S3-compatible Content-MD5 (Base64 of a 16-byte digest). */
export const ContentMd5Schema = z.string().regex(/^[A-Za-z0-9+/]{22}==$/);
/** Source map 的硬大小上限 / Hard byte-size limit for source maps. */
export const SOURCE_MAP_MAX_BYTES = 8 * 1024 * 1024;

/** 部署产物类别 / Deployment artifact kind. */
export const ArtifactKindSchema = z.enum([
  "binary",
  "debug_symbols",
  "source_map",
  "sbom",
  "manifest",
  "other",
]);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

const ArtifactFileNameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/)
  .refine(
    (value) => value !== "." && value !== "..",
    "file_name must be a safe ASCII base name",
  );

const ArtifactMediaTypeSchema = z
  .string()
  .min(3)
  .max(127)
  .regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i);

const ArtifactSizeSchema = z
  .number()
  .int()
  .positive()
  .max(5 * 1024 * 1024 * 1024);
const BuildIdSchema = z.string().min(1).max(256);
const ArtifactBaseShape = {
  file_name: ArtifactFileNameSchema,
  media_type: ArtifactMediaTypeSchema,
  size_bytes: ArtifactSizeSchema,
  artifact_digest: Sha256DigestSchema,
};
const BinaryArtifactDeclarationSchema = z.strictObject({
  ...ArtifactBaseShape,
  kind: z.literal("binary"),
  build_id: BuildIdSchema,
});
const DebugSymbolsArtifactDeclarationSchema = z.strictObject({
  ...ArtifactBaseShape,
  kind: z.literal("debug_symbols"),
  build_id: BuildIdSchema,
});
const SourceMapArtifactDeclarationSchema = z.strictObject({
  ...ArtifactBaseShape,
  kind: z.literal("source_map"),
  file_name: ArtifactFileNameSchema.regex(/\.map$/),
  media_type: z.literal("application/json"),
  size_bytes: z.number().int().positive().max(SOURCE_MAP_MAX_BYTES),
  build_id: BuildIdSchema.optional(),
});
const SbomArtifactDeclarationSchema = z.strictObject({
  ...ArtifactBaseShape,
  kind: z.literal("sbom"),
  build_id: BuildIdSchema.optional(),
});
const ManifestArtifactDeclarationSchema = z.strictObject({
  ...ArtifactBaseShape,
  kind: z.literal("manifest"),
  build_id: BuildIdSchema.optional(),
});
const OtherArtifactDeclarationSchema = z.strictObject({
  ...ArtifactBaseShape,
  kind: z.literal("other"),
  build_id: BuildIdSchema.optional(),
});
const artifactDeclarationOptions = [
  BinaryArtifactDeclarationSchema,
  DebugSymbolsArtifactDeclarationSchema,
  SourceMapArtifactDeclarationSchema,
  SbomArtifactDeclarationSchema,
  ManifestArtifactDeclarationSchema,
  OtherArtifactDeclarationSchema,
] as const;

/** Manifest 内的不可变产物声明 / Immutable artifact declaration embedded in a manifest. */
export const DeploymentArtifactDeclarationSchema = z.discriminatedUnion(
  "kind",
  artifactDeclarationOptions,
);
export type DeploymentArtifactDeclaration = z.infer<
  typeof DeploymentArtifactDeclarationSchema
>;

/** 不可变 Deployment Manifest / Immutable deployment manifest registered before production traffic. */
export const DeploymentManifestSchema = z
  .strictObject({
    deployment_id: UuidV7Schema,
    service_name: ServiceNameSchema,
    environment: EnvironmentSchema,
    service_version: z.string().min(1).max(128),
    repository_url: HttpsUrlSchema,
    git_commit: GitCommitSchema,
    git_ref: z.string().min(1).max(512),
    artifact_digest: Sha256DigestSchema,
    ci_provider: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
    ci_run_id: z.string().min(1).max(256),
    deployed_at: UtcDateTimeSchema,
    region: z
      .array(
        z
          .string()
          .min(1)
          .max(64)
          .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
      )
      .min(1)
      .max(64),
    artifacts: z
      .array(DeploymentArtifactDeclarationSchema)
      .min(1)
      .max(256)
      .describe(
        "Required immutable artifacts; exactly one binary or other artifact must match artifact_digest, and a JavaScript runtime requires its exact file_name plus .map source map",
      ),
  })
  .superRefine((manifest, context) => {
    const identities = new Set<string>();
    for (const [index, artifact] of manifest.artifacts.entries()) {
      const identity = `${artifact.kind}:${artifact.file_name}`;
      if (identities.has(identity)) {
        context.addIssue({
          code: "custom",
          path: ["artifacts", index],
          message: "artifact kind and file_name must be unique",
        });
      }
      identities.add(identity);
    }

    const runtimeArtifacts = manifest.artifacts.filter(
      (artifact) =>
        (artifact.kind === "binary" || artifact.kind === "other") &&
        artifact.artifact_digest === manifest.artifact_digest,
    );
    if (runtimeArtifacts.length !== 1) {
      context.addIssue({
        code: "custom",
        path: ["artifacts"],
        message:
          "exactly one binary or other artifact must match the top-level artifact_digest",
      });
      return;
    }

    const runtime = runtimeArtifacts[0]!;
    if (
      runtime.media_type !== "application/javascript" &&
      runtime.media_type !== "text/javascript"
    ) {
      return;
    }

    const sourceMapName = `${runtime.file_name}.map`;
    if (
      !manifest.artifacts.some(
        (artifact) =>
          artifact.kind === "source_map" &&
          artifact.file_name === sourceMapName,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["artifacts"],
        message: `JavaScript runtime artifact requires source_map file_name ${sourceMapName}`,
      });
    }
  });
export type DeploymentManifest = z.infer<typeof DeploymentManifestSchema>;

/** Deployment Registry 状态 / Deployment registry readiness state. */
export const DeploymentStateSchema = z.enum([
  "registered",
  "awaiting_artifacts",
  "ready",
]);
export type DeploymentState = z.infer<typeof DeploymentStateSchema>;

/** 部署注册结果 / Idempotent deployment registration result. */
export const DeploymentRegistrationSchema = z.strictObject({
  deployment_id: UuidV7Schema,
  state: DeploymentStateSchema,
  manifest_digest: Sha256DigestSchema,
  registered_at: UtcDateTimeSchema,
});
export type DeploymentRegistration = z.infer<
  typeof DeploymentRegistrationSchema
>;

/** 创建受限上传会话的请求 / Request for a time-limited, digest-bound upload session. */
export const CreateArtifactUploadRequestSchema = z.discriminatedUnion("kind", [
  BinaryArtifactDeclarationSchema.extend({ content_md5: ContentMd5Schema }),
  DebugSymbolsArtifactDeclarationSchema.extend({
    content_md5: ContentMd5Schema,
  }),
  SourceMapArtifactDeclarationSchema.extend({ content_md5: ContentMd5Schema }),
  SbomArtifactDeclarationSchema.extend({ content_md5: ContentMd5Schema }),
  ManifestArtifactDeclarationSchema.extend({ content_md5: ContentMd5Schema }),
  OtherArtifactDeclarationSchema.extend({ content_md5: ContentMd5Schema }),
]);
export type CreateArtifactUploadRequest = z.infer<
  typeof CreateArtifactUploadRequestSchema
>;

/** 上传会话响应；对象键不属于契约 / Upload session response; internal object keys are intentionally absent. */
export const ArtifactUploadSessionSchema = z.strictObject({
  upload_id: UuidV7Schema,
  method: z.literal("PUT"),
  upload_url: HttpsUrlSchema,
  required_headers: z.strictObject({
    "content-type": z.string().min(3).max(127),
    "content-length": z.string().regex(/^[1-9][0-9]{0,12}$/),
    "content-md5": ContentMd5Schema,
    "x-amz-meta-deployment-id": UuidV7Schema,
    "x-amz-meta-git-commit": z
      .string()
      .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
    "x-amz-meta-artifact-digest": Sha256DigestSchema,
    "x-amz-meta-artifact-kind": ArtifactKindSchema,
    "x-amz-meta-artifact-file-name": ArtifactFileNameSchema,
    "x-amz-meta-build-id": z.string().min(1).max(256),
    "if-none-match": z.literal("*"),
  }),
  expires_at: UtcDateTimeSchema,
});
export type ArtifactUploadSession = z.infer<typeof ArtifactUploadSessionSchema>;

/** 提交已上传产物的请求 / Commit request for a previously uploaded immutable artifact. */
export const CreateDeploymentArtifactRequestSchema = z.discriminatedUnion(
  "kind",
  [
    BinaryArtifactDeclarationSchema.extend({ upload_id: UuidV7Schema }),
    DebugSymbolsArtifactDeclarationSchema.extend({ upload_id: UuidV7Schema }),
    SourceMapArtifactDeclarationSchema.extend({ upload_id: UuidV7Schema }),
    SbomArtifactDeclarationSchema.extend({ upload_id: UuidV7Schema }),
    ManifestArtifactDeclarationSchema.extend({ upload_id: UuidV7Schema }),
    OtherArtifactDeclarationSchema.extend({ upload_id: UuidV7Schema }),
  ],
);
export type CreateDeploymentArtifactRequest = z.infer<
  typeof CreateDeploymentArtifactRequestSchema
>;

/** 已登记产物；不泄露 R2 object key / Registered artifact without an R2 object key. */
export const DeploymentArtifactSchema = z.strictObject({
  artifact_id: UuidV7Schema,
  deployment_id: UuidV7Schema,
  kind: ArtifactKindSchema,
  file_name: ArtifactFileNameSchema,
  media_type: z.string().min(3).max(127),
  size_bytes: z.number().int().positive(),
  artifact_digest: Sha256DigestSchema,
  build_id: z.string().min(1).max(256).nullable(),
  committed_at: UtcDateTimeSchema,
});
export type DeploymentArtifact = z.infer<typeof DeploymentArtifactSchema>;

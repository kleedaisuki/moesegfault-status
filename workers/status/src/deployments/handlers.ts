import {
  CreateArtifactUploadRequestSchema,
  CreateDeploymentArtifactRequestSchema,
  ARTIFACT_REQUEST_MAX_BODY_BYTES,
  DEPLOYMENT_MANIFEST_MAX_BODY_BYTES,
  DeploymentManifestSchema,
  SOURCE_MAP_MAX_BYTES,
  type ArtifactUploadSession,
  type CreateArtifactUploadRequest,
  type CreateDeploymentArtifactRequest,
  type DeploymentArtifact,
  type DeploymentManifest,
  type DeploymentRegistration,
  type DeploymentState,
  type Environment,
} from "@moesegfault/contracts";
import type { Crypto as WorkerCrypto } from "@cloudflare/workers-types";

import { canonicalJson, sha256Digest, toHex, uuidV7 } from "./crypto.js";
import { problem } from "./problem.js";
import { readJson } from "../platform/http.js";
import type {
  CommitArtifactResult,
  CreateArtifactUploadInput,
  DeploymentHttpContext,
  DeploymentHttpResult,
  PutDeploymentResult,
} from "./types.js";

const MANIFEST_SCHEMA_VERSION = "1.0";
const UPLOAD_TTL_SECONDS = 10 * 60;
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

interface DeploymentRow {
  readonly deployment_id: string;
  readonly service_name: string;
  readonly environment: string;
  readonly git_commit: string;
  readonly manifest_digest: string;
  readonly registered_at: string;
  readonly state: string;
}

interface UploadRow {
  readonly upload_id: string;
  readonly deployment_id: string;
  readonly request_digest: string;
  readonly object_key: string;
  readonly kind: string;
  readonly file_name: string;
  readonly media_type: string;
  readonly size_bytes: number;
  readonly artifact_digest: string;
  readonly content_md5: string | null;
  readonly build_id: string | null;
  readonly expires_at: string;
  readonly response_json?: string;
  readonly git_commit: string;
  readonly service_name: string;
  readonly environment: string;
}

interface ArtifactRow {
  readonly artifact_id: string;
  readonly deployment_id: string;
  readonly kind: string;
  readonly file_name: string;
  readonly media_type: string;
  readonly size_bytes: number;
  readonly artifact_digest: string;
  readonly build_id: string | null;
  readonly created_at: string;
}

/** 注册不可变 Deployment Manifest；同 ID 同内容重放返回 200 / Register an immutable manifest; identical replay returns 200. */
export async function putDeployment(
  request: Request,
  deploymentId: string,
  context: DeploymentHttpContext,
): Promise<PutDeploymentResult> {
  requireScope(context, "deployments:write");
  requireDeploymentClaim(context, deploymentId);
  const manifest = await parseBody(
    request,
    DeploymentManifestSchema,
    DEPLOYMENT_MANIFEST_MAX_BODY_BYTES,
  );
  if (manifest.deployment_id !== deploymentId) {
    problem(
      409,
      "deployment-id-mismatch",
      "Deployment ID mismatch",
      "Path and manifest deployment IDs must match.",
    );
  }
  authorizeManifest(context, manifest);
  validateReadinessManifest(manifest);

  const manifestJson = canonicalJson(manifest);
  const manifestDigest = await sha256Digest(manifestJson);
  const existing = await findDeployment(context, deploymentId);
  if (existing !== null) return replayRegistration(existing, manifestDigest);

  const serviceExists = await context.db
    .prepare(
      "SELECT service_name FROM services WHERE service_name = ?1 AND enabled = 1",
    )
    .bind(manifest.service_name)
    .first<string>("service_name");
  if (serviceExists === null) {
    problem(
      422,
      "unknown-service",
      "Unknown service",
      "The manifest service is not enabled in the service registry.",
    );
  }

  const manifestObjectKey = `observability/manifests/${deploymentId}.json`;
  await storeImmutableManifest(
    context,
    manifestObjectKey,
    manifestJson,
    manifestDigest,
    manifest,
  );

  const now = context.now();
  const registeredAt = now.toISOString();
  // Registration never implies readiness: at least the designated runtime bytes must pass R2 verification.
  // 注册绝不等于 ready：至少 designated runtime 的真实字节必须先通过 R2 校验。
  const initialState: DeploymentState = "awaiting_artifacts";
  const statements = [
    context.db
      .prepare(
        `INSERT INTO deployments (
        deployment_id, service_name, environment, service_version, repository_url, git_commit, git_ref,
        artifact_digest, ci_provider, ci_run_id, deployed_at, manifest_object_key, manifest_digest,
        manifest_schema_version, registered_at, registered_by
      ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)`,
      )
      .bind(
        manifest.deployment_id,
        manifest.service_name,
        manifest.environment,
        manifest.service_version,
        manifest.repository_url,
        manifest.git_commit,
        manifest.git_ref,
        manifest.artifact_digest,
        manifest.ci_provider,
        manifest.ci_run_id,
        manifest.deployed_at,
        manifestObjectKey,
        manifestDigest,
        MANIFEST_SCHEMA_VERSION,
        registeredAt,
        context.principal.subject,
      ),
    ...manifest.region.map((region) =>
      context.db
        .prepare(
          "INSERT INTO deployment_regions (deployment_id, region) VALUES (?1, ?2)",
        )
        .bind(deploymentId, region),
    ),
    ...manifest.artifacts.map((artifact) =>
      context.db
        .prepare(
          `INSERT INTO deployment_artifact_requirements
          (deployment_id, kind, file_name, media_type, size_bytes, artifact_digest, build_id, created_at)
          VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`,
        )
        .bind(
          deploymentId,
          artifact.kind,
          artifact.file_name,
          artifact.media_type,
          artifact.size_bytes,
          artifact.artifact_digest,
          artifact.build_id ?? null,
          registeredAt,
        ),
    ),
    context.db
      .prepare(
        `INSERT INTO deployment_status_history
        (deployment_id, sequence, state, reason, actor_subject, correlation_id, occurred_at)
        VALUES (?1,1,'registered','manifest registered',?2,?3,?4)`,
      )
      .bind(
        deploymentId,
        context.principal.subject,
        context.correlationId,
        registeredAt,
      ),
    context.db
      .prepare(
        `INSERT INTO deployment_status_history
        (deployment_id, sequence, state, reason, actor_subject, correlation_id, occurred_at)
        VALUES (?1,2,?2,?3,?4,?5,?6)`,
      )
      .bind(
        deploymentId,
        "artifacts_pending",
        "required artifacts are pending",
        context.principal.subject,
        context.correlationId,
        registeredAt,
      ),
    auditStatement(
      context,
      "deployment.registered",
      "deployment",
      deploymentId,
      registeredAt,
      {
        manifest_digest: manifestDigest,
        state: initialState,
      },
    ),
  ];

  try {
    await context.db.batch(statements);
  } catch {
    const raced = await findDeployment(context, deploymentId);
    if (raced !== null) return replayRegistration(raced, manifestDigest);
    problem(
      500,
      "deployment-registration-failed",
      "Deployment registration failed",
      "The manifest was not registered.",
    );
  }
  return {
    status: 201,
    body: {
      deployment_id: deploymentId,
      state: initialState,
      manifest_digest: manifestDigest,
      registered_at: registeredAt,
    },
  };
}

/** 创建短效、对象键与 provenance headers 均受限的 R2 直传会话 / Create a short-lived R2 direct-upload session bound to its key and provenance headers. */
export async function createArtifactUpload(
  request: Request,
  deploymentId: string,
  context: DeploymentHttpContext,
): Promise<DeploymentHttpResult<ArtifactUploadSession>> {
  requireScope(context, "artifacts:write");
  requireDeploymentClaim(context, deploymentId);
  const idempotencyKey = requireIdempotencyKey(request);
  const input = await parseBody(
    request,
    CreateArtifactUploadRequestSchema,
    ARTIFACT_REQUEST_MAX_BODY_BYTES,
  );
  const deployment = await requireAuthorizedDeployment(context, deploymentId);
  await requireManifestArtifact(context, deploymentId, input);

  const requestDigest = await sha256Digest(canonicalJson(input));
  const scope = `deployment-artifact-upload:${deploymentId}`;
  const replay = await context.db
    .prepare(
      `SELECT i.request_digest, i.response_json, s.expires_at FROM idempotency_keys i
      JOIN artifact_upload_sessions s ON s.upload_id=i.resource_id
      WHERE i.scope = ?1 AND i.idempotency_key = ?2`,
    )
    .bind(scope, idempotencyKey)
    .first<{
      request_digest: string;
      response_json: string;
      expires_at: string;
    }>();
  if (replay !== null) {
    if (replay.request_digest !== requestDigest) {
      problem(
        409,
        "idempotency-key-conflict",
        "Idempotency key conflict",
        "The key was already used for a different upload request.",
      );
    }
    if (Date.parse(replay.expires_at) <= context.now().getTime()) {
      problem(
        409,
        "upload-session-expired",
        "Upload session expired",
        "Create a replacement session with a new stable idempotency key.",
      );
    }
    return {
      status: 200,
      body: JSON.parse(replay.response_json) as ArtifactUploadSession,
    };
  }

  const objectKey = artifactObjectKey(deploymentId, input);
  const alreadyCommitted = await context.db
    .prepare(
      "SELECT artifact_id FROM deployment_artifacts WHERE object_key = ?1",
    )
    .bind(objectKey)
    .first<string>("artifact_id");
  if (alreadyCommitted !== null) {
    problem(
      409,
      "artifact-already-committed",
      "Artifact already committed",
      "The immutable artifact is already registered.",
    );
  }

  const now = context.now();
  const uploadId = uuidV7(now);
  const expiresAt = new Date(
    now.getTime() + UPLOAD_TTL_SECONDS * 1000,
  ).toISOString();
  const metadata = expectedMetadata(deployment, input);
  const signed = await context.signArtifactPut({
    objectKey,
    contentLength: input.size_bytes,
    contentType: input.media_type,
    contentMd5Base64: input.content_md5,
    metadata,
    expiresInSeconds: UPLOAD_TTL_SECONDS,
  });
  const body: ArtifactUploadSession = {
    upload_id: uploadId,
    method: "PUT",
    upload_url: signed.url,
    required_headers: signed.headers,
    expires_at: expiresAt,
  };
  const bodyJson = JSON.stringify(body);
  const createdAt = now.toISOString();
  const idempotencyExpiresAt = new Date(
    now.getTime() + IDEMPOTENCY_TTL_SECONDS * 1000,
  ).toISOString();
  try {
    await context.db.batch([
      context.db
        .prepare(
          `INSERT INTO artifact_upload_sessions
          (upload_id,deployment_id,idempotency_key,request_digest,object_key,kind,file_name,media_type,size_bytes,
           artifact_digest,content_md5,build_id,expires_at,created_at,created_by)
          VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)`,
        )
        .bind(
          uploadId,
          deploymentId,
          idempotencyKey,
          requestDigest,
          objectKey,
          input.kind,
          input.file_name,
          input.media_type,
          input.size_bytes,
          input.artifact_digest,
          input.content_md5,
          input.build_id ?? null,
          expiresAt,
          createdAt,
          context.principal.subject,
        ),
      context.db
        .prepare(
          `INSERT INTO idempotency_keys
          (scope,idempotency_key,request_digest,resource_type,resource_id,response_status,response_json,created_at,expires_at)
          VALUES (?1,?2,?3,'artifact_upload',?4,201,?5,?6,?7)`,
        )
        .bind(
          scope,
          idempotencyKey,
          requestDigest,
          uploadId,
          bodyJson,
          createdAt,
          idempotencyExpiresAt,
        ),
      auditStatement(
        context,
        "deployment.artifact-upload.created",
        "artifact_upload",
        uploadId,
        createdAt,
        {
          deployment_id: deploymentId,
          artifact_digest: input.artifact_digest,
          expires_at: expiresAt,
        },
      ),
    ]);
  } catch {
    const raced = await context.db
      .prepare(
        "SELECT request_digest, response_json FROM idempotency_keys WHERE scope = ?1 AND idempotency_key = ?2",
      )
      .bind(scope, idempotencyKey)
      .first<{ request_digest: string; response_json: string }>();
    if (raced?.request_digest === requestDigest) {
      return {
        status: 200,
        body: JSON.parse(raced.response_json) as ArtifactUploadSession,
      };
    }
    problem(
      500,
      "upload-session-failed",
      "Upload session failed",
      "The upload session was not persisted.",
    );
  }
  return { status: 201, body };
}

/** HEAD 校验实际 R2 对象后登记产物，并且仅在全部必需产物存在后置为 ready / Verify the actual R2 object before commit and mark ready only after all requirements exist. */
export async function commitArtifact(
  request: Request,
  deploymentId: string,
  context: DeploymentHttpContext,
): Promise<CommitArtifactResult> {
  requireScope(context, "artifacts:write");
  requireDeploymentClaim(context, deploymentId);
  const input = await parseBody(
    request,
    CreateDeploymentArtifactRequestSchema,
    ARTIFACT_REQUEST_MAX_BODY_BYTES,
  );
  const session = await context.db
    .prepare(
      `SELECT s.*, d.git_commit, d.service_name, d.environment
      FROM artifact_upload_sessions s JOIN deployments d ON d.deployment_id = s.deployment_id
      WHERE s.upload_id = ?1 AND s.deployment_id = ?2`,
    )
    .bind(input.upload_id, deploymentId)
    .first<UploadRow>();
  if (session === null) {
    problem(
      404,
      "upload-session-not-found",
      "Upload session not found",
      "No upload session belongs to this deployment.",
    );
  }
  authorizeDeploymentRow(context, session);
  await requireMatchingSession(input, session);

  const existing = await findArtifact(
    context,
    deploymentId,
    input.kind,
    input.file_name,
  );
  if (existing !== null) {
    ensureArtifactReplay(existing, input);
    await ensureReady(context, deploymentId);
    return { status: 200, body: artifactResponse(existing) };
  }

  const object = await context.artifacts.head(session.object_key);
  if (object === null) {
    problem(
      422,
      "artifact-not-uploaded",
      "Artifact not uploaded",
      "The object does not exist at the restricted upload key.",
    );
  }
  await verifyUploadedObject(context, object, session);

  const committedAt = context.now().toISOString();
  const artifactId = uuidV7(context.now());
  try {
    await context.db.batch([
      context.db
        .prepare(
          `INSERT INTO deployment_artifacts
          (artifact_id,deployment_id,upload_id,kind,object_key,file_name,media_type,size_bytes,artifact_digest,build_id,bundle_path,created_at)
          VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`,
        )
        .bind(
          artifactId,
          deploymentId,
          session.upload_id,
          session.kind,
          session.object_key,
          session.file_name,
          session.media_type,
          session.size_bytes,
          session.artifact_digest,
          session.build_id,
          session.kind === "source_map" && session.file_name.endsWith(".map")
            ? session.file_name.slice(0, -".map".length)
            : null,
          committedAt,
        ),
      auditStatement(
        context,
        "deployment.artifact.committed",
        "deployment_artifact",
        artifactId,
        committedAt,
        {
          deployment_id: deploymentId,
          artifact_digest: session.artifact_digest,
          upload_id: session.upload_id,
        },
      ),
    ]);
  } catch {
    const raced = await findArtifact(
      context,
      deploymentId,
      input.kind,
      input.file_name,
    );
    if (raced === null) {
      problem(
        500,
        "artifact-commit-failed",
        "Artifact commit failed",
        "The verified object was not registered.",
      );
    }
    ensureArtifactReplay(raced, input);
    await ensureReady(context, deploymentId);
    return { status: 200, body: artifactResponse(raced) };
  }

  await ensureReady(context, deploymentId);
  return {
    status: 201,
    body: {
      artifact_id: artifactId,
      deployment_id: deploymentId,
      kind: input.kind,
      file_name: input.file_name,
      media_type: input.media_type,
      size_bytes: input.size_bytes,
      artifact_digest: input.artifact_digest,
      build_id: input.build_id ?? null,
      committed_at: committedAt,
    },
  };
}

/** 有界读取并按共享契约校验 JSON / Read bounded JSON and validate it against the shared contract. */
async function parseBody<T>(
  request: Request,
  schema: {
    safeParse(value: unknown): { success: true; data: T } | { success: false };
  },
  limit: number,
): Promise<T> {
  const value = await readJson(request, limit);
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    problem(
      422,
      "invalid-request",
      "Invalid request",
      "The request does not satisfy the deployment contract.",
    );
  return parsed.data;
}

/** 在任何存储访问前检查 operation scope / Check operation scope before any storage access. */
function requireScope(context: DeploymentHttpContext, scope: string): void {
  if (!context.principal.scopes.has(scope))
    problem(
      403,
      "insufficient-scope",
      "Insufficient scope",
      `The machine identity lacks ${scope}.`,
    );
}

/** 强制 path deployment 与 token claim 一致 / Bind the path deployment to the token claim. */
function requireDeploymentClaim(
  context: DeploymentHttpContext,
  deploymentId: string,
): void {
  if (!context.principal.deploymentIds.has(deploymentId)) {
    problem(
      403,
      "deployment-claim-mismatch",
      "Deployment claim mismatch",
      "The path deployment ID is outside the machine identity's claims.",
    );
  }
}

/** 强制 manifest service/environment 与 token 一致 / Bind manifest service/environment to the token. */
function authorizeManifest(
  context: DeploymentHttpContext,
  manifest: DeploymentManifest,
): void {
  if (
    !context.principal.serviceNames.has(manifest.service_name) ||
    !context.principal.environments.has(manifest.environment)
  ) {
    problem(
      403,
      "manifest-claim-mismatch",
      "Manifest claim mismatch",
      "Service and environment must match the machine identity.",
    );
  }
}

/** 强制 ready 至少证明实际 runtime，并为 JavaScript runtime 要求 source map / Require proof of the actual runtime before ready, plus a source map for JavaScript runtimes. */
function validateReadinessManifest(manifest: DeploymentManifest): void {
  const runtime = manifest.artifacts.filter(
    (artifact) =>
      (artifact.kind === "binary" || artifact.kind === "other") &&
      artifact.artifact_digest === manifest.artifact_digest,
  );
  if (runtime.length !== 1) {
    problem(
      422,
      "invalid-runtime-artifact",
      "Invalid runtime artifact",
      "The manifest must declare exactly one binary or other artifact whose digest equals the top-level runtime digest.",
    );
  }
  if (
    ["application/javascript", "text/javascript"].includes(
      runtime[0]!.media_type.toLowerCase(),
    ) &&
    !manifest.artifacts.some(
      (artifact) =>
        artifact.kind === "source_map" &&
        artifact.file_name === `${runtime[0]!.file_name}.map`,
    )
  ) {
    problem(
      422,
      "missing-source-map",
      "Missing source map",
      "A JavaScript runtime artifact requires a source map named <runtime-file>.map.",
    );
  }
}

/** 对已存 deployment 再做授权，禁止 IDOR / Re-authorize a stored deployment to prevent IDOR. */
function authorizeDeploymentRow(
  context: DeploymentHttpContext,
  row: Pick<DeploymentRow, "service_name" | "environment">,
): void {
  if (
    !context.principal.serviceNames.has(row.service_name) ||
    !context.principal.environments.has(row.environment as Environment)
  ) {
    problem(
      403,
      "deployment-claim-mismatch",
      "Deployment claim mismatch",
      "The deployment is outside the machine identity's claims.",
    );
  }
}

/** 读取 manifest identity 与追加式当前状态 / Read manifest identity and append-only current state. */
async function findDeployment(
  context: DeploymentHttpContext,
  deploymentId: string,
): Promise<DeploymentRow | null> {
  return context.db
    .prepare(
      `SELECT d.deployment_id,d.service_name,d.environment,d.git_commit,d.manifest_digest,d.registered_at,
      COALESCE(s.state,'registered') AS state FROM deployments d
      LEFT JOIN deployment_current_status s ON s.deployment_id=d.deployment_id WHERE d.deployment_id=?1`,
    )
    .bind(deploymentId)
    .first<DeploymentRow>();
}

/** 仅允许相同 manifest digest 的 registration 重放 / Permit registration replay only for the identical manifest digest. */
function replayRegistration(
  existing: DeploymentRow,
  manifestDigest: string,
): PutDeploymentResult {
  if (existing.manifest_digest !== manifestDigest) {
    problem(
      409,
      "deployment-manifest-conflict",
      "Deployment manifest conflict",
      "The deployment ID is bound to different immutable content.",
    );
  }
  if (existing.state === "retired" || existing.state === "failed") {
    problem(
      409,
      "deployment-terminal",
      "Deployment is terminal",
      "A retired or failed deployment ID cannot re-enter the release readiness gate.",
    );
  }
  return {
    status: 200,
    body: {
      deployment_id: existing.deployment_id,
      state: publicDeploymentState(existing.state),
      manifest_digest: existing.manifest_digest as `sha256:${string}`,
      registered_at: existing.registered_at,
    },
  };
}

/** 把内部生命周期投影为机器 registration readiness / Project internal lifecycle onto machine registration readiness. */
function publicDeploymentState(state: string): DeploymentState {
  if (state === "ready" || state === "active") return "ready";
  if (state === "registered") return "registered";
  return "awaiting_artifacts";
}

/** 条件写 manifest 并在 D1 事务前重读验证 / Conditionally store and re-read a manifest before the D1 transaction. */
async function storeImmutableManifest(
  context: DeploymentHttpContext,
  key: string,
  json: string,
  digest: string,
  manifest: DeploymentManifest,
): Promise<void> {
  const existing = await context.artifacts.get(key);
  if (existing !== null) {
    if (
      existing.text === undefined ||
      (await sha256Digest(await existing.text())) !== digest
    ) {
      problem(
        409,
        "manifest-object-conflict",
        "Manifest object conflict",
        "The immutable manifest key already contains different bytes.",
      );
    }
    return;
  }
  const checksum = hexToArrayBuffer(digest.slice("sha256:".length));
  await context.artifacts.put(key, json, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      "manifest-digest": digest,
      "deployment-id": manifest.deployment_id,
      "git-commit": manifest.git_commit,
    },
    sha256: checksum,
  });
  // R2 与 D1 不能组成事务；在写 D1 前重读以封闭并发 conditional-PUT 的竞态。
  // R2 and D1 cannot share a transaction; re-read before D1 to close a concurrent conditional-PUT race.
  const persisted = await context.artifacts.get(key);
  if (
    persisted?.text === undefined ||
    (await sha256Digest(await persisted.text())) !== digest
  ) {
    problem(
      409,
      "manifest-object-conflict",
      "Manifest object conflict",
      "The immutable manifest object was not stored with the expected bytes.",
    );
  }
}

/** 读取可安全组成 D1 主键的稳定幂等键 / Read a stable idempotency key safe for the D1 primary key. */
function requireIdempotencyKey(request: Request): string {
  const value = request.headers.get("idempotency-key");
  if (value === null || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/.test(value)) {
    problem(
      400,
      "invalid-idempotency-key",
      "Invalid idempotency key",
      "A stable 8-256 character Idempotency-Key header is required.",
    );
  }
  return value;
}

/** 获取且授权 deployment，隐藏未注册资源 / Load and authorize a deployment while rejecting unregistered resources. */
async function requireAuthorizedDeployment(
  context: DeploymentHttpContext,
  deploymentId: string,
): Promise<DeploymentRow> {
  const deployment = await findDeployment(context, deploymentId);
  if (deployment === null)
    problem(
      404,
      "deployment-not-found",
      "Deployment not found",
      "The deployment is not registered.",
    );
  authorizeDeploymentRow(context, deployment);
  return deployment;
}

/** 要求 upload 与 immutable manifest declaration 全字段相同 / Require an upload to exactly match an immutable manifest declaration. */
async function requireManifestArtifact(
  context: DeploymentHttpContext,
  deploymentId: string,
  input: CreateArtifactUploadInput,
): Promise<void> {
  const found = await context.db
    .prepare(
      `SELECT 1 AS present FROM deployment_artifact_requirements
      WHERE deployment_id=?1 AND kind=?2 AND file_name=?3 AND media_type=?4 AND size_bytes=?5
        AND artifact_digest=?6 AND build_id IS ?7`,
    )
    .bind(
      deploymentId,
      input.kind,
      input.file_name,
      input.media_type,
      input.size_bytes,
      input.artifact_digest,
      input.build_id ?? null,
    )
    .first<number>("present");
  if (found === null) {
    problem(
      422,
      "undeclared-artifact",
      "Undeclared artifact",
      "The upload must exactly match an artifact declared by the immutable manifest.",
    );
  }
}

/** 构造摘要前缀且不可变的 R2 key / Build an immutable, digest-prefixed R2 key. */
function artifactObjectKey(
  deploymentId: string,
  input: CreateArtifactUploadRequest,
): string {
  const hex = input.artifact_digest.slice("sha256:".length);
  const file = encodeURIComponent(input.file_name);
  return `observability/artifacts/sha256/${hex.slice(0, 2)}/${hex}/${deploymentId}/${input.kind}/${file}`;
}

/** 生成由 SigV4 绑定、但不作为内容证明的 provenance metadata / Build SigV4-bound provenance metadata that is not itself content proof. */
function expectedMetadata(
  deployment: Pick<DeploymentRow, "deployment_id" | "git_commit">,
  input: {
    kind: string;
    file_name: string;
    artifact_digest: string;
    build_id?: string | null | undefined;
  },
): Record<string, string> {
  return {
    "artifact-digest": input.artifact_digest,
    "artifact-kind": input.kind,
    "artifact-file-name": input.file_name,
    "build-id": input.build_id ?? "none",
    "deployment-id": deployment.deployment_id,
    "git-commit": deployment.git_commit,
  };
}

/** 用稳定请求摘要阻止 commit body 换包 / Prevent commit-body substitution through the stable request digest. */
async function requireMatchingSession(
  input: CreateDeploymentArtifactRequest,
  session: UploadRow,
): Promise<void> {
  if (session.content_md5 === null) {
    problem(
      409,
      "legacy-upload-session",
      "Upload session must be renewed",
      "This legacy session lacks a transport checksum; create a new upload session.",
    );
  }
  if (
    input.kind !== session.kind ||
    input.file_name !== session.file_name ||
    input.media_type !== session.media_type ||
    input.size_bytes !== session.size_bytes ||
    input.artifact_digest !== session.artifact_digest ||
    (input.build_id ?? null) !== session.build_id
  ) {
    problem(
      409,
      "upload-session-mismatch",
      "Upload session mismatch",
      "Commit fields differ from the immutable upload session.",
    );
  }
}

/** 校验 HEAD provenance 并证明真实对象字节摘要 / Verify HEAD provenance and prove the actual object-byte digest. */
async function verifyUploadedObject(
  context: DeploymentHttpContext,
  object: NonNullable<
    Awaited<ReturnType<DeploymentHttpContext["artifacts"]["head"]>>
  >,
  session: UploadRow,
): Promise<void> {
  const metadata = object.customMetadata ?? {};
  const expected = expectedMetadata(session, session);
  const metadataMatches = Object.entries(expected).every(
    ([name, value]) => metadata[name] === value,
  );
  if (
    object.key !== session.object_key ||
    object.size !== session.size_bytes ||
    object.httpMetadata?.contentType !== session.media_type ||
    !metadataMatches
  ) {
    problem(
      422,
      "artifact-verification-failed",
      "Artifact verification failed",
      "R2 HEAD did not match the session's key, checksum, size, media type, Build ID, deployment, and commit metadata.",
    );
  }
  let actualDigest: string;
  if (session.kind === "source_map") {
    const bytes = await readObjectBytes(
      context,
      session.object_key,
      SOURCE_MAP_MAX_BYTES,
    );
    actualDigest = `sha256:${toHex(await crypto.subtle.digest("SHA-256", bytes))}`;
    validateSourceMap(bytes, session.file_name);
  } else {
    actualDigest =
      object.checksums?.sha256 === undefined
        ? await streamObjectDigest(context, session.object_key)
        : `sha256:${toHex(object.checksums.sha256)}`;
  }
  if (actualDigest !== session.artifact_digest) {
    problem(
      422,
      "artifact-verification-failed",
      "Artifact verification failed",
      "The stored bytes do not match the manifest SHA-256 digest.",
    );
  }
  if (
    object.checksums?.md5 !== undefined &&
    arrayBufferToBase64(object.checksums.md5) !== session.content_md5
  ) {
    problem(
      422,
      "artifact-transport-checksum-mismatch",
      "Artifact transport checksum mismatch",
      "R2 HEAD does not match the signed Content-MD5 value.",
    );
  }
  const afterHash = await context.artifacts.head(session.object_key);
  if (
    afterHash === null ||
    (object.version !== undefined && afterHash.version !== object.version) ||
    (object.etag !== undefined && afterHash.etag !== object.etag)
  ) {
    problem(
      409,
      "artifact-changed-during-verification",
      "Artifact changed during verification",
      "The immutable object changed while its digest was being verified.",
    );
  }
}

/** 在常量内存中计算 R2 对象 SHA-256 / Compute an R2 object's SHA-256 in constant memory. */
async function streamObjectDigest(
  context: DeploymentHttpContext,
  objectKey: string,
): Promise<string> {
  const stored = await context.artifacts.get(objectKey);
  if (stored?.body === undefined) {
    problem(
      422,
      "artifact-not-readable",
      "Artifact not readable",
      "The object body could not be read for checksum verification.",
    );
  }
  // Generated cross-project DOM types can narrow global `crypto`; this type-only import
  // keeps the runtime global while selecting Cloudflare's documented DigestStream surface.
  // 跨项目 DOM 类型可能收窄全局 `crypto`；仅类型导入保留运行时全局并采用 Cloudflare 官方接口。
  const digestStream = new (crypto as WorkerCrypto).DigestStream("SHA-256");
  await stored.body.pipeTo(digestStream);
  return `sha256:${toHex(await digestStream.digest)}`;
}

/** 有界读取小型语义 artifact，拒绝 HEAD 后替换成超大对象 / Read a small semantic artifact with a hard bound, rejecting post-HEAD growth. */
async function readObjectBytes(
  context: DeploymentHttpContext,
  objectKey: string,
  limit: number,
): Promise<ArrayBuffer> {
  const stored = await context.artifacts.get(objectKey);
  if (stored?.body === undefined) {
    problem(
      422,
      "artifact-not-readable",
      "Artifact not readable",
      "The object body could not be read for semantic verification.",
    );
  }
  const reader = stored.body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const bytes = new Uint8Array(chunk.value);
      length += bytes.byteLength;
      if (length > limit) {
        await reader.cancel();
        problem(
          422,
          "source-map-too-large",
          "Source map too large",
          `Source maps cannot exceed ${limit} bytes.`,
        );
      }
      parts.push(bytes);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result.buffer;
}

/** 校验 Source Map Revision 3 的最小可符号化结构与 bundle 关联 / Validate minimal symbolizable Source Map Revision 3 structure and bundle linkage. */
function validateSourceMap(bytes: ArrayBuffer, mapFileName: string): void {
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
  } catch {
    problem(
      422,
      "invalid-source-map",
      "Invalid source map",
      "The source map must be valid UTF-8 JSON.",
    );
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    problem(
      422,
      "invalid-source-map",
      "Invalid source map",
      "The source map root must be an object.",
    );
  }
  const map = value as Record<string, unknown>;
  const expectedBundle = mapFileName.endsWith(".map")
    ? mapFileName.slice(0, -".map".length)
    : "";
  if (
    map.version !== 3 ||
    !Array.isArray(map.sources) ||
    !map.sources.every((source) => typeof source === "string") ||
    typeof map.mappings !== "string" ||
    (map.file !== undefined && map.file !== expectedBundle)
  ) {
    problem(
      422,
      "invalid-source-map",
      "Invalid source map",
      "The map must be revision 3 with string sources/mappings and an optional file matching its runtime bundle.",
    );
  }
}

/** 按 manifest identity 查找已提交 artifact / Find a committed artifact by manifest identity. */
async function findArtifact(
  context: DeploymentHttpContext,
  deploymentId: string,
  kind: string,
  fileName: string,
): Promise<ArtifactRow | null> {
  return context.db
    .prepare(
      `SELECT artifact_id,deployment_id,kind,file_name,media_type,size_bytes,artifact_digest,build_id,created_at
      FROM deployment_artifacts WHERE deployment_id=?1 AND kind=?2 AND file_name=?3`,
    )
    .bind(deploymentId, kind, fileName)
    .first<ArtifactRow>();
}

/** 仅允许内容完全相同的 artifact commit 重放 / Permit artifact commit replay only for identical content. */
function ensureArtifactReplay(
  existing: ArtifactRow,
  input: CreateDeploymentArtifactRequest,
): void {
  if (
    existing.media_type !== input.media_type ||
    existing.size_bytes !== input.size_bytes ||
    existing.artifact_digest !== input.artifact_digest ||
    existing.build_id !== (input.build_id ?? null)
  ) {
    problem(
      409,
      "artifact-conflict",
      "Artifact conflict",
      "This manifest artifact identity is already bound to different content.",
    );
  }
}

/** 隐藏内部 object key 后投影契约响应 / Project the contract response without its internal object key. */
function artifactResponse(row: ArtifactRow): DeploymentArtifact {
  return {
    artifact_id: row.artifact_id,
    deployment_id: row.deployment_id,
    kind: row.kind as DeploymentArtifact["kind"],
    file_name: row.file_name,
    media_type: row.media_type,
    size_bytes: row.size_bytes,
    artifact_digest: row.artifact_digest as `sha256:${string}`,
    build_id: row.build_id,
    committed_at: row.created_at,
  };
}

/** 仅当 required-set 为空时原子追加 ready 与 audit / Atomically append ready and audit only when the required set is empty. */
async function ensureReady(
  context: DeploymentHttpContext,
  deploymentId: string,
): Promise<void> {
  const missing = await context.db
    .prepare(
      `SELECT COUNT(*) AS missing FROM deployment_artifact_requirements r
      WHERE r.deployment_id=?1 AND NOT EXISTS (
        SELECT 1 FROM deployment_artifacts a WHERE a.deployment_id=r.deployment_id
          AND a.kind=r.kind AND a.file_name=r.file_name AND a.media_type=r.media_type
          AND a.size_bytes=r.size_bytes AND a.artifact_digest=r.artifact_digest AND a.build_id IS r.build_id
      )`,
    )
    .bind(deploymentId)
    .first<number>("missing");
  if (missing !== 0) return;
  const current = await context.db
    .prepare(
      "SELECT revision,state FROM deployment_current_status WHERE deployment_id=?1",
    )
    .bind(deploymentId)
    .first<{ revision: number; state: string }>();
  if (
    current === null ||
    !["registered", "artifacts_pending"].includes(current.state)
  )
    return;

  const occurredAt = context.now().toISOString();
  try {
    await context.db.batch([
      context.db
        .prepare(
          `INSERT INTO deployment_status_history
          (deployment_id,sequence,state,reason,actor_subject,correlation_id,occurred_at)
          VALUES (?1,?2,'ready','all required artifacts verified',?3,?4,?5)`,
        )
        .bind(
          deploymentId,
          current.revision + 1,
          context.principal.subject,
          context.correlationId,
          occurredAt,
        ),
      auditStatement(
        context,
        "deployment.ready",
        "deployment",
        deploymentId,
        occurredAt,
        {
          from_state: current.state,
          after_revision: current.revision + 1,
        },
      ),
    ]);
  } catch {
    const raced = await context.db
      .prepare(
        "SELECT state FROM deployment_current_status WHERE deployment_id=?1",
      )
      .bind(deploymentId)
      .first<string>("state");
    if (raced !== "ready") {
      problem(
        500,
        "deployment-readiness-failed",
        "Deployment readiness failed",
        "Verified artifacts exist, but readiness was not recorded.",
      );
    }
  }
}

/** 构造与领域写入同 batch 的不可变 machine audit / Build immutable machine audit in the same batch as its domain write. */
function auditStatement(
  context: DeploymentHttpContext,
  action: string,
  targetType: string,
  targetId: string,
  occurredAt: string,
  details: Record<string, unknown>,
) {
  return context.db
    .prepare(
      `INSERT INTO audit_log
      (audit_id,actor_type,actor_subject,actor_roles_json,action,target_type,target_id,before_revision,
       after_revision,correlation_id,occurred_at,details_json)
      VALUES (?1,'machine',?2,?3,?4,?5,?6,NULL,NULL,?7,?8,?9)`,
    )
    .bind(
      uuidV7(new Date(occurredAt)),
      context.principal.subject,
      JSON.stringify([...context.principal.scopes].sort()),
      action,
      targetType,
      targetId,
      context.correlationId,
      occurredAt,
      canonicalJson(details),
    );
}

/** 解码已验证的十六进制摘要 / Decode an already-validated hexadecimal digest. */
function hexToArrayBuffer(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1)
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes.buffer;
}

/** 把 R2 checksum 转为标准 Base64 / Encode an R2 checksum as canonical Base64. */
function arrayBufferToBase64(value: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

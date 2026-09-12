import { spawnSync } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  buildManifest,
  canonicalJson,
  prepareArtifacts,
  readReleaseConfig,
  sha256,
  type PreparedArtifact,
} from "./provenance.js";

import {
  ArtifactUploadSessionSchema,
  CreateArtifactUploadRequestSchema,
  CreateDeploymentArtifactRequestSchema,
  DeploymentArtifactSchema,
  DeploymentRegistrationSchema,
  dataEnvelope,
  type DeploymentManifest,
} from "../../packages/contracts/src/index.js";

/** 执行发布事务：登记、上传、提交、ready 栅栏，最后才调用 Wrangler。 / Run register/upload/commit/readiness, invoking Wrangler only after the gate. */
export async function deploy(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const options = parseArgs(argv);
  const configPath = path.resolve(options.configPath);
  const config = await readReleaseConfig(configPath);
  const artifacts = await prepareArtifacts(config, configPath);
  const gitCommit = git(["rev-parse", "HEAD"]);
  assertCleanWorktree();
  if (git(["rev-parse", `${config.git_ref}^{commit}`]) !== gitCommit) {
    throw new Error("git_ref does not resolve to the checked-out commit");
  }
  if (
    env.GITHUB_REPOSITORY !== undefined &&
    config.repository_url !== `https://github.com/${env.GITHUB_REPOSITORY}`
  ) {
    throw new Error("repository_url does not match GITHUB_REPOSITORY");
  }
  if (
    env.GITHUB_RUN_ATTEMPT !== undefined &&
    config.release_attempt !== env.GITHUB_RUN_ATTEMPT
  ) {
    throw new Error("release_attempt does not match GITHUB_RUN_ATTEMPT");
  }
  const manifest = buildManifest(config, artifacts, {
    gitCommit,
  });

  if (options.verifyOnly) {
    process.stdout.write(`${canonicalJson(manifest)}\n`);
    return;
  }

  const apiBase = requireHttpsUrl(
    env.MOE_RELEASE_API_URL,
    "MOE_RELEASE_API_URL",
  );
  const token = requireSecret(env.MOE_MACHINE_JWT, "MOE_MACHINE_JWT");
  assertJwtClaims(token, config);
  await registerRelease(
    apiBase,
    token,
    config.release_attempt,
    manifest,
    artifacts,
  );

  const base = await realpath(path.dirname(configPath));
  const wranglerConfig = await realpath(
    path.resolve(base, config.wrangler_config),
  );
  assertWithin(base, wranglerConfig, "wrangler_config escapes release root");
  const entrypoint = await realpath(
    path.resolve(base, config.wrangler_entrypoint),
  );
  const childEnvironment = { ...env };
  delete childEnvironment.MOE_MACHINE_JWT;
  run(
    "pnpm",
    [
      "exec",
      "wrangler",
      "deploy",
      entrypoint,
      "--no-bundle",
      "--upload-source-maps",
      "--strict",
      "--config",
      wranglerConfig,
      "--var",
      `DEPLOYMENT_ID:${config.deployment_id}`,
      "--var",
      `GIT_COMMIT:${gitCommit}`,
      "--var",
      `ARTIFACT_DIGEST:${manifest.artifact_digest}`,
      "--var",
      `STATUS_VERSION:${config.service_version}`,
      "--var",
      `ENVIRONMENT:${config.environment}`,
    ],
    childEnvironment,
  );
}

/** 注册全部不可变字节并执行 ready 栅栏；失败绝不触发部署。 / Register immutable bytes and enforce readiness before deployment. */
export async function registerRelease(
  apiBase: URL,
  token: string,
  releaseAttempt: string,
  manifest: DeploymentManifest,
  artifacts: readonly PreparedArtifact[],
): Promise<void> {
  const deploymentPath = `/v1/deployments/${encodeURIComponent(manifest.deployment_id)}`;
  await jsonRequest(
    apiBase,
    deploymentPath,
    token,
    { method: "PUT", body: manifest },
    dataEnvelope(DeploymentRegistrationSchema),
  );
  for (const artifact of artifacts)
    await registerArtifact(
      apiBase,
      deploymentPath,
      token,
      manifest.deployment_id,
      releaseAttempt,
      artifact,
    );
  const readiness = await jsonRequest(
    apiBase,
    deploymentPath,
    token,
    { method: "PUT", body: manifest },
    dataEnvelope(DeploymentRegistrationSchema),
  );
  if (readiness.state !== "ready")
    throw new Error(`deployment readiness gate failed: ${readiness.state}`);
}

async function registerArtifact(
  apiBase: URL,
  deploymentPath: string,
  token: string,
  deploymentId: string,
  releaseAttempt: string,
  artifact: PreparedArtifact,
): Promise<void> {
  const body = {
    kind: artifact.kind,
    file_name: artifact.file_name,
    media_type: artifact.media_type,
    size_bytes: artifact.size_bytes,
    artifact_digest: artifact.artifact_digest,
    ...(artifact.build_id === undefined ? {} : { build_id: artifact.build_id }),
  };
  // 同一 attempt 的网络重试复用 session；过期后递增 attempt 才申请新 session。
  // Network retries within an attempt reuse the session; increment the attempt only after expiry.
  const stableKey = `release:${deploymentId}:${releaseAttempt}:${sha256(canonicalJson(body)).slice(7, 39)}`;
  const session = await jsonRequest(
    apiBase,
    `${deploymentPath}/artifact-uploads`,
    token,
    {
      method: "POST",
      body: CreateArtifactUploadRequestSchema.parse({
        ...body,
        content_md5: artifact.content_md5,
      }),
      headers: { "idempotency-key": stableKey },
    },
    dataEnvelope(ArtifactUploadSessionSchema),
  );
  const expectedHeaders = {
    "content-type": artifact.media_type,
    "content-length": String(artifact.size_bytes),
    "content-md5": artifact.content_md5,
    "x-amz-meta-deployment-id": deploymentId,
    "x-amz-meta-artifact-digest": artifact.artifact_digest,
    "x-amz-meta-artifact-kind": artifact.kind,
    "x-amz-meta-artifact-file-name": artifact.file_name,
  };
  for (const [name, value] of Object.entries(expectedHeaders)) {
    if (new Headers(session.required_headers).get(name) !== value)
      throw new Error("upload session does not match immutable artifact");
  }
  if (Date.parse(session.expires_at) <= Date.now())
    throw new Error("upload session expired; increment release_attempt");
  const upload = await fetch(session.upload_url, {
    method: "PUT",
    redirect: "error",
    signal: AbortSignal.timeout(120_000),
    headers: session.required_headers,
    body: Buffer.from(artifact.bytes),
  });
  await upload.body?.cancel();
  // 412 表示不可变 object key 已存在（常见于 session 续签）；commit 的服务端 HEAD/digest 才是权威验证。
  // 412 means the immutable key already exists (often after renewal); server-side HEAD/digest at commit is authoritative.
  if (!upload.ok && upload.status !== 412)
    throw new Error(
      `artifact upload failed (${upload.status}) for ${artifact.file_name}`,
    );
  await jsonRequest(
    apiBase,
    `${deploymentPath}/artifacts`,
    token,
    {
      method: "POST",
      body: CreateDeploymentArtifactRequestSchema.parse({
        upload_id: session.upload_id,
        ...body,
      }),
    },
    dataEnvelope(DeploymentArtifactSchema),
  );
}

async function jsonRequest<T>(
  base: URL,
  pathname: string,
  token: string,
  request: {
    readonly method: "PUT" | "POST";
    readonly body: unknown;
    readonly headers?: Record<string, string>;
  },
  schema: { parse(value: unknown): { data: T } },
): Promise<T> {
  const response = await fetch(new URL(pathname, base), {
    method: request.method,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...request.headers,
    },
    body: canonicalJson(request.body),
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(
      `registry request failed (${response.status}) at ${pathname}: ${redactProblem(text)}`,
    );
  return schema.parse(JSON.parse(text)).data;
}

function parseArgs(argv: readonly string[]): {
  configPath: string;
  verifyOnly: boolean;
} {
  let configPath = "";
  let verifyOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--verify-only") verifyOnly = true;
    else if (argument === "--config") configPath = argv[++index] ?? "";
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (configPath === "")
    throw new Error(
      "usage: tsx scripts/release/deploy.ts --config <release.json> [--verify-only]",
    );
  return { configPath, verifyOnly };
}

function assertJwtClaims(
  token: string,
  config: Awaited<ReturnType<typeof readReleaseConfig>>,
): void {
  const segments = token.split(".");
  if (segments.length !== 3)
    throw new Error("MOE_MACHINE_JWT is not a compact JWT");
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(
      Buffer.from(segments[1]!, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
  } catch {
    throw new Error("MOE_MACHINE_JWT has an invalid payload");
  }
  const scopes =
    typeof payload.scope === "string"
      ? new Set(payload.scope.split(" "))
      : new Set<string>();
  if (
    payload.deployment_id !== config.deployment_id ||
    payload.service_name !== config.service_name ||
    payload.environment !== config.environment
  ) {
    throw new Error(
      "machine JWT claims do not match deployment_id, service_name, and environment",
    );
  }
  if (!scopes.has("deployments:write") || !scopes.has("artifacts:write"))
    throw new Error("machine JWT lacks release scopes");
  const now = Math.floor(Date.now() / 1000);
  if (
    typeof payload.iat !== "number" ||
    typeof payload.exp !== "number" ||
    payload.exp - payload.iat > 900
  )
    throw new Error("machine JWT must have a maximum 15-minute lifetime");
  if (typeof payload.exp !== "number" || payload.exp <= now + 600)
    throw new Error(
      "machine JWT is expired or has less than 10 minutes remaining",
    );
}

function requireHttpsUrl(value: string | undefined, name: string): URL {
  if (value === undefined) throw new Error(`${name} is required`);
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  )
    throw new Error(`${name} must use HTTPS without credentials or fragments`);
  return url;
}

function requireSecret(value: string | undefined, name: string): string {
  if (value === undefined || value.length < 16)
    throw new Error(`${name} is missing or too short`);
  return value;
}

function assertCleanWorktree(): void {
  if (git(["status", "--porcelain", "--untracked-files=no"]) !== "")
    throw new Error(
      "tracked worktree changes would make source provenance ambiguous",
    );
}

function git(args: readonly string[]): string {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed`);
  return result.stdout.trim();
}

function run(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): void {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    windowsHide: true,
    env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${command} failed with exit status ${result.status ?? "unknown"}`,
    );
}

function redactProblem(text: string): string {
  if (text.length === 0) return "empty response";
  try {
    const value = JSON.parse(text) as {
      type?: unknown;
      title?: unknown;
      correlation_id?: unknown;
    };
    return JSON.stringify({
      type: value.type,
      title: value.title,
      correlation_id: value.correlation_id,
    });
  } catch {
    return "non-JSON error body suppressed";
  }
}

function assertWithin(base: string, candidate: string, message: string): void {
  const relative = path.relative(base, candidate);
  if (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  )
    return;
  throw new Error(message);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  deploy(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(
      `release failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
    process.exitCode = 1;
  });
}

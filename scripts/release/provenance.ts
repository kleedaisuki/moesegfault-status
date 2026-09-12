import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import {
  DeploymentManifestSchema,
  SOURCE_MAP_MAX_BYTES,
  type ArtifactKind,
  type DeploymentManifest,
} from "../../packages/contracts/src/index.js";

/** 发布配置中的文件声明。 / File declaration in release configuration. */
export interface ReleaseArtifactInput {
  /** 相对于配置文件的路径。 / Path relative to the configuration file. */
  readonly path: string;
  /** 注册表中的产物类别。 / Artifact kind recorded in the registry. */
  readonly kind: ArtifactKind;
  /** 规范 MIME 类型。 / Canonical MIME type. */
  readonly media_type: string;
  /** 原生产物 Build ID；binary/debug_symbols 必填。 / Native build ID; required for binary/debug_symbols. */
  readonly build_id?: string;
}

/** 人工可审计的发布输入；秘密不得写入此结构。 / Human-auditable release input; secrets never belong here. */
export interface ReleaseConfig {
  readonly deployment_id: string;
  readonly service_name: string;
  readonly environment: "development" | "test" | "staging" | "production";
  readonly service_version: string;
  readonly repository_url: string;
  readonly git_ref: string;
  /** 第一次发布尝试前固定，重试不得变化。 / Fixed before the first attempt and unchanged on retries. */
  readonly deployed_at: string;
  readonly ci_provider: string;
  readonly ci_run_id: string;
  /** 上传 session 到期后递增；不进入 immutable Manifest。 / Increment after upload-session expiry; excluded from the immutable manifest. */
  readonly release_attempt: string;
  readonly region: readonly string[];
  readonly artifacts: readonly ReleaseArtifactInput[];
  /** Wrangler 配置路径，相对于发布配置。 / Wrangler config path relative to this release config. */
  readonly wrangler_config: string;
  /** 已构建且已声明的入口；使用 --no-bundle 保证登记字节等于部署字节。 / Declared prebuilt entrypoint deployed with --no-bundle. */
  readonly wrangler_entrypoint: string;
  /** Worker 发布必须显式登记 source map。 / Worker releases must explicitly register a source map. */
  readonly require_source_map: boolean;
}

/** 已读取的产物及其内容寻址元数据。 / Loaded artifact and its content-addressed metadata. */
export interface PreparedArtifact {
  readonly absolutePath: string;
  readonly bytes: Uint8Array;
  readonly kind: ArtifactKind;
  readonly file_name: string;
  readonly media_type: string;
  readonly size_bytes: number;
  readonly artifact_digest: `sha256:${string}`;
  /** 传输校验，不进入 Manifest。 / Transport checksum, excluded from the manifest. */
  readonly content_md5: string;
  readonly build_id?: string;
  /** Wrangler 实际入口。 / Exact Wrangler entrypoint. */
  readonly entrypoint: boolean;
}

/** 构建 Manifest 所需的不可伪造 CI/Git 元数据。 / Non-secret CI/Git metadata required to build a manifest. */
export interface ProvenanceContext {
  readonly gitCommit: string;
}

/** 对字节生成契约格式的 SHA-256 摘要。 / Hash bytes into the contract's SHA-256 form. */
export function sha256(bytes: Uint8Array | string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** 使用排序键生成稳定 JSON；数组顺序具有领域含义。 / Produce stable JSON with sorted keys; array order remains semantic. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

/** 读取并校验发布配置，不接受未知的秘密字段。 / Read and validate release config; secret-shaped fields are rejected. */
export async function readReleaseConfig(
  configPath: string,
): Promise<ReleaseConfig> {
  const raw = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  if (!isRecord(raw)) throw new Error("release config must be a JSON object");
  for (const forbidden of [
    "token",
    "secret",
    "password",
    "api_key",
    "machine_jwt",
  ]) {
    if (forbidden in raw)
      throw new Error(
        `release config must not contain secret field: ${forbidden}`,
      );
  }
  const allowed = new Set([
    "deployment_id",
    "service_name",
    "environment",
    "service_version",
    "repository_url",
    "git_ref",
    "deployed_at",
    "ci_provider",
    "ci_run_id",
    "release_attempt",
    "region",
    "artifacts",
    "wrangler_config",
    "wrangler_entrypoint",
    "require_source_map",
  ]);
  for (const key of Object.keys(raw))
    if (!allowed.has(key))
      throw new Error(`unknown release config field: ${key}`);
  if (!Array.isArray(raw.artifacts) || raw.artifacts.length === 0)
    throw new Error("at least one artifact is required");
  const config = raw as unknown as ReleaseConfig;
  for (const [index, artifact] of config.artifacts.entries())
    validateArtifactInput(artifact, index);
  if (
    typeof config.wrangler_config !== "string" ||
    typeof config.wrangler_entrypoint !== "string"
  ) {
    throw new Error(
      "wrangler_config and wrangler_entrypoint are required strings",
    );
  }
  if (typeof config.require_source_map !== "boolean")
    throw new Error("require_source_map must be explicit");
  if (!/^[1-9][0-9]{0,8}$/u.test(config.release_attempt))
    throw new Error(
      "release_attempt must be a positive decimal attempt number",
    );
  return config;
}

/** 读取不可变发布字节并验证 source map 的基本来源结构。 / Load immutable release bytes and validate source-map provenance structure. */
export async function prepareArtifacts(
  config: ReleaseConfig,
  configPath: string,
): Promise<readonly PreparedArtifact[]> {
  const base = await realpath(path.dirname(path.resolve(configPath)));
  const prepared: PreparedArtifact[] = [];
  const identities = new Set<string>();
  for (const artifact of config.artifacts) {
    const absolutePath = await realpath(path.resolve(base, artifact.path));
    assertWithin(
      base,
      absolutePath,
      `artifact path escapes release root: ${artifact.path}`,
    );
    const metadata = await stat(absolutePath);
    if (!metadata.isFile() || metadata.size <= 0)
      throw new Error(
        `artifact must be a non-empty regular file: ${artifact.path}`,
      );
    const fileName = path.basename(absolutePath);
    if (/^(?:\.env(?:\..*)?|.*\.(?:key|pem|p12|pfx))$/iu.test(fileName))
      throw new Error(
        `secret-shaped file cannot be a release artifact: ${fileName}`,
      );
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(fileName))
      throw new Error(`unsafe artifact file name: ${fileName}`);
    const identity = `${artifact.kind}:${fileName}`;
    if (identities.has(identity))
      throw new Error(`duplicate artifact identity: ${identity}`);
    identities.add(identity);
    const bytes = await readFile(absolutePath);
    if (artifact.kind === "source_map") validateSourceMap(bytes, fileName);
    prepared.push({
      absolutePath,
      bytes,
      kind: artifact.kind,
      file_name: fileName,
      media_type: artifact.media_type,
      size_bytes: bytes.byteLength,
      artifact_digest: sha256(bytes),
      content_md5: createHash("md5").update(bytes).digest("base64"),
      ...(artifact.build_id === undefined
        ? {}
        : { build_id: artifact.build_id }),
      entrypoint: false,
    });
  }
  if (
    config.require_source_map &&
    !prepared.some(({ kind }) => kind === "source_map")
  ) {
    throw new Error(
      "require_source_map is true but no source_map artifact was declared",
    );
  }
  const entrypoint = await realpath(
    path.resolve(base, config.wrangler_entrypoint),
  );
  assertWithin(base, entrypoint, "wrangler_entrypoint escapes release root");
  const entrypointIndex = prepared.findIndex(
    ({ absolutePath }) => absolutePath === entrypoint,
  );
  if (entrypointIndex < 0) {
    throw new Error(
      "wrangler_entrypoint must be one of the content-addressed artifacts",
    );
  }
  if (!["binary", "other"].includes(prepared[entrypointIndex]!.kind)) {
    throw new Error(
      "wrangler_entrypoint must be the binary or other runtime artifact",
    );
  }
  const runtimes = prepared.filter(({ kind }) =>
    ["binary", "other"].includes(kind),
  );
  if (runtimes.length !== 1) {
    throw new Error(
      "release must declare exactly one binary or other runtime artifact",
    );
  }
  const entrypointMapName = `${prepared[entrypointIndex]!.file_name}.map`;
  const javaScriptRuntime = [
    "application/javascript",
    "text/javascript",
  ].includes(prepared[entrypointIndex]!.media_type);
  if (
    (config.require_source_map || javaScriptRuntime) &&
    !prepared.some(
      ({ kind, file_name: fileName }) =>
        kind === "source_map" && fileName === entrypointMapName,
    )
  ) {
    throw new Error(
      `required entrypoint source map was not declared: ${entrypointMapName}`,
    );
  }
  if (config.require_source_map || javaScriptRuntime) {
    const entrypointText = new TextDecoder().decode(
      prepared[entrypointIndex]!.bytes,
    );
    if (!entrypointText.includes(`sourceMappingURL=${entrypointMapName}`)) {
      throw new Error(
        `runtime does not link its registered source map: ${entrypointMapName}`,
      );
    }
  }
  prepared[entrypointIndex] = {
    ...prepared[entrypointIndex]!,
    entrypoint: true,
  };
  return prepared;
}

/** 由已哈希字节构建严格的不可变部署 Manifest。 / Build a strict immutable deployment manifest from hashed bytes. */
export function buildManifest(
  config: ReleaseConfig,
  artifacts: readonly PreparedArtifact[],
  context: ProvenanceContext,
): DeploymentManifest {
  const declarations = artifacts.map((artifact) => ({
    kind: artifact.kind,
    file_name: artifact.file_name,
    media_type: artifact.media_type,
    size_bytes: artifact.size_bytes,
    artifact_digest: artifact.artifact_digest,
    ...(artifact.build_id === undefined ? {} : { build_id: artifact.build_id }),
  }));
  const entrypoint = artifacts.find((artifact) => artifact.entrypoint);
  if (entrypoint === undefined)
    throw new Error("prepared artifacts lack a Wrangler entrypoint");
  return DeploymentManifestSchema.parse({
    deployment_id: config.deployment_id,
    service_name: config.service_name,
    environment: config.environment,
    service_version: config.service_version,
    repository_url: config.repository_url,
    git_commit: context.gitCommit,
    git_ref: config.git_ref,
    // 顶层 digest 指向实际部署入口；依赖文件由 artifacts 列表逐一内容寻址。
    // The top-level digest identifies deployed entry bytes; dependencies are individually content-addressed below.
    artifact_digest: entrypoint.artifact_digest,
    ci_provider: config.ci_provider,
    ci_run_id: config.ci_run_id,
    deployed_at: config.deployed_at,
    region: [...config.region],
    artifacts: declarations,
  });
}

function validateArtifactInput(
  value: unknown,
  index: number,
): asserts value is ReleaseArtifactInput {
  if (!isRecord(value))
    throw new Error(`artifacts[${index}] must be an object`);
  const allowed = new Set(["path", "kind", "media_type", "build_id"]);
  for (const key of Object.keys(value))
    if (!allowed.has(key))
      throw new Error(`unknown artifacts[${index}] field: ${key}`);
  if (typeof value.path !== "string" || value.path.length === 0)
    throw new Error(`artifacts[${index}].path is required`);
  if (
    ![
      "binary",
      "debug_symbols",
      "source_map",
      "sbom",
      "manifest",
      "other",
    ].includes(String(value.kind))
  ) {
    throw new Error(`artifacts[${index}].kind is invalid`);
  }
  if (
    typeof value.media_type !== "string" ||
    !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu.test(value.media_type)
  ) {
    throw new Error(`artifacts[${index}].media_type is invalid`);
  }
  if (
    (value.kind === "binary" || value.kind === "debug_symbols") &&
    typeof value.build_id !== "string"
  ) {
    throw new Error(
      `artifacts[${index}].build_id is required for ${value.kind}`,
    );
  }
}

function validateSourceMap(bytes: Uint8Array, fileName: string): void {
  if (bytes.byteLength > SOURCE_MAP_MAX_BYTES)
    throw new Error("source map exceeds 8 MiB");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error(`source map is not JSON: ${fileName}`);
  }
  if (
    !isRecord(value) ||
    value.version !== 3 ||
    typeof value.mappings !== "string" ||
    (value.file !== undefined && value.file !== fileName.slice(0, -4)) ||
    !Array.isArray(value.sources) ||
    value.sources.length === 0
  ) {
    throw new Error(
      `source map must use version 3 and name at least one source: ${fileName}`,
    );
  }
  for (const source of value.sources) {
    if (
      typeof source !== "string" ||
      source.length === 0 ||
      path.isAbsolute(source) ||
      /^[a-z][a-z0-9+.-]*:/iu.test(source)
    ) {
      throw new Error(
        `source map contains an unsafe or non-reproducible source path: ${fileName}`,
      );
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

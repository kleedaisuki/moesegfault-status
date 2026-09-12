import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const SERVICES = Object.freeze({
  status: Object.freeze({
    serviceName: "status",
    region: Object.freeze(["global"]),
  }),
  ops: Object.freeze({
    serviceName: "ops-gateway",
    region: Object.freeze(["global"]),
  }),
  probe: Object.freeze({
    serviceName: "probe-executor",
    region: Object.freeze(["asia"]),
  }),
});

/**
 * 生成 RFC 9562 UUIDv7；时间负责排序，剩余位来自密码学随机源。
 * Generate an RFC 9562 UUIDv7; time provides ordering and remaining bits use cryptographic randomness.
 *
 * @param {Date} now 冻结的发布时间 / Frozen release time.
 * @param {(size: number) => Uint8Array} entropy 随机字节源 / Random-byte source.
 * @returns {string} 小写规范 UUIDv7 / Lowercase canonical UUIDv7.
 */
export function uuidV7(now, entropy = randomBytes) {
  const milliseconds = now.getTime();
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 0 ||
    milliseconds >= 2 ** 48
  ) {
    throw new Error("release time is outside the UUIDv7 range");
  }
  const bytes = Uint8Array.from(entropy(16));
  if (bytes.byteLength !== 16)
    throw new Error("UUID entropy source must return 16 bytes");
  let timestamp = BigInt(milliseconds);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = 0x70 | (bytes[6] & 0x0f);
  bytes[8] = 0x80 | (bytes[8] & 0x3f);
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * 从显式 CI 身份构建不含秘密的 status-build 模板。
 * Build a secret-free status-build template from explicit CI identity.
 *
 * @param {{service: string, version: string, now: Date, head: string, env: NodeJS.ProcessEnv, entropy?: (size: number) => Uint8Array}} input 输入 / Input.
 * @returns {Record<string, unknown>} 严格发布 metadata / Strict release metadata.
 */
export function buildMetadata({
  service,
  version,
  now,
  head,
  env,
  entropy = randomBytes,
}) {
  const target = SERVICES[service];
  if (target === undefined)
    throw new Error("service must be one of: status, ops, probe");
  if (
    typeof version !== "string" ||
    !/^[0-9A-Za-z](?:[0-9A-Za-z._+-]{0,126}[0-9A-Za-z])?$/u.test(version)
  ) {
    throw new Error("version must be 1-128 safe visible characters");
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime()))
    throw new Error("release time is invalid");
  if (env.GITHUB_ACTIONS !== "true")
    throw new Error("metadata may only be generated in GitHub Actions");
  if (env.GITHUB_REF !== "refs/heads/main")
    throw new Error("production releases require refs/heads/main");
  if (
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(head) ||
    env.GITHUB_SHA !== head
  ) {
    throw new Error("GITHUB_SHA must equal the checked-out Git HEAD");
  }
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(env.GITHUB_REPOSITORY ?? "")
  ) {
    throw new Error("GITHUB_REPOSITORY is invalid");
  }
  if (!/^[1-9][0-9]{0,19}$/u.test(env.GITHUB_RUN_ID ?? ""))
    throw new Error("GITHUB_RUN_ID is invalid");
  if (!/^[1-9][0-9]{0,8}$/u.test(env.GITHUB_RUN_ATTEMPT ?? "")) {
    throw new Error("GITHUB_RUN_ATTEMPT is invalid");
  }

  return {
    deployment_id: uuidV7(now, entropy),
    // 构建目录选择器不是领域身份；telemetry、JWT 与 catalog 必须使用真实 service.name。
    // The build-directory selector is not domain identity; telemetry, JWT, and catalog use the real service.name.
    service_name: target.serviceName,
    environment: "production",
    service_version: version,
    repository_url: `https://github.com/${env.GITHUB_REPOSITORY}`,
    // 精确 commit ref 在 detached checkout 中仍可解析，且不会随 main 前移。
    // The exact commit ref resolves in detached checkouts and cannot move with main.
    git_ref: head,
    deployed_at: now.toISOString(),
    ci_provider: "github-actions",
    ci_run_id: env.GITHUB_RUN_ID,
    release_attempt: env.GITHUB_RUN_ATTEMPT,
    region: [...target.region],
    status_origin: "https://status.moesegfault.dev",
    machine_jwks: "config/machine-jwks.json",
  };
}

/**
 * 解析固定的无 shell CLI 参数，拒绝未知参数和重复参数。
 * Parse fixed shell-free CLI arguments, rejecting unknown and duplicate arguments.
 *
 * @param {readonly string[]} argv 参数 / Arguments.
 * @returns {{service: string, version: string, output: string}} 已解析参数 / Parsed arguments.
 */
export function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      !["--service", "--version", "--output"].includes(flag) ||
      value === undefined ||
      value.startsWith("--")
    ) {
      throw new Error(
        "usage: prepare-metadata.mjs --service <status|ops|probe> --version <version> --output <file>",
      );
    }
    if (values.has(flag)) throw new Error(`duplicate argument: ${flag}`);
    values.set(flag, value);
  }
  if (values.size !== 3) {
    throw new Error(
      "usage: prepare-metadata.mjs --service <status|ops|probe> --version <version> --output <file>",
    );
  }
  return {
    service: values.get("--service"),
    version: values.get("--version"),
    output: values.get("--output"),
  };
}

/**
 * 以独占创建方式写 metadata；拒绝覆盖使单次尝试的时间和 UUID 保持冻结。
 * Write metadata with exclusive creation; refusing overwrite keeps one attempt's time and UUID frozen.
 *
 * @param {string} output 输出路径 / Output path.
 * @param {Record<string, unknown>} metadata 发布 metadata / Release metadata.
 * @returns {Promise<void>}
 */
export async function writeMetadata(output, metadata) {
  if (
    typeof output !== "string" ||
    output.length === 0 ||
    output.includes("\0")
  )
    throw new Error("output path is invalid");
  await writeFile(
    path.resolve(output),
    `${JSON.stringify(metadata, null, 2)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
}

/** 执行 secret-free metadata 生成。 / Execute secret-free metadata generation. */
export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  const metadata = buildMetadata({
    service: args.service,
    version: args.version,
    now: new Date(),
    head,
    env,
  });
  await writeMetadata(args.output, metadata);
  process.stdout.write(
    `wrote secret-free release metadata for ${args.service}\n`,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(
      `metadata generation failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
    process.exitCode = 1;
  });
}

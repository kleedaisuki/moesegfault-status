import { execFileSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
  realpathSync,
  statSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

/** 固定引导目标，不能通过输入指定其他 Worker。 / Fixed bootstrap targets, never arbitrary Workers. */
const targets = {
  status: [
    "wrangler.jsonc",
    "moesegfault-status",
    "dist/rust/status/status.js",
  ],
  probe: [
    "workers/probe-executor/wrangler.jsonc",
    "moesegfault-probe-asia",
    "dist/rust/probe/probe.js",
  ],
};

/** 仅保留代码与绑定配置，绝不继承发布触发器。 / Allowlist code and bindings, never publication triggers. */
export function prepareConfig(source, service, root) {
  const target = targets[service];
  if (
    !target ||
    source.name !== target[1] ||
    source.no_bundle !== true ||
    source.build ||
    source.assets
  )
    throw new Error("Unsupported bootstrap configuration");
  const expected = resolve(root, target[2]);
  if (resolve(root, dirname(target[0]), source.main) !== expected)
    throw new Error("Unexpected Rust entrypoint");
  const allowed = [
    "name",
    "account_id",
    "compatibility_date",
    "compatibility_flags",
    "no_bundle",
    "find_additional_modules",
    "preserve_file_names",
    "upload_source_maps",
    "rules",
    "placement",
    "observability",
    "version_metadata",
    "r2_buckets",
    "analytics_engine_datasets",
    "d1_databases",
  ];
  const config = Object.fromEntries(
    allowed
      .filter((key) => source[key] !== undefined)
      .map((key) => [key, structuredClone(source[key])]),
  );
  config.main = expected;
  config.base_dir = dirname(expected);
  config.vars = {
    ...source.vars,
    ENVIRONMENT: "production",
    DEPLOYMENT_ID: "",
    GIT_COMMIT: "",
    ARTIFACT_DIGEST: "",
  };
  if (service === "status") {
    config.vars.BOOTSTRAP_MODE = "true";
    config.secrets = {
      required: ["ADMIN_PASSWORD_RECORD", "ADMIN_EMAIL", "CURSOR_SIGNING_KEY"],
    };
    if (source.queues?.producers)
      config.queues = { producers: structuredClone(source.queues.producers) };
    for (const database of config.d1_databases ?? [])
      database.migrations_dir = resolve(
        root,
        dirname(target[0]),
        database.migrations_dir,
      );
  } else {
    config.vars.PROBE_ALLOWED_HOSTS = "[]";
    config.vars.PROBE_ALLOWED_TCP_PORTS = "[]";
    config.vars.PROBE_BINDING_CONFIG = "{}";
    config.workers_dev = false;
    config.preview_urls = false;
  }
  if (
    Object.keys(config.vars).some((key) =>
      /PASSWORD|ADMIN_EMAIL|SECRET|TOKEN|PRIVATE_KEY|SIGNING_KEY/.test(key),
    )
  )
    throw new Error("Secret-like ordinary variable rejected");
  return config;
}

/** 只允许仍在引导中的既有状态服务，探针必须尚不存在。 / Require bootstrap status or an absent private probe. */
export function assertRemoteState(service, response) {
  if (service === "probe") {
    if (
      response.status === 404 &&
      response.body?.success === false &&
      response.body.errors?.some((error) => error.code === 10007)
    )
      return;
    throw new Error(
      "Private probe must not already exist; use the normal release workflow",
    );
  }
  const bindings = response.body?.result?.bindings;
  const bootstrap =
    Array.isArray(bindings) &&
    bindings.filter((binding) => binding.name === "BOOTSTRAP_MODE");
  if (
    response.status !== 200 ||
    response.body?.success !== true ||
    !bootstrap ||
    bootstrap.length !== 1 ||
    bootstrap[0].type !== "plain_text" ||
    bootstrap[0].text !== "true"
  )
    throw new Error("Existing status Worker is not strictly in bootstrap mode");
}

/** 从本次结构化回执提取唯一版本，不猜 latest。 / Extract one exact version from this upload receipt. */
export function uploadedVersion(receipt) {
  const records = receipt
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
    .filter((record) => record.type === "version-upload");
  if (
    records.length !== 1 ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(
      records[0].version_id,
    )
  )
    throw new Error("Invalid version receipt");
  return records[0].version_id;
}

/** 隔离秘密并抑制 Wrangler 原始输出。 / Isolate secrets and suppress raw Wrangler output. */
export function childEnvironment(environment) {
  const result = {};
  for (const key of [
    "PATH",
    "HOME",
    "USERPROFILE",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
  ])
    if (environment[key]) result[key] = environment[key];
  return { ...result, CI: "true", WRANGLER_SEND_METRICS: "false" };
}

/** Actions 专用受限引导；不注册 ready、不执行 DNS API。 / Actions-only bootstrap, never registry-ready or DNS management.
 * @example node scripts/operations/prepare-bootstrap.mjs status
 */
async function main() {
  const service = process.argv[2];
  if (
    process.argv.length !== 3 ||
    !targets[service] ||
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_REF !== "refs/heads/main"
  )
    throw new Error("Bootstrap requires a main-branch Actions dispatch");
  const root = realpathSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
  );
  const { experimental_readRawConfig } = await import("wrangler");
  const sourcePath = resolve(root, targets[service][0]);
  const parsed = experimental_readRawConfig({ config: sourcePath });
  if (parsed.redirected || realpathSync(parsed.configPath) !== sourcePath)
    throw new Error("Redirected configuration rejected");
  const config = prepareConfig(parsed.rawConfig, service, root);
  if (
    realpathSync(config.main) !== config.main ||
    !statSync(config.main).isFile()
  )
    throw new Error("Invalid built Rust entrypoint");
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (
    !token ||
    account !== config.account_id ||
    !/^[a-f0-9]{32}$/.test(account)
  )
    throw new Error("Missing or mismatched deployment credentials");
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${config.name}/settings`,
    {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    },
  );
  assertRemoteState(service, {
    status: response.status,
    body: await response.json(),
  });
  const directory = mkdtempSync(join(tmpdir(), "moe-bootstrap-"));
  try {
    const path = join(directory, "wrangler.json");
    const receipt = join(directory, "receipt.jsonl");
    writeFileSync(path, JSON.stringify(config), { mode: 0o600, flag: "wx" });
    const env = childEnvironment(process.env);
    const run = (args, input) => {
      try {
        execFileSync(
          process.execPath,
          [
            resolve(root, "node_modules/wrangler/bin/wrangler.js"),
            ...args,
            "--config",
            path,
          ],
          {
            cwd: root,
            env: { ...env, WRANGLER_OUTPUT_FILE_PATH: receipt },
            input,
            stdio: ["pipe", "pipe", "pipe"],
            timeout: 600000,
          },
        );
      } catch {
        throw new Error(
          "Bootstrap Wrangler command failed; child output suppressed",
        );
      }
    };
    if (service === "probe") {
      run(["deploy"]);
      console.log(
        JSON.stringify({
          service,
          state: "private-bootstrap-created",
          production_ready: false,
        }),
      );
      return;
    }
    const cursor = process.env.CURSOR_SIGNING_KEY;
    if (!cursor || cursor.length < 32)
      throw new Error("Runtime cursor secret missing");
    run(["secret", "bulk"], JSON.stringify({ CURSOR_SIGNING_KEY: cursor }));
    run(["versions", "upload"]);
    const version = uploadedVersion(readFileSync(receipt, "utf8"));
    run(["versions", "deploy", `${version}@100%`, "-y"]);
    console.log(
      JSON.stringify({
        service,
        state: "bootstrap-updated",
        version_id: version,
        production_ready: false,
      }),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch(() => {
    console.error(
      "Bootstrap refused or failed; no raw provider output or secrets are printed.",
    );
    process.exitCode = 1;
  });
}

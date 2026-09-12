/**
 * 本机预置唯一管理员；永不注册首位访问者、输出密码或交给 CI。
 * Provision the sole administrator locally; never enroll visitors or expose secrets to CI.
 * 只接受系统生成的 24 字节随机密码，不提供人工密码参数或环境变量入口。
 * Only generate 24 random bytes; no human-password argument or environment input.
 * Usage / 用法: node scripts/operations/admin-secret.mjs create|upload [--directory PRIVATE_DIR]
 * Rotation / 轮换: create into a NEW private directory, upload after verifying the target,
 * then verify new login and old-session rejection at 100% traffic before retiring old files.
 * 在新私密目录生成后上传；确认全量流量使用新 Secret、新登录成功且旧会话失效，再销毁旧文件。
 */
import { randomBytes, pbkdf2Sync } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import {
  basename,
  dirname,
  join,
  relative,
  resolve,
  isAbsolute,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

/** 固定仓库与 CLI，禁止通过参数重定向部署。 / Fixed repository and deployment CLI. */
const repository = realpathSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
);
/** 仅用于生成的 192-bit 随机凭据；不是人类密码策略。 / Only for generated 192-bit secrets, not human passwords. */
const iterations = 100000;
const passwordBytes = 24;
const passwordName = "administrator-login.txt";
const secretName = "status-worker-secrets.json";

/** 判断目录包含关系，不将同名前缀误认为子目录。 / Compare directory boundaries, not name prefixes. */
function contains(parent, child) {
  const delta = relative(parent, child);
  return (
    !delta ||
    (delta !== ".." && !delta.startsWith(`..${sep}`) && !isAbsolute(delta))
  );
}

/** 默认凭据仅在 Git 忽略的本机目录保存。 / Default credentials live only in the Git-ignored local directory. */
export const defaultDirectory = join(repository, ".local", "credentials");

/** 检查真实祖先及 Git 状态，拒绝仓库路径别名和链接逃逸。 / Check canonical ancestors and Git state; reject repository aliases and escapes. */
export function privateDirectory(input) {
  const path = resolve(input);
  let ancestor = path;
  const missing = [];
  while (!existsSync(ancestor)) {
    missing.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }
  const canonical = resolve(realpathSync(ancestor), ...missing);
  if (!contains(repository, path) && !contains(repository, canonical))
    return canonical;
  if (
    !contains(defaultDirectory, path) ||
    !contains(defaultDirectory, canonical) ||
    relative(path, canonical)
  )
    throw new Error(
      "Repository credentials require the canonical .local/credentials directory.",
    );
  try {
    const tracked = run("git", ["ls-files", "-z", "--", ".local/credentials"]);
    if (tracked) throw new Error("Tracked credential files.");
    // Verify the directory rule itself, including before the directory exists. / 创建前也验证目录本身被忽略。
    run("git", [
      "check-ignore",
      "--quiet",
      "--no-index",
      "--",
      relative(repository, canonical).split(sep).join("/") + "/",
    ]);
  } catch {
    throw new Error(
      "Repository credentials must be Git-ignored and contain no tracked files.",
    );
  }
  return canonical;
}

/** 无 shell、无凭据日志。 / No shell expansion or credential output. */
function run(command, args) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    cwd: repository,
  });
}

/** 在写入前设置仅本人/SYSTEM 权限。 / Restrict access before writing any secret bytes. */
function secureDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    chmodSync(path, 0o700);
    return;
  }
  const script =
    "$ErrorActionPreference='Stop'; $p=$env:ADMIN_PRIVATE_DIRECTORY; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $a=New-Object System.Security.AccessControl.DirectorySecurity; $a.SetOwner($sid); $a.SetAccessRuleProtection($true,$false); foreach($s in @($sid,([System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')))) { $r=[System.Security.AccessControl.FileSystemAccessRule]::new($s,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $a.AddAccessRule($r) }; [System.IO.Directory]::SetAccessControl($p,$a)";
  execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      env: { ...process.env, ADMIN_PRIVATE_DIRECTORY: path },
      stdio: "pipe",
      windowsHide: true,
    },
  );
}

/** 上传前检查 Windows ACL，不悄悄修复可能已泄露的文件。 / Check Windows ACLs without repairing potentially exposed files. */
function verifyWindowsPermissions(path, file) {
  if (process.platform !== "win32") return;
  const script =
    "$ErrorActionPreference='Stop'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; foreach($p in @($env:ADMIN_PRIVATE_DIRECTORY,$env:ADMIN_PRIVATE_FILE)) { $a=if([System.IO.Directory]::Exists($p)){[System.IO.Directory]::GetAccessControl($p)}else{[System.IO.File]::GetAccessControl($p)}; foreach($r in $a.Access) { $s=$r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; if($r.AccessControlType -eq 'Allow' -and $s -ne $sid -and $s -ne 'S-1-5-18') { throw 'Non-private credential ACL' } } }";
  execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      env: {
        ...process.env,
        ADMIN_PRIVATE_DIRECTORY: path,
        ADMIN_PRIVATE_FILE: file,
      },
      stdio: "pipe",
      windowsHide: true,
    },
  );
}

/** 精确验证冻结的记录格式；盐和摘要必须为规范 base64url。 / Validate the frozen canonical record format. */
export function validateSecret(value) {
  if (
    !value ||
    Array.isArray(value) ||
    Object.keys(value).join() !== "ADMIN_PASSWORD_RECORD" ||
    typeof value.ADMIN_PASSWORD_RECORD !== "string"
  )
    throw new Error("Invalid secret envelope.");
  const record = JSON.parse(value.ADMIN_PASSWORD_RECORD);
  if (
    !record ||
    Array.isArray(record) ||
    Object.keys(record).sort().join() !== "algorithm,hash,iterations,salt" ||
    record.algorithm !== "PBKDF2-SHA256" ||
    record.iterations !== iterations
  )
    throw new Error("Invalid password record.");
  for (const [key, bytes] of [
    ["salt", 16],
    ["hash", 32],
  ]) {
    const text = record[key];
    if (
      typeof text !== "string" ||
      !/^[A-Za-z0-9_-]+$/.test(text) ||
      Buffer.from(text, "base64url").length !== bytes ||
      Buffer.from(text, "base64url").toString("base64url") !== text
    )
      throw new Error("Invalid password record encoding.");
  }
  return value;
}

/** 创建一次，不读取或覆盖任何现有生产凭据。 / Create once without reading or replacing existing credentials. */
export function createCredentials(directory) {
  const path = privateDirectory(directory);
  if (
    existsSync(join(path, passwordName)) ||
    existsSync(join(path, secretName))
  )
    throw new Error(
      "Credentials already exist; use a new private directory for rotation.",
    );
  secureDirectory(path);
  const password = randomBytes(passwordBytes).toString("base64url");
  const salt = randomBytes(16);
  const record = {
    algorithm: "PBKDF2-SHA256",
    iterations,
    salt: salt.toString("base64url"),
    hash: pbkdf2Sync(password, salt, iterations, 32, "sha256").toString(
      "base64url",
    ),
  };
  // Exclusive writes fail closed even if another creator races us. / 独占创建，竞争时拒绝覆盖。
  writeFileSync(join(path, passwordName), password + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  writeFileSync(
    join(path, secretName),
    JSON.stringify({ ADMIN_PASSWORD_RECORD: JSON.stringify(record) }) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  return path;
}

/** 只上传摘要；先验证已有 Worker，避免 Wrangler 自动创建占位应用。 / Upload only the verifier to an existing Worker. */
export function uploadCredentials(directory, execute = run) {
  const path = privateDirectory(directory);
  const file = join(path, secretName);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2048)
    throw new Error("Invalid secret file.");
  if (
    process.platform !== "win32" &&
    (stat.mode & 0o077 || lstatSync(path).mode & 0o077)
  )
    throw new Error("Credential permissions must be private.");
  verifyWindowsPermissions(path, file);
  validateSecret(JSON.parse(readFileSync(file, "utf8")));
  const cli = join(repository, "node_modules/wrangler/bin/wrangler.js");
  const config = join(repository, "wrangler.jsonc");
  let metadata;
  try {
    metadata = JSON.parse(
      execute(process.execPath, [cli, "secret", "list", "--config", config]),
    );
  } catch {
    throw new Error("Existing Worker could not be verified; nothing uploaded.");
  }
  if (
    !Array.isArray(metadata) ||
    metadata.some((item) => !item || typeof item.name !== "string")
  )
    throw new Error("Invalid Worker secret metadata; nothing uploaded.");
  try {
    execute(process.execPath, [
      cli,
      "secret",
      "bulk",
      file,
      "--config",
      config,
    ]);
  } catch {
    throw new Error(
      "Secret upload failed; inspect Cloudflare without logging credentials.",
    );
  }
  return path;
}

/** CLI 仅打印路径与状态，异常不附带子进程输出。 / Print paths/status only, never subprocess errors. */
export function main(args) {
  if (
    !["create", "upload"].includes(args[0]) ||
    (args.length !== 1 && (args.length !== 3 || args[1] !== "--directory"))
  )
    throw new Error(
      "Usage: admin-secret.mjs create|upload [--directory PRIVATE_DIR]",
    );
  const directory = args[2] ?? defaultDirectory;
  const path =
    args[0] === "create"
      ? createCredentials(directory)
      : uploadCredentials(directory);
  console.log(`${args[0]} succeeded: ${path}`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main(process.argv.slice(2));
  } catch {
    console.error(
      "Administrator secret operation failed; no credentials were printed. Check private directory, existing files and Worker access.",
    );
    process.exitCode = 1;
  }
}

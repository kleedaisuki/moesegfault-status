import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** 无 shell 拼接地运行工具，并保留失败状态。 / Run tools without shell interpolation and preserve failure status. */
function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "packages", "domain-wasm", "pkg");
mkdirSync(output, { recursive: true });
run(
  "cargo",
  [
    "build",
    "--locked",
    "--release",
    "--target",
    "wasm32-unknown-unknown",
    "-p",
    "status-domain",
    "--features",
    "wasm",
  ],
  root,
);

// CLI 与 Cargo.lock 的 wasm-bindgen 必须一致。 / CLI must match Cargo.lock's wasm-bindgen version.
const lock = readFileSync(path.join(root, "Cargo.lock"), "utf8");
const version = /name = "wasm-bindgen"\r?\nversion = "([^"]+)"/.exec(lock)?.[1];
const installed = spawnSync("wasm-bindgen", ["--version"], {
  encoding: "utf8",
  windowsHide: true,
});
if (
  !version ||
  installed.status !== 0 ||
  installed.stdout.trim() !== `wasm-bindgen ${version}`
) {
  throw new Error(
    `Install the matching CLI: cargo install wasm-bindgen-cli --version ${version ?? "<Cargo.lock version>"} --locked`,
  );
}
run(
  "wasm-bindgen",
  [
    path.join(
      root,
      "target",
      "wasm32-unknown-unknown",
      "release",
      "status_domain.wasm",
    ),
    "--target",
    "web",
    "--out-dir",
    output,
    "--out-name",
    "status_domain",
  ],
  root,
);

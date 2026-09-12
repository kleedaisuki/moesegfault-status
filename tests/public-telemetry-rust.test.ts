import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { expect, it } from "vitest";

/** 直接编译生产 Rust 自观测模块及真实 Telemetry；不是 TS 重写或模拟预算。
 * Compile the production Rust observability module and real Telemetry, not a TypeScript rewrite or mocked budget.
 * The parent public module is Wasm-only, so this native harness executes its pure aggregation and sink contracts.
 */
it("executes public freshness, fixed-field redaction, and invocation-shared budget contracts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "public-telemetry-rust-"));
  const rustPath = (path: string) => path.replaceAll("\\", "/");
  try {
    await mkdir(join(directory, "src"));
    await writeFile(
      join(directory, "Cargo.toml"),
      `[package]\nname="public-telemetry-validation"\nversion="0.0.0"\nedition="2021"\n[dependencies]\nserde_json="1"\nchrono="0.4"\nstatus-backend={path=${JSON.stringify(rustPath(resolve("crates/status-backend")))}}\n`,
    );
    await writeFile(
      join(directory, "src/lib.rs"),
      `pub use status_backend::telemetry;\n#[path=${JSON.stringify(rustPath(resolve("crates/status-backend/src/public/instrumentation.rs")))}] mod instrumentation;\n`,
    );
    const output = execFileSync(
      "cargo",
      [
        "test",
        "--manifest-path",
        join(directory, "Cargo.toml"),
        "--target-dir",
        resolve("target/public-telemetry-validation"),
        "--offline",
      ],
      { encoding: "utf8", timeout: 180_000, windowsHide: true },
    );
    expect(output).toContain("4 passed; 0 failed");
  } finally {
    // 只删除 mkdtemp 返回的独占目录。 / Remove only the exclusively owned mkdtemp directory.
    await rm(directory, { recursive: true, force: true });
  }
}, 200_000);

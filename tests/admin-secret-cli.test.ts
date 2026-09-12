import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pbkdf2Sync } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  createCredentials,
  privateDirectory,
  uploadCredentials,
  validateSecret,
} from "../scripts/operations/admin-secret.mjs";

/** 仅本机临时文件与模拟 CLI；不操作云资源。 / Temporary local files and mocked CLI, never cloud writes. */
const temporary: string[] = [];
function directory() {
  const path = mkdtempSync(join(tmpdir(), "admin-secret-test-"));
  temporary.push(path);
  return path;
}
afterEach(() => {
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});

describe("local administrator provisioning", () => {
  it("creates a random password matching the frozen real PBKDF2 record without overwrite", () => {
    const path = createCredentials(directory());
    const password = readFileSync(
      join(path, "administrator-login.txt"),
      "utf8",
    ).trim();
    const envelope = JSON.parse(
      readFileSync(join(path, "status-worker-secrets.json"), "utf8"),
    );
    expect(password).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(validateSecret(envelope)).toEqual(envelope);
    const record = JSON.parse(envelope.ADMIN_PASSWORD_RECORD);
    expect(
      pbkdf2Sync(
        password,
        Buffer.from(record.salt, "base64url"),
        600000,
        32,
        "sha256",
      ).toString("base64url"),
    ).toBe(record.hash);
    expect(() => createCredentials(path)).toThrow("already exist");
    expect(
      readFileSync(join(path, "administrator-login.txt"), "utf8").trim(),
    ).toBe(password);
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o700);
      expect(statSync(join(path, "administrator-login.txt")).mode & 0o777).toBe(
        0o600,
      );
    }
  });

  it("rejects repository paths including dot-dot-prefixed child names and aliases", () => {
    expect(() => privateDirectory(resolve(".private"))).toThrow("outside");
    expect(() => privateDirectory(resolve("..private"))).toThrow("outside");
    const alias = join(directory(), "alias");
    symlinkSync(
      resolve("."),
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(() => privateDirectory(join(alias, "credentials"))).toThrow(
      "outside",
    );
  });

  it("uploads only the verifier after successful existing-Worker metadata inspection", () => {
    const path = createCredentials(directory());
    const execute = vi.fn().mockReturnValueOnce("[]").mockReturnValueOnce("");
    uploadCredentials(path, execute);
    expect(execute.mock.calls[0][1].slice(1, 3)).toEqual(["secret", "list"]);
    expect(execute.mock.calls[1][1].slice(1, 4)).toEqual([
      "secret",
      "bulk",
      join(path, "status-worker-secrets.json"),
    ]);
    expect(JSON.stringify(execute.mock.calls)).not.toContain(
      readFileSync(join(path, "administrator-login.txt"), "utf8").trim(),
    );
  });

  // 并发套件下多轮真实 Windows ACL 子进程可能超过 5 秒；保留真实 KDF 与权限检查。
  // Repeated real Windows ACL subprocesses can exceed 5s under suite contention; retain real KDF and permission checks.
  it("does not upload after failed or malformed metadata", () => {
    const path = createCredentials(directory());
    for (const result of ["not JSON", "{}", '[{"value":"unexpected"}]']) {
      const execute = vi.fn().mockReturnValue(result);
      expect(() => uploadCredentials(path, execute)).toThrow();
      expect(execute).toHaveBeenCalledTimes(1);
    }
    const execute = vi.fn(() => {
      throw new Error("sensitive subprocess diagnostic");
    });
    expect(() => uploadCredentials(path, execute)).toThrow(
      "Existing Worker could not be verified",
    );
    expect(execute).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("rejects additional secrets and modified KDF parameters before any CLI operation", () => {
    const path = createCredentials(directory());
    const file = join(path, "status-worker-secrets.json");
    const envelope = JSON.parse(readFileSync(file, "utf8"));
    expect(() => validateSecret({ ...envelope, OTHER: "no" })).toThrow();
    const record = JSON.parse(envelope.ADMIN_PASSWORD_RECORD);
    for (const modification of [
      { iterations: 1 },
      { salt: "A" },
      { hash: record.hash + "=" },
      { extra: true },
      { algorithm: "SHA256" },
    ]) {
      expect(() =>
        validateSecret({
          ADMIN_PASSWORD_RECORD: JSON.stringify({ ...record, ...modification }),
        }),
      ).toThrow();
    }
    writeFileSync(file, JSON.stringify({ ...envelope, OTHER: "no" }));
    const execute = vi.fn();
    expect(() => uploadCredentials(path, execute)).toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")(
    "rejects publicly readable Unix secret files",
    () => {
      const path = createCredentials(directory());
      chmodSync(join(path, "status-worker-secrets.json"), 0o644);
      expect(() => uploadCredentials(path, vi.fn())).toThrow("private");
    },
  );

  it.skipIf(process.platform !== "win32")(
    "rejects Windows credentials readable by Everyone",
    () => {
      const path = createCredentials(directory());
      const file = join(path, "status-worker-secrets.json");
      execFileSync("icacls.exe", [file, "/grant", "*S-1-1-0:R"], {
        stdio: "pipe",
        windowsHide: true,
      });
      const execute = vi.fn();
      expect(() => uploadCredentials(path, execute)).toThrow();
      expect(execute).not.toHaveBeenCalled();
    },
  );
});

import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildMetadata,
  parseArgs,
  uuidV7,
  writeMetadata,
} from "./prepare-metadata.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const NOW = new Date("2026-09-12T08:09:10.123Z");

/** 返回最小可信 GitHub runner 环境。 / Return a minimal trusted GitHub runner environment. */
function githubEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    GITHUB_ACTIONS: "true",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: SHA,
    GITHUB_REPOSITORY: "moesegfault/status",
    GITHUB_RUN_ID: "123456789",
    GITHUB_RUN_ATTEMPT: "2",
    ...overrides,
  };
}

describe("release metadata", () => {
  it("creates a valid UUIDv7 with the frozen timestamp", () => {
    const id = uuidV7(NOW, () => new Uint8Array(16));
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(Number(BigInt(`0x${id.replaceAll("-", "").slice(0, 12)}`))).toBe(
      NOW.getTime(),
    );
  });

  it.each([
    ["status", "status", ["global"]],
    ["ops", "ops-gateway", ["global"]],
    ["probe", "probe-executor", ["asia"]],
  ])(
    "maps build selector %s to domain service %s",
    (service, serviceName, region) => {
      const metadata = buildMetadata({
        service,
        version: "0.2.0-rc.1",
        now: NOW,
        head: SHA,
        env: githubEnv(),
        entropy: () => new Uint8Array(16),
      });
      expect(metadata).toMatchObject({
        service_name: serviceName,
        environment: "production",
        service_version: "0.2.0-rc.1",
        git_ref: SHA,
        ci_run_id: "123456789",
        release_attempt: "2",
        region,
        status_origin: "https://status.moesegfault.dev",
        machine_jwks: "config/machine-jwks.json",
      });
      expect(JSON.stringify(metadata)).not.toMatch(
        /password|private|secret|token/i,
      );
    },
  );

  it("rejects ambiguous source identity and unsafe inputs", () => {
    expect(() =>
      buildMetadata({
        service: "all",
        version: "1",
        now: NOW,
        head: SHA,
        env: githubEnv(),
      }),
    ).toThrow("service");
    expect(() =>
      buildMetadata({
        service: "status",
        version: "bad version",
        now: NOW,
        head: SHA,
        env: githubEnv(),
      }),
    ).toThrow("version");
    expect(() =>
      buildMetadata({
        service: "status",
        version: "1",
        now: NOW,
        head: SHA,
        env: githubEnv({ GITHUB_REF: "refs/heads/feature" }),
      }),
    ).toThrow("main");
    expect(() =>
      buildMetadata({
        service: "status",
        version: "1",
        now: NOW,
        head: SHA,
        env: githubEnv({ GITHUB_SHA: "f".repeat(40) }),
      }),
    ).toThrow("HEAD");
    expect(() =>
      buildMetadata({
        service: "status",
        version: "1",
        now: NOW,
        head: SHA,
        env: githubEnv({ GITHUB_RUN_ATTEMPT: "0" }),
      }),
    ).toThrow("ATTEMPT");
  });

  it("parses each required CLI argument exactly once", () => {
    expect(
      parseArgs([
        "--service",
        "status",
        "--version",
        "1.0.0",
        "--output",
        "metadata.json",
      ]),
    ).toEqual({
      service: "status",
      version: "1.0.0",
      output: "metadata.json",
    });
    expect(() =>
      parseArgs(["--service", "status", "--service", "ops", "--version", "1"]),
    ).toThrow();
    expect(() => parseArgs(["--service", "status", "--output"])).toThrow();
  });

  it("writes a private file once and refuses accidental identity replacement", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "moe-metadata-"));
    const output = path.join(directory, "metadata.json");
    const metadata = buildMetadata({
      service: "status",
      version: "1.0.0",
      now: NOW,
      head: SHA,
      env: githubEnv(),
      entropy: () => new Uint8Array(16),
    });
    await writeMetadata(output, metadata);
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual(metadata);
    await expect(writeMetadata(output, metadata)).rejects.toMatchObject({
      code: "EEXIST",
    });
  });

  it("keeps the manual workflow version-only and scopes secrets to the release step", async () => {
    const workflow = await readFile(
      new URL("../../.github/workflows/deploy.yml", import.meta.url),
      "utf8",
    );
    await expect(
      access(new URL("../../.github/workflows/pages.yml", import.meta.url)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("environment: production-release");
    // 发布失败必须穿过 tee 传播到 Actions。 / Release failures must propagate through tee to Actions.
    expect(workflow).toMatch(
      /name: Register artifacts, require ready, then publish this exact version\s+shell: bash/u,
    );
    expect(workflow).toContain("set -euo pipefail");
    expect(workflow).not.toMatch(
      /\brun:\s*[^\n]*(?:wrangler\s+deploy|triggers\s+deploy)/iu,
    );
    expect(workflow.match(/MACHINE_JWT_PRIVATE_KEY:/gu)).toHaveLength(1);
    expect(workflow.match(/CLOUDFLARE_API_TOKEN:/gu)).toHaveLength(1);
    expect(workflow.match(/CLOUDFLARE_ACCOUNT_ID:/gu)).toHaveLength(1);
    for (const action of workflow.matchAll(/uses:\s+([^\s#]+)/gu)) {
      expect(action[1]).toMatch(
        /^(?:\.\/.+|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40})$/u,
      );
    }
  });
});

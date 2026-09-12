import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildManifest,
  canonicalJson,
  prepareArtifacts,
  sha256,
  type ReleaseConfig,
} from "./provenance.js";

const DEPLOYMENT_ID = "0199d09a-b692-7ce0-a1c0-5138a43d7402";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

/** 构造最小有效发布配置。 / Build a minimal valid release configuration. */
function config(): ReleaseConfig {
  return {
    deployment_id: DEPLOYMENT_ID,
    service_name: "status",
    environment: "production",
    service_version: "1.2.3",
    repository_url: "https://github.com/moesegfault/status",
    git_ref: "refs/tags/v1.2.3",
    deployed_at: "2026-09-12T00:00:00.000Z",
    ci_provider: "github-actions",
    ci_run_id: "1234",
    release_attempt: "1",
    region: ["global"],
    artifacts: [
      { path: "worker.js", kind: "other", media_type: "text/javascript" },
      {
        path: "worker.js.map",
        kind: "source_map",
        media_type: "application/json",
      },
    ],
    wrangler_config: "wrangler.jsonc",
    wrangler_entrypoint: "worker.js",
    require_source_map: true,
  };
}

describe("release provenance", () => {
  it("hashes stable canonical JSON independent of object insertion order", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 } })).toBe(
      '{"a":{"x":3,"y":2},"z":1}',
    );
    expect(sha256("hello")).toBe(
      "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("binds the manifest to exact artifact bytes and commit", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "moe-release-"));
    const configPath = path.join(directory, "release.json");
    await writeFile(
      path.join(directory, "worker.js"),
      "export default {};\n//# sourceMappingURL=worker.js.map\n",
    );
    await writeFile(
      path.join(directory, "worker.js.map"),
      JSON.stringify({
        version: 3,
        sources: ["../src/index.ts"],
        mappings: "",
      }),
    );
    await writeFile(path.join(directory, "wrangler.jsonc"), "{}");
    const artifacts = await prepareArtifacts(config(), configPath);
    const manifest = buildManifest(config(), artifacts, {
      gitCommit: COMMIT,
    });

    expect(manifest.git_commit).toBe(COMMIT);
    expect(manifest.artifacts).toHaveLength(2);
    expect(manifest.artifacts[0]!.artifact_digest).toBe(
      sha256("export default {};\n//# sourceMappingURL=worker.js.map\n"),
    );
    expect(manifest.artifact_digest).toBe(
      sha256("export default {};\n//# sourceMappingURL=worker.js.map\n"),
    );
  });

  it("fails closed when source maps are required but absent", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "moe-release-"));
    const configPath = path.join(directory, "release.json");
    await writeFile(
      path.join(directory, "worker.js"),
      "export default {};\n//# sourceMappingURL=worker.js.map\n",
    );
    const withoutMap = {
      ...config(),
      artifacts: config().artifacts.slice(0, 1),
    };
    await expect(prepareArtifacts(withoutMap, configPath)).rejects.toThrow(
      "no source_map artifact",
    );
  });

  it("refuses secret-shaped release artifacts", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "moe-release-"));
    const configPath = path.join(directory, "release.json");
    await writeFile(
      path.join(directory, ".env.production"),
      "TOKEN=never-upload\n",
    );
    const unsafe = {
      ...config(),
      artifacts: [
        {
          path: ".env.production",
          kind: "other" as const,
          media_type: "text/plain",
        },
      ],
      wrangler_entrypoint: ".env.production",
      require_source_map: false,
    };
    await expect(prepareArtifacts(unsafe, configPath)).rejects.toThrow(
      "secret-shaped file",
    );
  });
});

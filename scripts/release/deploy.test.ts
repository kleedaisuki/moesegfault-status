import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CreateArtifactUploadRequestSchema,
  CreateDeploymentArtifactRequestSchema,
  DeploymentManifestSchema,
} from "../../packages/contracts/src/index.js";
import { registerRelease } from "./deploy.js";
import {
  buildManifest,
  prepareArtifacts,
  sha256,
  type ReleaseConfig,
} from "./provenance.js";

const id = "0199d09a-b692-7ce0-a1c0-5138a43d7402";
const commit = "0123456789abcdef0123456789abcdef01234567";
/** 使用真正磁盘字节，禁止仅手工拼装哈希。 / Prepare actual disk bytes rather than fabricated hashes. */
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "release-wire-"));
  await writeFile(
    path.join(dir, "worker.js"),
    "export default {};\n//# sourceMappingURL=worker.js.map\n",
  );
  await writeFile(
    path.join(dir, "worker.js.map"),
    JSON.stringify({
      version: 3,
      file: "worker.js",
      sources: ["src/index.ts"],
      mappings: "",
    }),
  );
  const config: ReleaseConfig = {
    deployment_id: id,
    service_name: "status",
    environment: "production",
    service_version: "1",
    repository_url: "https://github.com/moesegfault/status",
    git_ref: "main",
    deployed_at: "2026-09-12T00:00:00.000Z",
    ci_provider: "github-actions",
    ci_run_id: "1",
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
  const artifacts = await prepareArtifacts(
    config,
    path.join(dir, "release.json"),
  );
  return {
    artifacts,
    manifest: buildManifest(config, artifacts, { gitCommit: commit }),
  };
}
afterEach(() => vi.unstubAllGlobals());

describe("release registry wire contract", () => {
  it.each([
    "success",
    "existing",
    "not-ready",
    "expired",
    "put-failed",
    "commit-failed",
    "wrong-checksum",
  ])("runs strict wire path: %s", async (scenario) => {
    const uploadStatus =
      scenario === "existing" ? 412 : scenario === "put-failed" ? 503 : 200;
    const { artifacts, manifest } = await fixture();
    const keys: string[] = [];
    let registrations = 0;
    let uploads = 0;
    let commits = 0;
    const envelope = (data: unknown) =>
      Response.json({
        data,
        links: { self: "https://status.example/v1/deployments/" + id },
      });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL | string, init: RequestInit) => {
        const address = String(url);
        if (address.startsWith("https://r2.example/")) {
          const artifact = artifacts[uploads++]!;
          expect(Buffer.from(init.body as Uint8Array)).toEqual(
            Buffer.from(artifact.bytes),
          );
          expect(new Headers(init.headers).get("content-md5")).toBe(
            createHash("md5").update(artifact.bytes).digest("base64"),
          );
          expect(new Headers(init.headers).get("if-none-match")).toBe("*");
          expect(new Headers(init.headers).has("authorization")).toBe(false);
          expect(init.redirect).toBe("error");
          return new Response(null, { status: uploadStatus });
        }
        const body: unknown = JSON.parse(init.body as string);
        if (address.endsWith("/artifact-uploads")) {
          const input = CreateArtifactUploadRequestSchema.parse(body);
          keys.push(new Headers(init.headers).get("idempotency-key")!);
          return envelope({
            upload_id: id,
            method: "PUT",
            upload_url: "https://r2.example/object",
            expires_at:
              scenario === "expired"
                ? "2020-01-01T00:00:00.000Z"
                : "2099-01-01T00:00:00.000Z",
            required_headers: {
              "content-type": input.media_type,
              "content-length": String(input.size_bytes),
              "content-md5":
                scenario === "wrong-checksum"
                  ? "AAAAAAAAAAAAAAAAAAAAAA=="
                  : input.content_md5,
              "if-none-match": "*",
              "x-amz-meta-deployment-id": id,
              "x-amz-meta-git-commit": commit,
              "x-amz-meta-artifact-digest": input.artifact_digest,
              "x-amz-meta-artifact-kind": input.kind,
              "x-amz-meta-artifact-file-name": input.file_name,
              "x-amz-meta-build-id": input.build_id ?? "none",
            },
          });
        }
        if (address.endsWith("/artifacts")) {
          const { upload_id, ...input } =
            CreateDeploymentArtifactRequestSchema.parse(body);
          expect(upload_id).toBe(id);
          if (scenario === "commit-failed")
            return Response.json({ title: "digest mismatch" }, { status: 409 });
          commits++;
          return envelope({
            ...input,
            build_id: input.build_id ?? null,
            artifact_id: id,
            deployment_id: id,
            committed_at: "2026-09-12T00:00:00.000Z",
          });
        }
        DeploymentManifestSchema.parse(body);
        registrations++;
        if (registrations % 2 === 0) expect(commits).toBe(artifacts.length);
        return envelope({
          deployment_id: id,
          state:
            registrations % 2 === 0 && scenario !== "not-ready"
              ? "ready"
              : "awaiting_artifacts",
          manifest_digest: sha256("manifest"),
          registered_at: "2026-09-12T00:00:00.000Z",
        });
      }),
    );
    if (!["success", "existing"].includes(scenario)) {
      await expect(
        registerRelease(
          new URL("https://status.example"),
          "secret",
          "1",
          manifest,
          artifacts,
        ),
      ).rejects.toThrow();
      expect(registrations).toBe(scenario === "not-ready" ? 2 : 1);
      if (["expired", "wrong-checksum"].includes(scenario))
        expect(uploads).toBe(0);
      if (scenario === "put-failed") expect(commits).toBe(0);
      return;
    }
    await registerRelease(
      new URL("https://status.example"),
      "secret",
      "1",
      manifest,
      artifacts,
    );
    const initial = [...keys];
    uploads = 0;
    commits = 0;
    await registerRelease(
      new URL("https://status.example"),
      "secret",
      "1",
      manifest,
      artifacts,
    );
    expect(keys.slice(2)).toEqual(initial);
    expect(registrations).toBe(4);
    uploads = 0;
    commits = 0;
    await registerRelease(
      new URL("https://status.example"),
      "secret",
      "2",
      manifest,
      artifacts,
    );
    expect(keys.slice(4)).not.toEqual(initial);
  });

  it.each([409, 503])(
    "halts before upload on registry failure %s",
    async (status) => {
      const { artifacts, manifest } = await fixture();
      const transport = vi.fn(async () =>
        Response.json({ title: "conflict" }, { status }),
      );
      vi.stubGlobal("fetch", transport);
      await expect(
        registerRelease(
          new URL("https://status.example"),
          "secret",
          "1",
          manifest,
          artifacts,
        ),
      ).rejects.toThrow("registry request failed");
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects bare data rather than treating malformed envelopes as success", async () => {
    const { artifacts, manifest } = await fixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ state: "ready" })),
    );
    await expect(
      registerRelease(
        new URL("https://status.example"),
        "secret",
        "1",
        manifest,
        artifacts,
      ),
    ).rejects.toThrow();
  });
});

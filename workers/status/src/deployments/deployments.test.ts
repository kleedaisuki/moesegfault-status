import { describe, expect, it } from "vitest";

import { canonicalJson, sha256Digest } from "./crypto.js";
import {
  commitArtifact,
  createArtifactUpload,
  putDeployment,
} from "./handlers.js";
import { DeploymentProblem } from "./problem.js";
import { createR2ArtifactSigner } from "./signer.js";
import type {
  ArtifactBucket,
  DeploymentDatabase,
  DeploymentHttpContext,
} from "./types.js";

const deploymentId = "0199d09a-b692-7ce0-a1c0-5138a43d7402";
const uploadId = "0199d09a-b692-7ce0-a1c0-5138a43d7403";
const artifactId =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const contentMd5 = "CY9rzUYh03PK3k6DJie09g==";
const gitCommit = "b".repeat(40);

/** 固定查询结果的 D1 测试替身 / D1 test double returning query-selected fixtures. */
class FixtureStatement {
  public constructor(
    private readonly sql: string,
    private readonly fixture: (sql: string, column?: string) => unknown,
  ) {}

  public bind(..._values: unknown[]): FixtureStatement {
    return this;
  }

  public async first<T = Record<string, unknown>>(
    column?: string,
  ): Promise<T | null> {
    return (this.fixture(this.sql, column) ?? null) as T | null;
  }
}

/** 测试专用窄 D1 实现 / Minimal D1 implementation for handler tests. */
class FixtureDatabase {
  public constructor(
    private readonly fixture: (sql: string, column?: string) => unknown,
  ) {}

  public prepare(sql: string): FixtureStatement {
    return new FixtureStatement(sql, this.fixture);
  }

  public async batch<T = unknown>(_statements: unknown[]): Promise<T[]> {
    return [];
  }
}

function context(
  overrides: Partial<DeploymentHttpContext> = {},
): DeploymentHttpContext {
  const artifacts: ArtifactBucket = {
    async head() {
      return null;
    },
    async get() {
      return null;
    },
    async put() {
      return null;
    },
  };
  return {
    db: new FixtureDatabase(() => null) as unknown as DeploymentDatabase,
    artifacts,
    principal: {
      subject: "ci:test",
      serviceNames: new Set(["identity"]),
      environments: new Set(["production"]),
      deploymentIds: new Set([deploymentId]),
      scopes: new Set(["deployments:write", "artifacts:write"]),
    },
    correlationId: "0199d09a-b692-7ce0-a1c0-5138a43d7404",
    now: () => new Date("2026-09-12T00:00:00.000Z"),
    signArtifactPut: async () => ({
      url: "https://example.com/upload",
      headers: {
        "content-type": "application/octet-stream",
        "content-length": "4",
        "content-md5": contentMd5,
        "x-amz-meta-deployment-id": deploymentId,
        "x-amz-meta-git-commit": gitCommit,
        "x-amz-meta-artifact-digest": artifactId,
        "x-amz-meta-artifact-kind": "binary",
        "x-amz-meta-artifact-file-name": "server",
        "x-amz-meta-build-id": "build-1",
        "if-none-match": "*",
      },
    }),
    ...overrides,
  };
}

describe("deployment provenance", () => {
  it("rejects a path deployment ID not bound to the machine token", async () => {
    const manifest = {
      deployment_id: deploymentId,
      service_name: "identity",
      environment: "production",
      service_version: "1.0.0",
      repository_url: "https://github.com/example/identity",
      git_commit: gitCommit,
      git_ref: "refs/heads/main",
      artifact_digest: artifactId,
      ci_provider: "github-actions",
      ci_run_id: "42",
      deployed_at: "2026-09-12T00:00:00.000Z",
      region: ["global"],
      artifacts: [
        {
          kind: "other" as const,
          file_name: "worker.wasm",
          media_type: "application/wasm",
          size_bytes: 4,
          artifact_digest: artifactId,
        },
      ],
    };
    const request = new Request("https://status.test/v1/deployments/x", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(manifest),
    });
    const denied = context({
      principal: { ...context().principal, deploymentIds: new Set() },
    });

    await expect(
      putDeployment(request, deploymentId, denied),
    ).rejects.toMatchObject<Partial<DeploymentProblem>>({
      status: 403,
      type: "https://status.moesegfault.dev/problems/deployment-claim-mismatch",
    });
  });

  it("embeds a bounded expiry and all immutable headers in the R2 signature", async () => {
    const signer = createR2ArtifactSigner({
      accountId: "0123456789abcdef0123456789abcdef",
      bucketName: "artifacts",
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });
    const signed = await signer({
      objectKey: "observability/artifacts/sha256/aa/object",
      contentLength: 4,
      contentType: "application/octet-stream",
      contentMd5Base64: contentMd5,
      metadata: {
        "deployment-id": deploymentId,
        "git-commit": gitCommit,
        "artifact-digest": artifactId,
        "artifact-kind": "binary",
        "artifact-file-name": "server",
        "build-id": "build-1",
      },
      expiresInSeconds: 600,
    });
    const url = new URL(signed.url);

    expect(url.searchParams.get("X-Amz-Expires")).toBe("600");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toContain(
      "if-none-match",
    );
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toContain(
      "content-md5",
    );
    expect(signed.headers["x-amz-meta-deployment-id"]).toBe(deploymentId);
    expect(signed.headers["x-amz-meta-artifact-digest"]).toBe(artifactId);
  });

  it("never projects a retired deployment back into the release readiness gate", async () => {
    const manifest = {
      deployment_id: deploymentId,
      service_name: "identity",
      environment: "production",
      service_version: "1.0.0",
      repository_url: "https://github.com/example/identity",
      git_commit: gitCommit,
      git_ref: "refs/heads/main",
      artifact_digest: artifactId,
      ci_provider: "github-actions",
      ci_run_id: "42",
      deployed_at: "2026-09-12T00:00:00.000Z",
      region: ["global"],
      artifacts: [
        {
          kind: "other" as const,
          file_name: "worker.wasm",
          media_type: "application/wasm",
          size_bytes: 4,
          artifact_digest: artifactId,
        },
      ],
    };
    const manifestDigest = await sha256Digest(canonicalJson(manifest));
    const db = new FixtureDatabase((sql) =>
      sql.includes("FROM deployments")
        ? {
            ...manifest,
            manifest_digest: manifestDigest,
            registered_at: "2026-09-12T00:00:00.000Z",
            state: "retired",
          }
        : null,
    );
    const request = new Request(
      `https://status.test/v1/deployments/${deploymentId}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(manifest),
      },
    );

    await expect(
      putDeployment(
        request,
        deploymentId,
        context({ db: db as unknown as DeploymentDatabase }),
      ),
    ).rejects.toMatchObject<Partial<DeploymentProblem>>({
      status: 409,
      type: "https://status.moesegfault.dev/problems/deployment-terminal",
    });
  });

  it("rejects an unrelated source map for a JavaScript runtime", async () => {
    const manifest = {
      deployment_id: deploymentId,
      service_name: "identity",
      environment: "production",
      service_version: "1.0.0",
      repository_url: "https://github.com/example/identity",
      git_commit: gitCommit,
      git_ref: "refs/heads/main",
      artifact_digest: artifactId,
      ci_provider: "github-actions",
      ci_run_id: "42",
      deployed_at: "2026-09-12T00:00:00.000Z",
      region: ["global"],
      artifacts: [
        {
          kind: "other" as const,
          file_name: "worker.js",
          media_type: "application/javascript",
          size_bytes: 4,
          artifact_digest: artifactId,
        },
        {
          kind: "source_map" as const,
          file_name: "unrelated.js.map",
          media_type: "application/json",
          size_bytes: 4,
          artifact_digest: `sha256:${"c".repeat(64)}` as const,
        },
      ],
    };
    const request = new Request(
      `https://status.test/v1/deployments/${deploymentId}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(manifest),
      },
    );

    await expect(
      putDeployment(request, deploymentId, context()),
    ).rejects.toMatchObject<Partial<DeploymentProblem>>({
      status: 422,
      type: "https://status.moesegfault.dev/problems/invalid-request",
    });
  });

  it("requires a new stable idempotency key after an upload session expires", async () => {
    const input = {
      kind: "binary" as const,
      file_name: "server",
      media_type: "application/octet-stream",
      size_bytes: 4,
      artifact_digest: artifactId,
      content_md5: contentMd5,
      build_id: "build-1",
    };
    const requestDigest = await sha256Digest(canonicalJson(input));
    const db = new FixtureDatabase((sql, column) => {
      if (sql.includes("FROM deployments")) {
        return {
          deployment_id: deploymentId,
          service_name: "identity",
          environment: "production",
          git_commit: gitCommit,
          manifest_digest: artifactId,
          registered_at: "2026-09-12T00:00:00.000Z",
          state: "artifacts_pending",
        };
      }
      if (sql.includes("FROM deployment_artifact_requirements"))
        return column ? 1 : { present: 1 };
      if (sql.includes("FROM idempotency_keys i")) {
        return {
          request_digest: requestDigest,
          response_json: JSON.stringify({}),
          expires_at: "2026-09-12T00:10:00.000Z",
        };
      }
      return null;
    });
    const request = new Request(
      `https://status.test/v1/deployments/${deploymentId}/artifact-uploads`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "stable-attempt-1",
        },
        body: JSON.stringify(input),
      },
    );

    await expect(
      createArtifactUpload(
        request,
        deploymentId,
        context({
          db: db as unknown as DeploymentDatabase,
          now: () => new Date("2026-09-12T00:10:00.001Z"),
        }),
      ),
    ).rejects.toMatchObject<Partial<DeploymentProblem>>({
      status: 409,
      type: "https://status.moesegfault.dev/problems/upload-session-expired",
    });
  });

  it("rejects metadata-correct objects whose stored bytes have another digest", async () => {
    const commitInput = {
      upload_id: uploadId,
      kind: "binary" as const,
      file_name: "server",
      media_type: "application/octet-stream",
      size_bytes: 4,
      artifact_digest: artifactId,
      build_id: "build-1",
    };
    const uploadRequest = { ...commitInput };
    delete (uploadRequest as Partial<typeof commitInput>).upload_id;
    const requestDigest = await sha256Digest(canonicalJson(uploadRequest));
    const session = {
      ...commitInput,
      request_digest: requestDigest,
      content_md5: contentMd5,
      deployment_id: deploymentId,
      object_key: "observability/artifacts/sha256/aa/object",
      expires_at: "2026-09-12T00:10:00.000Z",
      git_commit: gitCommit,
      service_name: "identity",
      environment: "production",
    };
    const db = new FixtureDatabase((sql) =>
      sql.includes("FROM artifact_upload_sessions") ? session : null,
    );
    const wrongChecksum = new Uint8Array(32).fill(0xbb).buffer;
    const artifacts: ArtifactBucket = {
      async head(key) {
        return {
          key,
          version: "v1",
          size: 4,
          httpMetadata: { contentType: "application/octet-stream" },
          checksums: { sha256: wrongChecksum },
          customMetadata: {
            "deployment-id": deploymentId,
            "git-commit": gitCommit,
            "artifact-digest": artifactId,
            "artifact-kind": "binary",
            "artifact-file-name": "server",
            "build-id": "build-1",
          },
        };
      },
      async get() {
        return null;
      },
      async put() {
        return null;
      },
    };
    const request = new Request(
      `https://status.test/v1/deployments/${deploymentId}/artifacts`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(commitInput),
      },
    );

    await expect(
      commitArtifact(
        request,
        deploymentId,
        context({ db: db as unknown as DeploymentDatabase, artifacts }),
      ),
    ).rejects.toMatchObject<Partial<DeploymentProblem>>({
      status: 422,
      type: "https://status.moesegfault.dev/problems/artifact-verification-failed",
    });
  });

  it.each([
    {
      name: "accepts a valid revision-3 map",
      map: {
        version: 3,
        file: "worker.js",
        sources: ["worker.ts"],
        mappings: "AAAA",
      },
      status: 201,
    },
    {
      name: "rejects a map that names another bundle",
      map: {
        version: 3,
        file: "other.js",
        sources: ["worker.ts"],
        mappings: "AAAA",
      },
      status: 422,
    },
  ])("$name", async ({ map, status }) => {
    const bytes = new TextEncoder().encode(JSON.stringify(map));
    const digest = await sha256Digest(new TextDecoder().decode(bytes));
    const input = {
      upload_id: uploadId,
      kind: "source_map" as const,
      file_name: "worker.js.map",
      media_type: "application/json",
      size_bytes: bytes.byteLength,
      artifact_digest: digest,
    };
    const session = {
      ...input,
      request_digest: artifactId,
      content_md5: contentMd5,
      deployment_id: deploymentId,
      object_key: "observability/artifacts/source-map",
      expires_at: "2026-09-12T00:10:00.000Z",
      git_commit: gitCommit,
      service_name: "identity",
      environment: "production",
      build_id: null,
    };
    const db = new FixtureDatabase((sql, column) => {
      if (sql.includes("FROM artifact_upload_sessions")) return session;
      if (sql.includes("COUNT(*) AS missing"))
        return column ? 1 : { missing: 1 };
      return null;
    });
    const metadata = {
      "deployment-id": deploymentId,
      "git-commit": gitCommit,
      "artifact-digest": digest,
      "artifact-kind": "source_map",
      "artifact-file-name": "worker.js.map",
      "build-id": "none",
    };
    const artifacts: ArtifactBucket = {
      async head(key) {
        return {
          key,
          version: "v1",
          size: bytes.byteLength,
          httpMetadata: { contentType: "application/json" },
          customMetadata: metadata,
        };
      },
      async get(key) {
        return {
          key,
          size: bytes.byteLength,
          body: new Blob([bytes]).stream(),
        };
      },
      async put() {
        return null;
      },
    };
    const request = new Request(
      `https://status.test/v1/deployments/${deploymentId}/artifacts`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      },
    );
    const operation = commitArtifact(
      request,
      deploymentId,
      context({ db: db as unknown as DeploymentDatabase, artifacts }),
    );

    if (status === 201) {
      await expect(operation).resolves.toMatchObject({ status: 201 });
    } else {
      await expect(operation).rejects.toMatchObject<Partial<DeploymentProblem>>(
        {
          status: 422,
          type: "https://status.moesegfault.dev/problems/invalid-source-map",
        },
      );
    }
  });
});

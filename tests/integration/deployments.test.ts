import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import {
  commitArtifact,
  createArtifactUpload,
  putDeployment,
} from "../../workers/status/src/deployments/index.js";
import type { ArtifactKind } from "../../packages/contracts/src/deployments.js";
import type {
  ArtifactBucket,
  ArtifactObject,
  DeploymentDatabase,
  DeploymentHttpContext,
} from "../../workers/status/src/deployments/types.js";
import { createMigratedD1, type TestD1Database } from "./d1.js";

const NOW = new Date("2026-09-12T12:00:00.000Z");
const DEPLOYMENT = "018f0000-0000-7000-8000-000000000301";
const CORRELATION = "018f0000-0000-7000-8000-000000000302";
const GIT_COMMIT = "a".repeat(40);

interface StoredObject extends ArtifactObject {
  readonly bytes: Uint8Array;
}

/** 最小内存 R2，保留真实字节、HEAD metadata 与不可变 PUT 条件。 / Minimal in-memory R2 preserving real bytes, HEAD metadata, and immutable PUT conditions. */
class MemoryArtifactBucket implements ArtifactBucket {
  readonly objects = new Map<string, StoredObject>();

  public async head(key: string): Promise<ArtifactObject | null> {
    return this.objects.get(key) ?? null;
  }

  public async get(key: string): Promise<ArtifactObject | null> {
    return this.objects.get(key) ?? null;
  }

  public async put(
    key: string,
    value: string | ArrayBuffer | ReadableStream,
    options?: {
      readonly onlyIf?: { readonly etagDoesNotMatch?: string };
      readonly httpMetadata?: { readonly contentType?: string };
      readonly customMetadata?: Readonly<Record<string, string>>;
      readonly sha256?: ArrayBuffer;
    },
  ): Promise<ArtifactObject | null> {
    if (options?.onlyIf?.etagDoesNotMatch === "*" && this.objects.has(key))
      return null;
    const bytes =
      typeof value === "string"
        ? new TextEncoder().encode(value)
        : value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : await readStream(value);
    const stableBytes = Uint8Array.from(bytes);
    const digest =
      options?.sha256 ??
      (await crypto.subtle.digest("SHA-256", stableBytes.buffer));
    const stored: StoredObject = {
      key,
      version: "1",
      etag: `etag-${this.objects.size + 1}`,
      size: bytes.byteLength,
      ...(options?.httpMetadata === undefined
        ? {}
        : { httpMetadata: options.httpMetadata }),
      ...(options?.customMetadata === undefined
        ? {}
        : { customMetadata: options.customMetadata }),
      checksums: { sha256: digest },
      body: new Blob([stableBytes.buffer]).stream(),
      text: async () => new TextDecoder().decode(stableBytes),
      bytes: stableBytes,
    };
    this.objects.set(key, stored);
    return stored;
  }

  /** 模拟由签名 URL 写入且 R2 已校验双 checksum 的客户端上传。 / Simulate a signed-URL client upload with both checksums verified by R2. */
  public async upload(
    key: string,
    bytes: Uint8Array,
    contentType: string,
    customMetadata: Readonly<Record<string, string>>,
  ): Promise<void> {
    const stableBytes = Uint8Array.from(bytes);
    const sha256 = await crypto.subtle.digest("SHA-256", stableBytes.buffer);
    const md5Bytes = Uint8Array.from(
      createHash("md5").update(stableBytes).digest(),
    );
    this.objects.set(key, {
      key,
      version: "upload-1",
      etag: "uploaded-etag",
      size: stableBytes.byteLength,
      httpMetadata: { contentType },
      customMetadata,
      checksums: { sha256, md5: md5Bytes.buffer },
      body: new Blob([stableBytes.buffer]).stream(),
      text: async () => new TextDecoder().decode(stableBytes),
      bytes: stableBytes,
    });
  }
}

/** 消费 Web ReadableStream。 / Consume a Web ReadableStream. */
async function readStream(stream: ReadableStream): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 计算契约格式 SHA-256。 / Compute a contract-shaped SHA-256 digest. */
async function digest(bytes: Uint8Array): Promise<`sha256:${string}`> {
  const value = new Uint8Array(
    await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer),
  );
  return `sha256:${[...value].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** 计算 R2 Content-MD5 所需 base64。 / Compute base64 Content-MD5 required by R2. */
function contentMd5(bytes: Uint8Array): string {
  return createHash("md5").update(bytes).digest("base64");
}

/** 构造 JSON Request。 / Build a JSON Request. */
function jsonRequest(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("deployment provenance and readiness with real D1", () => {
  const opened: TestD1Database[] = [];
  afterEach(() => {
    for (const database of opened.splice(0)) database.close();
  });

  it("becomes ready only after every exact manifest artifact is verified", async () => {
    const database = await createMigratedD1();
    opened.push(database);
    await database
      .prepare(
        "INSERT INTO services(service_name,display_name,description,owner,criticality,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .bind(
        "api",
        "API",
        "",
        "platform",
        "critical",
        1,
        NOW.toISOString(),
        NOW.toISOString(),
      )
      .run();
    const bucket = new MemoryArtifactBucket();
    const signed = new Map<
      string,
      {
        objectKey: string;
        metadata: Readonly<Record<string, string>>;
        contentType: string;
      }
    >();
    const context: DeploymentHttpContext = {
      db: database as unknown as DeploymentDatabase,
      artifacts: bucket,
      principal: {
        subject: "ci:api",
        serviceNames: new Set(["api"]),
        environments: new Set(["production"]),
        deploymentIds: new Set([DEPLOYMENT]),
        scopes: new Set(["deployments:write", "artifacts:write"]),
      },
      correlationId: CORRELATION,
      now: () => NOW,
      signArtifactPut: async (input) => {
        signed.set(input.objectKey, {
          objectKey: input.objectKey,
          metadata: input.metadata,
          contentType: input.contentType,
        });
        return {
          url: `https://upload.example/${encodeURIComponent(input.objectKey)}`,
          headers: {
            "content-type": input.contentType,
            "content-length": String(input.contentLength),
            "content-md5": input.contentMd5Base64,
            "x-amz-meta-deployment-id": input.metadata["deployment-id"]!,
            "x-amz-meta-git-commit": input.metadata["git-commit"]!,
            "x-amz-meta-artifact-digest": input.metadata[
              "artifact-digest"
            ]! as `sha256:${string}`,
            "x-amz-meta-artifact-kind": input.metadata[
              "artifact-kind"
            ]! as ArtifactKind,
            "x-amz-meta-artifact-file-name":
              input.metadata["artifact-file-name"]!,
            "x-amz-meta-build-id": input.metadata["build-id"]!,
            "if-none-match": "*",
          },
        };
      },
    };
    const firstBytes = new TextEncoder().encode("wasm");
    const secondBytes = new TextEncoder().encode("sbom2");
    const runtimeDigest = await digest(firstBytes);
    const declarations = [
      {
        kind: "other" as const,
        file_name: "worker.wasm",
        media_type: "application/wasm",
        size_bytes: firstBytes.byteLength,
        artifact_digest: runtimeDigest,
      },
      {
        kind: "sbom" as const,
        file_name: "sbom.json",
        media_type: "application/json",
        size_bytes: secondBytes.byteLength,
        artifact_digest: await digest(secondBytes),
      },
    ];
    const manifest = {
      deployment_id: DEPLOYMENT,
      service_name: "api",
      environment: "production" as const,
      service_version: "1.0.0",
      repository_url: "https://example.com/repo",
      git_commit: GIT_COMMIT,
      git_ref: "refs/heads/main",
      artifact_digest: runtimeDigest,
      ci_provider: "github",
      ci_run_id: "123",
      deployed_at: NOW.toISOString(),
      region: ["global"],
      artifacts: declarations,
    };

    const registered = await putDeployment(
      jsonRequest(
        `https://status.example/v1/deployments/${DEPLOYMENT}`,
        manifest,
      ),
      DEPLOYMENT,
      context,
    );
    expect(registered).toMatchObject({
      status: 201,
      body: { state: "awaiting_artifacts" },
    });

    for (const [index, declaration] of declarations.entries()) {
      const bytes = index === 0 ? firstBytes : secondBytes;
      const uploadInput = { ...declaration, content_md5: contentMd5(bytes) };
      const upload = await createArtifactUpload(
        jsonRequest(
          `https://status.example/v1/deployments/${DEPLOYMENT}/artifact-uploads`,
          uploadInput,
          { "idempotency-key": `artifact-upload-${index}` },
        ),
        DEPLOYMENT,
        context,
      );
      const replay = await createArtifactUpload(
        jsonRequest(
          `https://status.example/v1/deployments/${DEPLOYMENT}/artifact-uploads`,
          uploadInput,
          { "idempotency-key": `artifact-upload-${index}` },
        ),
        DEPLOYMENT,
        context,
      );
      expect(replay).toEqual({ status: 200, body: upload.body });
      const row = await database
        .prepare(
          "SELECT object_key FROM artifact_upload_sessions WHERE upload_id=?",
        )
        .bind(upload.body.upload_id)
        .first<{ object_key: string }>();
      if (row === null) throw new Error("upload session did not persist");
      if (index === 0) {
        const renewal = await createArtifactUpload(
          jsonRequest(
            `https://status.example/v1/deployments/${DEPLOYMENT}/artifact-uploads`,
            uploadInput,
            { "idempotency-key": "artifact-renewal-0" },
          ),
          DEPLOYMENT,
          context,
        );
        expect(renewal.status).toBe(201);
        expect(renewal.body.upload_id).not.toBe(upload.body.upload_id);
        await expect(
          database
            .prepare(
              "SELECT COUNT(*) FROM artifact_upload_sessions WHERE object_key=?",
            )
            .bind(row.object_key)
            .first<number>("COUNT(*)"),
        ).resolves.toBe(2);
      }
      const signing = signed.get(row.object_key);
      if (signing === undefined) throw new Error("upload was not signed");
      await bucket.upload(
        row.object_key,
        bytes,
        signing.contentType,
        signing.metadata,
      );

      await expect(
        commitArtifact(
          jsonRequest(
            `https://status.example/v1/deployments/${DEPLOYMENT}/artifacts`,
            { upload_id: upload.body.upload_id, ...declaration },
          ),
          DEPLOYMENT,
          context,
        ),
      ).resolves.toMatchObject({
        status: 201,
        body: { file_name: declaration.file_name },
      });

      const current = await database
        .prepare(
          "SELECT state,revision FROM deployment_current_status WHERE deployment_id=?",
        )
        .bind(DEPLOYMENT)
        .first<{ state: string; revision: number }>();
      expect(current).toEqual(
        index === 0
          ? { state: "artifacts_pending", revision: 2 }
          : { state: "ready", revision: 3 },
      );
    }

    await expect(
      database
        .prepare(
          "SELECT COUNT(*) FROM deployment_artifacts WHERE deployment_id=?",
        )
        .bind(DEPLOYMENT)
        .first<number>("COUNT(*)"),
    ).resolves.toBe(2);
    await expect(
      database
        .prepare(
          "SELECT COUNT(*) FROM audit_log WHERE action='deployment.ready'",
        )
        .first<number>("COUNT(*)"),
    ).resolves.toBe(1);
  });
});

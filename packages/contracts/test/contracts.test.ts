import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  AdminPrincipalSchema,
  DiagnosticEventSchema,
  DiagnosticQueueEnvelopeSchema,
  DeploymentManifestSchema,
  CreateMonitorCommandSchema,
  CreateArtifactUploadRequestSchema,
  CreateDeploymentArtifactRequestSchema,
  EvaluationPolicySchema,
  ProblemDetailsSchema,
  TelemetryReferenceSchema,
  UtcDateTimeSchema,
  UuidV7Schema,
  buildOpenApiDocument,
  httpRouteManifest,
  toCoreEvaluationPolicy,
} from "../src/index.js";

const eventId = "0199d0a8-2e12-7a59-a51e-44aa9b6d1001";
const deploymentId = "0199d09a-b692-7ce0-a1c0-5138a43d7402";
const correlationId = "0199d0a7-d771-7435-a388-bb6fa5d533fc";
const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";

/** 构造有效 Diagnostic 测试样例 / Build a valid Diagnostic fixture. */
function diagnosticEvent() {
  return {
    event_id: eventId,
    schema_version: "1.0",
    kind: "dependency.unavailable",
    severity: "error",
    service_name: "identity",
    environment: "production",
    deployment_id: deploymentId,
    occurred_at: "2026-09-08T15:51:02.314Z",
    correlation_id: correlationId,
    trace_id: traceId,
    span_id: "00f067aa0ba902b7",
    summary: "D1 query exceeded the dependency deadline",
    fingerprint: {
      dependency: "d1",
      operation: "identity.lookup",
      error_type: "timeout",
    },
    evidence: [
      {
        kind: "trace",
        backend: "grafana-cloud",
        locator: { trace_id: traceId },
      },
    ],
    attributes: { "dependency.name": "d1", "error.type": "TimeoutError" },
  } as const;
}

describe("platform primitives", () => {
  it("requires a causal fault reference exactly for explicit recovery", () => {
    const event = diagnosticEvent();
    expect(DiagnosticEventSchema.parse(event).signal).toBe("fault");
    expect(
      DiagnosticEventSchema.safeParse({ ...event, signal: "recovery" }).success,
    ).toBe(false);
    expect(
      DiagnosticEventSchema.safeParse({
        ...event,
        signal: "fault",
        recovery_of_event_id: eventId,
      }).success,
    ).toBe(false);
    expect(
      DiagnosticEventSchema.safeParse({
        ...event,
        signal: "recovery",
        recovery_of_event_id: eventId,
      }).success,
    ).toBe(true);
    expect(
      DiagnosticEventSchema.safeParse({
        ...event,
        signal: "recovery",
        recovery_of_event_id: "not-an-event",
      }).success,
    ).toBe(false);
  });
  it("accepts lowercase UUIDv7 and rejects other versions or uppercase", () => {
    expect(UuidV7Schema.safeParse(eventId).success).toBe(true);
    expect(
      UuidV7Schema.safeParse("627cc493-f310-47de-96bd-71410b7dec09").success,
    ).toBe(false);
    expect(UuidV7Schema.safeParse(eventId.toUpperCase()).success).toBe(false);
  });

  it("accepts only UTC Z timestamps", () => {
    expect(
      UtcDateTimeSchema.safeParse("2026-09-08T15:51:02.314Z").success,
    ).toBe(true);
    expect(
      UtcDateTimeSchema.safeParse("2026-09-08T23:51:02.314+08:00").success,
    ).toBe(false);
  });
});

describe("diagnostic contracts", () => {
  it("accepts the documented diagnostic and rejects unknown attributes", () => {
    expect(DiagnosticEventSchema.safeParse(diagnosticEvent()).success).toBe(
      true,
    );
    const unsafe = {
      ...diagnosticEvent(),
      attributes: { authorization: "Bearer secret" },
    };
    expect(DiagnosticEventSchema.safeParse(unsafe).success).toBe(false);
  });

  it("requires evidence or an execution trace identity", () => {
    const {
      trace_id: _traceId,
      span_id: _spanId,
      ...withoutTrace
    } = diagnosticEvent();
    expect(
      DiagnosticEventSchema.safeParse({ ...withoutTrace, evidence: [] })
        .success,
    ).toBe(false);
  });

  it("validates a complete trace TelemetryReference", () => {
    expect(
      TelemetryReferenceSchema.safeParse({
        id: eventId,
        kind: "trace",
        backend: "grafana-cloud",
        locator: { trace_id: traceId, span_id: "00f067aa0ba902b7" },
        service_name: "identity",
        deployment_id: deploymentId,
        correlation_id: correlationId,
        trace_id: traceId,
        span_id: "00f067aa0ba902b7",
      }).success,
    ).toBe(true);
  });

  it("binds trusted queue metadata to event provenance", () => {
    const envelope = {
      schema_version: "1.0",
      message_id: "0199d0a8-2e12-7a59-a51e-44aa9b6d1002",
      event: diagnosticEvent(),
      received_at: "2026-09-08T15:51:02.400Z",
      producer: {
        subject: "ci:identity",
        service_name: "identity",
        environment: "production",
        deployment_id: deploymentId,
        scopes: ["diagnostic:write"],
        token_id: "token-1",
        auth_method: "jwt",
      },
      trace_context: { correlation_id: correlationId },
    } as const;
    expect(DiagnosticQueueEnvelopeSchema.safeParse(envelope).success).toBe(
      true,
    );
    expect(
      DiagnosticQueueEnvelopeSchema.safeParse({
        ...envelope,
        origin: { kind: "monitor", monitor_id: eventId },
      }).success,
    ).toBe(true);
    expect(
      DiagnosticQueueEnvelopeSchema.safeParse({
        ...envelope,
        producer: { ...envelope.producer, deployment_id: eventId },
      }).success,
    ).toBe(false);
  });
});

describe("provenance and administration", () => {
  it("rejects mutable refs and invalid artifact provenance", () => {
    const manifest = {
      deployment_id: deploymentId,
      service_name: "identity",
      environment: "production",
      service_version: "1.2.3",
      repository_url: "https://github.com/moesegfault/identity",
      git_commit: "a".repeat(40),
      git_ref: "refs/tags/v1.2.3",
      artifact_digest: `sha256:${"b".repeat(64)}`,
      ci_provider: "github-actions",
      ci_run_id: "12345",
      deployed_at: "2026-09-08T15:51:02.314Z",
      region: ["global"],
      artifacts: [
        {
          kind: "binary",
          file_name: "identity",
          media_type: "application/octet-stream",
          size_bytes: 100,
          artifact_digest: `sha256:${"b".repeat(64)}`,
        },
      ],
    };
    expect(DeploymentManifestSchema.safeParse(manifest).success).toBe(false);
    expect(
      DeploymentManifestSchema.safeParse({
        ...manifest,
        artifacts: [{ ...manifest.artifacts[0], build_id: "deadbeef" }],
      }).success,
    ).toBe(true);
  });

  it("requires one digest-bound runtime and its exact JavaScript source map", () => {
    const runtimeDigest = `sha256:${"d".repeat(64)}`;
    const manifest = {
      deployment_id: deploymentId,
      service_name: "status",
      environment: "production",
      service_version: "1.0.0",
      repository_url: "https://github.com/moesegfault/status",
      git_commit: "e".repeat(40),
      git_ref: "refs/tags/v1.0.0",
      artifact_digest: runtimeDigest,
      ci_provider: "github-actions",
      ci_run_id: "67890",
      deployed_at: "2026-09-08T15:51:02.314Z",
      region: ["global"],
      artifacts: [
        {
          kind: "other",
          file_name: "worker.js",
          media_type: "application/javascript",
          size_bytes: 1_000,
          artifact_digest: runtimeDigest,
        },
      ],
    } as const;

    expect(
      DeploymentManifestSchema.safeParse({ ...manifest, artifacts: [] })
        .success,
    ).toBe(false);
    expect(DeploymentManifestSchema.safeParse(manifest).success).toBe(false);
    expect(
      DeploymentManifestSchema.safeParse({
        ...manifest,
        artifacts: [
          ...manifest.artifacts,
          {
            kind: "source_map",
            file_name: "unrelated.js.map",
            media_type: "application/json",
            size_bytes: 2_000,
            artifact_digest: `sha256:${"f".repeat(64)}`,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      DeploymentManifestSchema.safeParse({
        ...manifest,
        artifacts: [
          ...manifest.artifacts,
          {
            kind: "source_map",
            file_name: "worker.js.map",
            media_type: "application/json",
            size_bytes: 2_000,
            artifact_digest: `sha256:${"f".repeat(64)}`,
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("requires a valid Content-MD5 for conditional artifact upload", () => {
    const upload = {
      kind: "binary",
      file_name: "identity",
      media_type: "application/octet-stream",
      size_bytes: 4,
      artifact_digest: `sha256:${"a".repeat(64)}`,
      content_md5: "CY9rzUYh03PK3k6DJie09g==",
      build_id: "deadbeef",
    } as const;
    expect(CreateArtifactUploadRequestSchema.safeParse(upload).success).toBe(
      true,
    );
    expect(
      CreateArtifactUploadRequestSchema.safeParse({
        ...upload,
        content_md5: "not-base64",
      }).success,
    ).toBe(false);
  });

  it("enforces source-map constraints on upload and commit", () => {
    const sourceMap = {
      kind: "source_map",
      file_name: "worker.js.map",
      media_type: "application/json",
      size_bytes: 8 * 1024 * 1024,
      artifact_digest: `sha256:${"a".repeat(64)}`,
    } as const;
    expect(
      CreateArtifactUploadRequestSchema.safeParse({
        ...sourceMap,
        content_md5: "CY9rzUYh03PK3k6DJie09g==",
      }).success,
    ).toBe(true);
    expect(
      CreateArtifactUploadRequestSchema.safeParse({
        ...sourceMap,
        size_bytes: 8 * 1024 * 1024 + 1,
        content_md5: "CY9rzUYh03PK3k6DJie09g==",
      }).success,
    ).toBe(false);
    expect(
      CreateDeploymentArtifactRequestSchema.safeParse({
        ...sourceMap,
        upload_id: eventId,
      }).success,
    ).toBe(true);
    expect(
      CreateDeploymentArtifactRequestSchema.safeParse({
        ...sourceMap,
        upload_id: eventId,
        media_type: "application/octet-stream",
      }).success,
    ).toBe(false);
  });

  it("normalizes the exact Access principal contract", () => {
    const principal = {
      subject: "github|42",
      email: "ops@example.com",
      roles: ["operator"],
      authenticated_at: "2026-09-08T15:51:02.314Z",
      access_application: "ops-gateway",
    };
    expect(AdminPrincipalSchema.safeParse(principal).success).toBe(true);
    expect(
      AdminPrincipalSchema.safeParse({
        ...principal,
        correlation_id: correlationId,
      }).success,
    ).toBe(false);
  });

  it("supports RFC 9457 validation errors without arbitrary extensions", () => {
    expect(
      ProblemDetailsSchema.safeParse({
        type: "https://status.moesegfault.dev/problems/validation-error",
        title: "Invalid request",
        status: 422,
        instance: "/v1/diagnostic-events",
        correlation_id: correlationId,
        errors: [{ pointer: "/attributes", detail: "Unknown field" }],
      }).success,
    ).toBe(true);
  });

  it("projects an exact policy losslessly into the core evaluator", () => {
    const policy = EvaluationPolicySchema.parse({
      policy_id: eventId,
      revision: 3,
      window_seconds: 300,
      minimum_samples: 5,
      failure_threshold: { numerator: 2, denominator: 3 },
      recovery_threshold: { numerator: 9, denominator: 10 },
      latency_threshold_ms: 1_000,
      stale_after_seconds: 600,
      quorum: {
        minimum_locations: 2,
        failure_locations: 2,
        recovery_locations: 2,
      },
      issue_fingerprint_template: ["operation", "error_type"],
      failure_status: "degraded",
    });
    expect(toCoreEvaluationPolicy(policy)).toEqual({
      revision: 3,
      window_seconds: 300,
      minimum_samples: 5,
      failure_threshold: { numerator: 2, denominator: 3 },
      recovery_threshold: { numerator: 9, denominator: 10 },
      latency_threshold_ms: 1_000,
      stale_after_seconds: 600,
      quorum: {
        minimum_locations: 2,
        failure_locations: 2,
        recovery_locations: 2,
      },
      failure_status: "degraded",
    });
  });

  it("enforces executable monitor probe and scheduling invariants", () => {
    const monitor = {
      command_id: correlationId,
      monitor_id: eventId,
      service_name: "identity",
      target_type: "service",
      target_id: "identity",
      probe_kind: "http",
      probe_config: {
        kind: "http",
        url: "https://identity.moesegfault.dev/health",
      },
      schedule_kind: "interval",
      schedule_expression: null,
      interval_seconds: 60,
      timeout_ms: 5_000,
      locations: ["global"],
      policy_id: deploymentId,
      policy_revision: 1,
      enabled: true,
    } as const;
    expect(CreateMonitorCommandSchema.safeParse(monitor).success).toBe(true);
    expect(
      CreateMonitorCommandSchema.safeParse({ ...monitor, probe_kind: "tcp" })
        .success,
    ).toBe(false);
    expect(
      CreateMonitorCommandSchema.safeParse({ ...monitor, timeout_ms: 60_000 })
        .success,
    ).toBe(false);
  });
});

describe("OpenAPI", () => {
  it("contains exactly the documented public routes and unique operation IDs", () => {
    const document = buildOpenApiDocument() as {
      openapi: string;
      paths: Record<string, Record<string, { operationId: string }>>;
    };
    expect(document.openapi).toBe("3.1.1");
    expect(Object.keys(document.paths).sort()).toEqual(
      [...new Set(httpRouteManifest.map(({ path }) => path))].sort(),
    );
    const operations = Object.values(document.paths).flatMap((path) =>
      Object.values(path).map(({ operationId }) => operationId),
    );
    expect(new Set(operations).size).toBe(httpRouteManifest.length);
    expect(operations.sort()).toEqual(
      httpRouteManifest.map(({ operation_id }) => operation_id).sort(),
    );
  });

  it("derives strict schemas and declares correlation headers/security", () => {
    const document = buildOpenApiDocument() as any;
    expect(
      document.components.schemas.DiagnosticEvent.additionalProperties,
    ).toBe(false);
    expect(
      document.components.schemas.DiagnosticEvent.properties.event_id.format,
    ).toBe("uuid");
    expect(
      document.components.schemas.DiagnosticEvent.properties.occurred_at.format,
    ).toBe("date-time");
    expect(document.paths["/v1/status"].get.security).toEqual([]);
    expect(document.paths["/v1/diagnostic-events"].post.security).toEqual([
      { machineBearer: [] },
    ]);
    for (const path of Object.values(document.paths) as any[]) {
      for (const operation of Object.values(path) as any[]) {
        for (const response of Object.values(operation.responses) as any[]) {
          expect(
            response.headers["x-moesegfault-correlation-id"],
          ).toBeDefined();
        }
      }
    }
  });

  it("keeps the checked-in OpenAPI artifact synchronized", () => {
    const generated = JSON.parse(
      readFileSync(new URL("../openapi.json", import.meta.url), "utf8"),
    );
    expect(generated).toEqual(buildOpenApiDocument());
  });
});

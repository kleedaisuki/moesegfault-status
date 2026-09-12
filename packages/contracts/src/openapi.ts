import { z } from "zod";
import {
  DIAGNOSTIC_EVENT_MAX_BODY_BYTES,
  DiagnosticAcceptedSchema,
  DiagnosticEventSchema,
} from "./diagnostics.js";
import {
  ARTIFACT_REQUEST_MAX_BODY_BYTES,
  ARTIFACT_MAX_BYTES,
  ArtifactUploadSessionSchema,
  CreateArtifactUploadRequestSchema,
  CreateDeploymentArtifactRequestSchema,
  DeploymentArtifactSchema,
  DeploymentManifestSchema,
  DeploymentRegistrationSchema,
  DEPLOYMENT_MANIFEST_MAX_BODY_BYTES,
} from "./deployments.js";
import {
  PlatformStatusResponseSchema,
  ProblemDetailsSchema,
  PublicIncidentListResponseSchema,
  PublicIncidentResponseSchema,
  PublicMaintenanceWindowListResponseSchema,
  PublicServiceListResponseSchema,
  PublicServiceStatusResponseSchema,
} from "./public.js";

/** 文档规定的全部且仅有的公网 HTTP 路由 / The complete and exclusive public HTTP route manifest defined by the design. */
export const httpRouteManifest = [
  {
    method: "GET",
    path: "/v1/status",
    operation_id: "getPlatformStatus",
    security: "public",
  },
  {
    method: "GET",
    path: "/v1/services",
    operation_id: "listServices",
    security: "public",
  },
  {
    method: "GET",
    path: "/v1/services/{service_name}",
    operation_id: "getServiceStatus",
    security: "public",
  },
  {
    method: "GET",
    path: "/v1/incidents",
    operation_id: "listIncidents",
    security: "public",
  },
  {
    method: "GET",
    path: "/v1/incidents/{incident_id}",
    operation_id: "getIncident",
    security: "public",
  },
  {
    method: "GET",
    path: "/v1/maintenance-windows",
    operation_id: "listMaintenanceWindows",
    security: "public",
  },
  {
    method: "POST",
    path: "/v1/diagnostic-events",
    operation_id: "ingestDiagnosticEvent",
    security: "machine",
  },
  {
    method: "PUT",
    path: "/v1/deployments/{deployment_id}",
    operation_id: "putDeployment",
    security: "machine",
  },
  {
    method: "POST",
    path: "/v1/deployments/{deployment_id}/artifact-uploads",
    operation_id: "createDeploymentArtifactUpload",
    security: "machine",
  },
  {
    method: "PUT",
    path: "/v1/deployments/{deployment_id}/artifact-uploads/{upload_id}",
    operation_id: "uploadDeploymentArtifact",
    security: "machine",
  },
  {
    method: "POST",
    path: "/v1/deployments/{deployment_id}/artifacts",
    operation_id: "createDeploymentArtifact",
    security: "machine",
  },
] as const;
export type HttpRoute = (typeof httpRouteManifest)[number];

const contractSchemas = {
  ProblemDetails: ProblemDetailsSchema,
  DiagnosticEvent: DiagnosticEventSchema,
  DiagnosticAccepted: DiagnosticAcceptedSchema,
  DeploymentManifest: DeploymentManifestSchema,
  DeploymentRegistration: DeploymentRegistrationSchema,
  CreateArtifactUploadRequest: CreateArtifactUploadRequestSchema,
  ArtifactUploadSession: ArtifactUploadSessionSchema,
  CreateDeploymentArtifactRequest: CreateDeploymentArtifactRequestSchema,
  DeploymentArtifact: DeploymentArtifactSchema,
  PlatformStatusResponse: PlatformStatusResponseSchema,
  PublicServiceListResponse: PublicServiceListResponseSchema,
  PublicServiceStatusResponse: PublicServiceStatusResponseSchema,
  PublicIncidentListResponse: PublicIncidentListResponseSchema,
  PublicIncidentResponse: PublicIncidentResponseSchema,
  PublicMaintenanceWindowListResponse:
    PublicMaintenanceWindowListResponseSchema,
} satisfies Record<string, z.ZodType>;

function schemaRef(name: keyof typeof contractSchemas): Record<string, string> {
  return { $ref: `#/components/schemas/${name}` };
}

const correlationHeader = {
  description: "RFC 9562 UUIDv7 execution correlation identifier.",
  required: true,
  schema: {
    type: "string",
    format: "uuid",
    pattern:
      "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
  },
} as const;

const etagHeader = {
  description: "Opaque resource revision validator.",
  required: true,
  schema: { type: "string" },
} as const;

function jsonResponse(
  description: string,
  schemaName: keyof typeof contractSchemas,
  withEtag = false,
) {
  return {
    description,
    headers: {
      "x-moesegfault-correlation-id": correlationHeader,
      ...(withEtag ? { ETag: etagHeader } : {}),
    },
    content: { "application/json": { schema: schemaRef(schemaName) } },
  };
}

function problemResponse(description: string) {
  return {
    description,
    headers: { "x-moesegfault-correlation-id": correlationHeader },
    content: {
      "application/problem+json": { schema: schemaRef("ProblemDetails") },
    },
  };
}

const commonProblems = {
  "400": problemResponse("Malformed request"),
  "401": problemResponse("Authentication required"),
  "403": problemResponse("Insufficient scope or claim mismatch"),
  "404": problemResponse("Resource not found"),
  "409": problemResponse("Immutable identifier or revision conflict"),
  "413": problemResponse("Request body too large"),
  "429": problemResponse("Rate limit exceeded"),
  "422": problemResponse("Semantically invalid request"),
  "500": problemResponse("Internal server error"),
  "503": problemResponse("Temporarily unavailable"),
} as const;

const deploymentIdParameter = {
  name: "deployment_id",
  in: "path",
  required: true,
  schema: {
    type: "string",
    format: "uuid",
    pattern:
      "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
  },
} as const;
const cursorParameter = {
  name: "cursor",
  in: "query",
  required: false,
  schema: { type: "string", minLength: 16, maxLength: 2048 },
} as const;
const limitParameter = {
  name: "limit",
  in: "query",
  required: false,
  schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
} as const;
const idempotencyKeyParameter = {
  name: "Idempotency-Key",
  in: "header",
  required: true,
  description:
    "Stable 8-256 character key bound to the canonical request body for 24 hours.",
  schema: {
    type: "string",
    minLength: 8,
    maxLength: 256,
    pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
  },
} as const;

/** 从运行时 Zod schema 构建 OpenAPI 3.1.1 文档 / Build the OpenAPI 3.1.1 document from the runtime Zod schemas. */
export function buildOpenApiDocument(): Record<string, unknown> {
  const schemas = Object.fromEntries(
    Object.entries(contractSchemas).map(([name, schema]) => {
      const converted = z.toJSONSchema(schema, {
        target: "draft-2020-12",
        unrepresentable: "throw",
        ...(name === "DiagnosticEvent" ? { io: "input" as const } : {}),
      }) as Record<string, unknown>;
      delete converted.$schema;
      // Zod refinement 不会自动导出；显式保留恢复因果字段的双向约束。 / Zod refinements are not exported automatically; preserve the recovery reference constraint explicitly.
      if (name === "DiagnosticEvent") {
        converted.allOf = [
          {
            if: {
              properties: { signal: { const: "recovery" } },
              required: ["signal"],
            },
            then: {
              properties: { recovery_of_event_id: {} },
              required: ["recovery_of_event_id"],
            },
            else: {
              not: {
                properties: { recovery_of_event_id: {} },
                required: ["recovery_of_event_id"],
              },
            },
          },
        ];
      }
      return [name, converted];
    }),
  );

  return {
    openapi: "3.1.1",
    info: {
      title: "moeSegFault Status API",
      version: "1.0.0",
      description:
        "Public status reads and authenticated machine ingress. Administrative operations use Service Binding RPC and are deliberately absent.",
      license: {
        name: "GNU General Public License v3.0",
        identifier: "GPL-3.0-only",
      },
    },
    servers: [{ url: "https://status.moesegfault.dev" }],
    paths: {
      "/v1/status": {
        get: {
          operationId: "getPlatformStatus",
          summary: "Get aggregate platform status",
          security: [],
          responses: {
            "200": jsonResponse(
              "Current platform status",
              "PlatformStatusResponse",
              true,
            ),
            ...commonProblems,
          },
        },
      },
      "/v1/services": {
        get: {
          operationId: "listServices",
          summary: "List public service statuses",
          security: [],
          parameters: [cursorParameter, limitParameter],
          responses: {
            "200": jsonResponse(
              "Public service statuses",
              "PublicServiceListResponse",
              true,
            ),
            ...commonProblems,
          },
        },
      },
      "/v1/services/{service_name}": {
        get: {
          operationId: "getServiceStatus",
          summary: "Get detailed service status",
          security: [],
          parameters: [
            {
              name: "service_name",
              in: "path",
              required: true,
              schema: {
                type: "string",
                pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
                maxLength: 63,
              },
            },
          ],
          responses: {
            "200": jsonResponse(
              "Detailed service status",
              "PublicServiceStatusResponse",
              true,
            ),
            ...commonProblems,
          },
        },
      },
      "/v1/incidents": {
        get: {
          operationId: "listIncidents",
          summary: "List current and historical incidents",
          security: [],
          parameters: [
            {
              name: "states",
              in: "query",
              required: false,
              style: "form",
              explode: true,
              schema: {
                type: "array",
                maxItems: 4,
                items: {
                  type: "string",
                  enum: [
                    "investigating",
                    "identified",
                    "monitoring",
                    "resolved",
                  ],
                },
              },
            },
            cursorParameter,
            limitParameter,
          ],
          responses: {
            "200": jsonResponse(
              "Current and historical public incidents",
              "PublicIncidentListResponse",
              true,
            ),
            ...commonProblems,
          },
        },
      },
      "/v1/incidents/{incident_id}": {
        get: {
          operationId: "getIncident",
          summary: "Get an incident timeline",
          security: [],
          parameters: [
            {
              name: "incident_id",
              in: "path",
              required: true,
              schema: {
                type: "string",
                format: "uuid",
                pattern:
                  "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
              },
            },
          ],
          responses: {
            "200": jsonResponse(
              "Incident detail and timeline",
              "PublicIncidentResponse",
              true,
            ),
            ...commonProblems,
          },
        },
      },
      "/v1/maintenance-windows": {
        get: {
          operationId: "listMaintenanceWindows",
          summary: "List current and future maintenance windows",
          security: [],
          parameters: [
            {
              name: "from",
              in: "query",
              required: false,
              schema: {
                type: "string",
                format: "date-time",
                pattern:
                  "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?Z$",
              },
            },
            {
              name: "to",
              in: "query",
              required: false,
              schema: {
                type: "string",
                format: "date-time",
                pattern:
                  "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?Z$",
              },
            },
            cursorParameter,
            limitParameter,
          ],
          responses: {
            "200": jsonResponse(
              "Current and future maintenance windows",
              "PublicMaintenanceWindowListResponse",
              true,
            ),
            ...commonProblems,
          },
        },
      },
      "/v1/diagnostic-events": {
        post: {
          operationId: "ingestDiagnosticEvent",
          summary: "Ingest an immutable diagnostic event",
          security: [{ machineBearer: [] }],
          "x-body-max-bytes": DIAGNOSTIC_EVENT_MAX_BODY_BYTES,
          "x-idempotency":
            "event_id; duplicate events return 202 without duplicate side effects",
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: schemaRef("DiagnosticEvent") },
            },
          },
          responses: {
            "202": jsonResponse(
              "Accepted for at-least-once processing",
              "DiagnosticAccepted",
            ),
            ...commonProblems,
          },
        },
      },
      "/v1/deployments/{deployment_id}": {
        put: {
          operationId: "putDeployment",
          summary: "Register an immutable deployment manifest",
          security: [{ machineBearer: [] }],
          parameters: [deploymentIdParameter],
          "x-body-max-bytes": DEPLOYMENT_MANIFEST_MAX_BODY_BYTES,
          "x-idempotency":
            "same deployment_id and identical canonical manifest returns 200; differing content returns 409",
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: schemaRef("DeploymentManifest") },
            },
          },
          responses: {
            "200": jsonResponse(
              "Identical manifest already registered",
              "DeploymentRegistration",
              true,
            ),
            "201": jsonResponse(
              "Manifest registered",
              "DeploymentRegistration",
              true,
            ),
            ...commonProblems,
          },
        },
      },
      "/v1/deployments/{deployment_id}/artifact-uploads": {
        post: {
          operationId: "createDeploymentArtifactUpload",
          summary: "Create a restricted artifact upload session",
          description:
            "A D1-backed session expires after 600 seconds. The returned URL is on this API origin and requires a fresh artifacts:write machine Bearer JWT on PUT; it is not an anonymous S3 presigned URL. Clients must reject cross-origin URLs and redirects. The PUT conditionally creates a content-addressed object through the native R2 binding. A 412 from that URL means the immutable key already exists (for example after session renewal); clients must continue to artifact commit, whose server-side byte digest verification is authoritative, and must never attempt an overwrite.",
          security: [{ machineBearer: [] }],
          parameters: [deploymentIdParameter, idempotencyKeyParameter],
          "x-body-max-bytes": ARTIFACT_REQUEST_MAX_BODY_BYTES,
          "x-idempotency":
            "artifact declaration is digest-bound; replay returns an equivalent active session or a new time-limited session",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: schemaRef("CreateArtifactUploadRequest"),
              },
            },
          },
          responses: {
            "201": jsonResponse(
              "Restricted upload session created",
              "ArtifactUploadSession",
            ),
            ...commonProblems,
          },
        },
      },
      "/v1/deployments/{deployment_id}/artifact-uploads/{upload_id}": {
        put: {
          operationId: "uploadDeploymentArtifact",
          summary: "Upload immutable artifact bytes through native R2",
          description:
            "Requires artifacts:write on every request and a matching unexpired D1 session (600 seconds). Send the exact session-provided Content-Type, Content-Length, Content-MD5 and If-None-Match headers plus Authorization: Bearer. Reject cross-origin upload URLs and redirects. Native R2 writes are create-only; 412 must never cause an overwrite. Continue to artifact commit after 201 or 412: only server-side SHA-256 verification and registration can make a deployment ready. Source maps retain their stricter 8 MiB ceiling.",
          security: [{ machineBearer: [] }],
          "x-body-max-bytes": ARTIFACT_MAX_BYTES,
          "x-required-scope": "artifacts:write",
          parameters: [
            deploymentIdParameter,
            { ...deploymentIdParameter, name: "upload_id" },
            {
              name: "Content-Type",
              in: "header",
              required: true,
              description: "Exact media type returned by the upload session.",
              schema: { type: "string" },
            },
            {
              name: "Content-Length",
              in: "header",
              required: true,
              description: "Exact declared byte length, at most 64 MiB.",
              schema: {
                type: "integer",
                minimum: 1,
                maximum: ARTIFACT_MAX_BYTES,
              },
            },
            {
              name: "Content-MD5",
              in: "header",
              required: true,
              schema: { type: "string", pattern: "^[A-Za-z0-9+/]{22}==$" },
            },
            {
              name: "If-None-Match",
              in: "header",
              required: true,
              schema: { type: "string", const: "*" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "*/*": { schema: { type: "string", format: "binary" } },
            },
          },
          responses: {
            "201": {
              description:
                "Immutable bytes stored; explicit artifact commit is still required",
              headers: { "x-moesegfault-correlation-id": correlationHeader },
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["data", "meta"],
                    properties: {
                      data: {
                        type: "object",
                        required: ["upload_id"],
                        properties: { upload_id: deploymentIdParameter.schema },
                      },
                      meta: { type: "object" },
                    },
                  },
                },
              },
            },
            "412": problemResponse(
              "Immutable object already exists; verify through artifact commit, never overwrite",
            ),
            ...commonProblems,
          },
        },
      },
      "/v1/deployments/{deployment_id}/artifacts": {
        post: {
          operationId: "createDeploymentArtifact",
          summary: "Verify and commit a deployment artifact",
          security: [{ machineBearer: [] }],
          parameters: [deploymentIdParameter],
          "x-body-max-bytes": ARTIFACT_REQUEST_MAX_BODY_BYTES,
          "x-idempotency":
            "same upload and verified digest returns 200; immutable metadata conflict returns 409",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: schemaRef("CreateDeploymentArtifactRequest"),
              },
            },
          },
          responses: {
            "200": jsonResponse(
              "Artifact already committed",
              "DeploymentArtifact",
              true,
            ),
            "201": jsonResponse(
              "Artifact verified and committed",
              "DeploymentArtifact",
              true,
            ),
            ...commonProblems,
          },
        },
      },
    },
    components: {
      securitySchemes: {
        machineBearer: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description:
            "Short-lived machine token with a unique token ID and subject, service_name, environment, deployment_id, and scope restrictions.",
        },
      },
      schemas,
    },
  };
}

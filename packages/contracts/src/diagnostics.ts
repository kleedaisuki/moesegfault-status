import { z } from "zod";
import {
  EnvironmentSchema,
  HttpsUrlSchema,
  ServiceNameSchema,
  Sha256DigestSchema,
  SpanIdSchema,
  TraceIdSchema,
  UtcDateTimeSchema,
  UuidV7Schema,
  DiagnosticSeveritySchema,
} from "./primitives.js";

/** 查询时间范围 / UTC query time range. */
export const TimeRangeSchema = z
  .strictObject({ start: UtcDateTimeSchema, end: UtcDateTimeSchema })
  .refine(({ start, end }) => Date.parse(start) <= Date.parse(end), {
    message: "start must not be after end",
  });
export type TimeRange = z.infer<typeof TimeRangeSchema>;

const BackendNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);
const SafeQueryValueSchema = z.union([
  z.string().min(1).max(512),
  z.number().finite(),
  z.boolean(),
]);
const SafeQuerySchema = z
  .record(
    z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_.-]*$/),
    SafeQueryValueSchema,
  )
  .refine(
    (value) => Object.keys(value).length <= 16,
    "locator query may contain at most 16 entries",
  );

/** Trace 证据 / Trace evidence locator. */
export const TraceEvidenceSchema = z.strictObject({
  kind: z.literal("trace"),
  backend: BackendNameSchema,
  locator: z.strictObject({
    trace_id: TraceIdSchema,
    span_id: SpanIdSchema.optional(),
  }),
});

/** 日志查询证据 / Structured log-query evidence. */
export const LogQueryEvidenceSchema = z.strictObject({
  kind: z.literal("log_query"),
  backend: BackendNameSchema,
  locator: z.strictObject({ query: SafeQuerySchema }),
  time_range: TimeRangeSchema,
});

/** Profile 证据 / Structured continuous-profile evidence. */
export const ProfileEvidenceSchema = z.strictObject({
  kind: z.literal("profile"),
  backend: BackendNameSchema,
  locator: z
    .strictObject({
      profile_type: z.enum([
        "cpu",
        "memory",
        "allocations",
        "mutex",
        "goroutine",
        "wall",
      ]),
      profile_id: z.string().min(1).max(256).optional(),
      query: SafeQuerySchema.optional(),
    })
    .refine(
      (value) => value.profile_id !== undefined || value.query !== undefined,
      "profile_id or query is required",
    ),
  time_range: TimeRangeSchema,
});

/** Metric 查询证据 / Structured metric-query evidence. */
export const MetricQueryEvidenceSchema = z.strictObject({
  kind: z.literal("metric_query"),
  backend: BackendNameSchema,
  locator: z.strictObject({
    metric_name: z.string().min(1).max(255),
    query: SafeQuerySchema,
  }),
  time_range: TimeRangeSchema,
});

/** 固定到 commit 的源码证据 / Source evidence pinned to an immutable commit. */
export const SourceEvidenceSchema = z.strictObject({
  kind: z.literal("source"),
  backend: BackendNameSchema,
  locator: z.strictObject({
    repository_url: HttpsUrlSchema,
    git_commit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
    path: z
      .string()
      .min(1)
      .max(1024)
      .regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/),
    line: z.number().int().positive().max(10_000_000).optional(),
    column: z.number().int().positive().max(10_000_000).optional(),
  }),
});

/** 不可变产物证据 / Immutable artifact evidence. */
export const ArtifactEvidenceSchema = z.strictObject({
  kind: z.literal("artifact"),
  backend: BackendNameSchema,
  locator: z.strictObject({
    artifact_digest: Sha256DigestSchema,
    build_id: z.string().min(1).max(256).optional(),
    artifact_kind: z.enum([
      "binary",
      "debug_symbols",
      "source_map",
      "sbom",
      "manifest",
      "other",
    ]),
  }),
});

/** Diagnostic 可内嵌的后端无关证据 / Backend-neutral evidence accepted in a DiagnosticEvent. */
export const DiagnosticEvidenceSchema = z.discriminatedUnion("kind", [
  TraceEvidenceSchema,
  LogQueryEvidenceSchema,
  ProfileEvidenceSchema,
  MetricQueryEvidenceSchema,
  SourceEvidenceSchema,
  ArtifactEvidenceSchema,
]);
export type DiagnosticEvidence = z.infer<typeof DiagnosticEvidenceSchema>;

/** 完整 TelemetryReference；身份字段把证据绑定到部署来源 / Full TelemetryReference with deployment provenance. */
const TelemetryIdentityShape = {
  id: UuidV7Schema,
  service_name: ServiceNameSchema,
  deployment_id: UuidV7Schema,
  correlation_id: UuidV7Schema.optional(),
  trace_id: TraceIdSchema.optional(),
  span_id: SpanIdSchema.optional(),
  expires_at: UtcDateTimeSchema.optional(),
};

export const TelemetryReferenceSchema = z
  .discriminatedUnion("kind", [
    TraceEvidenceSchema.extend(TelemetryIdentityShape),
    LogQueryEvidenceSchema.extend(TelemetryIdentityShape),
    ProfileEvidenceSchema.extend(TelemetryIdentityShape),
    MetricQueryEvidenceSchema.extend(TelemetryIdentityShape),
    SourceEvidenceSchema.extend(TelemetryIdentityShape),
    ArtifactEvidenceSchema.extend(TelemetryIdentityShape),
  ])
  .superRefine((value, context) => {
    if (value.span_id !== undefined && value.trace_id === undefined) {
      context.addIssue({
        code: "custom",
        path: ["span_id"],
        message: "span_id requires trace_id",
      });
    }
    if (
      value.kind === "trace" &&
      value.trace_id !== undefined &&
      value.trace_id !== value.locator.trace_id
    ) {
      context.addIssue({
        code: "custom",
        path: ["trace_id"],
        message: "trace_id must match locator.trace_id",
      });
    }
  });
export type TelemetryReference = z.infer<typeof TelemetryReferenceSchema>;

/** 低基数、明确许可的 Diagnostic attributes / Explicitly allowlisted, low-cardinality Diagnostic attributes. */
export const DiagnosticAttributesSchema = z.strictObject({
  "dependency.name": z.string().min(1).max(128).optional(),
  "operation.name": z.string().min(1).max(128).optional(),
  "error.type": z.string().min(1).max(128).optional(),
  "component.id": z.string().min(1).max(128).optional(),
  "cloud.region": z.string().min(1).max(64).optional(),
  "http.request.method": z
    .enum([
      "GET",
      "HEAD",
      "POST",
      "PUT",
      "DELETE",
      "CONNECT",
      "OPTIONS",
      "TRACE",
      "PATCH",
    ])
    .optional(),
  "http.response.status_code": z.number().int().min(100).max(599).optional(),
  "rpc.system": z.string().min(1).max(64).optional(),
  "db.system.name": z.string().min(1).max(64).optional(),
  "deployment.environment.name": EnvironmentSchema.optional(),
});
export type DiagnosticAttributes = z.infer<typeof DiagnosticAttributesSchema>;

/** 稳定聚合指纹；禁止时间、随机 ID 和自由文本 / Stable aggregation fingerprint; timestamps and random IDs are impossible by construction. */
export const DiagnosticFingerprintSchema = z
  .strictObject({
    dependency: z.string().min(1).max(128).optional(),
    operation: z.string().min(1).max(128).optional(),
    error_type: z.string().min(1).max(128).optional(),
    component: z.string().min(1).max(128).optional(),
    capability: z.string().min(1).max(128).optional(),
    region: z.string().min(1).max(64).optional(),
    protocol: z
      .enum(["http", "rpc", "tcp", "dns", "queue", "database"])
      .optional(),
  })
  .refine(
    (value) => Object.values(value).some((entry) => entry !== undefined),
    "at least one fingerprint field is required",
  );
export type DiagnosticFingerprint = z.infer<typeof DiagnosticFingerprintSchema>;

/**
 * Diagnostic 条件信号 / Diagnostic condition signal.
 *
 * `recovery` 是检测器主动提交的正向证据，不会由缺少 `fault` 事件推断。
 * `recovery` is positive evidence submitted by the detector; it is never inferred
 * from the absence of `fault` events.
 */
export const DiagnosticSignalSchema = z.enum(["fault", "recovery"]);
export type DiagnosticSignal = z.infer<typeof DiagnosticSignalSchema>;

/** Diagnostic ingress 请求（最大传输体积仍由 HTTP 层强制 64 KiB）/ Diagnostic ingress request; HTTP enforces the 64 KiB body limit. */
export const DiagnosticEventSchema = z
  .strictObject({
    event_id: UuidV7Schema,
    schema_version: z.literal("1.0"),
    kind: z
      .string()
      .min(3)
      .max(128)
      .regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/),
    /** 省略时保持旧生产者的故障语义。 / Omission preserves legacy producer fault semantics. */
    signal: DiagnosticSignalSchema.default("fault"),
    /** 恢复证据必须因果引用它要清除的最新故障事件。 / Recovery evidence causally references the latest fault event it clears. */
    recovery_of_event_id: UuidV7Schema.optional(),
    severity: DiagnosticSeveritySchema,
    service_name: ServiceNameSchema,
    environment: EnvironmentSchema,
    deployment_id: UuidV7Schema,
    instance_id: z.string().uuid().optional(),
    occurred_at: UtcDateTimeSchema,
    correlation_id: UuidV7Schema,
    trace_id: TraceIdSchema.optional(),
    span_id: SpanIdSchema.optional(),
    summary: z.string().min(1).max(512),
    fingerprint: DiagnosticFingerprintSchema,
    evidence: z.array(DiagnosticEvidenceSchema).max(8).default([]),
    attributes: DiagnosticAttributesSchema.default({}),
  })
  .superRefine((value, context) => {
    if (
      (value.signal === "recovery") !==
      (value.recovery_of_event_id !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["recovery_of_event_id"],
        message:
          "recovery_of_event_id is required exactly when signal is recovery",
      });
    }
    if (value.span_id !== undefined && value.trace_id === undefined) {
      context.addIssue({
        code: "custom",
        path: ["span_id"],
        message: "span_id requires trace_id",
      });
    }
    if (value.evidence.length === 0 && value.trace_id === undefined) {
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "evidence or trace execution identity is required",
      });
    }
  });
export type DiagnosticEvent = z.infer<typeof DiagnosticEventSchema>;

/** DiagnosticEvent 固定 HTTP body 上限 / Fixed DiagnosticEvent HTTP body limit. */
export const DIAGNOSTIC_EVENT_MAX_BODY_BYTES = 64 * 1024;

/** 202 接受回执；重复 event 也返回相同成功语义 / 202 acknowledgement; duplicate events retain success semantics. */
export const DiagnosticAcceptedSchema = z.strictObject({
  event_id: UuidV7Schema,
  accepted: z.literal(true),
});
export type DiagnosticAccepted = z.infer<typeof DiagnosticAcceptedSchema>;

/** 已认证机器主体 / Authenticated machine principal bound to service and environment claims. */
export const MachinePrincipalSchema = z.strictObject({
  subject: z.string().min(1).max(255),
  service_name: ServiceNameSchema,
  environment: EnvironmentSchema,
  deployment_id: UuidV7Schema,
  scopes: z
    .array(
      z
        .string()
        .min(1)
        .max(128)
        .regex(/^[a-z][a-z0-9:_-]*$/),
    )
    .min(1)
    .max(32),
  token_id: z.string().min(1).max(255),
  auth_method: z.enum(["jwt", "oauth2", "service_binding", "mtls"]),
});
export type MachinePrincipal = z.infer<typeof MachinePrincipalSchema>;

/** Queue 中的可信追加入站元数据 / Trusted ingress metadata attached before Queue publication. */
export const DiagnosticQueueEnvelopeSchema = z
  .strictObject({
    schema_version: z.literal("1.0"),
    message_id: UuidV7Schema,
    event: DiagnosticEventSchema,
    received_at: UtcDateTimeSchema,
    origin: z
      .discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("external") }),
        z.strictObject({
          kind: z.literal("monitor"),
          monitor_id: UuidV7Schema,
        }),
      ])
      .optional(),
    producer: MachinePrincipalSchema,
    trace_context: z.strictObject({
      correlation_id: UuidV7Schema,
      traceparent: z
        .string()
        .regex(/^00-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$/)
        .optional(),
      tracestate: z.string().min(1).max(512).optional(),
    }),
  })
  .superRefine((value, context) => {
    if (value.producer.service_name !== value.event.service_name) {
      context.addIssue({
        code: "custom",
        path: ["producer", "service_name"],
        message: "producer and event service_name must match",
      });
    }
    if (value.producer.environment !== value.event.environment) {
      context.addIssue({
        code: "custom",
        path: ["producer", "environment"],
        message: "producer and event environment must match",
      });
    }
    if (value.producer.deployment_id !== value.event.deployment_id) {
      context.addIssue({
        code: "custom",
        path: ["producer", "deployment_id"],
        message: "producer and event deployment_id must match",
      });
    }
    if (value.trace_context.correlation_id !== value.event.correlation_id) {
      context.addIssue({
        code: "custom",
        path: ["trace_context", "correlation_id"],
        message: "correlation_id must match event",
      });
    }
  });
export type DiagnosticQueueEnvelope = z.infer<
  typeof DiagnosticQueueEnvelopeSchema
>;

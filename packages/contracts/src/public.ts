import { z } from "zod";
import {
  CursorSchema,
  HttpsUrlSchema,
  IncidentImpactSchema,
  IncidentStateSchema,
  RevisionSchema,
  ServiceNameSchema,
  StatusSchema,
  UtcDateTimeSchema,
  UuidV7Schema,
  dataEnvelope,
  listEnvelope,
} from "./primitives.js";

/** 公共服务列表查询 / Public service-list query. */
export const ListServicesQuerySchema = z.strictObject({
  cursor: CursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListServicesQuery = z.infer<typeof ListServicesQuerySchema>;

/** 公共 Incident 列表查询 / Public incident-list query. */
export const ListIncidentsQuerySchema = z.strictObject({
  states: z.array(IncidentStateSchema).max(4).optional(),
  cursor: CursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListIncidentsQuery = z.infer<typeof ListIncidentsQuerySchema>;

/** 公共维护窗口列表查询 / Public maintenance-window query. */
export const ListMaintenanceWindowsQuerySchema = z.strictObject({
  from: UtcDateTimeSchema.optional(),
  to: UtcDateTimeSchema.optional(),
  cursor: CursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListMaintenanceWindowsQuery = z.infer<
  typeof ListMaintenanceWindowsQuerySchema
>;

/** 服务 path 参数 / Service path parameters. */
export const ServicePathParamsSchema = z.strictObject({
  service_name: ServiceNameSchema,
});
/** Incident path 参数 / Incident path parameters. */
export const IncidentPathParamsSchema = z.strictObject({
  incident_id: UuidV7Schema,
});

/** 公开组件状态 / Public component status. */
export const PublicComponentStatusSchema = z.strictObject({
  id: z.string().min(1).max(128),
  display_name: z.string().min(1).max(128).optional(),
  status: StatusSchema,
});
export type PublicComponentStatus = z.infer<typeof PublicComponentStatusSchema>;

/** 平台聚合状态快照 / Aggregate platform status snapshot with an explicit freshness contract. */
export const PlatformStatusSchema = z.strictObject({
  status: StatusSchema,
  evaluated_at: UtcDateTimeSchema,
  fresh_until: UtcDateTimeSchema,
  active_incident_count: z.number().int().nonnegative(),
  components: z.array(PublicComponentStatusSchema),
});
export type PlatformStatus = z.infer<typeof PlatformStatusSchema>;
export const PlatformStatusResponseSchema = dataEnvelope(PlatformStatusSchema);
export type PlatformStatusResponse = z.infer<
  typeof PlatformStatusResponseSchema
>;

/** 公开服务列表行 / Public service-list row. */
export const PublicServiceSummarySchema = z.strictObject({
  service_name: ServiceNameSchema,
  display_name: z.string().min(1).max(128),
  description: z.string().max(1024).nullable(),
  status: StatusSchema,
  evaluated_at: UtcDateTimeSchema,
  fresh_until: UtcDateTimeSchema,
  components: z.array(PublicComponentStatusSchema),
});
export type PublicServiceSummary = z.infer<typeof PublicServiceSummarySchema>;
export const PublicServiceListResponseSchema = listEnvelope(
  PublicServiceSummarySchema,
);
export type PublicServiceListResponse = z.infer<
  typeof PublicServiceListResponseSchema
>;

/** 依赖风险摘要；不会覆盖 direct_status / Dependency-risk summary that never overwrites direct_status. */
export const DependencyRiskSchema = z.strictObject({
  status: z.enum([
    "none",
    "degraded",
    "partial_outage",
    "major_outage",
    "unknown",
  ]),
  affected_capabilities: z.array(z.string().min(1).max(128)).max(128),
  dependency_count: z.number().int().nonnegative(),
});
export type DependencyRisk = z.infer<typeof DependencyRiskSchema>;

/** 单服务公开状态 / Detailed public service status. */
export const PublicServiceStatusSchema = z.strictObject({
  service_name: ServiceNameSchema,
  display_name: z.string().min(1).max(128),
  description: z.string().max(1024).nullable(),
  direct_status: StatusSchema,
  dependency_risk: DependencyRiskSchema,
  effective_impact: StatusSchema,
  evaluated_at: UtcDateTimeSchema,
  fresh_until: UtcDateTimeSchema,
  components: z.array(PublicComponentStatusSchema),
  active_incident_ids: z.array(UuidV7Schema),
});
export type PublicServiceStatus = z.infer<typeof PublicServiceStatusSchema>;
export const PublicServiceStatusResponseSchema = dataEnvelope(
  PublicServiceStatusSchema,
);
export type PublicServiceStatusResponse = z.infer<
  typeof PublicServiceStatusResponseSchema
>;

/** 脱敏后的公开证据摘要；刻意不包含 backend locator / Redacted public evidence summary; backend locators are intentionally absent. */
export const PublicEvidenceSummarySchema = z.strictObject({
  kind: z.enum([
    "trace",
    "log_query",
    "profile",
    "metric_query",
    "source",
    "artifact",
  ]),
  count: z.number().int().positive(),
  first_observed_at: UtcDateTimeSchema,
  last_observed_at: UtcDateTimeSchema,
});
export type PublicEvidenceSummary = z.infer<typeof PublicEvidenceSummarySchema>;

/** 不可变 Incident 时间线更新 / Immutable, public incident timeline update. */
export const PublicIncidentUpdateSchema = z.strictObject({
  sequence: z.number().int().positive(),
  state: IncidentStateSchema,
  impact: IncidentImpactSchema,
  message: z.string().min(1).max(4096),
  published_at: UtcDateTimeSchema,
});
export type PublicIncidentUpdate = z.infer<typeof PublicIncidentUpdateSchema>;

/** Incident 列表摘要 / Public incident-list summary. */
export const PublicIncidentSummarySchema = z.strictObject({
  incident_id: UuidV7Schema,
  title: z.string().min(1).max(256),
  state: IncidentStateSchema,
  impact: IncidentImpactSchema,
  started_at: UtcDateTimeSchema,
  detected_at: UtcDateTimeSchema,
  resolved_at: UtcDateTimeSchema.nullable(),
  affected_components: z.array(z.string().min(1).max(128)).max(256),
  latest_update: PublicIncidentUpdateSchema,
});
export type PublicIncidentSummary = z.infer<typeof PublicIncidentSummarySchema>;
export const PublicIncidentListResponseSchema = listEnvelope(
  PublicIncidentSummarySchema,
);
export type PublicIncidentListResponse = z.infer<
  typeof PublicIncidentListResponseSchema
>;

/** Incident 公开详情 / Public incident detail and redacted evidence timeline. */
export const PublicIncidentSchema = PublicIncidentSummarySchema.extend({
  cause: z.string().max(4096).nullable(),
  updates: z.array(PublicIncidentUpdateSchema),
  evidence: z.array(PublicEvidenceSummarySchema),
});
export type PublicIncident = z.infer<typeof PublicIncidentSchema>;
export const PublicIncidentResponseSchema = dataEnvelope(PublicIncidentSchema);
export type PublicIncidentResponse = z.infer<
  typeof PublicIncidentResponseSchema
>;

/** 公开维护窗口；不包含操作者身份 / Public maintenance window without operator identity. */
export const PublicMaintenanceWindowSchema = z.strictObject({
  maintenance_id: UuidV7Schema,
  title: z.string().min(1).max(256),
  description: z.string().min(1).max(4096),
  starts_at: UtcDateTimeSchema,
  ends_at: UtcDateTimeSchema,
  expected_impact: IncidentImpactSchema,
  target_services: z.array(ServiceNameSchema).max(256),
  target_components: z.array(z.string().min(1).max(128)).max(256),
  state: z.enum(["scheduled", "active", "completed", "cancelled"]),
});
export type PublicMaintenanceWindow = z.infer<
  typeof PublicMaintenanceWindowSchema
>;
export const PublicMaintenanceWindowListResponseSchema = listEnvelope(
  PublicMaintenanceWindowSchema,
);
export type PublicMaintenanceWindowListResponse = z.infer<
  typeof PublicMaintenanceWindowListResponseSchema
>;

/** RFC 9457 Problem Details，含平台 Correlation ID / RFC 9457 Problem Details with platform correlation identity. */
export const ProblemDetailsSchema = z.strictObject({
  type: z.url().max(2048),
  title: z.string().min(1).max(256),
  status: z.number().int().min(400).max(599),
  detail: z.string().max(4096).optional(),
  instance: z.string().min(1).max(2048).optional(),
  correlation_id: UuidV7Schema,
  errors: z
    .array(
      z.strictObject({
        pointer: z.string().min(1).max(1024),
        detail: z.string().min(1).max(1024),
      }),
    )
    .max(128)
    .optional(),
});
export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;

/** 可变资源引用 / Mutable-resource metadata for optimistic concurrency. */
export const RevisionMetadataSchema = z.strictObject({
  revision: RevisionSchema,
});

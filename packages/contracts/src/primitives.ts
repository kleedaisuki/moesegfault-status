import { z } from "zod";

/** RFC 9562 UUIDv7（小写规范形式）/ RFC 9562 UUIDv7 in lowercase canonical form. */
export const UuidV7Schema = z
  .uuidv7()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  )
  .meta({ format: "uuid" })
  .describe("RFC 9562 UUIDv7 in lowercase canonical form");
export type UuidV7 = z.infer<typeof UuidV7Schema>;

/** UTC RFC 3339 时间；仅接受 `Z`，拒绝时区偏移 / UTC RFC 3339 timestamp; offsets are rejected. */
export const UtcDateTimeSchema = z.iso
  .datetime({ offset: false })
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/)
  .meta({ format: "date-time" })
  .describe("RFC 3339 UTC date-time ending in Z");
export type UtcDateTime = z.infer<typeof UtcDateTimeSchema>;

/** 平台服务稳定名 / Stable platform service name matching OTel `service.name`. */
export const ServiceNameSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .describe("Lowercase kebab-case service name");
export type ServiceName = z.infer<typeof ServiceNameSchema>;

/** 不透明游标 / Opaque, query-bound pagination cursor. */
export const CursorSchema = z.string().min(16).max(2048);

/** 可重试 POST 的稳定幂等键 / Stable idempotency key for retryable POST requests. */
export const IdempotencyKeySchema = z
  .string()
  .min(8)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

/** W3C Trace Context 的 Trace ID / W3C Trace Context trace identifier. */
export const TraceIdSchema = z.string().regex(/^(?!0{32}$)[0-9a-f]{32}$/);

/** W3C Trace Context 的 Span ID / W3C Trace Context span identifier. */
export const SpanIdSchema = z.string().regex(/^(?!0{16}$)[0-9a-f]{16}$/);

/** 完整 Git 对象 ID（SHA-1 或 SHA-256）/ Full Git object ID (SHA-1 or SHA-256). */
export const GitCommitSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

/** 内容寻址 SHA-256 摘要 / Content-addressed SHA-256 digest. */
export const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/** 部署环境 / Deployment environment. */
export const EnvironmentSchema = z.enum([
  "development",
  "test",
  "staging",
  "production",
]);
export type Environment = z.infer<typeof EnvironmentSchema>;

/** 领域状态 / Evaluated domain status. */
export const StatusSchema = z.enum([
  "operational",
  "degraded",
  "partial_outage",
  "major_outage",
  "maintenance",
  "unknown",
]);
export type Status = z.infer<typeof StatusSchema>;

/** Incident 对外影响 / Public incident impact. */
export const IncidentImpactSchema = z.enum([
  "degraded",
  "partial_outage",
  "major_outage",
]);
export type IncidentImpact = z.infer<typeof IncidentImpactSchema>;

/** Incident 生命周期状态 / Incident lifecycle state. */
export const IncidentStateSchema = z.enum([
  "investigating",
  "identified",
  "monitoring",
  "resolved",
]);
export type IncidentState = z.infer<typeof IncidentStateSchema>;

/** Diagnostic 严重度 / Diagnostic severity, independent from log severity and incident impact. */
export const DiagnosticSeveritySchema = z.enum([
  "info",
  "warning",
  "error",
  "critical",
]);
export type DiagnosticSeverity = z.infer<typeof DiagnosticSeveritySchema>;

/** 资源 revision / Optimistic-concurrency revision. */
export const RevisionSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

/** 安全的绝对 HTTPS URI / Safe absolute HTTPS URI. */
export const HttpsUrlSchema = z.url({ protocol: /^https$/ }).max(2048);

/** 页信息 / Cursor page metadata. */
export const PageSchema = z.strictObject({
  next_cursor: CursorSchema.nullable(),
});

/** 标准链接容器 / Standard links object. */
export const LinksSchema = z.strictObject({ self: HttpsUrlSchema });

/** 构造严格的数据响应 / Build a strict data envelope. */
export function dataEnvelope<const T extends z.ZodType>(data: T) {
  return z.strictObject({ data, links: LinksSchema });
}

/** 构造严格的游标分页响应 / Build a strict cursor-paginated envelope. */
export function listEnvelope<const T extends z.ZodType>(item: T) {
  return z.strictObject({
    data: z.array(item),
    page: PageSchema,
    links: LinksSchema,
  });
}

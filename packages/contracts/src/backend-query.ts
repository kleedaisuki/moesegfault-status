import { z } from "zod";

import {
  AdminPrincipalSchema,
  RpcTraceContextSchema,
  TelemetryBackendQueryAdapterSchema,
  rpcResult,
} from "./admin.js";
import { TelemetryReferenceSchema } from "./diagnostics.js";
import {
  HttpsUrlSchema,
  UtcDateTimeSchema,
  UuidV7Schema,
} from "./primitives.js";

/** 后端能力的封闭集合 / Closed set of telemetry backend capabilities. */
export const TelemetryCapabilitySchema = z.enum([
  "trace",
  "log_query",
  "profile",
  "metric_query",
  "source",
  "artifact",
]);
export type TelemetryCapability = z.infer<typeof TelemetryCapabilitySchema>;

/** 受审计查询适配器的封闭集合，注册表不能注入代码 / Closed set of reviewed query adapters; registry rows cannot inject code. */
export const TelemetryQueryAdapterSchema = TelemetryBackendQueryAdapterSchema;
export type TelemetryQueryAdapter = z.infer<typeof TelemetryQueryAdapterSchema>;

/** 证据查询的可观察终态 / Observable terminal state of an evidence query. */
export const EvidenceQueryStatusSchema = z.enum([
  "ok",
  "expired",
  "unsupported",
  "unavailable",
  "not_found",
]);
export type EvidenceQueryStatus = z.infer<typeof EvidenceQueryStatusSchema>;

/** 规范化证据属性值；禁止透传任意供应商 JSON / Normalized evidence value; arbitrary vendor JSON is never passed through. */
export const EvidenceAttributeValueSchema = z.union([
  z.string().max(512),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

/** 单条有界证据记录 / One bounded, vendor-neutral evidence record. */
export const EvidenceRecordSchema = z.strictObject({
  timestamp: UtcDateTimeSchema.optional(),
  title: z.string().min(1).max(512),
  attributes: z
    .record(z.string().min(1).max(64), EvidenceAttributeValueSchema)
    .refine(
      (attributes) => Object.keys(attributes).length <= 32,
      "evidence record may contain at most 32 attributes",
    ),
});
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;

/** 已知 TelemetryReference 的只读查询请求 / Read-only query for a known TelemetryReference. */
export const QueryTelemetryReferenceRpcRequestSchema = z.strictObject({
  principal: AdminPrincipalSchema,
  correlation_id: UuidV7Schema,
  trace_context: RpcTraceContextSchema.optional(),
  telemetry_reference_id: UuidV7Schema,
});
export type QueryTelemetryReferenceRpcRequest = z.infer<
  typeof QueryTelemetryReferenceRpcRequestSchema
>;

/** 有界且已规范化的证据结果 / Bounded and normalized evidence result. */
export const EvidenceQueryResultSchema = z.strictObject({
  telemetry_reference: TelemetryReferenceSchema,
  status: EvidenceQueryStatusSchema,
  ui_url: HttpsUrlSchema.nullable(),
  records: z.array(EvidenceRecordSchema).max(100),
  truncated: z.boolean(),
  queried_at: UtcDateTimeSchema,
  detail: z.string().min(1).max(512).optional(),
});
export type EvidenceQueryResult = z.infer<typeof EvidenceQueryResultSchema>;

/** 查询 RPC 成功/Problem 联合 / Query RPC success/problem union. */
export const QueryTelemetryReferenceRpcResultSchema = rpcResult(
  EvidenceQueryResultSchema,
);
export type QueryTelemetryReferenceRpcResult = z.infer<
  typeof QueryTelemetryReferenceRpcResultSchema
>;

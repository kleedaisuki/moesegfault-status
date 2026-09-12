import { z } from "zod";
import { UuidV7Schema } from "./primitives.js";

/** 私有区域执行器协议，禁止任意代码与额外字段。 / Private regional executor protocol; no arbitrary code or additional fields. */
export const RegionalProbeSpecSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("http"),
    url: z.url().max(2048),
    method: z.enum(["GET", "HEAD"]).default("HEAD"),
    expectedStatuses: z
      .array(z.number().int().min(100).max(599))
      .max(32)
      .default([]),
    maxRedirects: z.number().int().min(0).max(3).default(0),
  }),
  z.strictObject({
    kind: z.literal("tcp"),
    hostname: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65535),
  }),
  z.strictObject({
    kind: z.literal("dns"),
    hostname: z.string().min(1).max(253),
    recordType: z.enum(["A", "AAAA"]),
  }),
  z.strictObject({
    kind: z.literal("rpc"),
    binding: z.string().min(1).max(64),
    operation: z.string().min(1).max(64),
  }),
  z.strictObject({
    kind: z.literal("synthetic"),
    binding: z.string().min(1).max(64),
    scenario: z.string().min(1).max(64),
  }),
]);
const Identity = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
/** 调用身份与绝对截止时间必须回显绑定。 / Caller identity and absolute deadline are bound to the echoed result. */
export const RegionalProbeRequestSchema = z.strictObject({
  version: z.literal("1"),
  executor_id: Identity,
  location: Identity,
  run_id: UuidV7Schema,
  monitor_id: UuidV7Schema,
  correlation_id: UuidV7Schema,
  deadline_at: z.iso.datetime(),
  scheduled_for: z.iso.datetime(),
  traceparent: z
    .string()
    .regex(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/)
    .refine(
      (value) =>
        !value.split("-")[1]!.match(/^0+$/) &&
        !value.split("-")[2]!.match(/^0+$/),
    ),
  timeout_ms: z.number().int().min(1).max(300000),
  probe: RegionalProbeSpecSchema,
});
/** 仅有平台来源信息的完成样本可进入评估。 / Only completed samples with platform provenance can enter evaluation. */
export const RegionalProbeResponseSchema = z.strictObject({
  version: z.literal("1"),
  executor_id: Identity,
  location: Identity,
  run_id: UuidV7Schema,
  scheduled_for: z.iso.datetime(),
  actual_colo: z.string().regex(/^[A-Z]{3}$/),
  observation: z.strictObject({
    observationId: UuidV7Schema,
    monitorId: UuidV7Schema,
    observedAt: z.iso.datetime(),
    outcome: z.enum(["success", "failure", "timeout", "invalid"]),
    latencyMs: z.number().finite().min(0).max(300000),
    protocolStatus: z.string().max(128).nullable(),
    errorType: z.string().max(128).nullable(),
    correlationId: UuidV7Schema,
  }),
});
/** 运维注册表只引用已声明的能力绑定。 / Operator registry references only declared capability bindings. */
export const RegionalProbeRegistrySchema = z.record(
  Identity,
  z.strictObject({
    binding: z.string().regex(/^PROBE_EXECUTOR_[A-Z0-9_]+$/),
    executor_id: Identity,
    allowed_colos: z
      .array(z.string().regex(/^[A-Z]{3}$/))
      .min(1)
      .max(64),
    allowed_kinds: z
      .array(z.enum(["http", "tcp", "dns", "rpc", "synthetic"]))
      .min(1)
      .max(5),
  }),
);
export type RegionalProbeRequest = z.infer<typeof RegionalProbeRequestSchema>;

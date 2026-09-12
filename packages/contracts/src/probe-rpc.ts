import { z } from "zod";
import { UuidV7Schema } from "./primitives.js";

/** 有限操作标识符，绝不是代码或 URL。 / Finite operation identifier, never code or a URL. */
const Identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/);
/** 专用测试主体必须与正常业务主体区分。 / Dedicated test principals must be distinguishable from business principals. */
const TestSubject = z
  .string()
  .regex(/^probe:[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/);
/** 只允许专门声明的探针绑定，不能借别名读取其他 Env 字段。 / Only dedicated probe bindings, never arbitrary Env fields. */
const ServiceBinding = z.string().regex(/^PROBE_SERVICE_[A-Z][A-Z0-9_]{0,95}$/);
/** 纯数据 RPC 元数据；接收方必须实施 deadline 和无副作用约束。 / Data-only RPC metadata; receivers must enforce deadlines and side-effect constraints. */
const Metadata = z.object({
  schema_version: z.literal("1.0"),
  correlation_id: UuidV7Schema,
  traceparent: z
    .string()
    .regex(/^00-(?!0{32}-)[0-9a-f]{32}-(?!0{16}-)[0-9a-f]{16}-0[01]$/),
  user_agent: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[\x20-\x7e]+$/),
  deadline_at: z.iso.datetime({ precision: 3 }),
});

/** 固定 probe(request) 的共享协议；禁止动态方法名。 / Shared fixed probe(request) protocol; dynamic methods are forbidden. */
export const RpcProbeRequestSchema = Metadata.extend({
  operation: Identifier,
}).strict();
/** 固定 run(request) 的共享协议；每次请求仅作用于专用测试主体。 / Shared fixed run(request) protocol restricted to a dedicated test principal. */
export const SyntheticProbeRequestSchema = Metadata.extend({
  scenario: Identifier,
  test_subject: TestSubject,
}).strict();
/** 健康响应只能含有限状态代码，不能携带业务内容或异常原文。 / Health responses contain bounded status codes, never business data or raw exceptions. */
export const RpcProbeResponseSchema = z
  .object({
    schema_version: z.literal("1.0"),
    ok: z.boolean(),
    status: Identifier.optional(),
  })
  .strict();
/** 清理失败即探针失败；主体回显防止把别人的清理误认为自己的。 / Cleanup failure is probe failure; principal echo prevents misattributed cleanup. */
export const SyntheticProbeResponseSchema = RpcProbeResponseSchema.extend({
  cleanup_completed: z.boolean(),
  test_subject: TestSubject,
}).strict();

/** 运维配置决定有限调用能力，Monitor 只能选择其别名。 / Operations configuration determines finite capabilities; monitors only select aliases. */
export const ProbeBindingConfigSchema = z
  .record(
    Identifier,
    z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("rpc"),
          service_binding: ServiceBinding,
          operations: z.array(Identifier).min(1).max(64),
          timeout_ms: z.number().int().min(1).max(30_000),
        })
        .strict(),
      z
        .object({
          kind: z.literal("synthetic"),
          service_binding: ServiceBinding,
          scenarios: z.array(Identifier).min(1).max(64),
          test_subject: TestSubject,
          timeout_ms: z.number().int().min(1).max(30_000),
        })
        .strict(),
    ]),
  )
  .refine(
    (value) => Object.keys(value).length <= 64,
    "At most 64 probe bindings",
  );

/** 接收方实现此入参。 / Receiver implements this input. */
export type RpcProbeRequest = z.infer<typeof RpcProbeRequestSchema>;
/** 接收方实现此入参，并以 correlation_id 隔离测试数据。 / Receiver implements this input and isolates test data by correlation_id. */
export type SyntheticProbeRequest = z.infer<typeof SyntheticProbeRequestSchema>;
/** 接收方返回此结果。 / Receiver returns this result. */
export type RpcProbeResponse = z.infer<typeof RpcProbeResponseSchema>;
/** 清理必须在返回前完成，不使用 waitUntil 伪造清理成功。 / Cleanup must finish before return, never claim cleanup scheduled with waitUntil succeeded. */
export type SyntheticProbeResponse = z.infer<
  typeof SyntheticProbeResponseSchema
>;

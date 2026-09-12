import { z } from "zod";

import {
  AdminPrincipalSchema,
  RpcTraceContextSchema,
  rpcResult,
} from "./admin.js";
import {
  EnvironmentSchema,
  RevisionSchema,
  ServiceNameSchema,
  UtcDateTimeSchema,
  UuidV7Schema,
} from "./primitives.js";

/** 不可变数据保留策略标识 / Immutable data-retention policy identifier. */
export const RetentionPolicyIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/);

/** 不可变 occurrence 保留策略 revision / Immutable occurrence-retention policy revision. */
export const RetentionPolicyRevisionSchema = z.strictObject({
  policy_id: RetentionPolicyIdSchema,
  revision: RevisionSchema,
  occurrence_retention_days: z.number().int().min(1).max(3_650),
  cleanup_batch_size: z.number().int().min(1).max(10_000),
});
export type RetentionPolicyRevision = z.infer<
  typeof RetentionPolicyRevisionSchema
>;

/**
 * 原子登记保留策略 revision 并绑定服务的命令。
 * Command that atomically registers a retention-policy revision and assigns it to a service.
 *
 * `expected_assignment_revision` 为 `null` 表示调用方确认当前尚无绑定；否则必须精确匹配。
 * A `null` `expected_assignment_revision` asserts that no assignment exists; otherwise it must match exactly.
 */
export const RegisterAndAssignRetentionPolicyCommandSchema = z.strictObject({
  command_id: UuidV7Schema,
  service_name: ServiceNameSchema,
  policy: RetentionPolicyRevisionSchema,
  expected_assignment_revision: RevisionSchema.nullable(),
});
export type RegisterAndAssignRetentionPolicyCommand = z.infer<
  typeof RegisterAndAssignRetentionPolicyCommandSchema
>;

/** 服务保留策略的当前可审计快照 / Current auditable service-retention assignment snapshot. */
export const ServiceRetentionPolicyAssignmentSchema = z.strictObject({
  service_name: ServiceNameSchema,
  policy: RetentionPolicyRevisionSchema,
  assignment_revision: RevisionSchema,
  assigned_at: UtcDateTimeSchema,
  assigned_by: z.string().min(1).max(255),
  policy_registered_at: UtcDateTimeSchema,
  policy_registered_by: z.string().min(1).max(255),
});
export type ServiceRetentionPolicyAssignment = z.infer<
  typeof ServiceRetentionPolicyAssignmentSchema
>;

/**
 * 已实际部署后显式激活 ready deployment 的命令。
 * Command that explicitly activates a ready deployment after the real deploy step.
 *
 * 两个 expected revision 分别保护部署状态历史和 service/environment 指针。
 * The two expected revisions protect deployment history and the service/environment pointer independently.
 */
export const ActivateDeploymentCommandSchema = z.strictObject({
  command_id: UuidV7Schema,
  expected_deployment_revision: RevisionSchema,
  expected_pointer_revision: RevisionSchema.nullable(),
  reason: z.string().trim().min(1).max(1_024),
});
export type ActivateDeploymentCommand = z.infer<
  typeof ActivateDeploymentCommandSchema
>;

/** 激活后的权威 deployment 指针 / Authoritative deployment pointer after activation. */
export const ActiveDeploymentSchema = z.strictObject({
  deployment_id: UuidV7Schema,
  service_name: ServiceNameSchema,
  environment: EnvironmentSchema,
  deployment_state: z.literal("active"),
  deployment_revision: RevisionSchema,
  pointer_revision: RevisionSchema,
  activated_at: UtcDateTimeSchema,
  activated_by: z.string().min(1).max(255),
});
export type ActiveDeployment = z.infer<typeof ActiveDeploymentSchema>;

const BootstrapRpcContextShape = {
  principal: AdminPrincipalSchema,
  correlation_id: UuidV7Schema,
  trace_context: RpcTraceContextSchema.optional(),
};

/** 保留策略 bootstrap RPC 请求/结果 / Retention bootstrap RPC request/result. */
export const RegisterAndAssignRetentionPolicyRpcRequestSchema = z.strictObject({
  ...BootstrapRpcContextShape,
  command: RegisterAndAssignRetentionPolicyCommandSchema,
});
export type RegisterAndAssignRetentionPolicyRpcRequest = z.infer<
  typeof RegisterAndAssignRetentionPolicyRpcRequestSchema
>;
export const RegisterAndAssignRetentionPolicyRpcResultSchema = rpcResult(
  ServiceRetentionPolicyAssignmentSchema,
);
export type RegisterAndAssignRetentionPolicyRpcResult = z.infer<
  typeof RegisterAndAssignRetentionPolicyRpcResultSchema
>;

/** Deployment 激活 RPC 请求/结果 / Deployment activation RPC request/result. */
export const ActivateDeploymentRpcRequestSchema = z.strictObject({
  ...BootstrapRpcContextShape,
  deployment_id: UuidV7Schema,
  command: ActivateDeploymentCommandSchema,
});
export type ActivateDeploymentRpcRequest = z.infer<
  typeof ActivateDeploymentRpcRequestSchema
>;
export const ActivateDeploymentRpcResultSchema = rpcResult(
  ActiveDeploymentSchema,
);
export type ActivateDeploymentRpcResult = z.infer<
  typeof ActivateDeploymentRpcResultSchema
>;

import { z } from "zod";

import {
  AdminPrincipalSchema,
  RpcTraceContextSchema,
  rpcResult,
} from "./admin.js";
import { ServiceRetentionPolicyAssignmentSchema } from "./bootstrap.js";
import { ComponentCatalogSchema, ServiceCatalogSchema } from "./catalog.js";
import {
  EnvironmentSchema,
  RevisionSchema,
  ServiceNameSchema,
  UuidV7Schema,
} from "./primitives.js";

const ReadRpcContextShape = {
  principal: AdminPrincipalSchema,
  correlation_id: UuidV7Schema,
  trace_context: RpcTraceContextSchema.optional(),
};

/** Deployment 当前状态与同 service/environment 权威指针 / Current deployment state and authoritative pointer for the same service/environment. */
export const DeploymentActivationContextSchema = z.strictObject({
  deployment_id: UuidV7Schema,
  service_name: ServiceNameSchema,
  environment: EnvironmentSchema,
  state: z.enum([
    "registered",
    "artifacts_pending",
    "ready",
    "active",
    "retired",
    "failed",
  ]),
  deployment_revision: RevisionSchema,
  current_pointer: z
    .strictObject({
      deployment_id: UuidV7Schema,
      revision: RevisionSchema,
    })
    .nullable(),
});
export type DeploymentActivationContext = z.infer<
  typeof DeploymentActivationContextSchema
>;

/** 读取服务目录快照的私有 RPC / Private RPC reading a service-catalog snapshot. */
export const GetServiceCatalogRpcRequestSchema = z.strictObject({
  ...ReadRpcContextShape,
  service_name: ServiceNameSchema,
});
export type GetServiceCatalogRpcRequest = z.infer<
  typeof GetServiceCatalogRpcRequestSchema
>;
export const GetServiceCatalogRpcResultSchema = rpcResult(ServiceCatalogSchema);
export type GetServiceCatalogRpcResult = z.infer<
  typeof GetServiceCatalogRpcResultSchema
>;

/** 读取 Component 目录快照的私有 RPC / Private RPC reading a component-catalog snapshot. */
export const GetComponentCatalogRpcRequestSchema = z.strictObject({
  ...ReadRpcContextShape,
  component_id: ComponentCatalogSchema.shape.component_id,
});
export type GetComponentCatalogRpcRequest = z.infer<
  typeof GetComponentCatalogRpcRequestSchema
>;
export const GetComponentCatalogRpcResultSchema = rpcResult(
  ComponentCatalogSchema,
);
export type GetComponentCatalogRpcResult = z.infer<
  typeof GetComponentCatalogRpcResultSchema
>;

/** 读取服务保留策略绑定的私有 RPC / Private RPC reading a service retention-policy assignment. */
export const GetServiceRetentionPolicyAssignmentRpcRequestSchema =
  z.strictObject({
    ...ReadRpcContextShape,
    service_name: ServiceNameSchema,
  });
export type GetServiceRetentionPolicyAssignmentRpcRequest = z.infer<
  typeof GetServiceRetentionPolicyAssignmentRpcRequestSchema
>;
export const GetServiceRetentionPolicyAssignmentRpcResultSchema = rpcResult(
  ServiceRetentionPolicyAssignmentSchema,
);
export type GetServiceRetentionPolicyAssignmentRpcResult = z.infer<
  typeof GetServiceRetentionPolicyAssignmentRpcResultSchema
>;

/** 读取 Deployment 激活上下文的私有 RPC / Private RPC reading deployment activation context. */
export const GetDeploymentActivationContextRpcRequestSchema = z.strictObject({
  ...ReadRpcContextShape,
  deployment_id: UuidV7Schema,
});
export type GetDeploymentActivationContextRpcRequest = z.infer<
  typeof GetDeploymentActivationContextRpcRequestSchema
>;
export const GetDeploymentActivationContextRpcResultSchema = rpcResult(
  DeploymentActivationContextSchema,
);
export type GetDeploymentActivationContextRpcResult = z.infer<
  typeof GetDeploymentActivationContextRpcResultSchema
>;

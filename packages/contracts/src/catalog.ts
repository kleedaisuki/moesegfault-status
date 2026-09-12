import { z } from "zod";

import {
  AdminPrincipalSchema,
  RpcTraceContextSchema,
  rpcResult,
} from "./admin.js";
import {
  RevisionSchema,
  ServiceNameSchema,
  UtcDateTimeSchema,
  UuidV7Schema,
} from "./primitives.js";

/** 服务或依赖的业务关键级别。 / Business criticality of a service or dependency. */
export const CatalogCriticalitySchema = z.enum([
  "low",
  "medium",
  "high",
  "critical",
]);

/** 有向依赖边；边的身份是 target_service 与 capability。 / Directed dependency edge identified by target_service and capability. */
export const CatalogDependencySchema = z.strictObject({
  target_service: ServiceNameSchema,
  capability: z.string().min(1).max(128),
  kind: z.enum(["required", "optional", "degraded_fallback"]),
  criticality: CatalogCriticalitySchema,
});
export type CatalogDependency = z.infer<typeof CatalogDependencySchema>;

const DependencySetSchema = z
  .array(CatalogDependencySchema)
  .max(256)
  .superRefine((dependencies, context) => {
    const keys = new Set<string>();
    dependencies.forEach((dependency, index) => {
      const key = `${dependency.target_service}\u0000${dependency.capability}`;
      if (keys.has(key)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "dependency target_service and capability must be unique",
        });
      }
      keys.add(key);
    });
  });

const SupportingServiceSetSchema = z
  .array(ServiceNameSchema)
  .max(256)
  .superRefine((services, context) => {
    const seen = new Set<string>();
    services.forEach((service, index) => {
      if (seen.has(service)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "supporting service names must be unique",
        });
      }
      seen.add(service);
    });
  });

/** 可变服务目录快照；service_name 是不可变外部目标 ID。 / Mutable service-catalog snapshot; service_name is an immutable external target ID. */
export const ServiceCatalogSchema = z.strictObject({
  service_name: ServiceNameSchema,
  display_name: z.string().min(1).max(128),
  description: z.string().max(1024),
  owner: z.string().min(1).max(128),
  criticality: CatalogCriticalitySchema,
  enabled: z.boolean(),
  dependencies: DependencySetSchema,
  created_at: UtcDateTimeSchema,
  updated_at: UtcDateTimeSchema,
  revision: RevisionSchema,
});
export type ServiceCatalog = z.infer<typeof ServiceCatalogSchema>;

/**
 * Component 目录快照。
 * Component catalog snapshot.
 *
 * component_id 在整个目录全局唯一且不可改名；owner_service 是唯一权威 owner，
 * supporting_services 只表达额外支撑关系。
 * component_id is globally unique and immutable; owner_service is the sole
 * authoritative owner and supporting_services contains only additional support.
 */
export const ComponentCatalogSchema = z.strictObject({
  component_id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  owner_service: ServiceNameSchema,
  display_name: z.string().min(1).max(128),
  description: z.string().max(1024),
  public: z.boolean(),
  sort_order: z.number().int().nonnegative().max(100_000),
  enabled: z.boolean(),
  supporting_services: SupportingServiceSetSchema,
  created_at: UtcDateTimeSchema,
  updated_at: UtcDateTimeSchema,
  revision: RevisionSchema,
});
export type ComponentCatalog = z.infer<typeof ComponentCatalogSchema>;

/** 修改服务元数据和/或完整依赖集合。 / Change service metadata and/or its complete authored dependency set. */
export const UpdateServiceCatalogCommandSchema = z
  .strictObject({
    command_id: UuidV7Schema,
    display_name: z.string().min(1).max(128).optional(),
    description: z.string().max(1024).optional(),
    owner: z.string().min(1).max(128).optional(),
    criticality: CatalogCriticalitySchema.optional(),
    enabled: z.boolean().optional(),
    dependencies: DependencySetSchema.optional(),
  })
  .refine(
    (command) => Object.keys(command).some((key) => key !== "command_id"),
    "at least one mutable field is required",
  );
export type UpdateServiceCatalogCommand = z.infer<
  typeof UpdateServiceCatalogCommandSchema
>;

/** 创建全局 ID 的 Component 及其完整服务关系。 / Create a globally identified Component and its complete service relationships. */
export const CreateComponentCommandSchema = z
  .strictObject({
    command_id: UuidV7Schema,
    component_id: ComponentCatalogSchema.shape.component_id,
    owner_service: ServiceNameSchema,
    display_name: z.string().min(1).max(128),
    description: z.string().max(1024),
    public: z.boolean(),
    sort_order: z.number().int().nonnegative().max(100_000),
    enabled: z.boolean(),
    supporting_services: SupportingServiceSetSchema,
  })
  .superRefine((command, context) => {
    if (command.supporting_services.includes(command.owner_service)) {
      context.addIssue({
        code: "custom",
        path: ["supporting_services"],
        message: "owner_service must not be repeated as a supporting service",
      });
    }
  });
export type CreateComponentCommand = z.infer<
  typeof CreateComponentCommandSchema
>;

/** 修改 Component 元数据和/或完整支撑服务集合。 / Change Component metadata and/or its complete supporting-service set. */
export const UpdateComponentCatalogCommandSchema = z
  .strictObject({
    command_id: UuidV7Schema,
    display_name: z.string().min(1).max(128).optional(),
    description: z.string().max(1024).optional(),
    public: z.boolean().optional(),
    sort_order: z.number().int().nonnegative().max(100_000).optional(),
    enabled: z.boolean().optional(),
    supporting_services: SupportingServiceSetSchema.optional(),
  })
  .refine(
    (command) => Object.keys(command).some((key) => key !== "command_id"),
    "at least one mutable field is required",
  );
export type UpdateComponentCatalogCommand = z.infer<
  typeof UpdateComponentCatalogCommandSchema
>;

const CatalogRpcContextShape = {
  principal: AdminPrincipalSchema,
  correlation_id: UuidV7Schema,
  trace_context: RpcTraceContextSchema.optional(),
};

/** `updateServiceCatalog` 私有 RPC 请求/结果。 / Private `updateServiceCatalog` RPC request/result. */
export const UpdateServiceCatalogRpcRequestSchema = z.strictObject({
  ...CatalogRpcContextShape,
  service_name: ServiceNameSchema,
  expected_revision: RevisionSchema,
  command: UpdateServiceCatalogCommandSchema,
});
export type UpdateServiceCatalogRpcRequest = z.infer<
  typeof UpdateServiceCatalogRpcRequestSchema
>;
export const UpdateServiceCatalogRpcResultSchema =
  rpcResult(ServiceCatalogSchema);
export type UpdateServiceCatalogRpcResult = z.infer<
  typeof UpdateServiceCatalogRpcResultSchema
>;

/** `createComponent` 私有 RPC 请求/结果。 / Private `createComponent` RPC request/result. */
export const CreateComponentRpcRequestSchema = z.strictObject({
  ...CatalogRpcContextShape,
  command: CreateComponentCommandSchema,
});
export type CreateComponentRpcRequest = z.infer<
  typeof CreateComponentRpcRequestSchema
>;
export const CreateComponentRpcResultSchema = rpcResult(ComponentCatalogSchema);
export type CreateComponentRpcResult = z.infer<
  typeof CreateComponentRpcResultSchema
>;

/** `updateComponentCatalog` 私有 RPC 请求/结果。 / Private `updateComponentCatalog` RPC request/result. */
export const UpdateComponentCatalogRpcRequestSchema = z.strictObject({
  ...CatalogRpcContextShape,
  component_id: ComponentCatalogSchema.shape.component_id,
  expected_revision: RevisionSchema,
  command: UpdateComponentCatalogCommandSchema,
});
export type UpdateComponentCatalogRpcRequest = z.infer<
  typeof UpdateComponentCatalogRpcRequestSchema
>;
export const UpdateComponentCatalogRpcResultSchema = rpcResult(
  ComponentCatalogSchema,
);
export type UpdateComponentCatalogRpcResult = z.infer<
  typeof UpdateComponentCatalogRpcResultSchema
>;

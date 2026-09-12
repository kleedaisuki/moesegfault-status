import {
  ActivateDeploymentCommandSchema,
  CreateComponentCommandSchema,
  RegisterAndAssignRetentionPolicyCommandSchema,
  UpdateComponentCatalogCommandSchema,
  UpdateServiceCatalogCommandSchema,
} from "@moesegfault/contracts";

/** 浏览器表单快照，不包含身份或凭据。 / Browser form snapshot, excluding identity and credentials. */
type Values = Record<string, FormDataEntryValue>;

/** 空 revision 明确表示首次绑定，绝不猜测已有版本。 / An empty revision explicitly asserts initial assignment, never guesses an existing version. */
function nullableRevision(
  value: FormDataEntryValue | undefined,
): number | null {
  return value === undefined || value === "" ? null : Number(value);
}

/** 将每行四列的依赖编辑器转换为完整集合，最终由共享契约校验。 / Convert four-column dependency rows into a full replacement set, validated by the shared contract. */
export function dependencyRows(
  value: FormDataEntryValue | undefined,
): unknown[] {
  return String(value ?? "")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const columns = line.split(",").map((part) => part.trim());
      if (columns.length !== 4)
        throw new Error("每条依赖必须为：服务, capability, kind, criticality");
      const [target_service, capability, kind, criticality] = columns;
      return { target_service, capability, kind, criticality };
    });
}

/** 支撑服务集合保留重复值供 schema 报错，不静默更改操作者意图。 / Preserve duplicate support names for schema rejection rather than silently changing intent. */
function supportingServices(value: FormDataEntryValue | undefined): string[] {
  return String(value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/** 保留策略注册与绑定的显式 OCC 命令。 / Explicit OCC command for retention registration and assignment. */
export function retentionCommand(raw: Values, command_id: string) {
  return RegisterAndAssignRetentionPolicyCommandSchema.parse({
    command_id,
    service_name: raw.service_name,
    expected_assignment_revision: nullableRevision(
      raw.expected_assignment_revision,
    ),
    policy: {
      policy_id: raw.policy_id,
      revision: Number(raw.policy_revision),
      occurrence_retention_days: Number(raw.occurrence_retention_days),
      cleanup_batch_size: Number(raw.cleanup_batch_size),
    },
  });
}

/** 激活仅用于已完成真实部署的 ready 产物，双 revision 不自动重试。 / Activate only an actually deployed ready artifact; never auto-retry the dual revisions. */
export function activationCommand(raw: Values, command_id: string) {
  return ActivateDeploymentCommandSchema.parse({
    command_id,
    expected_deployment_revision: Number(raw.expected_deployment_revision),
    expected_pointer_revision: nullableRevision(raw.expected_pointer_revision),
    reason: raw.reason,
  });
}

/** 服务元数据与完整依赖集合编辑。 / Edit service metadata and the complete dependency set. */
export function serviceUpdateCommand(raw: Values, command_id: string) {
  return UpdateServiceCatalogCommandSchema.parse({
    command_id,
    display_name: raw.display_name,
    description: raw.description,
    owner: raw.owner,
    criticality: raw.criticality,
    enabled: raw.enabled === "on",
    dependencies: dependencyRows(raw.dependencies),
  });
}

/** Component 元数据与完整支撑集合编辑；owner 与 ID 保持不可变。 / Edit Component metadata and full support set; owner and ID remain immutable. */
export function componentUpdateCommand(raw: Values, command_id: string) {
  return UpdateComponentCatalogCommandSchema.parse({
    command_id,
    display_name: raw.display_name,
    description: raw.description,
    public: raw.public === "on",
    enabled: raw.enabled === "on",
    sort_order: Number(raw.sort_order),
    supporting_services: supportingServices(raw.supporting_services),
  });
}

/** 创建具有单一 owner 的 Component。 / Create a Component with a single authoritative owner. */
export function componentCreateCommand(raw: Values, command_id: string) {
  return CreateComponentCommandSchema.parse({
    ...componentUpdateCommand(raw, command_id),
    component_id: raw.component_id,
    owner_service: raw.owner_service,
  });
}

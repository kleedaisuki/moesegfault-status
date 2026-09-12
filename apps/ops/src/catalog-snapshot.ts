import {
  ComponentCatalogSchema,
  DeploymentActivationContextSchema,
  ServiceCatalogSchema,
  ServiceRetentionPolicyAssignmentSchema,
} from "@moesegfault/contracts";

/** 可读取的权威目录快照种类。 / Readable authoritative catalog snapshot kinds. */
export type SnapshotKind = "service" | "component" | "retention" | "activation";

/** 将已验证快照映射到可编辑字段，绝不从公开投影猜测 revision。 / Map validated snapshots to editable fields, never guessing revisions from public projections. */
export function snapshotFields(
  kind: SnapshotKind,
  value: unknown,
): Record<string, string | boolean> {
  if (kind === "service") {
    const service = ServiceCatalogSchema.parse(value);
    return {
      id: service.service_name,
      display_name: service.display_name,
      description: service.description,
      owner: service.owner,
      criticality: service.criticality,
      enabled: service.enabled,
      revision: String(service.revision),
      dependencies: service.dependencies
        .map((edge) =>
          [
            edge.target_service,
            edge.capability,
            edge.kind,
            edge.criticality,
          ].join(", "),
        )
        .join("\n"),
    };
  }
  if (kind === "component") {
    const component = ComponentCatalogSchema.parse(value);
    return {
      id: component.component_id,
      display_name: component.display_name,
      description: component.description,
      public: component.public,
      enabled: component.enabled,
      sort_order: String(component.sort_order),
      supporting_services: component.supporting_services.join(", "),
      revision: String(component.revision),
    };
  }
  if (kind === "retention") {
    const assignment = ServiceRetentionPolicyAssignmentSchema.parse(value);
    return {
      service_name: assignment.service_name,
      policy_id: assignment.policy.policy_id,
      policy_revision: String(assignment.policy.revision),
      occurrence_retention_days: String(
        assignment.policy.occurrence_retention_days,
      ),
      cleanup_batch_size: String(assignment.policy.cleanup_batch_size),
      expected_assignment_revision: String(assignment.assignment_revision),
    };
  }
  const deployment = DeploymentActivationContextSchema.parse(value);
  return {
    id: deployment.deployment_id,
    expected_deployment_revision: String(deployment.deployment_revision),
    expected_pointer_revision: deployment.current_pointer
      ? String(deployment.current_pointer.revision)
      : "",
  };
}

/** 同步布尔与文本控件；不使用 HTML 拼接。 / Populate boolean and text controls without HTML interpolation. */
export function populateSnapshot(
  form: HTMLFormElement,
  fields: Record<string, string | boolean>,
): void {
  for (const [name, value] of Object.entries(fields)) {
    const input = form.elements.namedItem(name);
    if (input instanceof HTMLInputElement && typeof value === "boolean")
      input.checked = value;
    else if (
      (input instanceof HTMLInputElement ||
        input instanceof HTMLTextAreaElement ||
        input instanceof HTMLSelectElement) &&
      typeof value === "string"
    )
      input.value = value;
  }
}

import { z } from "zod";
import { TelemetryReferenceSchema } from "./diagnostics.js";
import { DeploymentManifestSchema } from "./deployments.js";
import {
  DiagnosticSeveritySchema,
  IncidentImpactSchema,
  IncidentStateSchema,
  RevisionSchema,
  ServiceNameSchema,
  StatusSchema,
  UtcDateTimeSchema,
  UuidV7Schema,
  HttpsUrlSchema,
} from "./primitives.js";
import { ProblemDetailsSchema, PublicIncidentUpdateSchema } from "./public.js";

/** Cloudflare Access 派生的管理员主体 / Administrator principal derived from Cloudflare Access. */
export const AdminPrincipalSchema = z.strictObject({
  subject: z.string().min(1).max(255),
  email: z.email().max(320),
  roles: z
    .array(z.enum(["viewer", "operator", "admin"]))
    .min(1)
    .max(3),
  authenticated_at: UtcDateTimeSchema,
  access_application: z.string().min(1).max(255),
});
export type AdminPrincipal = z.infer<typeof AdminPrincipalSchema>;

/** RPC 成功/Problem 联合；调用者必须显式处理失败 / RPC success/problem union; callers must handle failure explicitly. */
export function rpcResult<const T extends z.ZodType>(data: T) {
  return z.union([
    z.strictObject({ data }),
    z.strictObject({ problem: ProblemDetailsSchema }),
  ]);
}

/** Issue 生命周期状态 / Machine-aggregated issue lifecycle state. */
export const IssueStateSchema = z.enum([
  "observed",
  "active",
  "recovering",
  "suppressed",
  "resolved",
]);
export type IssueState = z.infer<typeof IssueStateSchema>;

/** 管理界面 Issue 行 / Administrative issue row with bounded evidence references. */
export const IssueSummarySchema = z.strictObject({
  issue_id: UuidV7Schema,
  fingerprint_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  service_name: ServiceNameSchema,
  kind: z.string().min(3).max(128),
  severity: DiagnosticSeveritySchema,
  state: IssueStateSchema,
  first_seen_at: UtcDateTimeSchema,
  last_seen_at: UtcDateTimeSchema,
  occurrence_count: z.number().int().positive(),
  affected_instance_count: z.number().int().nonnegative(),
  policy_revision: z.string().min(1).max(128),
  latest_evidence: z.array(TelemetryReferenceSchema).max(32),
  acknowledged_at: UtcDateTimeSchema.nullable(),
  acknowledged_by: z.string().min(1).max(255).nullable(),
  suppressed_until: UtcDateTimeSchema.nullable(),
  suppression_reason: z.string().max(1024).nullable(),
  revision: RevisionSchema,
});
export type IssueSummary = z.infer<typeof IssueSummarySchema>;

/** 管理 Incident 快照 / Administrative incident snapshot. */
export const AdminIncidentSchema = z.strictObject({
  incident_id: UuidV7Schema,
  title: z.string().min(1).max(256),
  state: IncidentStateSchema,
  impact: IncidentImpactSchema,
  started_at: UtcDateTimeSchema,
  detected_at: UtcDateTimeSchema,
  resolved_at: UtcDateTimeSchema.nullable(),
  affected_components: z.array(z.string().min(1).max(128)).max(256),
  affected_services: z.array(ServiceNameSchema).max(256),
  issue_ids: z.array(UuidV7Schema).max(1024),
  cause: z.string().max(4096).nullable(),
  updates: z.array(PublicIncidentUpdateSchema),
  revision: RevisionSchema,
});
export type AdminIncident = z.infer<typeof AdminIncidentSchema>;

/** Issue 搜索条件 / Cursor-based issue search query. */
export const SearchIssuesQuerySchema = z.strictObject({
  service_name: ServiceNameSchema.optional(),
  states: z.array(IssueStateSchema).max(5).optional(),
  severities: z.array(DiagnosticSeveritySchema).max(4).optional(),
  kind: z.string().min(3).max(128).optional(),
  seen_after: UtcDateTimeSchema.optional(),
  seen_before: UtcDateTimeSchema.optional(),
  cursor: z.string().min(16).max(2048).optional(),
  limit: z.number().int().min(1).max(100).default(50),
});
export type SearchIssuesQuery = z.infer<typeof SearchIssuesQuerySchema>;

/** 创建 Incident 命令 / Idempotent create-incident command. */
export const CreateIncidentCommandSchema = z.strictObject({
  command_id: UuidV7Schema,
  title: z.string().min(1).max(256),
  impact: IncidentImpactSchema,
  started_at: UtcDateTimeSchema,
  affected_components: z.array(z.string().min(1).max(128)).min(1).max(256),
  issue_ids: z.array(UuidV7Schema).max(1024),
  initial_message: z.string().min(1).max(4096),
});
export type CreateIncidentCommand = z.infer<typeof CreateIncidentCommandSchema>;

/** 更新 Incident 命令；每次变更形成新 update / Incident update command; every mutation creates an immutable update. */
export const UpdateIncidentCommandSchema = z.strictObject({
  command_id: UuidV7Schema,
  message: z.string().min(1).max(4096),
  title: z.string().min(1).max(256).optional(),
  state: IncidentStateSchema.optional(),
  impact: IncidentImpactSchema.optional(),
  affected_components: z.array(z.string().min(1).max(128)).max(256).optional(),
  issue_ids: z.array(UuidV7Schema).max(1024).optional(),
  cause: z.string().max(4096).nullable().optional(),
});
export type UpdateIncidentCommand = z.infer<typeof UpdateIncidentCommandSchema>;

/** Maintenance Window 当前快照 / Administrative maintenance-window snapshot. */
export const MaintenanceWindowSchema = z
  .strictObject({
    maintenance_id: UuidV7Schema,
    title: z.string().min(1).max(256),
    description: z.string().min(1).max(4096),
    starts_at: UtcDateTimeSchema,
    ends_at: UtcDateTimeSchema,
    expected_impact: IncidentImpactSchema,
    target_services: z.array(ServiceNameSchema).max(256),
    target_components: z.array(z.string().min(1).max(128)).max(256),
    state: z.enum(["scheduled", "active", "completed", "cancelled"]),
    created_by: z.string().min(1).max(255),
    revision: RevisionSchema,
  })
  .refine((value) => Date.parse(value.starts_at) < Date.parse(value.ends_at), {
    message: "starts_at must be before ends_at",
  });
export type MaintenanceWindow = z.infer<typeof MaintenanceWindowSchema>;

/** 创建维护窗口命令 / Idempotent maintenance-window creation command. */
export const CreateMaintenanceWindowCommandSchema = z
  .strictObject({
    command_id: UuidV7Schema,
    title: z.string().min(1).max(256),
    description: z.string().min(1).max(4096),
    starts_at: UtcDateTimeSchema,
    ends_at: UtcDateTimeSchema,
    expected_impact: IncidentImpactSchema,
    target_services: z.array(ServiceNameSchema).max(256),
    target_components: z.array(z.string().min(1).max(128)).max(256),
  })
  .superRefine((value, context) => {
    if (Date.parse(value.starts_at) >= Date.parse(value.ends_at)) {
      context.addIssue({
        code: "custom",
        path: ["ends_at"],
        message: "ends_at must be after starts_at",
      });
    }
    if (
      value.target_services.length === 0 &&
      value.target_components.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["target_services"],
        message: "at least one target is required",
      });
    }
  });
export type CreateMaintenanceWindowCommand = z.infer<
  typeof CreateMaintenanceWindowCommandSchema
>;

/** 更新维护窗口命令 / Optimistic maintenance-window update command. */
export const UpdateMaintenanceWindowCommandSchema = z
  .strictObject({
    command_id: UuidV7Schema,
    title: z.string().min(1).max(256).optional(),
    description: z.string().min(1).max(4096).optional(),
    starts_at: UtcDateTimeSchema.optional(),
    ends_at: UtcDateTimeSchema.optional(),
    expected_impact: IncidentImpactSchema.optional(),
    target_services: z.array(ServiceNameSchema).max(256).optional(),
    target_components: z.array(z.string().min(1).max(128)).max(256).optional(),
    state: z.enum(["scheduled", "active", "cancelled"]).optional(),
  })
  .refine(
    (value) => Object.keys(value).some((key) => key !== "command_id"),
    "at least one mutable field is required",
  );
export type UpdateMaintenanceWindowCommand = z.infer<
  typeof UpdateMaintenanceWindowCommandSchema
>;

/** Service Registry 的 Component 定义 / Component definition for the Service Registry. */
export const ServiceComponentRegistrationSchema = z.strictObject({
  component_id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  display_name: z.string().min(1).max(128),
  public: z.boolean(),
  sort_order: z.number().int().nonnegative().max(100_000),
});

/** 有向服务依赖 / Directed service dependency. */
export const ServiceDependencyRegistrationSchema = z.strictObject({
  target_service: ServiceNameSchema,
  kind: z.enum(["required", "optional", "degraded_fallback"]),
  criticality: z.enum(["low", "medium", "high", "critical"]),
  capability: z.string().min(1).max(128),
});

/** 服务注册命令 / Idempotent Service Registry command. */
export const RegisterServiceCommandSchema = z.strictObject({
  command_id: UuidV7Schema,
  service_name: ServiceNameSchema,
  display_name: z.string().min(1).max(128),
  description: z.string().min(1).max(1024),
  owner: z.string().min(1).max(128),
  criticality: z.enum(["low", "medium", "high", "critical"]),
  enabled: z.boolean(),
  components: z.array(ServiceComponentRegistrationSchema).max(256),
  dependencies: z.array(ServiceDependencyRegistrationSchema).max(256),
});
export type RegisterServiceCommand = z.infer<
  typeof RegisterServiceCommandSchema
>;

/** 注册后的服务目录行 / Registered service catalog row. */
export const ServiceRegistrationSchema = RegisterServiceCommandSchema.omit({
  command_id: true,
}).extend({
  revision: RevisionSchema,
  registered_at: UtcDateTimeSchema,
});
export type ServiceRegistration = z.infer<typeof ServiceRegistrationSchema>;

function greatestCommonDivisor(left: number, right: number): number {
  let a = left;
  let b = right;
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

/** 精确且约分的有理数阈值，避免 native/Wasm 漂移和重复表示 / Exact reduced rational threshold avoiding drift and duplicate encodings. */
export const ExactRatioSchema = z
  .strictObject({
    numerator: z.number().int().nonnegative().max(1_000_000_000),
    denominator: z.number().int().positive().max(1_000_000_000),
  })
  .superRefine((ratio, context) => {
    if (ratio.numerator > ratio.denominator) {
      context.addIssue({
        code: "custom",
        message: "ratio must be between zero and one",
      });
    }
    if (greatestCommonDivisor(ratio.numerator, ratio.denominator) !== 1) {
      context.addIssue({
        code: "custom",
        message: "ratio must be reduced to canonical terms",
      });
    }
  });
export type ExactRatio = z.infer<typeof ExactRatioSchema>;

/** 不可变评估策略；字段可无损投影到核心 evaluator / Immutable policy with a lossless projection into the core evaluator. */
export const EvaluationPolicySchema = z.strictObject({
  policy_id: UuidV7Schema,
  revision: RevisionSchema,
  window_seconds: z.number().int().positive().max(86_400),
  minimum_samples: z.number().int().positive().max(100_000),
  failure_threshold: ExactRatioSchema,
  recovery_threshold: ExactRatioSchema,
  latency_threshold_ms: z.number().int().positive().max(3_600_000).nullable(),
  stale_after_seconds: z.number().int().positive().max(604_800),
  quorum: z.strictObject({
    minimum_locations: z.number().int().positive().max(256),
    failure_locations: z.number().int().positive().max(256),
    recovery_locations: z.number().int().positive().max(256),
  }),
  issue_fingerprint_template: z
    .array(
      z.enum([
        "dependency",
        "operation",
        "error_type",
        "component",
        "capability",
        "region",
        "protocol",
      ]),
    )
    .min(1)
    .max(7),
  failure_status: z.enum(["degraded", "partial_outage", "major_outage"]),
});
export type EvaluationPolicy = z.infer<typeof EvaluationPolicySchema>;

/** 核心 evaluator 的无损输入 schema / Lossless input schema consumed by the native/Wasm core evaluator. */
export const CoreEvaluationPolicySchema = EvaluationPolicySchema.omit({
  policy_id: true,
  issue_fingerprint_template: true,
});
export type CoreEvaluationPolicy = z.infer<typeof CoreEvaluationPolicySchema>;

/**
 * 去除注册元数据并生成核心 evaluator JSON / Remove registry metadata and build core evaluator JSON.
 *
 * 阈值保持精确 numerator/denominator，不执行浮点转换。
 * Thresholds remain exact numerator/denominator pairs; no floating-point conversion occurs.
 */
export function toCoreEvaluationPolicy(
  policy: EvaluationPolicy,
): CoreEvaluationPolicy {
  const {
    policy_id: _policyId,
    issue_fingerprint_template: _fingerprint,
    ...core
  } = policy;
  return CoreEvaluationPolicySchema.parse(core);
}

/** 注册不可变评估策略命令 / Idempotent immutable evaluation-policy registration command. */
export const RegisterEvaluationPolicyCommandSchema = z.strictObject({
  command_id: UuidV7Schema,
  policy: EvaluationPolicySchema,
});
export type RegisterEvaluationPolicyCommand = z.infer<
  typeof RegisterEvaluationPolicyCommandSchema
>;

/** Diagnostic/Monitor 策略绑定选择器 / Selector for assigning a policy to a monitor or Diagnostic class. */
export const DiagnosticPolicySelectorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("monitor"), monitor_id: UuidV7Schema }),
  z.strictObject({
    kind: z.literal("service_kind"),
    service_name: ServiceNameSchema,
    diagnostic_kind: z
      .string()
      .min(3)
      .max(128)
      .regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/),
  }),
  z.strictObject({
    kind: z.literal("service_default"),
    service_name: ServiceNameSchema,
  }),
]);
export type DiagnosticPolicySelector = z.infer<
  typeof DiagnosticPolicySelectorSchema
>;

/** 绑定不可变策略 revision 的幂等命令 / Idempotent assignment of an immutable policy revision. */
export const AssignDiagnosticPolicyCommandSchema = z.strictObject({
  command_id: UuidV7Schema,
  selector: DiagnosticPolicySelectorSchema,
  policy_id: UuidV7Schema,
  policy_revision: RevisionSchema,
});
export type AssignDiagnosticPolicyCommand = z.infer<
  typeof AssignDiagnosticPolicyCommandSchema
>;

/** 策略绑定快照 / Policy assignment snapshot. */
export const DiagnosticPolicyAssignmentSchema = z.strictObject({
  assignment_id: UuidV7Schema,
  selector: DiagnosticPolicySelectorSchema,
  policy_id: UuidV7Schema,
  policy_revision: RevisionSchema,
  assigned_at: UtcDateTimeSchema,
  assigned_by: z.string().min(1).max(255),
  revision: RevisionSchema,
});
export type DiagnosticPolicyAssignment = z.infer<
  typeof DiagnosticPolicyAssignmentSchema
>;

/** Kind-specific probe destination; secret values are referenced, never embedded / 各 probe 类型的目标配置；仅引用 secret。 */
export const ProbeDefinitionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("http"),
    url: HttpsUrlSchema,
    method: z.enum(["GET", "HEAD"]).default("HEAD"),
    expected_statuses: z
      .array(z.number().int().min(100).max(599))
      .min(1)
      .max(32)
      .default([200]),
    max_redirects: z.number().int().min(0).max(3).default(0),
  }),
  z.strictObject({
    kind: z.literal("tcp"),
    hostname: z
      .string()
      .min(1)
      .max(253)
      .regex(/^[A-Za-z0-9][A-Za-z0-9.:-]*$/),
    port: z.number().int().min(1).max(65_535),
  }),
  z.strictObject({
    kind: z.literal("dns"),
    hostname: z.string().min(1).max(253),
    record_type: z.enum(["A", "AAAA"]),
  }),
  z.strictObject({
    kind: z.literal("rpc"),
    binding: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/),
    operation: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/),
  }),
  z.strictObject({
    kind: z.literal("synthetic"),
    binding: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/),
    scenario: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/),
  }),
]);
export type ProbeDefinition = z.infer<typeof ProbeDefinitionSchema>;

const MonitorConfigObjectSchema = z.strictObject({
  monitor_id: UuidV7Schema,
  service_name: ServiceNameSchema,
  target_type: z.enum(["service", "component"]),
  target_id: z.string().min(1).max(128),
  probe_kind: z.enum(["http", "tcp", "dns", "rpc", "synthetic"]),
  probe_config: ProbeDefinitionSchema,
  schedule_kind: z.enum(["interval", "cron"]),
  schedule_expression: z.string().min(9).max(128).nullable(),
  interval_seconds: z.number().int().min(10).max(86_400).nullable(),
  timeout_ms: z.number().int().positive().max(300_000),
  locations: z.array(z.string().min(1).max(64)).min(1).max(64),
  policy_id: UuidV7Schema,
  policy_revision: RevisionSchema,
  enabled: z.boolean(),
  revision: RevisionSchema,
});

function validateMonitorConfig(
  value: {
    probe_kind: string;
    probe_config: { kind: string };
    schedule_kind: "interval" | "cron";
    schedule_expression: string | null;
    interval_seconds: number | null;
    timeout_ms: number;
  },
  context: z.RefinementCtx,
): void {
  if (value.probe_kind !== value.probe_config.kind) {
    context.addIssue({
      code: "custom",
      path: ["probe_config"],
      message: "probe_config.kind must match probe_kind",
    });
  }
  if (value.schedule_kind === "interval") {
    if (value.interval_seconds === null || value.schedule_expression !== null) {
      context.addIssue({
        code: "custom",
        path: ["interval_seconds"],
        message: "interval schedule requires only interval_seconds",
      });
    } else if (value.timeout_ms >= value.interval_seconds * 1000) {
      context.addIssue({
        code: "custom",
        path: ["timeout_ms"],
        message: "timeout_ms must be shorter than the interval",
      });
    }
    return;
  }
  if (value.schedule_expression === null || value.interval_seconds !== null) {
    context.addIssue({
      code: "custom",
      path: ["schedule_expression"],
      message: "cron schedule requires only schedule_expression",
    });
    return;
  }
  if (
    /[LW#?]/.test(value.schedule_expression) ||
    value.schedule_expression.trim().split(/\s+/).length !== 5
  ) {
    context.addIssue({
      code: "custom",
      path: ["schedule_expression"],
      message: "only standard five-field UTC cron is supported",
    });
  }
}
/** Probe Monitor 配置 / Complete, executable probe monitor configuration. */
export const MonitorConfigSchema = MonitorConfigObjectSchema.superRefine(
  validateMonitorConfig,
);
export type MonitorConfig = z.infer<typeof MonitorConfigSchema>;

/** 创建 Monitor 命令 / Idempotent create-monitor command. */
export const CreateMonitorCommandSchema = MonitorConfigObjectSchema.omit({
  revision: true,
})
  .extend({
    command_id: UuidV7Schema,
  })
  .superRefine(validateMonitorConfig);
export type CreateMonitorCommand = z.infer<typeof CreateMonitorCommandSchema>;

/** 更新 Monitor 命令 / Optimistic monitor-update command. */
export const UpdateMonitorCommandSchema = z
  .strictObject({
    command_id: UuidV7Schema,
    probe_kind: z.enum(["http", "tcp", "dns", "rpc", "synthetic"]).optional(),
    probe_config: ProbeDefinitionSchema.optional(),
    schedule_kind: z.enum(["interval", "cron"]).optional(),
    schedule_expression: z.string().min(9).max(128).nullable().optional(),
    interval_seconds: z
      .number()
      .int()
      .min(10)
      .max(86_400)
      .nullable()
      .optional(),
    timeout_ms: z.number().int().positive().max(300_000).optional(),
    locations: z.array(z.string().min(1).max(64)).min(1).max(64).optional(),
    policy_id: UuidV7Schema.optional(),
    policy_revision: RevisionSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .superRefine((value, context) => {
    if (!Object.keys(value).some((key) => key !== "command_id")) {
      context.addIssue({
        code: "custom",
        message: "at least one mutable field is required",
      });
    }
    if (
      (value.probe_config === undefined) !==
      (value.probe_kind === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["probe_config"],
        message: "probe_config and probe_kind must be updated together",
      });
    }
    if (
      value.probe_config !== undefined &&
      value.probe_kind !== value.probe_config.kind
    ) {
      context.addIssue({
        code: "custom",
        path: ["probe_config"],
        message: "probe_config.kind must match probe_kind",
      });
    }
  });
export type UpdateMonitorCommand = z.infer<typeof UpdateMonitorCommandSchema>;

/** 遥测后端注册项；auth_reference 仅为 secret 引用 / Telemetry backend registration; auth_reference is a secret reference, never a credential. */
export const TelemetryBackendRegistrationSchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
  capabilities: z
    .array(
      z.enum([
        "trace",
        "log_query",
        "profile",
        "metric_query",
        "source",
        "artifact",
      ]),
    )
    .min(1)
    .max(6),
  query_adapter: z.string().min(1).max(128),
  ui_url_template: z.string().url().max(2048),
  retention_class: z.string().min(1).max(64),
  auth_reference: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Z][A-Z0-9_]*$/),
});
export type TelemetryBackendRegistration = z.infer<
  typeof TelemetryBackendRegistrationSchema
>;

/** 注册遥测后端命令 / Idempotent telemetry-backend registration command. */
export const RegisterTelemetryBackendCommandSchema = z.strictObject({
  command_id: UuidV7Schema,
  backend: TelemetryBackendRegistrationSchema,
});
export type RegisterTelemetryBackendCommand = z.infer<
  typeof RegisterTelemetryBackendCommandSchema
>;

/** `registerBackend` 的规范名称；旧长名称保持类型兼容 / Canonical `registerBackend` alias; the long legacy name remains compatible. */
export const RegisterBackendCommandSchema =
  RegisterTelemetryBackendCommandSchema;
export type RegisterBackendCommand = RegisterTelemetryBackendCommand;

/** 有到期时间的人工状态覆盖目标 / Target of an expiring operator status override. */
export const StatusOverrideTargetSchema = z.discriminatedUnion("target_type", [
  z.strictObject({
    target_type: z.literal("service"),
    service_name: ServiceNameSchema,
  }),
  z.strictObject({
    target_type: z.literal("component"),
    service_name: ServiceNameSchema,
    component_id: z.string().min(1).max(128),
  }),
]);

/** 创建人工状态覆盖命令；maintenance 只能由窗口表达 / Create an expiring status override; maintenance is represented only by a window. */
export const SetStatusOverrideCommandSchema = z.strictObject({
  command_id: UuidV7Schema,
  target: StatusOverrideTargetSchema,
  status: z.enum([
    "operational",
    "degraded",
    "partial_outage",
    "major_outage",
    "unknown",
  ]),
  expires_at: UtcDateTimeSchema,
  reason: z.string().min(1).max(1024),
});
export type SetStatusOverrideCommand = z.infer<
  typeof SetStatusOverrideCommandSchema
>;

/** 人工状态覆盖快照 / Expiring operator status-override snapshot. */
export const StatusOverrideSchema = z.strictObject({
  override_id: UuidV7Schema,
  target: StatusOverrideTargetSchema,
  status: z.enum([
    "operational",
    "degraded",
    "partial_outage",
    "major_outage",
    "unknown",
  ]),
  expires_at: UtcDateTimeSchema,
  reason: z.string().min(1).max(1024),
  created_at: UtcDateTimeSchema,
  created_by: z.string().min(1).max(255),
  revision: RevisionSchema,
});
export type StatusOverride = z.infer<typeof StatusOverrideSchema>;

/** 诊断上下文定位器 / Locator for an administrative diagnostic-context query. */
export const DiagnosticContextLocatorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("issue"), issue_id: UuidV7Schema }),
  z.strictObject({ kind: z.literal("incident"), incident_id: UuidV7Schema }),
  z.strictObject({
    kind: z.literal("correlation"),
    correlation_id: UuidV7Schema,
  }),
  z.strictObject({
    kind: z.literal("trace"),
    trace_id: z.string().regex(/^(?!0{32}$)[0-9a-f]{32}$/),
  }),
  z.strictObject({
    kind: z.literal("deployment"),
    deployment_id: UuidV7Schema,
  }),
  z.strictObject({
    kind: z.literal("service"),
    service_name: ServiceNameSchema,
    start: UtcDateTimeSchema,
    end: UtcDateTimeSchema,
  }),
]);
export type DiagnosticContextLocator = z.infer<
  typeof DiagnosticContextLocatorSchema
>;

/** 有界诊断上下文结果 / Bounded diagnostic context; raw telemetry remains in its backend. */
export const DiagnosticContextSchema = z.strictObject({
  issues: z.array(IssueSummarySchema).max(100),
  incidents: z.array(AdminIncidentSchema).max(100),
  evidence: z.array(TelemetryReferenceSchema).max(200),
  deployments: z.array(DeploymentManifestSchema).max(100),
  truncated: z.boolean(),
});
export type DiagnosticContext = z.infer<typeof DiagnosticContextSchema>;

/** status 管理 RPC 健康状态 / Health result for the internal status management RPC. */
export const CheckHealthResultSchema = z.strictObject({
  status: z.enum(["ok", "degraded"]),
  checked_at: UtcDateTimeSchema,
  service_name: z.literal("status"),
  version: z.string().min(1).max(128),
  dependencies: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(64),
        status: z.enum(["ok", "degraded", "unavailable"]),
        last_success_at: UtcDateTimeSchema.nullable(),
      }),
    )
    .max(32),
});
export type CheckHealthResult = z.infer<typeof CheckHealthResultSchema>;

/** 管理 RPC 的 W3C Trace Context；不得承载授权数据 / W3C Trace Context for administrative RPC; never an authorization source. */
export const RpcTraceContextSchema = z.strictObject({
  traceparent: z
    .string()
    .regex(/^00-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$/),
  tracestate: z.string().min(1).max(512).optional(),
});
export type RpcTraceContext = z.infer<typeof RpcTraceContextSchema>;

const AdminRpcContextShape = {
  principal: AdminPrincipalSchema,
  correlation_id: UuidV7Schema,
  trace_context: RpcTraceContextSchema.optional(),
};
const PrincipalOnlySchema = z.strictObject(AdminRpcContextShape);

/** `checkHealth` RPC 请求 / `checkHealth` RPC request. */
export const CheckHealthRpcRequestSchema = PrincipalOnlySchema;
export type CheckHealthRpcRequest = z.infer<typeof CheckHealthRpcRequestSchema>;
export const CheckHealthRpcResultSchema = rpcResult(CheckHealthResultSchema);
export type CheckHealthRpcResult = z.infer<typeof CheckHealthRpcResultSchema>;

/** `getIncident` RPC 请求/结果 / `getIncident` RPC request/result. */
export const GetIncidentRpcRequestSchema = z.strictObject({
  ...AdminRpcContextShape,
  incident_id: UuidV7Schema,
});
export type GetIncidentRpcRequest = z.infer<typeof GetIncidentRpcRequestSchema>;
export const GetIncidentRpcResultSchema = rpcResult(AdminIncidentSchema);
export type GetIncidentRpcResult = z.infer<typeof GetIncidentRpcResultSchema>;

/** `searchIssues` RPC 请求/结果 / `searchIssues` RPC request/result. */
export const SearchIssuesRpcRequestSchema = z.strictObject({
  ...AdminRpcContextShape,
  query: SearchIssuesQuerySchema,
});
export type SearchIssuesRpcRequest = z.infer<
  typeof SearchIssuesRpcRequestSchema
>;
export const SearchIssuesResultDataSchema = z.strictObject({
  data: z.array(IssueSummarySchema),
  next_cursor: z.string().min(16).max(2048).nullable(),
});
export const SearchIssuesRpcResultSchema = rpcResult(
  SearchIssuesResultDataSchema,
);
export type SearchIssuesRpcResult = z.infer<typeof SearchIssuesRpcResultSchema>;

/** `createIncident` RPC 请求/结果 / `createIncident` RPC request/result. */
export const CreateIncidentRpcRequestSchema = z.strictObject({
  ...AdminRpcContextShape,
  command: CreateIncidentCommandSchema,
});
export type CreateIncidentRpcRequest = z.infer<
  typeof CreateIncidentRpcRequestSchema
>;
export const CreateIncidentRpcResultSchema = rpcResult(AdminIncidentSchema);
export type CreateIncidentRpcResult = z.infer<
  typeof CreateIncidentRpcResultSchema
>;

/** `updateIncident` RPC 请求/结果 / `updateIncident` RPC request/result. */
export const UpdateIncidentRpcRequestSchema = z.strictObject({
  ...AdminRpcContextShape,
  incident_id: UuidV7Schema,
  expected_revision: RevisionSchema,
  command: UpdateIncidentCommandSchema,
});
export type UpdateIncidentRpcRequest = z.infer<
  typeof UpdateIncidentRpcRequestSchema
>;
export const UpdateIncidentRpcResultSchema = rpcResult(AdminIncidentSchema);
export type UpdateIncidentRpcResult = z.infer<
  typeof UpdateIncidentRpcResultSchema
>;

/** `acknowledgeIssue` RPC 请求/结果 / `acknowledgeIssue` RPC request/result. */
export const AcknowledgeIssueRpcRequestSchema = z.strictObject({
  ...AdminRpcContextShape,
  issue_id: UuidV7Schema,
  expected_revision: RevisionSchema,
  command_id: UuidV7Schema,
});
export type AcknowledgeIssueRpcRequest = z.infer<
  typeof AcknowledgeIssueRpcRequestSchema
>;
export const AcknowledgeIssueRpcResultSchema = rpcResult(IssueSummarySchema);
export type AcknowledgeIssueRpcResult = z.infer<
  typeof AcknowledgeIssueRpcResultSchema
>;

/** `suppressIssue` RPC 请求/结果 / `suppressIssue` RPC request/result. */
export const SuppressIssueRpcRequestSchema = z.strictObject({
  ...AdminRpcContextShape,
  issue_id: UuidV7Schema,
  expected_revision: RevisionSchema,
  command_id: UuidV7Schema,
  until: UtcDateTimeSchema,
  reason: z.string().min(1).max(1024),
});
export type SuppressIssueRpcRequest = z.infer<
  typeof SuppressIssueRpcRequestSchema
>;
export const SuppressIssueRpcResultSchema = rpcResult(IssueSummarySchema);
export type SuppressIssueRpcResult = z.infer<
  typeof SuppressIssueRpcResultSchema
>;

/** Maintenance RPC 请求/结果 / Maintenance RPC request/result. */
export const CreateMaintenanceWindowRpcRequestSchema = z.strictObject({
  ...AdminRpcContextShape,
  command: CreateMaintenanceWindowCommandSchema,
});
export type CreateMaintenanceWindowRpcRequest = z.infer<
  typeof CreateMaintenanceWindowRpcRequestSchema
>;
export const CreateMaintenanceWindowRpcResultSchema = rpcResult(
  MaintenanceWindowSchema,
);
export type CreateMaintenanceWindowRpcResult = z.infer<
  typeof CreateMaintenanceWindowRpcResultSchema
>;
export const UpdateMaintenanceWindowRpcRequestSchema = z.strictObject({
  ...AdminRpcContextShape,
  id: UuidV7Schema,
  expected_revision: RevisionSchema,
  command: UpdateMaintenanceWindowCommandSchema,
});
export type UpdateMaintenanceWindowRpcRequest = z.infer<
  typeof UpdateMaintenanceWindowRpcRequestSchema
>;
export const UpdateMaintenanceWindowRpcResultSchema = rpcResult(
  MaintenanceWindowSchema,
);
export type UpdateMaintenanceWindowRpcResult = z.infer<
  typeof UpdateMaintenanceWindowRpcResultSchema
>;

/** `queryDiagnosticContext` RPC 请求/结果 / `queryDiagnosticContext` RPC request/result. */
export const QueryDiagnosticContextRpcRequestSchema = z.strictObject({
  ...AdminRpcContextShape,
  locator: DiagnosticContextLocatorSchema,
});
export type QueryDiagnosticContextRpcRequest = z.infer<
  typeof QueryDiagnosticContextRpcRequestSchema
>;
export const QueryDiagnosticContextRpcResultSchema = rpcResult(
  DiagnosticContextSchema,
);
export type QueryDiagnosticContextRpcResult = z.infer<
  typeof QueryDiagnosticContextRpcResultSchema
>;

/** Catalog RPC 请求/结果 / Catalog RPC request/result. */
export const RegisterServiceRpcRequestSchema = z.strictObject({
  ...AdminRpcContextShape,
  command: RegisterServiceCommandSchema,
});
export type RegisterServiceRpcRequest = z.infer<
  typeof RegisterServiceRpcRequestSchema
>;
export const RegisterServiceRpcResultSchema = rpcResult(
  ServiceRegistrationSchema,
);
export type RegisterServiceRpcResult = z.infer<
  typeof RegisterServiceRpcResultSchema
>;
export const UpdateMonitorRpcRequestSchema = z.strictObject({
  ...AdminRpcContextShape,
  monitor_id: UuidV7Schema,
  expected_revision: RevisionSchema,
  command: UpdateMonitorCommandSchema,
});
export type UpdateMonitorRpcRequest = z.infer<
  typeof UpdateMonitorRpcRequestSchema
>;
export const UpdateMonitorRpcResultSchema = rpcResult(MonitorConfigSchema);
export type UpdateMonitorRpcResult = z.infer<
  typeof UpdateMonitorRpcResultSchema
>;

/** `createMonitor` RPC 请求/结果 / `createMonitor` RPC request/result. */
export const CreateMonitorRpcRequestSchema = z.strictObject({
  ...AdminRpcContextShape,
  command: CreateMonitorCommandSchema,
});
export type CreateMonitorRpcRequest = z.infer<
  typeof CreateMonitorRpcRequestSchema
>;
export const CreateMonitorRpcResultSchema = rpcResult(MonitorConfigSchema);
export type CreateMonitorRpcResult = z.infer<
  typeof CreateMonitorRpcResultSchema
>;

/** 附加 catalog registration RPC 请求/结果 / Additional catalog-registration RPC request/results. */
export const RegisterEvaluationPolicyRpcRequestSchema = z.strictObject({
  ...AdminRpcContextShape,
  command: RegisterEvaluationPolicyCommandSchema,
});
export type RegisterEvaluationPolicyRpcRequest = z.infer<
  typeof RegisterEvaluationPolicyRpcRequestSchema
>;
export const RegisterEvaluationPolicyRpcResultSchema = rpcResult(
  EvaluationPolicySchema,
);
export type RegisterEvaluationPolicyRpcResult = z.infer<
  typeof RegisterEvaluationPolicyRpcResultSchema
>;
export const AssignDiagnosticPolicyRpcRequestSchema = z.strictObject({
  ...AdminRpcContextShape,
  command: AssignDiagnosticPolicyCommandSchema,
});
export type AssignDiagnosticPolicyRpcRequest = z.infer<
  typeof AssignDiagnosticPolicyRpcRequestSchema
>;
export const AssignDiagnosticPolicyRpcResultSchema = rpcResult(
  DiagnosticPolicyAssignmentSchema,
);
export type AssignDiagnosticPolicyRpcResult = z.infer<
  typeof AssignDiagnosticPolicyRpcResultSchema
>;
export const RegisterTelemetryBackendRpcRequestSchema = z.strictObject({
  ...AdminRpcContextShape,
  command: RegisterTelemetryBackendCommandSchema,
});
export type RegisterTelemetryBackendRpcRequest = z.infer<
  typeof RegisterTelemetryBackendRpcRequestSchema
>;
export const RegisterTelemetryBackendRpcResultSchema = rpcResult(
  TelemetryBackendRegistrationSchema,
);
export type RegisterTelemetryBackendRpcResult = z.infer<
  typeof RegisterTelemetryBackendRpcResultSchema
>;
export const RegisterBackendRpcRequestSchema =
  RegisterTelemetryBackendRpcRequestSchema;
export type RegisterBackendRpcRequest = RegisterTelemetryBackendRpcRequest;
export const RegisterBackendRpcResultSchema =
  RegisterTelemetryBackendRpcResultSchema;
export type RegisterBackendRpcResult = RegisterTelemetryBackendRpcResult;
export const SetStatusOverrideRpcRequestSchema = z.strictObject({
  ...AdminRpcContextShape,
  command: SetStatusOverrideCommandSchema,
});
export type SetStatusOverrideRpcRequest = z.infer<
  typeof SetStatusOverrideRpcRequestSchema
>;
export const SetStatusOverrideRpcResultSchema = rpcResult(StatusOverrideSchema);
export type SetStatusOverrideRpcResult = z.infer<
  typeof SetStatusOverrideRpcResultSchema
>;

/** RPC 名称联合，用于穷尽调度 / RPC name union for exhaustive dispatch. */
export const AdminRpcNameSchema = z.enum([
  "checkHealth",
  "getIncident",
  "searchIssues",
  "createIncident",
  "updateIncident",
  "acknowledgeIssue",
  "suppressIssue",
  "createMaintenanceWindow",
  "updateMaintenanceWindow",
  "queryDiagnosticContext",
  "registerService",
  "createMonitor",
  "updateMonitor",
  "registerEvaluationPolicy",
  "assignDiagnosticPolicy",
  "registerBackend",
  "registerTelemetryBackend",
  "setStatusOverride",
]);
export type AdminRpcName = z.infer<typeof AdminRpcNameSchema>;

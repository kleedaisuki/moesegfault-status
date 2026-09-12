import type { DiagnosticEvent } from "@moesegfault/contracts";
import type { DiagnosticDomainCore, DiagnosticEvaluation } from "./types.js";

/** 领域核心指纹返回值。 / Fingerprint result returned by the domain core. */
export interface CanonicalFingerprint {
  /** 小写 SHA-256，不带前缀。 / Lowercase SHA-256 without a prefix. */
  readonly hash: string;
  /** 用于审查的规范形式。 / Canonical form retained for inspection. */
  readonly canonical: string;
}

/** 当前未解决 Issue 快照。 / Snapshot of the current unresolved Issue. */
export interface CurrentIssue {
  readonly issue_id: string;
  readonly state: string;
  readonly severity: DiagnosticEvent["severity"];
  readonly occurrence_count: number;
  readonly recovery_count: number;
  readonly last_fault_event_id: string | null;
  readonly last_recovery_at: string | null;
  readonly first_seen_at: string;
  readonly last_seen_at: string;
  readonly revision: number;
  readonly fingerprint_hash: string;
  readonly policy_revision: number;
}

/** 当前服务状态快照。 / Snapshot of the service's current status. */
export interface CurrentStatus {
  readonly direct_status: string;
  readonly dependency_risk: string;
  readonly effective_impact: string;
  readonly evaluated_at: string;
  readonly fresh_until: string;
  readonly revision: number;
}

/**
 * 调用 Rust 领域核心并对边界返回值做 fail-closed 检查。
 * Invoke the Rust domain core and fail closed on malformed boundary output.
 */
function dispatch<T>(
  core: DiagnosticDomainCore,
  operation: string,
  payload: unknown,
): T {
  const decoded: unknown = JSON.parse(
    core.dispatchJson(JSON.stringify({ operation, payload })),
  );
  if (typeof decoded !== "object" || decoded === null || "error" in decoded) {
    throw new Error(`domain operation failed: ${operation}`);
  }
  return decoded as T;
}

/** 用 Rust 核心重新验证领域不变量。 / Revalidate domain invariants with the Rust core. */
export function validateWithCore(
  core: DiagnosticDomainCore,
  event: DiagnosticEvent,
): void {
  const result = dispatch<{ valid?: boolean }>(
    core,
    "validate_diagnostic_event",
    event,
  );
  if (result.valid !== true)
    throw new Error("domain rejected diagnostic event");
}

/** 仅使用 Rust 核心计算规范指纹。 / Compute the canonical fingerprint only in the Rust core. */
export function fingerprintWithCore(
  core: DiagnosticDomainCore,
  event: DiagnosticEvent,
): CanonicalFingerprint {
  const result = dispatch<CanonicalFingerprint>(core, "canonical_fingerprint", {
    kind: event.kind,
    service_name: event.service_name,
    fingerprint: event.fingerprint,
  });
  if (
    !/^[0-9a-f]{64}$/.test(result.hash) ||
    typeof result.canonical !== "string"
  ) {
    throw new Error("domain returned an invalid fingerprint");
  }
  return result;
}

/**
 * 根据显式的不可变 policy revision 评估 Diagnostic。
 * Evaluate a Diagnostic against an explicit immutable policy revision.
 */
export function evaluateWithCore(
  core: DiagnosticDomainCore,
  event: DiagnosticEvent,
  policy: {
    readonly policy_id: string;
    readonly revision: number;
    readonly minimum_occurrences: number;
    readonly recovery_min_occurrences: number;
    readonly status_by_severity: Readonly<
      Record<DiagnosticEvent["severity"], string>
    >;
  },
  currentIssue: CurrentIssue | null,
  currentStatus: CurrentStatus | null,
  now: string,
): DiagnosticEvaluation {
  const raw = dispatch<
    Omit<DiagnosticEvaluation, "policy_revision"> & {
      policy_revision: string | number;
    }
  >(core, "evaluate_diagnostic", {
    event,
    policy: { ...policy, revision: String(policy.revision) },
    current_issue:
      currentIssue === null
        ? null
        : {
            fingerprint_hash: currentIssue.fingerprint_hash,
            state: currentIssue.state,
            occurrence_count: currentIssue.occurrence_count,
            recovery_count: currentIssue.recovery_count,
            last_fault_event_id: currentIssue.last_fault_event_id,
            last_recovery_at: currentIssue.last_recovery_at,
            severity: currentIssue.severity,
            policy_revision: String(currentIssue.policy_revision),
            last_seen_at: currentIssue.last_seen_at,
            revision: currentIssue.revision,
          },
    current_service_status: currentStatus?.direct_status ?? "unknown",
    now,
  });
  const result: DiagnosticEvaluation = {
    ...raw,
    policy_revision: Number(raw.policy_revision),
    recovery_count: raw.recovery_count ?? 0,
    last_recovery_at: raw.last_recovery_at ?? null,
  };
  if (
    !/^[0-9a-f]{64}$/.test(result.fingerprint_hash) ||
    result.policy_revision !== policy.revision ||
    !["observed", "active", "recovering", "suppressed", "resolved"].includes(
      result.issue_state,
    ) ||
    !["info", "warning", "error", "critical"].includes(result.severity) ||
    ![
      "operational",
      "degraded",
      "partial_outage",
      "major_outage",
      "maintenance",
      "unknown",
    ].includes(result.direct_status) ||
    ![
      "create_observed",
      "create_active",
      "increment_observed",
      "confirm",
      "reactivate",
      "record_suppressed",
      "record_out_of_order",
      "create_recurrence",
      "begin_recovery",
      "resolve_recovery",
      "record_stale_recovery",
      "record_unmatched_recovery",
    ].includes(result.action) ||
    !Number.isSafeInteger(result.occurrence_count) ||
    !Number.isSafeInteger(result.recovery_count) ||
    (result.last_recovery_at !== null &&
      typeof result.last_recovery_at !== "string") ||
    typeof result.last_seen_at !== "string"
  ) {
    throw new Error("domain returned an invalid diagnostic evaluation");
  }
  return result;
}

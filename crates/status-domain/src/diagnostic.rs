//! DiagnosticEvent 校验和确定性聚合。 / DiagnosticEvent validation and deterministic aggregation.

use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    canonical_fingerprint, validate_uuid_v7, CanonicalFingerprint, DomainError, DomainResult,
};
use crate::{Environment, IssueState, Status, TelemetryKind, TimeRange};

/// Diagnostic 条件信号；恢复必须是显式正向证据。 / Diagnostic condition signal; recovery must be explicit positive evidence.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticSignal {
    /// 条件存在；省略字段的旧生产者保持此语义。 / The condition is present; legacy producers that omit the field retain this meaning.
    #[default]
    Fault,
    /// 检测器已观测到条件消失；静默绝不等价于此信号。 / The detector observed the condition clear; silence is never equivalent to this signal.
    Recovery,
}

/// DiagnosticEvent 内嵌的无身份证据；事件身份提供来源绑定。 / Identity-free evidence embedded in a DiagnosticEvent; event identity supplies provenance.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticEvidence {
    /// 证据类别。 / Evidence kind.
    pub kind: TelemetryKind,
    /// 后端 registry 名。 / Backend registry name.
    pub backend: String,
    /// kind-specific 结构化 locator。 / Kind-specific structured locator.
    pub locator: BTreeMap<String, Value>,
    /// 查询型证据必需的 UTC 范围。 / UTC range required for query evidence.
    pub time_range: Option<TimeRange>,
}

impl DiagnosticEvidence {
    /// 校验最小结构与条件字段。 / Validates minimal structure and conditional fields.
    pub fn validate(&self) -> DomainResult<()> {
        if self.backend.trim().is_empty() || self.locator.is_empty() {
            return Err(DomainError::Validation(
                "diagnostic evidence requires backend and structured locator".into(),
            ));
        }
        if matches!(
            self.kind,
            TelemetryKind::LogQuery | TelemetryKind::Profile | TelemetryKind::MetricQuery
        ) && self.time_range.is_none()
        {
            return Err(DomainError::Validation(
                "query evidence requires time_range".into(),
            ));
        }
        if self
            .time_range
            .as_ref()
            .is_some_and(|range| range.end < range.start)
        {
            return Err(DomainError::Validation(
                "evidence time_range end cannot precede start".into(),
            ));
        }
        if self.kind == TelemetryKind::Trace {
            let trace_id = self
                .locator
                .get("trace_id")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    DomainError::Validation("trace evidence requires locator.trace_id".into())
                })?;
            validate_w3c_id(trace_id, 32, "locator.trace_id")?;
        }
        Ok(())
    }
}

/// Diagnostic 运维严重度；不同于日志严重度。 / Diagnostic operational severity; distinct from log severity.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticSeverity {
    /// 值得记录但通常不影响能力。 / Worth recording but generally not capability-impacting.
    Info,
    /// 已偏离预期但能力大体可用。 / Deviates from expectations while capability broadly remains usable.
    Warning,
    /// 当前能力操作失败。 / A current capability operation failed.
    Error,
    /// 核心能力或正确性面临严重影响。 / Core capability or correctness faces severe impact.
    Critical,
}

/// 服务提交的不可变运维语义事实。 / Immutable operational semantic fact submitted by a service.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticEvent {
    /// UUIDv7 幂等事件身份。 / UUIDv7 idempotency identity.
    pub event_id: String,
    /// 输入 schema 版本。 / Input schema version.
    pub schema_version: String,
    /// 稳定小写点分事实类别。 / Stable lowercase dotted fact kind.
    pub kind: String,
    /// 显式故障或恢复信号。 / Explicit fault or recovery signal.
    #[serde(default)]
    pub signal: DiagnosticSignal,
    /// 恢复信号因果引用的最新故障事件。 / Latest fault event causally referenced by a recovery signal.
    pub recovery_of_event_id: Option<String>,
    /// 运维严重度。 / Operational severity.
    pub severity: DiagnosticSeverity,
    /// 已注册 `service.name`。 / Registered `service.name`.
    pub service_name: String,
    /// 与机器主体一致的部署环境。 / Deployment environment matching the machine principal.
    pub environment: Environment,
    /// 来源 deployment UUIDv7。 / Source deployment UUIDv7.
    pub deployment_id: String,
    /// 可选实例身份；Workers 不得伪造。 / Optional instance identity; Workers must not fabricate one.
    pub instance_id: Option<String>,
    /// 生产者认为事实发生的 UTC 时刻。 / UTC instant at which the producer believes the fact occurred.
    pub occurred_at: DateTime<Utc>,
    /// 可选逻辑执行 UUIDv7。 / Optional logical-execution UUIDv7.
    pub correlation_id: String,
    /// 可选 W3C trace ID。 / Optional W3C trace ID.
    pub trace_id: Option<String>,
    /// 可选 W3C span ID。 / Optional W3C span ID.
    pub span_id: Option<String>,
    /// 只供人展示、绝不参与聚合的摘要。 / Human-only summary that never participates in aggregation.
    pub summary: String,
    /// 只含稳定分类字段的指纹对象。 / Fingerprint object containing only stable classification fields.
    pub fingerprint: Value,
    /// 后端无关证据引用。 / Backend-neutral evidence references.
    #[serde(default)]
    pub evidence: Vec<DiagnosticEvidence>,
    /// 显式扩展的结构化属性。 / Explicitly extensible structured attributes.
    #[serde(default)]
    pub attributes: BTreeMap<String, Value>,
}

impl DiagnosticEvent {
    /// 校验身份、证据来源与稳定指纹。 / Validates identities, evidence provenance, and stable fingerprint.
    pub fn validate(&self) -> DomainResult<CanonicalFingerprint> {
        validate_uuid_v7(&self.event_id, "event_id")?;
        validate_uuid_v7(&self.deployment_id, "deployment_id")?;
        validate_uuid_v7(&self.correlation_id, "correlation_id")?;
        if self.schema_version != "1.0"
            || self.service_name.trim().is_empty()
            || self.summary.trim().is_empty()
            || self.summary.len() > 512
            || !valid_dotted_name(&self.kind)
        {
            return Err(DomainError::Validation(
                "schema_version 1.0, service_name, bounded summary, and dotted kind are required"
                    .into(),
            ));
        }
        match (self.signal, self.recovery_of_event_id.as_deref()) {
            (DiagnosticSignal::Fault, None) => {}
            (DiagnosticSignal::Recovery, Some(event_id)) => {
                validate_uuid_v7(event_id, "recovery_of_event_id")?;
            }
            _ => {
                return Err(DomainError::Validation(
                    "recovery_of_event_id is required exactly for recovery signals".into(),
                ));
            }
        }
        if let Some(instance_id) = &self.instance_id {
            uuid::Uuid::parse_str(instance_id).map_err(|_| {
                DomainError::Validation("instance_id must be a UUID when present".into())
            })?;
        }
        if self.evidence.len() > 8 {
            return Err(DomainError::Validation(
                "diagnostic may contain at most eight evidence references".into(),
            ));
        }
        if self.evidence.is_empty() && self.trace_id.is_none() {
            return Err(DomainError::Validation(
                "diagnostic requires evidence or reconstructible execution identity".into(),
            ));
        }
        for evidence in &self.evidence {
            evidence.validate()?;
        }
        for (key, value) in &self.attributes {
            if !allowed_attribute(key)
                || !matches!(value, Value::String(_) | Value::Number(_) | Value::Bool(_))
            {
                return Err(DomainError::Validation(format!(
                    "diagnostic attribute `{key}` is not an allowed scalar"
                )));
            }
        }
        if let Some(trace_id) = &self.trace_id {
            validate_w3c_id(trace_id, 32, "trace_id")?;
        }
        if let Some(span_id) = &self.span_id {
            validate_w3c_id(span_id, 16, "span_id")?;
            if self.trace_id.is_none() {
                return Err(DomainError::Validation("span_id requires trace_id".into()));
            }
        }
        canonical_fingerprint(&self.kind, &self.service_name, &self.fingerprint)
    }
}

/// 四级严重度到公开状态的显式单调映射。 / Explicit monotonic mapping from four severity levels to public status.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SeverityStatusMap {
    /// Info 映射。 / Info mapping.
    pub info: Status,
    /// Warning 映射。 / Warning mapping.
    pub warning: Status,
    /// Error 映射。 / Error mapping.
    pub error: Status,
    /// Critical 映射。 / Critical mapping.
    pub critical: Status,
}

impl SeverityStatusMap {
    fn status(&self, severity: DiagnosticSeverity) -> Status {
        match severity {
            DiagnosticSeverity::Info => self.info,
            DiagnosticSeverity::Warning => self.warning,
            DiagnosticSeverity::Error => self.error,
            DiagnosticSeverity::Critical => self.critical,
        }
    }

    fn validate(&self) -> DomainResult<()> {
        let values = [self.info, self.warning, self.error, self.critical];
        if values
            .iter()
            .any(|value| matches!(value, Status::Maintenance | Status::Unknown))
            || values
                .windows(2)
                .any(|pair| pair[0].failure_rank() > pair[1].failure_rank())
        {
            return Err(DomainError::Validation(
                "severity status mappings must be ranked and monotonic".into(),
            ));
        }
        Ok(())
    }
}

/// 不可变 Diagnostic 聚合策略。 / Immutable Diagnostic aggregation policy.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticEvaluationPolicy {
    /// 策略身份。 / Policy identity.
    pub policy_id: String,
    /// 不可变 revision。 / Immutable revision.
    pub revision: String,
    /// 确认到 `active` 所需 occurrence 数。 / Occurrences required to confirm into `active`.
    pub minimum_occurrences: u64,
    /// active Issue 解决所需的连续恢复证据数。 / Consecutive recovery evidence required to resolve an active issue.
    #[serde(default = "default_recovery_min_occurrences")]
    pub recovery_min_occurrences: u64,
    /// 显式严重度映射。 / Explicit severity mapping.
    pub status_by_severity: SeverityStatusMap,
}

impl DiagnosticEvaluationPolicy {
    /// 校验策略约束。 / Validates policy constraints.
    pub fn validate(&self) -> DomainResult<()> {
        if self.policy_id.trim().is_empty()
            || self.revision.trim().is_empty()
            || self.minimum_occurrences == 0
            || self.recovery_min_occurrences < 2
        {
            return Err(DomainError::Validation(
                "policy identity, positive minimum_occurrences, and recovery_min_occurrences >= 2 are required".into(),
            ));
        }
        self.status_by_severity.validate()
    }
}

/// 当前同指纹 Issue 的有界快照。 / Bounded snapshot of the current issue with the same fingerprint.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticIssueSnapshot {
    /// 当前指纹摘要。 / Current fingerprint digest.
    pub fingerprint_hash: String,
    /// 当前状态。 / Current state.
    pub state: IssueState,
    /// 已去重发生数。 / Deduplicated occurrence count.
    pub occurrence_count: u64,
    /// 当前因果头之后的连续恢复证据数。 / Consecutive recovery evidence after the current causal head.
    #[serde(default)]
    pub recovery_count: u64,
    /// 当前最新故障事件的不可变身份。 / Immutable identity of the current latest fault event.
    pub last_fault_event_id: Option<String>,
    /// 最新已接受恢复证据的时间。 / Time of the latest accepted recovery evidence.
    pub last_recovery_at: Option<DateTime<Utc>>,
    /// 当前最大严重度。 / Current maximum severity.
    pub severity: DiagnosticSeverity,
    /// 创建时策略 revision。 / Policy revision at creation.
    pub policy_revision: String,
    /// 当前最近发生时刻。 / Current latest occurrence instant.
    pub last_seen_at: DateTime<Utc>,
    /// 数据库乐观并发 revision。 / Database optimistic-concurrency revision.
    pub revision: u64,
}

/// Diagnostic 评估器输入。 / Input to the Diagnostic evaluator.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticEvaluationInput {
    /// 新的已去重事件。 / New, already-deduplicated event.
    pub event: DiagnosticEvent,
    /// 当前同指纹 Issue。 / Current issue with the same fingerprint.
    pub current_issue: Option<DiagnosticIssueSnapshot>,
    /// 固定 revision 策略。 / Fixed-revision policy.
    pub policy: DiagnosticEvaluationPolicy,
    /// 事务前服务直接状态。 / Service direct status before the transaction.
    pub current_service_status: Status,
    /// 平台当前 UTC 时刻。 / Platform current UTC instant.
    pub now: DateTime<Utc>,
}

/// Consumer 应在同一事务中执行的动作。 / Action the consumer should perform in the same transaction.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticAction {
    /// 创建 `observed` Issue。 / Creates an `observed` issue.
    CreateObserved,
    /// 创建并立即确认 Issue。 / Creates and immediately confirms an issue.
    CreateActive,
    /// 增加 `observed` occurrence。 / Increments an `observed` occurrence.
    IncrementObserved,
    /// 确认现有 Issue。 / Confirms an existing issue.
    Confirm,
    /// 新故障证据激活 Issue。 / New failure evidence activates the issue.
    Reactivate,
    /// 抑制期间仅记录证据。 / Records evidence while suppressed.
    RecordSuppressed,
    /// 迟到事件仅增加 occurrence，不倒退状态或时间。 / Late event only increments occurrence without regressing state or time.
    RecordOutOfOrder,
    /// 为已解决条件创建 recurrence。 / Creates a recurrence for a resolved condition.
    CreateRecurrence,
    /// 首个恢复证据使 active Issue 进入恢复观察。 / First recovery evidence moves an active issue into recovery observation.
    BeginRecovery,
    /// 足够新的恢复证据将 Issue 终结为 resolved。 / Sufficiently new recovery evidence terminates the issue as resolved.
    ResolveRecovery,
    /// 迟到或同时恢复证据仅记录，不覆盖较新故障。 / Late or simultaneous recovery evidence is recorded without overriding a newer fault.
    RecordStaleRecovery,
    /// 未匹配到未解决 Issue 的恢复证据仅记录。 / Recovery evidence without a matching unresolved issue is recorded only.
    RecordUnmatchedRecovery,
}

/// Diagnostic 聚合的确定性结果。 / Deterministic Diagnostic aggregation result.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticEvaluationResult {
    /// 规范指纹 SHA-256。 / Canonical fingerprint SHA-256.
    pub fingerprint_hash: String,
    /// 固定策略 revision。 / Fixed policy revision.
    pub policy_revision: String,
    /// 更新后的 Issue 状态。 / Updated issue state.
    pub issue_state: IssueState,
    /// 更新后的最大严重度。 / Updated maximum severity.
    pub severity: DiagnosticSeverity,
    /// 更新后的服务直接状态。 / Updated service direct status.
    pub direct_status: Status,
    /// 事务动作。 / Transaction action.
    pub action: DiagnosticAction,
    /// 更新后的 occurrence 数。 / Updated occurrence count.
    pub occurrence_count: u64,
    /// 更新后的连续恢复证据数。 / Consecutive recovery-evidence count after evaluation.
    pub recovery_count: u64,
    /// 更新后的最新恢复证据时间。 / Latest recovery-evidence time after evaluation.
    pub last_recovery_at: Option<DateTime<Utc>>,
    /// 不会因迟到事件倒退的最近时间。 / Latest time, never regressed by a late event.
    pub last_seen_at: DateTime<Utc>,
    /// 更新时必须匹配的 revision；创建时为 `None`。 / Revision that an update must match; `None` for creation.
    pub expected_revision: Option<u64>,
}

/// 以同一纯函数评估外部和 probe 产生的 Diagnostic。 / Evaluates external and probe-produced Diagnostics with the same pure function.
pub fn evaluate_diagnostic(
    input: &DiagnosticEvaluationInput,
) -> DomainResult<DiagnosticEvaluationResult> {
    input.policy.validate()?;
    let fingerprint = input.event.validate()?;
    if let Some(issue) = &input.current_issue {
        if issue.fingerprint_hash != fingerprint.hash {
            return Err(DomainError::Validation(
                "current_issue fingerprint does not match event".into(),
            ));
        }
        if issue.policy_revision != input.policy.revision {
            return Err(DomainError::Validation(
                "current_issue policy revision differs from evaluator revision".into(),
            ));
        }
        if let Some(event_id) = issue.last_fault_event_id.as_deref() {
            validate_uuid_v7(event_id, "current_issue.last_fault_event_id")?;
        }
        if (issue.recovery_count == 0) != issue.last_recovery_at.is_none() {
            return Err(DomainError::Validation(
                "current_issue recovery_count and last_recovery_at must be present together".into(),
            ));
        }
    }
    if input.event.signal == DiagnosticSignal::Recovery {
        return crate::recovery::evaluate_diagnostic_recovery(input, fingerprint.hash);
    }
    let expected_revision = input.current_issue.as_ref().map(|issue| issue.revision);
    let next_count = match &input.current_issue {
        Some(issue) => issue.occurrence_count.checked_add(1).ok_or_else(|| {
            DomainError::Validation("diagnostic occurrence_count overflow".into())
        })?,
        None => 1,
    };

    if let Some(issue) = &input.current_issue {
        if input.event.occurred_at < issue.last_seen_at {
            return Ok(DiagnosticEvaluationResult {
                fingerprint_hash: fingerprint.hash,
                policy_revision: input.policy.revision.clone(),
                issue_state: issue.state,
                severity: issue.severity,
                direct_status: input.current_service_status,
                action: DiagnosticAction::RecordOutOfOrder,
                occurrence_count: next_count,
                recovery_count: issue.recovery_count,
                last_recovery_at: issue.last_recovery_at,
                last_seen_at: issue.last_seen_at,
                expected_revision,
            });
        }
    }

    let severity = input
        .current_issue
        .as_ref()
        .map_or(input.event.severity, |issue| {
            issue.severity.max(input.event.severity)
        });
    let (issue_state, action, count) =
        decide_state(&input.policy, input.current_issue.as_ref(), next_count);
    let direct_status = if matches!(issue_state, IssueState::Active | IssueState::Recovering) {
        strongest_ranked(
            input.current_service_status,
            input.policy.status_by_severity.status(severity),
        )
    } else {
        input.current_service_status
    };
    Ok(DiagnosticEvaluationResult {
        fingerprint_hash: fingerprint.hash,
        policy_revision: input.policy.revision.clone(),
        issue_state,
        severity,
        direct_status,
        action,
        occurrence_count: count,
        recovery_count: 0,
        last_recovery_at: None,
        last_seen_at: input.event.occurred_at,
        expected_revision,
    })
}

fn decide_state(
    policy: &DiagnosticEvaluationPolicy,
    issue: Option<&DiagnosticIssueSnapshot>,
    next_count: u64,
) -> (IssueState, DiagnosticAction, u64) {
    match issue {
        None if next_count >= policy.minimum_occurrences => (
            IssueState::Active,
            DiagnosticAction::CreateActive,
            next_count,
        ),
        None => (
            IssueState::Observed,
            DiagnosticAction::CreateObserved,
            next_count,
        ),
        Some(old) if old.state == IssueState::Resolved => {
            let state = if policy.minimum_occurrences == 1 {
                IssueState::Active
            } else {
                IssueState::Observed
            };
            (state, DiagnosticAction::CreateRecurrence, 1)
        }
        Some(old) if old.state == IssueState::Suppressed => (
            IssueState::Suppressed,
            DiagnosticAction::RecordSuppressed,
            next_count,
        ),
        Some(old) if matches!(old.state, IssueState::Recovering | IssueState::Active) => {
            (IssueState::Active, DiagnosticAction::Reactivate, next_count)
        }
        Some(_) if next_count >= policy.minimum_occurrences => {
            (IssueState::Active, DiagnosticAction::Confirm, next_count)
        }
        Some(_) => (
            IssueState::Observed,
            DiagnosticAction::IncrementObserved,
            next_count,
        ),
    }
}

fn strongest_ranked(current: Status, candidate: Status) -> Status {
    match (current.failure_rank(), candidate.failure_rank()) {
        (Some(left), Some(right)) => Status::from_failure_rank(left.max(right)),
        (_, Some(_)) => candidate,
        _ => current,
    }
}

const fn default_recovery_min_occurrences() -> u64 {
    2
}

fn valid_dotted_name(value: &str) -> bool {
    !value.is_empty()
        && value.split('.').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
        })
}

fn allowed_attribute(key: &str) -> bool {
    matches!(
        key,
        "dependency.name"
            | "operation.name"
            | "error.type"
            | "component.id"
            | "cloud.region"
            | "http.request.method"
            | "http.response.status_code"
            | "rpc.system"
            | "db.system.name"
            | "deployment.environment.name"
    )
}

fn validate_w3c_id(value: &str, length: usize, field: &str) -> DomainResult<()> {
    if value.len() != length
        || value.bytes().all(|byte| byte == b'0')
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        Err(DomainError::Validation(format!(
            "{field} must be non-zero lowercase {length}-character hex"
        )))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use chrono::{Duration, TimeZone};
    use serde_json::json;

    use super::*;

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 9, 8, 15, 0, 0).unwrap()
    }

    fn event() -> DiagnosticEvent {
        DiagnosticEvent {
            event_id: "0199d0a8-2e12-7a59-a51e-44aa9b6d1001".into(),
            schema_version: "1.0".into(),
            kind: "dependency.unavailable".into(),
            signal: DiagnosticSignal::Fault,
            recovery_of_event_id: None,
            severity: DiagnosticSeverity::Error,
            service_name: "identity".into(),
            environment: Environment::Production,
            deployment_id: "0199d09a-b692-7ce0-a1c0-5138a43d7402".into(),
            instance_id: None,
            occurred_at: now(),
            correlation_id: "0199d0a7-d771-7435-a388-bb6fa5d533fc".into(),
            trace_id: Some("4bf92f3577b34da6a3ce929d0e0e4736".into()),
            span_id: None,
            summary: "D1 unavailable".into(),
            fingerprint: json!({"dependency":"d1"}),
            evidence: vec![],
            attributes: BTreeMap::new(),
        }
    }

    fn policy() -> DiagnosticEvaluationPolicy {
        DiagnosticEvaluationPolicy {
            policy_id: "default".into(),
            revision: "1".into(),
            minimum_occurrences: 2,
            recovery_min_occurrences: 2,
            status_by_severity: SeverityStatusMap {
                info: Status::Operational,
                warning: Status::Degraded,
                error: Status::PartialOutage,
                critical: Status::MajorOutage,
            },
        }
    }

    #[test]
    fn confirmation_and_out_of_order_are_deterministic() {
        let event = event();
        let hash = event.validate().unwrap().hash;
        let input = DiagnosticEvaluationInput {
            event: event.clone(),
            current_issue: Some(DiagnosticIssueSnapshot {
                fingerprint_hash: hash,
                state: IssueState::Observed,
                occurrence_count: 1,
                recovery_count: 0,
                last_fault_event_id: Some(event.event_id.clone()),
                last_recovery_at: None,
                severity: DiagnosticSeverity::Warning,
                policy_revision: "1".into(),
                last_seen_at: now(),
                revision: 7,
            }),
            policy: policy(),
            current_service_status: Status::Operational,
            now: now(),
        };
        let confirmed = evaluate_diagnostic(&input).unwrap();
        assert_eq!(confirmed.action, DiagnosticAction::Confirm);
        assert_eq!(confirmed.direct_status, Status::PartialOutage);

        let mut late = input;
        late.event.occurred_at = now() - Duration::seconds(1);
        let ignored = evaluate_diagnostic(&late).unwrap();
        assert_eq!(ignored.action, DiagnosticAction::RecordOutOfOrder);
        assert_eq!(ignored.issue_state, IssueState::Observed);
        assert_eq!(ignored.last_seen_at, now());
    }

    #[test]
    fn recovery_requires_current_fault_head_and_never_counts_occurrence() {
        let fault = event();
        let hash = fault.validate().unwrap().hash;
        let mut recovery = fault.clone();
        recovery.event_id = "0199d0a8-2e12-7a59-a51e-44aa9b6d1002".into();
        recovery.signal = DiagnosticSignal::Recovery;
        recovery.recovery_of_event_id = Some(fault.event_id.clone());
        recovery.occurred_at = now() + Duration::seconds(1);
        let first = evaluate_diagnostic(&DiagnosticEvaluationInput {
            event: recovery.clone(),
            current_issue: Some(DiagnosticIssueSnapshot {
                fingerprint_hash: hash.clone(),
                state: IssueState::Active,
                occurrence_count: 7,
                recovery_count: 0,
                last_fault_event_id: Some(fault.event_id.clone()),
                last_recovery_at: None,
                severity: DiagnosticSeverity::Error,
                policy_revision: "1".into(),
                last_seen_at: now(),
                revision: 4,
            }),
            policy: policy(),
            current_service_status: Status::PartialOutage,
            now: now() + Duration::seconds(2),
        })
        .unwrap();
        assert_eq!(first.action, DiagnosticAction::BeginRecovery);
        assert_eq!(first.issue_state, IssueState::Recovering);
        assert_eq!(first.occurrence_count, 7);
        assert_eq!(first.recovery_count, 1);

        recovery.event_id = "0199d0a8-2e12-7a59-a51e-44aa9b6d1003".into();
        recovery.occurred_at = now() + Duration::seconds(2);
        let resolved = evaluate_diagnostic(&DiagnosticEvaluationInput {
            event: recovery.clone(),
            current_issue: Some(DiagnosticIssueSnapshot {
                fingerprint_hash: hash.clone(),
                state: IssueState::Recovering,
                occurrence_count: 7,
                recovery_count: 1,
                last_fault_event_id: Some(fault.event_id.clone()),
                last_recovery_at: first.last_recovery_at,
                severity: DiagnosticSeverity::Error,
                policy_revision: "1".into(),
                last_seen_at: now(),
                revision: 5,
            }),
            policy: policy(),
            current_service_status: Status::PartialOutage,
            now: now() + Duration::seconds(3),
        })
        .unwrap();
        assert_eq!(resolved.action, DiagnosticAction::ResolveRecovery);
        assert_eq!(resolved.issue_state, IssueState::Resolved);
        assert_eq!(resolved.occurrence_count, 7);

        recovery.recovery_of_event_id = Some("0199d0a8-2e12-7a59-a51e-44aa9b6d1999".into());
        let stale = evaluate_diagnostic(&DiagnosticEvaluationInput {
            event: recovery,
            current_issue: Some(DiagnosticIssueSnapshot {
                fingerprint_hash: hash,
                state: IssueState::Active,
                occurrence_count: 8,
                recovery_count: 0,
                last_fault_event_id: Some(fault.event_id),
                last_recovery_at: None,
                severity: DiagnosticSeverity::Error,
                policy_revision: "1".into(),
                last_seen_at: now(),
                revision: 6,
            }),
            policy: policy(),
            current_service_status: Status::PartialOutage,
            now: now() + Duration::seconds(3),
        })
        .unwrap();
        assert_eq!(stale.action, DiagnosticAction::RecordStaleRecovery);
        assert_eq!(stale.occurrence_count, 8);
        assert_eq!(stale.issue_state, IssueState::Active);
    }
}

//! Issue、Incident 与公开状态机。 / Issue, incident, and public status machines.

use std::collections::BTreeSet;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::{DomainError, DomainResult};

/// 服务或组件的公开状态。 / Public status of a service or component.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// 新鲜且充分的证据证明能力正常。 / Fresh, sufficient evidence proves the capability healthy.
    Operational,
    /// 能力可用但偏离契约。 / Capability remains usable but deviates from its contract.
    Degraded,
    /// 部分区域、请求或子能力不可用。 / Some regions, requests, or sub-capabilities are unavailable.
    PartialOutage,
    /// 核心能力不可用或正确性无保证。 / Core capability is unavailable or correctness is uncertain.
    MajorOutage,
    /// 影响由当前维护窗口覆盖。 / Impact is covered by an active maintenance window.
    Maintenance,
    /// 证据缺失、过期或冲突。 / Evidence is missing, stale, or contradictory.
    #[default]
    Unknown,
}

impl Status {
    /// 返回可排序的故障等级；维护与未知不可排序。 / Returns an ordered failure rank; maintenance and unknown are unranked.
    pub(crate) const fn failure_rank(self) -> Option<u8> {
        match self {
            Self::Operational => Some(0),
            Self::Degraded => Some(1),
            Self::PartialOutage => Some(2),
            Self::MajorOutage => Some(3),
            Self::Maintenance | Self::Unknown => None,
        }
    }

    /// 将状态限制在依赖边允许造成的最大影响内。 / Clamps a status to the maximum impact allowed by a dependency edge.
    pub(crate) fn clamp_failure(self, maximum: Self) -> Self {
        match (self.failure_rank(), maximum.failure_rank()) {
            (Some(actual), Some(cap)) => Self::from_failure_rank(actual.min(cap)),
            _ => self,
        }
    }

    pub(crate) const fn from_failure_rank(rank: u8) -> Self {
        match rank {
            0 => Self::Operational,
            1 => Self::Degraded,
            2 => Self::PartialOutage,
            _ => Self::MajorOutage,
        }
    }
}

/// 机器聚合 Issue 的生命周期状态。 / Lifecycle state of a machine-aggregated issue.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IssueState {
    /// 尚未满足确认策略。 / Confirmation policy has not yet been met.
    Observed,
    /// 条件已确认并影响状态。 / Condition is confirmed and affects status.
    Active,
    /// 恢复证据已开始但尚未满足门槛。 / Recovery evidence has begun but has not met its threshold.
    Recovering,
    /// 证据保留但公开影响被抑制。 / Evidence is retained while public impact is suppressed.
    Suppressed,
    /// 终态；同指纹复发必须创建新 Issue。 / Terminal state; recurrence must create a new issue.
    Resolved,
}

/// Issue 状态机命令。 / Command accepted by the issue state machine.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum IssueCommand {
    /// 确认观察到的条件。 / Confirms an observed condition.
    Confirm,
    /// 标记恢复证据开始。 / Marks the start of recovery evidence.
    BeginRecovery,
    /// 标记恢复期间故障返回。 / Marks failure returning during recovery.
    FailureReturned,
    /// 抑制至严格晚于当前时间的时刻。 / Suppresses until an instant strictly after the command time.
    Suppress {
        /// 抑制到期时刻。 / Suppression expiry.
        until: DateTime<Utc>,
        /// 可审计理由。 / Auditable rationale.
        reason: String,
    },
    /// 抑制到期且条件仍存在。 / Suppression expired while the condition still exists.
    SuppressionExpired,
    /// 条件消失并进入不可重开终态。 / Condition cleared and enters the non-reopenable terminal state.
    Resolve,
}

/// 相同诊断条件的机器聚合事实。 / Machine aggregation of the same diagnostic condition.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Issue {
    /// UUIDv7 Issue 身份。 / UUIDv7 issue identity.
    pub issue_id: String,
    /// 规范指纹的 SHA-256 十六进制。 / SHA-256 hex of the canonical fingerprint.
    pub fingerprint_hash: String,
    /// OpenTelemetry `service.name`。 / OpenTelemetry `service.name`.
    pub service_name: String,
    /// 稳定的小写点分诊断类别。 / Stable lowercase dotted diagnostic kind.
    pub kind: String,
    /// 公开影响映射。 / Public impact mapping.
    pub impact: Status,
    /// 当前生命周期状态。 / Current lifecycle state.
    pub state: IssueState,
    /// 首次观察时刻。 / First observed instant.
    pub first_seen_at: DateTime<Utc>,
    /// 最近观察时刻。 / Most recent observed instant.
    pub last_seen_at: DateTime<Utc>,
    /// 幂等去重后的发生次数。 / Occurrence count after idempotent deduplication.
    pub occurrence_count: u64,
    /// 产生本 Issue 的不可变策略 revision。 / Immutable policy revision that produced this issue.
    pub policy_revision: String,
    /// 若为复发则指向前一已解决 Issue。 / Previous resolved issue when this is a recurrence.
    pub recurrence_of: Option<String>,
    /// 当前抑制的到期时刻。 / Expiry of the current suppression.
    pub suppressed_until: Option<DateTime<Utc>>,
    /// 乐观并发 revision。 / Optimistic-concurrency revision.
    pub revision: u64,
}

impl Issue {
    /// 创建 `observed` Issue；调用者应先验证身份和指纹。 / Creates an `observed` issue; the caller should validate identity and fingerprint first.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        issue_id: String,
        fingerprint_hash: String,
        service_name: String,
        kind: String,
        impact: Status,
        policy_revision: String,
        observed_at: DateTime<Utc>,
        recurrence_of: Option<String>,
    ) -> DomainResult<Self> {
        if impact.failure_rank().is_none() || impact == Status::Operational {
            return Err(DomainError::Validation(
                "issue impact must be degraded, partial_outage, or major_outage".into(),
            ));
        }
        if service_name.trim().is_empty()
            || kind.trim().is_empty()
            || policy_revision.trim().is_empty()
        {
            return Err(DomainError::Validation(
                "service_name, kind, and policy_revision must be non-empty".into(),
            ));
        }
        Ok(Self {
            issue_id,
            fingerprint_hash,
            service_name,
            kind,
            impact,
            state: IssueState::Observed,
            first_seen_at: observed_at,
            last_seen_at: observed_at,
            occurrence_count: 1,
            policy_revision,
            recurrence_of,
            suppressed_until: None,
            revision: 1,
        })
    }

    /// 记录一个已去重 occurrence，不改变状态机。 / Records one already-deduplicated occurrence without changing the state machine.
    pub fn record_occurrence(&mut self, observed_at: DateTime<Utc>) -> DomainResult<()> {
        if self.state == IssueState::Resolved {
            return Err(DomainError::InvalidTransition(
                "resolved issue cannot receive another occurrence; create a recurrence".into(),
            ));
        }
        self.last_seen_at = self.last_seen_at.max(observed_at);
        self.occurrence_count = self
            .occurrence_count
            .checked_add(1)
            .ok_or_else(|| DomainError::Validation("issue occurrence_count overflow".into()))?;
        self.revision = self
            .revision
            .checked_add(1)
            .ok_or_else(|| DomainError::Validation("issue revision overflow".into()))?;
        Ok(())
    }

    /// 以乐观并发检查执行合法迁移。 / Applies a legal transition with optimistic-concurrency checking.
    pub fn apply(
        &mut self,
        expected_revision: u64,
        command: IssueCommand,
        at: DateTime<Utc>,
    ) -> DomainResult<()> {
        if self.revision != expected_revision {
            return Err(DomainError::RevisionConflict(format!(
                "expected {expected_revision}, current {}",
                self.revision
            )));
        }

        let (next, suppression) = match (self.state, command) {
            (IssueState::Observed, IssueCommand::Confirm) => (IssueState::Active, None),
            (IssueState::Observed, IssueCommand::Resolve)
            | (IssueState::Recovering, IssueCommand::Resolve)
            | (IssueState::Suppressed, IssueCommand::Resolve) => (IssueState::Resolved, None),
            (IssueState::Active, IssueCommand::BeginRecovery) => (IssueState::Recovering, None),
            (IssueState::Recovering, IssueCommand::FailureReturned) => (IssueState::Active, None),
            (IssueState::Suppressed, IssueCommand::SuppressionExpired) => {
                if self.suppressed_until.is_some_and(|until| at < until) {
                    return Err(DomainError::InvalidTransition(
                        "suppression cannot expire before suppressed_until".into(),
                    ));
                }
                (IssueState::Active, None)
            }
            (IssueState::Active, IssueCommand::Suppress { until, reason }) => {
                if until <= at || reason.trim().is_empty() {
                    return Err(DomainError::Validation(
                        "suppression requires a future expiry and non-empty reason".into(),
                    ));
                }
                (IssueState::Suppressed, Some(until))
            }
            (state, command) => {
                return Err(DomainError::InvalidTransition(format!(
                    "issue {state:?} cannot apply {command:?}"
                )))
            }
        };

        self.state = next;
        self.suppressed_until = suppression;
        self.last_seen_at = self.last_seen_at.max(at);
        self.revision = self
            .revision
            .checked_add(1)
            .ok_or_else(|| DomainError::Validation("issue revision overflow".into()))?;
        Ok(())
    }
}

/// 面向用户的 Incident 影响等级。 / User-facing incident impact.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IncidentImpact {
    /// 性能或部分功能偏离契约。 / Performance or some functionality deviates from contract.
    Degraded,
    /// 部分能力不可用。 / Part of the capability is unavailable.
    PartialOutage,
    /// 核心能力整体不可用。 / Core capability is broadly unavailable.
    MajorOutage,
}

impl From<IncidentImpact> for Status {
    fn from(value: IncidentImpact) -> Self {
        match value {
            IncidentImpact::Degraded => Self::Degraded,
            IncidentImpact::PartialOutage => Self::PartialOutage,
            IncidentImpact::MajorOutage => Self::MajorOutage,
        }
    }
}

/// Incident 协作生命周期。 / Incident collaboration lifecycle.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IncidentState {
    /// 正在调查。 / Investigation is in progress.
    Investigating,
    /// 原因或修复路径已识别。 / Cause or remediation path is identified.
    Identified,
    /// 修复后正在观察。 / Remediation is being monitored.
    Monitoring,
    /// 终态：影响已完全恢复。 / Terminal state: impact is fully recovered.
    Resolved,
}

/// 会产生不可变 `IncidentUpdate` 的命令。 / Command that produces an immutable `IncidentUpdate`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum IncidentCommand {
    /// 将原因识别并可选写入已确认原因。 / Marks the cause identified and optionally records it.
    Identify {
        /// 已确认原因。 / Confirmed cause.
        cause: Option<String>,
    },
    /// 进入恢复观察。 / Enters recovery monitoring.
    Monitor,
    /// 观察期间回归到调查。 / Regresses from monitoring to investigation.
    Regress,
    /// 标记完全恢复。 / Marks complete recovery.
    Resolve,
    /// 修改公开影响。 / Changes public impact.
    ChangeImpact {
        /// 新影响等级。 / New impact level.
        impact: IncidentImpact,
    },
    /// 修改稳定标题。 / Changes the stable title.
    Rename {
        /// 非空新标题。 / Non-empty new title.
        title: String,
    },
    /// 设置或清除已确认原因。 / Sets or clears the confirmed cause.
    SetCause {
        /// 新原因；`None` 表示尚未确认。 / New cause; `None` means unconfirmed.
        cause: Option<String>,
    },
    /// 原子替换受影响组件集合。 / Atomically replaces affected components.
    ReplaceAffectedComponents {
        /// 去重前组件身份。 / Component identities before deduplication.
        components: Vec<String>,
    },
    /// 关联一个证据 Issue。 / Links an evidence issue.
    LinkIssue {
        /// Issue 身份。 / Issue identity.
        issue_id: String,
    },
    /// 解除一个证据 Issue。 / Unlinks an evidence issue.
    UnlinkIssue {
        /// Issue 身份。 / Issue identity.
        issue_id: String,
    },
}

/// Incident 当前可变快照。 / Current mutable snapshot of an incident.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Incident {
    /// UUIDv7 Incident 身份。 / UUIDv7 incident identity.
    pub incident_id: String,
    /// 面向人的稳定标题。 / Stable human-facing title.
    pub title: String,
    /// 当前协作状态。 / Current collaboration state.
    pub state: IncidentState,
    /// 当前公开影响。 / Current public impact.
    pub impact: IncidentImpact,
    /// 实际影响开始时间。 / Actual impact start time.
    pub started_at: DateTime<Utc>,
    /// 平台发现时间。 / Platform detection time.
    pub detected_at: DateTime<Utc>,
    /// 完全恢复时间，仅终态存在。 / Full recovery time, present only in terminal state.
    pub resolved_at: Option<DateTime<Utc>>,
    /// 已排序且去重的受影响组件。 / Sorted, deduplicated affected components.
    pub affected_components: BTreeSet<String>,
    /// 已排序且去重的证据 Issue。 / Sorted, deduplicated evidence issues.
    pub issue_ids: BTreeSet<String>,
    /// 已确认原因。 / Confirmed cause.
    pub cause: Option<String>,
    /// 乐观并发及 update 序号。 / Optimistic-concurrency and update sequence.
    pub revision: u64,
}

/// 一条不可变 Incident 时间线记录。 / One immutable incident timeline record.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IncidentUpdate {
    /// 所属 Incident。 / Owning incident.
    pub incident_id: String,
    /// 单调且无间隙的序号。 / Monotonic, gap-free sequence.
    pub sequence: u64,
    /// 操作发生时间。 / Operation time.
    pub occurred_at: DateTime<Utc>,
    /// 形成该记录的命令。 / Command that produced this record.
    pub command: IncidentCommand,
    /// 命令执行后的状态。 / State after applying the command.
    pub resulting_state: IncidentState,
}

impl Incident {
    /// 创建 `investigating` Incident。 / Creates an `investigating` incident.
    pub fn new(
        incident_id: String,
        title: String,
        impact: IncidentImpact,
        started_at: DateTime<Utc>,
        detected_at: DateTime<Utc>,
        affected_components: impl IntoIterator<Item = String>,
        issue_ids: impl IntoIterator<Item = String>,
    ) -> DomainResult<Self> {
        if title.trim().is_empty() || detected_at < started_at {
            return Err(DomainError::Validation(
                "incident title must be non-empty and detected_at must not precede started_at"
                    .into(),
            ));
        }
        let affected_components = collect_non_empty(affected_components, "component")?;
        let issue_ids = collect_non_empty(issue_ids, "issue_id")?;
        Ok(Self {
            incident_id,
            title,
            state: IncidentState::Investigating,
            impact,
            started_at,
            detected_at,
            resolved_at: None,
            affected_components,
            issue_ids,
            cause: None,
            revision: 1,
        })
    }

    /// 应用命令并返回必须追加保存的更新。 / Applies a command and returns the update that must be appended.
    pub fn apply(
        &mut self,
        expected_revision: u64,
        command: IncidentCommand,
        at: DateTime<Utc>,
    ) -> DomainResult<IncidentUpdate> {
        if self.revision != expected_revision {
            return Err(DomainError::RevisionConflict(format!(
                "expected {expected_revision}, current {}",
                self.revision
            )));
        }
        if self.state == IncidentState::Resolved
            && matches!(
                &command,
                IncidentCommand::Identify { .. }
                    | IncidentCommand::Monitor
                    | IncidentCommand::Regress
                    | IncidentCommand::Resolve
            )
        {
            return Err(DomainError::InvalidTransition(
                "resolved incident cannot reenter a lifecycle state".into(),
            ));
        }

        match &command {
            IncidentCommand::Identify { cause } => {
                require_state(self.state, &[IncidentState::Investigating], "identify")?;
                validate_optional_text(cause, "cause")?;
                self.state = IncidentState::Identified;
                self.cause.clone_from(cause);
            }
            IncidentCommand::Monitor => {
                require_state(
                    self.state,
                    &[IncidentState::Investigating, IncidentState::Identified],
                    "monitor",
                )?;
                self.state = IncidentState::Monitoring;
            }
            IncidentCommand::Regress => {
                require_state(self.state, &[IncidentState::Monitoring], "regress")?;
                self.state = IncidentState::Investigating;
            }
            IncidentCommand::Resolve => {
                require_state(
                    self.state,
                    &[IncidentState::Identified, IncidentState::Monitoring],
                    "resolve",
                )?;
                if at < self.started_at {
                    return Err(DomainError::Validation(
                        "resolved_at cannot precede started_at".into(),
                    ));
                }
                self.state = IncidentState::Resolved;
                self.resolved_at = Some(at);
            }
            IncidentCommand::ChangeImpact { impact } => self.impact = *impact,
            IncidentCommand::Rename { title } => {
                if title.trim().is_empty() {
                    return Err(DomainError::Validation("title must be non-empty".into()));
                }
                self.title.clone_from(title);
            }
            IncidentCommand::SetCause { cause } => {
                validate_optional_text(cause, "cause")?;
                self.cause.clone_from(cause);
            }
            IncidentCommand::ReplaceAffectedComponents { components } => {
                self.affected_components =
                    collect_non_empty(components.iter().cloned(), "component")?;
            }
            IncidentCommand::LinkIssue { issue_id } => {
                require_non_empty(issue_id, "issue_id")?;
                self.issue_ids.insert(issue_id.clone());
            }
            IncidentCommand::UnlinkIssue { issue_id } => {
                require_non_empty(issue_id, "issue_id")?;
                self.issue_ids.remove(issue_id);
            }
        }

        self.revision = self
            .revision
            .checked_add(1)
            .ok_or_else(|| DomainError::Validation("incident revision overflow".into()))?;
        Ok(IncidentUpdate {
            incident_id: self.incident_id.clone(),
            sequence: self.revision,
            occurred_at: at,
            command,
            resulting_state: self.state,
        })
    }
}

fn require_state(
    current: IncidentState,
    allowed: &[IncidentState],
    action: &str,
) -> DomainResult<()> {
    if allowed.contains(&current) {
        Ok(())
    } else {
        Err(DomainError::InvalidTransition(format!(
            "incident {current:?} cannot {action}"
        )))
    }
}

fn validate_optional_text(value: &Option<String>, field: &str) -> DomainResult<()> {
    if value.as_ref().is_some_and(|text| text.trim().is_empty()) {
        Err(DomainError::Validation(format!(
            "{field} must be non-empty when present"
        )))
    } else {
        Ok(())
    }
}

fn require_non_empty(value: &str, field: &str) -> DomainResult<()> {
    if value.trim().is_empty() {
        Err(DomainError::Validation(format!(
            "{field} must be non-empty"
        )))
    } else {
        Ok(())
    }
}

fn collect_non_empty(
    values: impl IntoIterator<Item = String>,
    field: &str,
) -> DomainResult<BTreeSet<String>> {
    let values: BTreeSet<_> = values.into_iter().collect();
    if values.iter().any(|value| value.trim().is_empty()) {
        return Err(DomainError::Validation(format!(
            "{field} entries must be non-empty"
        )));
    }
    Ok(values)
}

#[cfg(test)]
mod tests {
    use chrono::{Duration, TimeZone};

    use super::*;

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 9, 8, 15, 0, 0).unwrap()
    }

    fn issue() -> Issue {
        Issue::new(
            "i".into(),
            "f".into(),
            "identity".into(),
            "dependency.unavailable".into(),
            Status::Degraded,
            "p1".into(),
            now(),
            None,
        )
        .unwrap()
    }

    #[test]
    fn issue_follows_declared_machine_and_never_reopens() {
        let mut issue = issue();
        issue.apply(1, IssueCommand::Confirm, now()).unwrap();
        issue.apply(2, IssueCommand::BeginRecovery, now()).unwrap();
        issue.apply(3, IssueCommand::Resolve, now()).unwrap();
        assert_eq!(issue.state, IssueState::Resolved);
        assert!(issue.apply(4, IssueCommand::Confirm, now()).is_err());
        assert!(issue.record_occurrence(now()).is_err());
    }

    #[test]
    fn suppression_requires_expiry_and_condition_reactivates() {
        let mut issue = issue();
        issue.apply(1, IssueCommand::Confirm, now()).unwrap();
        issue
            .apply(
                2,
                IssueCommand::Suppress {
                    until: now() + Duration::hours(1),
                    reason: "planned work".into(),
                },
                now(),
            )
            .unwrap();
        issue
            .apply(
                3,
                IssueCommand::SuppressionExpired,
                now() + Duration::hours(1),
            )
            .unwrap();
        assert_eq!(issue.state, IssueState::Active);
    }

    #[test]
    fn incident_emits_one_update_for_every_change() {
        let mut incident = Incident::new(
            "inc".into(),
            "Login failures".into(),
            IncidentImpact::Degraded,
            now(),
            now(),
            ["login".into()],
            ["issue".into()],
        )
        .unwrap();
        let update = incident.apply(1, IncidentCommand::Monitor, now()).unwrap();
        assert_eq!(update.sequence, 2);
        assert_eq!(incident.state, IncidentState::Monitoring);
        incident.apply(2, IncidentCommand::Regress, now()).unwrap();
        assert_eq!(incident.state, IncidentState::Investigating);
    }

    #[test]
    fn optimistic_revision_rejects_stale_writer_without_mutation() {
        let mut issue = issue();
        let before = issue.clone();
        assert!(matches!(
            issue.apply(9, IssueCommand::Confirm, now()),
            Err(DomainError::RevisionConflict(_))
        ));
        assert_eq!(issue, before);
    }
}

//! 有界窗口评估、迟滞与公开状态聚合。 / Bounded-window evaluation, hysteresis, and public status aggregation.

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

use crate::{DomainError, DomainResult};
use crate::{IssueState, Status};

/// 一个精确的有理数阈值，避免跨原生/Wasm 浮点漂移。 / An exact rational threshold that avoids native/Wasm floating-point drift.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Ratio {
    /// 分子。 / Numerator.
    pub numerator: u32,
    /// 非零分母。 / Non-zero denominator.
    pub denominator: u32,
}

impl Ratio {
    /// 判断 `part / total >= self`，使用扩宽整数避免舍入。 / Tests `part / total >= self` using widened integers without rounding.
    fn at_least(self, part: u32, total: u32) -> bool {
        u128::from(part) * u128::from(self.denominator)
            >= u128::from(total) * u128::from(self.numerator)
    }

    /// 判断 `part / total <= self`。 / Tests `part / total <= self`.
    fn at_most(self, part: u32, total: u32) -> bool {
        u128::from(part) * u128::from(self.denominator)
            <= u128::from(total) * u128::from(self.numerator)
    }

    fn validate(self, name: &str) -> DomainResult<()> {
        if self.denominator == 0 || self.numerator > self.denominator {
            Err(DomainError::Validation(format!(
                "{name} must be a ratio in [0, 1] with a non-zero denominator"
            )))
        } else {
            Ok(())
        }
    }
}

/// 多位置投票要求。 / Multi-location voting requirements.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Quorum {
    /// 形成任何结论所需的新鲜位置数。 / Fresh locations required for any conclusion.
    pub minimum_locations: u32,
    /// 进入故障所需的故障位置数。 / Failing locations required to enter failure.
    pub failure_locations: u32,
    /// 从故障恢复所需的健康位置数。 / Healthy locations required to recover from failure.
    pub recovery_locations: u32,
}

/// 不可变评估策略 revision。 / Immutable evaluation policy revision.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvaluationPolicy {
    /// 不可变 revision 身份。 / Immutable revision identity.
    pub revision: String,
    /// 滚动窗口宽度（秒）。 / Rolling-window width in seconds.
    pub window_seconds: i64,
    /// 每个位置在窗口内的最小样本数。 / Minimum samples per location in the window.
    pub minimum_samples: u32,
    /// 健康状态进入故障的坏样本比例。 / Bad-sample ratio for entering failure while healthy.
    pub failure_threshold: Ratio,
    /// 故障状态恢复所允许的最大坏样本比例。 / Maximum bad-sample ratio allowed when recovering.
    pub recovery_threshold: Ratio,
    /// 可选延迟上限；窗口汇总器必须将超限成功请求计入 `unhealthy_count`。 / Optional latency limit; the window aggregator must include slow successes in `unhealthy_count`.
    pub latency_threshold_ms: Option<u64>,
    /// 最新样本超过此秒数即为过期。 / Latest sample becomes stale after this many seconds.
    pub stale_after_seconds: i64,
    /// 多位置仲裁参数。 / Multi-location quorum parameters.
    pub quorum: Quorum,
    /// 故障映射的公开状态。 / Public status mapped from failure.
    pub failure_status: Status,
}

impl EvaluationPolicy {
    /// 校验策略自身不变量。 / Validates invariants intrinsic to the policy.
    pub fn validate(&self) -> DomainResult<()> {
        if self.revision.trim().is_empty()
            || self.window_seconds <= 0
            || self.stale_after_seconds <= 0
            || self.minimum_samples == 0
        {
            return Err(DomainError::Validation(
                "revision must be non-empty and durations/sample count must be positive".into(),
            ));
        }
        self.failure_threshold.validate("failure_threshold")?;
        self.recovery_threshold.validate("recovery_threshold")?;
        if u128::from(self.failure_threshold.numerator)
            * u128::from(self.recovery_threshold.denominator)
            < u128::from(self.recovery_threshold.numerator)
                * u128::from(self.failure_threshold.denominator)
        {
            return Err(DomainError::Validation(
                "failure_threshold must be greater than or equal to recovery_threshold".into(),
            ));
        }
        let quorum = self.quorum;
        if quorum.minimum_locations == 0
            || quorum.failure_locations == 0
            || quorum.recovery_locations == 0
            || quorum.failure_locations > quorum.minimum_locations
            || quorum.recovery_locations > quorum.minimum_locations
        {
            return Err(DomainError::Validation(
                "location quorum values must be non-zero and not exceed minimum_locations".into(),
            ));
        }
        if !matches!(
            self.failure_status,
            Status::Degraded | Status::PartialOutage | Status::MajorOutage
        ) {
            return Err(DomainError::Validation(
                "failure_status must be a ranked failure status".into(),
            ));
        }
        Ok(())
    }
}

/// 一个位置的有界滚动窗口汇总；不是 Observation 历史。 / Bounded rolling-window summary for one location; not observation history.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LocationWindow {
    /// Probe 执行位置。 / Probe execution location.
    pub location: String,
    /// 当前策略窗口开始。 / Start of the current policy window.
    pub window_started_at: DateTime<Utc>,
    /// 窗口内总样本数。 / Total samples in the window.
    pub sample_count: u32,
    /// 失败、超时、无效或超过延迟阈值的去重样本数。 / Deduplicated samples that failed, timed out, were invalid, or exceeded the latency threshold.
    pub unhealthy_count: u32,
    /// 最近样本时刻。 / Most recent sample time.
    pub last_observed_at: Option<DateTime<Utc>>,
}

/// 评估器的迟滞状态。 / Hysteretic evaluator state.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvaluationState {
    /// 有充分证据证明健康。 / Sufficient evidence proves health.
    Healthy,
    /// 有充分证据证明故障。 / Sufficient evidence proves failure.
    Failing,
    /// 无法可靠判断。 / No reliable determination can be made.
    #[default]
    Unknown,
}

/// 评估结果的主要原因。 / Primary reason for an evaluation result.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvaluationReason {
    /// 达到进入故障的多位置门槛。 / Multi-location failure threshold was met.
    FailureQuorumMet,
    /// 达到恢复门槛。 / Recovery threshold was met.
    RecoveryQuorumMet,
    /// 灰区中由迟滞保持上一状态。 / Hysteresis retained the prior state in the gray zone.
    HysteresisHeld,
    /// 新鲜位置不足。 / There were too few fresh locations.
    InsufficientFreshLocations,
    /// 窗口样本不足。 / Window sample counts were insufficient.
    InsufficientSamples,
}

/// 可重放的 monitor 评估结果。 / Replayable monitor evaluation result.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvaluationResult {
    /// 策略 revision。 / Policy revision.
    pub policy_revision: String,
    /// 新评估状态。 / New evaluator state.
    pub state: EvaluationState,
    /// 映射后的公开状态。 / Mapped public status.
    pub status: Status,
    /// 主要判定原因。 / Primary decision reason.
    pub reason: EvaluationReason,
    /// 参与投票的新鲜且充分位置数。 / Fresh, sufficiently sampled locations participating in the vote.
    pub eligible_locations: u32,
    /// 达到故障门槛的位置数。 / Locations meeting the failure threshold.
    pub failing_locations: u32,
    /// 达到恢复门槛的位置数。 / Locations meeting the recovery threshold.
    pub recovering_locations: u32,
    /// 本结果必须在此时刻前重新评估。 / Instant before which this result must be reevaluated.
    pub fresh_until: Option<DateTime<Utc>>,
}

/// 从有界位置窗口评估一个 monitor。 / Evaluates one monitor from bounded per-location windows.
pub fn evaluate_monitor(
    policy: &EvaluationPolicy,
    previous: EvaluationState,
    locations: &[LocationWindow],
    now: DateTime<Utc>,
) -> DomainResult<EvaluationResult> {
    policy.validate()?;
    let window_start = now - Duration::seconds(policy.window_seconds);
    let stale_cutoff = now - Duration::seconds(policy.stale_after_seconds);
    let mut eligible = 0_u32;
    let mut failing = 0_u32;
    let mut recovering = 0_u32;
    let mut fresh_until: Option<DateTime<Utc>> = None;
    let mut fresh_but_small = false;

    for location in locations {
        if location.location.trim().is_empty()
            || location.unhealthy_count > location.sample_count
            || location.window_started_at > now
        {
            return Err(DomainError::Validation(
                "location windows require a name, valid counts, and non-future start".into(),
            ));
        }
        let Some(last) = location.last_observed_at else {
            continue;
        };
        if last > now {
            return Err(DomainError::Validation(
                "last_observed_at cannot be in the future".into(),
            ));
        }
        if last < stale_cutoff || location.window_started_at < window_start {
            continue;
        }
        let expiry = last + Duration::seconds(policy.stale_after_seconds);
        fresh_until = Some(fresh_until.map_or(expiry, |current| current.min(expiry)));
        if location.sample_count < policy.minimum_samples {
            fresh_but_small = true;
            continue;
        }
        eligible += 1;
        if policy
            .failure_threshold
            .at_least(location.unhealthy_count, location.sample_count)
        {
            failing += 1;
        }
        if policy
            .recovery_threshold
            .at_most(location.unhealthy_count, location.sample_count)
        {
            recovering += 1;
        }
    }

    let enough = eligible >= policy.quorum.minimum_locations;
    let (state, reason) = if !enough {
        (
            EvaluationState::Unknown,
            if fresh_but_small {
                EvaluationReason::InsufficientSamples
            } else {
                EvaluationReason::InsufficientFreshLocations
            },
        )
    } else if failing >= policy.quorum.failure_locations {
        (EvaluationState::Failing, EvaluationReason::FailureQuorumMet)
    } else if previous == EvaluationState::Failing {
        if recovering >= policy.quorum.recovery_locations {
            (
                EvaluationState::Healthy,
                EvaluationReason::RecoveryQuorumMet,
            )
        } else {
            (EvaluationState::Failing, EvaluationReason::HysteresisHeld)
        }
    } else if previous == EvaluationState::Healthy {
        (EvaluationState::Healthy, EvaluationReason::HysteresisHeld)
    } else if recovering >= policy.quorum.recovery_locations {
        (
            EvaluationState::Healthy,
            EvaluationReason::RecoveryQuorumMet,
        )
    } else {
        (EvaluationState::Unknown, EvaluationReason::HysteresisHeld)
    };

    Ok(EvaluationResult {
        policy_revision: policy.revision.clone(),
        state,
        status: match state {
            EvaluationState::Healthy => Status::Operational,
            EvaluationState::Failing => policy.failure_status,
            EvaluationState::Unknown => Status::Unknown,
        },
        reason,
        eligible_locations: eligible,
        failing_locations: failing,
        recovering_locations: recovering,
        fresh_until,
    })
}

/// 一个直接 Issue 对目标状态的信号。 / Signal from a direct issue to target status.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IssueSignal {
    /// Issue 状态。 / Issue state.
    pub state: IssueState,
    /// Issue 的公开影响。 / Public impact of the issue.
    pub impact: Status,
    /// 是否已由生效维护窗口覆盖。 / Whether an active maintenance window covers it.
    pub covered_by_maintenance: bool,
}

/// 一个维护窗口信号。 / Signal from a maintenance window.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MaintenanceSignal {
    /// 窗口是否已生效。 / Whether the window is active.
    pub active: bool,
}

/// 一个关键 monitor 的状态信号。 / Status signal from a critical monitor.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MonitorSignal {
    /// Monitor 是否关键。 / Whether the monitor is critical.
    pub critical: bool,
    /// Monitor 当前评估状态。 / Current monitor evaluation state.
    pub state: EvaluationState,
}

/// 有时限且带审计事实的操作员状态覆盖。 / Time-bounded operator status override carrying an audit fact.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OperatorOverrideSignal {
    /// 覆盖状态；不得伪造 maintenance。 / Override status; must not fabricate maintenance.
    pub status: Status,
    /// 严格到期时刻。 / Strict expiry instant.
    pub expires_at: DateTime<Utc>,
    /// 已持久化的不可变 audit log 身份。 / Identity of the persisted immutable audit log.
    pub audit_id: String,
}

/// 公开状态聚合的完整且有限输入。 / Complete, finite input to public status aggregation.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AggregationInput {
    /// 目标的直接 Issue。 / Direct issues for the target.
    pub issues: Vec<IssueSignal>,
    /// 覆盖目标的维护窗口。 / Maintenance windows covering the target.
    pub maintenance: Vec<MaintenanceSignal>,
    /// 目标的 monitor。 / Monitors for the target.
    pub monitors: Vec<MonitorSignal>,
    /// 有到期时间且已审计的操作员覆盖。 / Audited operator override with an expiry.
    pub operator_override: Option<OperatorOverrideSignal>,
    /// 本次聚合的 UTC 时刻。 / UTC instant of this aggregation.
    pub evaluated_at: DateTime<Utc>,
}

/// 按规范优先级聚合 direct status；未确认的关键 monitor 故障返回 `unknown` 而非伪造绿色。
/// / Aggregates direct status by normative precedence; an unconfirmed critical-monitor
/// failure returns `unknown` rather than manufacturing a green status.
pub fn aggregate_status(input: &AggregationInput) -> DomainResult<Status> {
    if let Some(override_signal) = &input.operator_override {
        if override_signal.status == Status::Maintenance
            || override_signal.audit_id.trim().is_empty()
        {
            return Err(DomainError::Validation(
                "operator override requires audit_id and cannot manufacture maintenance".into(),
            ));
        }
        if override_signal.expires_at > input.evaluated_at {
            return Ok(override_signal.status);
        }
    }

    let strongest_issue = input
        .issues
        .iter()
        .filter(|issue| {
            matches!(issue.state, IssueState::Active | IssueState::Recovering)
                && !issue.covered_by_maintenance
        })
        .try_fold(None, |strongest: Option<Status>, issue| {
            let rank = issue
                .impact
                .failure_rank()
                .filter(|rank| *rank > 0)
                .ok_or_else(|| {
                    DomainError::Validation("active issue requires a ranked failure impact".into())
                })?;
            Ok::<_, DomainError>(Some(match strongest {
                Some(current) if current.failure_rank().unwrap_or(0) >= rank => current,
                _ => issue.impact,
            }))
        })?;
    if let Some(status) = strongest_issue {
        return Ok(status);
    }
    if input.maintenance.iter().any(|window| window.active) {
        return Ok(Status::Maintenance);
    }
    if input
        .monitors
        .iter()
        .any(|monitor| monitor.critical && monitor.state != EvaluationState::Healthy)
    {
        return Ok(Status::Unknown);
    }
    Ok(Status::Operational)
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::*;

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 9, 8, 15, 0, 0).unwrap()
    }

    fn policy() -> EvaluationPolicy {
        EvaluationPolicy {
            revision: "p1".into(),
            window_seconds: 300,
            minimum_samples: 10,
            failure_threshold: Ratio {
                numerator: 1,
                denominator: 2,
            },
            recovery_threshold: Ratio {
                numerator: 1,
                denominator: 10,
            },
            latency_threshold_ms: Some(500),
            stale_after_seconds: 120,
            quorum: Quorum {
                minimum_locations: 2,
                failure_locations: 2,
                recovery_locations: 2,
            },
            failure_status: Status::PartialOutage,
        }
    }

    fn location(name: &str, bad: u32) -> LocationWindow {
        LocationWindow {
            location: name.into(),
            window_started_at: now() - Duration::seconds(300),
            sample_count: 10,
            unhealthy_count: bad,
            last_observed_at: Some(now()),
        }
    }

    #[test]
    fn quorum_enters_failure() {
        let result = evaluate_monitor(
            &policy(),
            EvaluationState::Healthy,
            &[location("sin", 5), location("fra", 8)],
            now(),
        )
        .unwrap();
        assert_eq!(result.state, EvaluationState::Failing);
        assert_eq!(result.status, Status::PartialOutage);
    }

    #[test]
    fn hysteresis_holds_until_recovery_threshold() {
        let result = evaluate_monitor(
            &policy(),
            EvaluationState::Failing,
            &[location("sin", 2), location("fra", 2)],
            now(),
        )
        .unwrap();
        assert_eq!(result.state, EvaluationState::Failing);
        assert_eq!(result.reason, EvaluationReason::HysteresisHeld);
    }

    #[test]
    fn stale_or_short_windows_are_unknown() {
        let mut stale = location("sin", 0);
        stale.last_observed_at = Some(now() - Duration::seconds(121));
        let result = evaluate_monitor(
            &policy(),
            EvaluationState::Healthy,
            &[stale, location("fra", 0)],
            now(),
        )
        .unwrap();
        assert_eq!(result.state, EvaluationState::Unknown);
    }

    #[test]
    fn warmup_sample_reports_finite_freshness_without_claiming_health() {
        let mut warming = location("sin", 0);
        warming.sample_count = 1;
        let result =
            evaluate_monitor(&policy(), EvaluationState::Unknown, &[warming], now()).unwrap();
        assert_eq!(result.state, EvaluationState::Unknown);
        assert_eq!(result.reason, EvaluationReason::InsufficientSamples);
        assert_eq!(
            result.fresh_until,
            Some(now() + Duration::seconds(policy().stale_after_seconds))
        );
    }

    #[test]
    fn direct_failure_beats_maintenance_and_unknown() {
        let input = AggregationInput {
            issues: vec![IssueSignal {
                state: IssueState::Active,
                impact: Status::MajorOutage,
                covered_by_maintenance: false,
            }],
            maintenance: vec![MaintenanceSignal { active: true }],
            monitors: vec![MonitorSignal {
                critical: true,
                state: EvaluationState::Unknown,
            }],
            operator_override: None,
            evaluated_at: now(),
        };
        assert_eq!(aggregate_status(&input).unwrap(), Status::MajorOutage);
    }

    #[test]
    fn maintenance_does_not_forge_success() {
        let input = AggregationInput {
            maintenance: vec![MaintenanceSignal { active: true }],
            evaluated_at: now(),
            ..AggregationInput::default()
        };
        assert_eq!(aggregate_status(&input).unwrap(), Status::Maintenance);
    }

    #[test]
    fn unconfirmed_critical_failure_cannot_be_reported_operational() {
        let input = AggregationInput {
            monitors: vec![MonitorSignal {
                critical: true,
                state: EvaluationState::Failing,
            }],
            evaluated_at: now(),
            ..AggregationInput::default()
        };
        assert_eq!(aggregate_status(&input).unwrap(), Status::Unknown);
    }

    #[test]
    fn observed_issue_does_not_claim_outage_or_hide_failing_monitor() {
        let input = AggregationInput {
            issues: vec![IssueSignal {
                state: IssueState::Observed,
                impact: Status::MajorOutage,
                covered_by_maintenance: false,
            }],
            monitors: vec![MonitorSignal {
                critical: true,
                state: EvaluationState::Failing,
            }],
            evaluated_at: now(),
            ..AggregationInput::default()
        };
        assert_eq!(aggregate_status(&input).unwrap(), Status::Unknown);
    }
}

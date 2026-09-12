//! 探针成功证据的因果恢复事务。 / Causal recovery transactions for successful probe evidence.

use super::types::{ClaimedMonitor, MonitorEvaluationResult, Observation};
use crate::database::{Database, DatabaseError, Query, SqlValue};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::json;
use status_domain::{canonical_fingerprint, Issue, IssueCommand, IssueState, Status};

/// 从数据库读取的固定 Issue 与策略快照。 / Pinned issue and policy snapshot read from the database.
#[derive(Deserialize)]
struct IssueRow {
    /// Issue 身份。 / Issue identity.
    issue_id: String,
    /// 指纹摘要。 / Fingerprint digest.
    fingerprint_hash: String,
    /// 归属服务。 / Owning service.
    service_name: String,
    /// 诊断种类。 / Diagnostic kind.
    kind: String,
    /// 生命周期状态。 / Lifecycle state.
    state: IssueState,
    /// 固定严重度。 / Pinned severity.
    severity: String,
    /// 首次故障时刻。 / First fault instant.
    first_seen_at: DateTime<Utc>,
    /// 最后故障时刻，不以恢复观察覆盖。 / Last fault instant, never overwritten by recovery observations.
    last_seen_at: DateTime<Utc>,
    /// 故障事件身份用于因果检查。 / Fault event identity for causality checks.
    last_fault_event_id: Option<String>,
    /// 已接受的恢复观察数。 / Accepted recovery observation count.
    recovery_count: u64,
    /// 最后接受的恢复时刻，阻止重试计数。 / Last accepted recovery instant prevents retry counting.
    last_recovery_at: Option<DateTime<Utc>>,
    /// 去重后的发生数。 / Deduplicated occurrence count.
    occurrence_count: u64,
    /// 固定策略身份。 / Pinned policy identity.
    policy_id: String,
    /// 固定策略修订。 / Pinned policy revision.
    policy_revision: u64,
    /// 前次复发身份。 / Previous recurrence identity.
    recurrence_of_issue_id: Option<String>,
    /// 抑制期限。 / Suppression deadline.
    suppression_until: Option<DateTime<Utc>>,
    /// 并发修订。 / Concurrency revision.
    revision: u64,
    /// 固定诊断规则。 / Pinned diagnostic rules.
    diagnostic_rules_json: String,
}

/// 只接受晚于最后故障的成功证据；失败仍由 Diagnostic 聚合器处理。
/// Accept only success evidence newer than the last fault; diagnostics own failures.
pub async fn apply(
    db: &Database,
    monitor: &ClaimedMonitor,
    observation: &Observation,
    evaluation: &MonitorEvaluationResult,
) -> Result<(), DatabaseError> {
    if observation.outcome != "success" {
        return Ok(());
    }
    let hash = fingerprint(monitor)?;
    let Some(row) = db
        .first::<IssueRow>(&Query::new(
            READ_ISSUE,
            vec![monitor.target.service_name.clone().into(), hash.into()],
        ))
        .await?
    else {
        return Ok(());
    };
    let at = DateTime::parse_from_rfc3339(&observation.observed_at)
        .map_err(|_| DatabaseError::RowContract)?
        .with_timezone(&Utc);
    let Some(next) = recovery_state(&row, at, evaluation.checkpoint.evaluation_status)? else {
        return Ok(());
    };
    let mut issue = issue_snapshot(&row, monitor)?;
    if next == row.state {
        issue.revision = issue
            .revision
            .checked_add(1)
            .ok_or(DatabaseError::RowContract)?;
    } else {
        let command = if next == IssueState::Resolved {
            IssueCommand::Resolve
        } else {
            IssueCommand::BeginRecovery
        };
        issue
            .apply(row.revision, command, at)
            .map_err(|_| DatabaseError::RowContract)?;
    }
    commit_recovery(db, monitor, observation, evaluation, &row, &issue, at).await
}

/// 指纹与失败 Diagnostic 使用完全相同的维度。 / Fingerprints use exactly the same dimensions as failure diagnostics.
fn fingerprint(monitor: &ClaimedMonitor) -> Result<String, DatabaseError> {
    let kind = monitor
        .probe
        .get("kind")
        .and_then(|v| v.as_str())
        .ok_or(DatabaseError::RowContract)?;
    let mut value = json!({"operation":"active-health-probe", "capability":monitor.target.id});
    if monitor.target.target_type == "component" {
        value["component"] = json!(monitor.target.id);
    }
    if kind != "synthetic" {
        value["protocol"] = json!(kind);
    }
    canonical_fingerprint("health.probe_failed", &monitor.target.service_name, &value)
        .map(|v| v.hash)
        .map_err(|_| DatabaseError::RowContract)
}

/// 因果和迟滞门槛先于任何写操作。 / Causality and hysteresis gates precede every write.
fn recovery_state(
    row: &IssueRow,
    at: DateTime<Utc>,
    status: Status,
) -> Result<Option<IssueState>, DatabaseError> {
    if row.last_fault_event_id.is_none()
        || at <= row.last_seen_at
        || row.last_recovery_at.is_some_and(|prior| at <= prior)
    {
        return Ok(None);
    }
    let rules: serde_json::Value =
        serde_json::from_str(&row.diagnostic_rules_json).map_err(|_| DatabaseError::RowContract)?;
    let minimum = match rules.get("recovery_min_occurrences") {
        None => 2,
        Some(value) => value
            .as_u64()
            .filter(|n| *n >= 2)
            .ok_or(DatabaseError::RowContract)?,
    };
    let count = row
        .recovery_count
        .checked_add(1)
        .ok_or(DatabaseError::RowContract)?;
    Ok(match row.state {
        IssueState::Active => Some(IssueState::Recovering),
        IssueState::Recovering if count >= minimum && status == Status::Operational => {
            Some(IssueState::Resolved)
        }
        IssueState::Recovering => Some(IssueState::Recovering),
        _ => None,
    })
}

/// 使用纯领域状态机而非 JSON 操作派发。 / Use the pure domain state machine rather than JSON operation dispatch.
fn issue_snapshot(row: &IssueRow, monitor: &ClaimedMonitor) -> Result<Issue, DatabaseError> {
    let impact: Status = serde_json::from_value(
        monitor
            .policy
            .status_mapping
            .get("failure_status")
            .cloned()
            .ok_or(DatabaseError::RowContract)?,
    )
    .map_err(|_| DatabaseError::RowContract)?;
    if !matches!(
        impact,
        Status::Degraded | Status::PartialOutage | Status::MajorOutage
    ) {
        return Err(DatabaseError::RowContract);
    }
    Ok(Issue {
        issue_id: row.issue_id.clone(),
        fingerprint_hash: row.fingerprint_hash.clone(),
        service_name: row.service_name.clone(),
        kind: row.kind.clone(),
        impact,
        state: row.state,
        first_seen_at: row.first_seen_at,
        last_seen_at: row.last_seen_at,
        occurrence_count: row.occurrence_count,
        policy_revision: format!("{}:{}", row.policy_id, row.policy_revision),
        recurrence_of: row.recurrence_of_issue_id.clone(),
        suppressed_until: row.suppression_until,
        revision: row.revision,
    })
}

/// 固定行查询，不接受未确认或已解决 Issue。 / Fixed row query excludes unconfirmed and resolved issues.
const READ_ISSUE: &str = "SELECT i.*,p.diagnostic_rules_json FROM issues i JOIN evaluation_policies p ON p.policy_id=i.policy_id AND p.revision=i.policy_revision WHERE i.service_name=? AND i.kind='health.probe_failed' AND i.fingerprint_hash=? AND i.state IN ('active','recovering') LIMIT 1";

/// 将全信号覆盖计划与恢复事实放在同一事务，所有快照 guard 先于任何写入。
/// Commit full-signal overlays and recovery facts together, with all snapshot guards before any write.
async fn commit_recovery(
    db: &Database,
    monitor: &ClaimedMonitor,
    observation: &Observation,
    evaluation: &MonitorEvaluationResult,
    row: &IssueRow,
    issue: &Issue,
    at: DateTime<Utc>,
) -> Result<(), DatabaseError> {
    use super::reevaluate::{plan_reevaluation_with_overlay, EvaluationOverlay};
    let mut overlay = EvaluationOverlay {
        issues: vec![
            json!({"issue_id":row.issue_id,"state":issue.state,"severity":row.severity,"fingerprint_hash":row.fingerprint_hash,"diagnostic_rules_json":row.diagnostic_rules_json,"service_name":row.service_name}),
        ],
        policy: Some(
            json!({"policy_id":monitor.policy.policy_id,"policy_revision":monitor.policy.revision,"fresh_until":evaluation.checkpoint.fresh_until}),
        ),
        source: Some(("observation".into(), observation.observation_id.clone())),
        ..Default::default()
    };
    let mut targets = vec![("service", row.service_name.as_str())];
    let target = (
        monitor.target.target_type.as_str(),
        monitor.target.id.as_str(),
    );
    if !targets.contains(&target) {
        targets.push(target);
    }
    let mut guards = Vec::new();
    let mut statuses = Vec::new();
    for (kind, id) in targets {
        let mut plan =
            plan_reevaluation_with_overlay(db, kind, id, &observation.observed_at, &overlay)
                .await?;
        if plan.is_empty() {
            return Err(DatabaseError::RowContract);
        }
        guards.push(plan.remove(0));
        carry_service_status(&mut overlay, kind, id, &plan)?;
        statuses.extend(plan);
    }
    guards.extend(recovery_writes(row, issue, observation, at)?);
    guards.extend(statuses);
    db.batch(&guards).await?;
    Ok(())
}

/// 修订断言紧跟 UPDATE，使并发失败回滚审计、outbox 和状态。
/// A revision assertion immediately follows UPDATE, rolling back audit, outbox, and status on races.
fn recovery_writes(
    row: &IssueRow,
    issue: &Issue,
    observation: &Observation,
    at: DateTime<Utc>,
) -> Result<Vec<Query>, DatabaseError> {
    let revision = i64::try_from(issue.revision).map_err(|_| DatabaseError::InvalidParameter)?;
    let previous = i64::try_from(row.revision).map_err(|_| DatabaseError::InvalidParameter)?;
    let state = match issue.state {
        IssueState::Recovering => "recovering",
        IssueState::Resolved => "resolved",
        _ => return Err(DatabaseError::RowContract),
    };
    let audit = super::stable_id(
        at.timestamp_millis(),
        &format!("{}:{}:recovery-audit", row.issue_id, revision),
    );
    let outbox = super::stable_id(
        at.timestamp_millis(),
        &format!("{}:{}:recovery-outbox", row.issue_id, revision),
    );
    let stamp = &observation.observed_at;
    let resolved = if state == "resolved" {
        stamp.clone().into()
    } else {
        SqlValue::Null
    };
    Ok(vec![
        Query::new("UPDATE issues SET state=?,suppression_until=NULL,suppression_reason=NULL,resolved_at=?,revision=?,recovery_count=recovery_count+1,last_recovery_at=? WHERE issue_id=? AND revision=? AND (last_recovery_at IS NULL OR last_recovery_at<?)", vec![state.into(),resolved,revision.into(),stamp.clone().into(),row.issue_id.clone().into(),previous.into(),stamp.clone().into()]),
        Query::new("INSERT INTO transaction_assertions(assertion_id,passed) VALUES (?,CASE WHEN changes()=1 THEN 1 ELSE 0 END)", vec![format!("issue-recovery:{}:{}",row.issue_id,revision).into()]),
        Query::new("INSERT INTO audit_log(audit_id,actor_type,actor_subject,actor_roles_json,action,target_type,target_id,before_revision,after_revision,correlation_id,occurred_at,details_json) VALUES (?,'system','status-scheduler','[]','issue.recovery_evaluated','issue',?,?,?,?,?,'{}')",vec![audit.into(),row.issue_id.clone().into(),previous.into(),revision.into(),observation.correlation_id.clone().into(),stamp.clone().into()]),
        Query::new("INSERT INTO outbox(outbox_id,aggregate_type,aggregate_id,event_type,schema_version,payload_json,state,attempt_count,available_at,next_attempt_at,created_at) VALUES (?,'issue',?,'issue.state_changed','1.0',?,'pending',0,?,?,?)",vec![outbox.into(),row.issue_id.clone().into(),json!({"issue_id":row.issue_id,"state":state,"revision":issue.revision}).to_string().into(),stamp.clone().into(),stamp.clone().into(),stamp.clone().into()]),
    ])
}

/// 到期抑制必须持久迁移，且其公开影响与审计在同一事务恢复。
/// Expired suppression must transition durably, restoring public impact and audit atomically.
pub async fn expire_suppression(
    db: &Database,
    issue_id: &str,
    now: &str,
) -> Result<(), DatabaseError> {
    use super::reevaluate::{plan_reevaluation_with_overlay, EvaluationOverlay};
    let at = DateTime::parse_from_rfc3339(now)
        .map_err(|_| DatabaseError::InvalidParameter)?
        .with_timezone(&Utc);
    let query = Query::new("SELECT i.*,p.diagnostic_rules_json FROM issues i JOIN evaluation_policies p ON p.policy_id=i.policy_id AND p.revision=i.policy_revision WHERE i.issue_id=? AND i.state='suppressed' AND i.suppression_until<=?", vec![issue_id.into(),now.into()]);
    let Some(row) = db.first::<IssueRow>(&query).await? else {
        return Ok(());
    };
    let rules: serde_json::Value =
        serde_json::from_str(&row.diagnostic_rules_json).map_err(|_| DatabaseError::RowContract)?;
    let impact = rules
        .get("status_by_severity")
        .and_then(|v| v.get(&row.severity))
        .or_else(|| rules.get("contract").and_then(|v| v.get("failure_status")))
        .cloned()
        .ok_or(DatabaseError::RowContract)?;
    let impact: Status = serde_json::from_value(impact).map_err(|_| DatabaseError::RowContract)?;
    if !matches!(
        impact,
        Status::Degraded | Status::PartialOutage | Status::MajorOutage
    ) {
        return Err(DatabaseError::RowContract);
    }
    let mut issue = Issue {
        issue_id: row.issue_id.clone(),
        fingerprint_hash: row.fingerprint_hash.clone(),
        service_name: row.service_name.clone(),
        kind: row.kind.clone(),
        impact,
        state: row.state,
        first_seen_at: row.first_seen_at,
        last_seen_at: row.last_seen_at,
        occurrence_count: row.occurrence_count,
        policy_revision: format!("{}:{}", row.policy_id, row.policy_revision),
        recurrence_of: row.recurrence_of_issue_id.clone(),
        suppressed_until: row.suppression_until,
        revision: row.revision,
    };
    issue
        .apply(row.revision, IssueCommand::SuppressionExpired, at)
        .map_err(|_| DatabaseError::RowContract)?;
    let mut overlay = EvaluationOverlay {
        issues: vec![
            json!({"issue_id":row.issue_id,"state":"active","severity":row.severity,"fingerprint_hash":row.fingerprint_hash,"diagnostic_rules_json":row.diagnostic_rules_json,"service_name":row.service_name}),
        ],
        source: Some(("issue".into(), row.issue_id.clone())),
        ..Default::default()
    };
    // 所有直属组件均需重新考虑服务诊断；规划器会用指纹过滤 probe-owned 影响。
    // All owned components reconsider service diagnostics; the planner filters probe-owned impacts by fingerprint.
    let components = db
        .all::<ComponentTarget>(&Query::new(
            "SELECT component_id FROM components WHERE service_name=?",
            vec![row.service_name.clone().into()],
        ))
        .await?;
    let mut targets = vec![("service", row.service_name.as_str())];
    targets.extend(
        components
            .iter()
            .map(|c| ("component", c.component_id.as_str())),
    );
    let mut guards = Vec::new();
    let mut writes = Vec::new();
    for (kind, id) in targets {
        let mut plan = plan_reevaluation_with_overlay(db, kind, id, now, &overlay).await?;
        if plan.is_empty() {
            return Err(DatabaseError::RowContract);
        }
        guards.push(plan.remove(0));
        carry_service_status(&mut overlay, kind, id, &plan)?;
        writes.extend(plan);
    }
    guards.extend(suppression_writes(&row, &issue, now, at)?);
    guards.extend(writes);
    db.batch(&guards).await?;
    Ok(())
}

/// 需要重新考虑所属服务事实的组件。 / Component reconsidering facts of its owning service.
#[derive(Deserialize)]
struct ComponentTarget {
    /// 组件身份。 / Component identity.
    component_id: String,
}

/// 到期事实采用相同修订栅栏和稳定事件身份。 / Expiry facts use the same revision fence and stable event identities.
fn suppression_writes(
    row: &IssueRow,
    issue: &Issue,
    now: &str,
    at: DateTime<Utc>,
) -> Result<Vec<Query>, DatabaseError> {
    let revision = i64::try_from(issue.revision).map_err(|_| DatabaseError::InvalidParameter)?;
    let previous = i64::try_from(row.revision).map_err(|_| DatabaseError::InvalidParameter)?;
    let audit = super::stable_id(
        at.timestamp_millis(),
        &format!("{}:{}:suppression-expiry-audit", row.issue_id, revision),
    );
    let outbox = super::stable_id(
        at.timestamp_millis(),
        &format!("{}:{}:suppression-expiry-outbox", row.issue_id, revision),
    );
    Ok(vec![
        Query::new("UPDATE issues SET state='active',suppression_until=NULL,suppression_reason=NULL,resolved_at=NULL,revision=? WHERE issue_id=? AND revision=? AND state='suppressed'",vec![revision.into(),row.issue_id.clone().into(),previous.into()]),
        Query::new("INSERT INTO transaction_assertions(assertion_id,passed) VALUES (?,CASE WHEN changes()=1 THEN 1 ELSE 0 END)",vec![format!("suppression-expiry:{}:{}",row.issue_id,revision).into()]),
        Query::new("INSERT INTO audit_log(audit_id,actor_type,actor_subject,actor_roles_json,action,target_type,target_id,before_revision,after_revision,correlation_id,occurred_at,details_json) VALUES (?,'system','status-scheduler','[]','issue.suppression_expired','issue',?,?,?,?,?,'{}')",vec![audit.into(),row.issue_id.clone().into(),previous.into(),revision.into(),format!("suppression:{}",row.issue_id).into(),now.into()]),
        Query::new("INSERT INTO outbox(outbox_id,aggregate_type,aggregate_id,event_type,schema_version,payload_json,state,attempt_count,available_at,next_attempt_at,created_at) VALUES (?,'issue',?,'issue.state_changed','1.0',?,'pending',0,?,?,?)",vec![outbox.into(),row.issue_id.clone().into(),json!({"issue_id":row.issue_id,"state":"active","revision":issue.revision}).to_string().into(),now.into(),now.into(),now.into()]),
    ])
}

/// 在规划下一组件前传递同事务服务候选状态，不能重新读取旧持久状态。
/// Carry pending service status before planning the next component, never rereading stale persisted state.
fn carry_service_status(
    overlay: &mut super::reevaluate::EvaluationOverlay,
    kind: &str,
    id: &str,
    plan: &[Query],
) -> Result<(), DatabaseError> {
    if kind != "service" {
        return Ok(());
    }
    let values = plan.first().ok_or(DatabaseError::RowContract)?.values();
    let text = |index: usize| -> Result<String, DatabaseError> {
        match values.get(index) {
            Some(SqlValue::Text(value)) => Ok(value.clone()),
            _ => Err(DatabaseError::RowContract),
        }
    };
    overlay.service_statuses.push(json!({"service_name":id,"direct_status":text(2)?,"effective_impact":text(4)?,"fresh_until":text(6)?}));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pinned_five_observations_and_retries_gate_resolution() {
        let mut row: IssueRow = serde_json::from_value(json!({"issue_id":"i","fingerprint_hash":"h","service_name":"api","kind":"health.probe_failed","state":"active","severity":"error","first_seen_at":"2026-09-12T00:00:00Z","last_seen_at":"2026-09-12T00:00:00Z","last_fault_event_id":"fault","recovery_count":0,"last_recovery_at":null,"occurrence_count":1,"policy_id":"p","policy_revision":1,"recurrence_of_issue_id":null,"suppression_until":null,"revision":1,"diagnostic_rules_json":"{\"recovery_min_occurrences\":5}"})).unwrap();
        for count in 1..=5 {
            let at = row.last_seen_at + chrono::Duration::seconds(count);
            let next = recovery_state(&row, at, Status::Operational)
                .unwrap()
                .unwrap();
            assert_eq!(
                next,
                if count == 5 {
                    IssueState::Resolved
                } else {
                    IssueState::Recovering
                }
            );
            row.state = next;
            row.recovery_count = count as u64;
            row.last_recovery_at = Some(at);
            assert_eq!(recovery_state(&row, at, Status::Operational).unwrap(), None);
        }
    }

    #[test]
    fn service_candidate_is_carried_to_following_component() {
        let mut overlay = super::super::reevaluate::EvaluationOverlay::default();
        let plan = vec![Query::new(
            "candidate",
            vec![
                "service".into(),
                "api".into(),
                "operational".into(),
                "none".into(),
                "operational".into(),
                "now".into(),
                "future".into(),
            ],
        )];
        carry_service_status(&mut overlay, "service", "api", &plan).unwrap();
        assert_eq!(
            overlay.service_statuses,
            vec![
                json!({"service_name":"api","direct_status":"operational","effective_impact":"operational","fresh_until":"future"})
            ]
        );
        carry_service_status(&mut overlay, "component", "web", &[]).unwrap();
        assert_eq!(overlay.service_statuses.len(), 1);
        assert!(carry_service_status(&mut overlay, "service", "other", &[]).is_err());
    }
}

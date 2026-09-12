//! 显式 Diagnostic 恢复证据的纯状态评估。 / Pure state evaluation for explicit Diagnostic recovery evidence.

use crate::{DiagnosticAction, DiagnosticEvaluationInput, DiagnosticEvaluationResult, IssueState};

///
/// 使用与故障聚合相同的不可变策略 revision 评估正向恢复证据。
/// Evaluate positive recovery evidence against the same immutable policy revision
/// used by fault aggregation.
///
/// `last_fault_event_id` 是因果头；恢复引用必须精确匹配，才不会清除后来故障。
/// `last_fault_event_id` is the causal head; recovery must reference it exactly
/// so recovery for an older fault cannot clear a later one.
pub(crate) fn evaluate_diagnostic_recovery(
    input: &DiagnosticEvaluationInput,
    fingerprint_hash: String,
) -> crate::DomainResult<DiagnosticEvaluationResult> {
    let Some(issue) = input.current_issue.as_ref() else {
        return Ok(DiagnosticEvaluationResult {
            fingerprint_hash,
            policy_revision: input.policy.revision.clone(),
            issue_state: IssueState::Resolved,
            severity: input.event.severity,
            direct_status: input.current_service_status,
            action: DiagnosticAction::RecordUnmatchedRecovery,
            occurrence_count: 0,
            recovery_count: 0,
            last_recovery_at: None,
            last_seen_at: input.event.occurred_at,
            expected_revision: None,
        });
    };

    if input.event.recovery_of_event_id.as_ref() != issue.last_fault_event_id.as_ref() {
        return Ok(DiagnosticEvaluationResult {
            fingerprint_hash,
            policy_revision: input.policy.revision.clone(),
            issue_state: issue.state,
            severity: issue.severity,
            direct_status: input.current_service_status,
            action: DiagnosticAction::RecordStaleRecovery,
            occurrence_count: issue.occurrence_count,
            recovery_count: issue.recovery_count,
            last_recovery_at: issue.last_recovery_at,
            last_seen_at: issue.last_seen_at,
            expected_revision: Some(issue.revision),
        });
    }

    let next_recovery_count = issue.recovery_count.checked_add(1).ok_or_else(|| {
        crate::DomainError::Validation("diagnostic recovery_count overflow".into())
    })?;
    let last_recovery_at = Some(
        issue
            .last_recovery_at
            .map_or(input.event.occurred_at, |prior| {
                prior.max(input.event.occurred_at)
            }),
    );
    let (issue_state, action, recovery_count) = match issue.state {
        IssueState::Active => (
            IssueState::Recovering,
            DiagnosticAction::BeginRecovery,
            next_recovery_count,
        ),
        IssueState::Recovering if next_recovery_count < input.policy.recovery_min_occurrences => (
            IssueState::Recovering,
            DiagnosticAction::BeginRecovery,
            next_recovery_count,
        ),
        IssueState::Observed | IssueState::Recovering | IssueState::Suppressed => (
            IssueState::Resolved,
            DiagnosticAction::ResolveRecovery,
            next_recovery_count,
        ),
        // Consumer 通常不会提供 resolved Issue；仅记录分支让直接/native 调用保持确定且无害。
        // The consumer normally omits resolved Issues; a record-only branch keeps
        // direct/native callers deterministic and harmless.
        IssueState::Resolved => (
            IssueState::Resolved,
            DiagnosticAction::RecordUnmatchedRecovery,
            issue.recovery_count,
        ),
    };

    Ok(DiagnosticEvaluationResult {
        fingerprint_hash,
        policy_revision: input.policy.revision.clone(),
        issue_state,
        severity: issue.severity,
        direct_status: input.current_service_status,
        action,
        occurrence_count: issue.occurrence_count,
        recovery_count,
        last_recovery_at,
        last_seen_at: issue.last_seen_at,
        expected_revision: Some(issue.revision),
    })
}

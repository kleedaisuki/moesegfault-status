//! moeSegFault Status 的纯领域核心。 / Pure domain core for moeSegFault Status.
//!
//! 本 crate 不执行 I/O，不依赖数据库，也不保存原始遥测洪水。所有决策函数都可重放，
//! 原生服务与 WebAssembly 客户端因而能够共享同一套语义。
//! This crate performs no I/O, has no database dependency, and never stores raw
//! telemetry floods. Every decision function is replayable, so native services and
//! WebAssembly clients share exactly the same semantics.

#![forbid(unsafe_code)]
#![deny(missing_docs)]

mod bridge;
mod dependency;
mod diagnostic;
mod evaluation;
mod fingerprint;
mod lifecycle;
mod provenance;
mod recovery;

#[cfg(feature = "wasm")]
pub use bridge::dispatch_json;
pub use bridge::dispatch_json_native;
pub use dependency::{
    compute_dependency_risk, Criticality, Dependency, DependencyContributor, DependencyGraph,
    DependencyKind, DependencyRisk,
};
pub use diagnostic::{
    evaluate_diagnostic, DiagnosticAction, DiagnosticEvaluationInput, DiagnosticEvaluationPolicy,
    DiagnosticEvaluationResult, DiagnosticEvent, DiagnosticEvidence, DiagnosticIssueSnapshot,
    DiagnosticSeverity, DiagnosticSignal, SeverityStatusMap,
};
pub use evaluation::{
    aggregate_status, evaluate_monitor, AggregationInput, EvaluationPolicy, EvaluationReason,
    EvaluationResult, EvaluationState, IssueSignal, LocationWindow, MaintenanceSignal,
    MonitorSignal, OperatorOverrideSignal, Quorum, Ratio,
};
pub use fingerprint::{canonical_fingerprint, canonicalize_fingerprint, CanonicalFingerprint};
pub use lifecycle::{
    Incident, IncidentCommand, IncidentImpact, IncidentState, IncidentUpdate, Issue, IssueCommand,
    IssueState, Status,
};
pub use provenance::{
    validate_uuid_v7, Artifact, ArtifactKind, DeploymentManifest, Environment, ResourceIdentity,
    TelemetryKind, TelemetryReference, TimeRange, Validation,
};

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// 纯领域操作失败。 / Failure from a pure domain operation.
#[derive(Clone, Debug, Error, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "code", content = "message", rename_all = "snake_case")]
pub enum DomainError {
    /// 输入违反稳定领域不变量。 / Input violates a stable domain invariant.
    #[error("validation failed: {0}")]
    Validation(String),
    /// 状态迁移不属于已声明状态机。 / Transition is absent from the declared state machine.
    #[error("invalid transition: {0}")]
    InvalidTransition(String),
    /// 请求使用过期的乐观并发版本。 / Request carries a stale optimistic-concurrency revision.
    #[error("revision conflict: {0}")]
    RevisionConflict(String),
    /// JSON 桥收到无效负载。 / The JSON bridge received an invalid payload.
    #[error("invalid JSON payload: {0}")]
    Json(String),
}

impl From<serde_json::Error> for DomainError {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value.to_string())
    }
}

/// 领域函数的统一结果类型。 / Common result type for domain functions.
pub type DomainResult<T> = Result<T, DomainError>;

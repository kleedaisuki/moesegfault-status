//! 有界、尽力而为的诊断生产 SDK；内存缓冲不是持久队列。
//! Bounded best-effort Diagnostic producer SDK; its memory buffer is not a durable queue.
#![forbid(unsafe_code)]
#![deny(missing_docs)]
pub mod builder;
pub mod evidence;
pub mod propagation;
pub mod publisher;
#[cfg(target_arch = "wasm32")]
pub mod workers;

pub use builder::{
    resource_from_manifest, DiagnosticEventBuilder, DiagnosticEventInput, PreparedDiagnostic,
};
pub use evidence::{
    artifact_evidence, log_query_evidence, metric_query_evidence, profile_evidence,
    source_evidence, trace_evidence, LogQueryKey, MetricQueryKey, ProfileQueryKey, ProfileType,
    SafeDiagnosticEvidence, SafeQueryValue,
};
pub use propagation::DiagnosticPropagation;
pub use publisher::{DiagnosticClient, Options, Stats};

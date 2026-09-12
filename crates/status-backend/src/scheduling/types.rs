//! 调度协议数据；保持现有 camelCase 边界。 / Scheduling wire data preserving camelCase contracts.
use serde::{Deserialize, Serialize};
use serde_json::Value;
/// 调度边界记录。 / Typed StatusTarget scheduling boundary record.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusTarget {
    /// 协议字段 `target_type`。 / Wire contract field `target_type`.
    #[serde(rename = "type")]
    pub target_type: String,
    /// 协议字段 `id`。 / Wire contract field `id`.
    pub id: String,
    /// 协议字段 `service_name`。 / Wire contract field `service_name`.
    pub service_name: String,
}
/// 调度边界记录。 / Typed Policy scheduling boundary record.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Policy {
    /// 协议字段 `policy_id`。 / Wire contract field `policy_id`.
    pub policy_id: String,
    /// 协议字段 `revision`。 / Wire contract field `revision`.
    pub revision: u64,
    /// 协议字段 `observation_window_ms`。 / Wire contract field `observation_window_ms`.
    pub observation_window_ms: i64,
    /// 协议字段 `minimum_samples`。 / Wire contract field `minimum_samples`.
    pub minimum_samples: u32,
    /// 协议字段 `failure_threshold`。 / Wire contract field `failure_threshold`.
    pub failure_threshold: f64,
    /// 协议字段 `recovery_threshold`。 / Wire contract field `recovery_threshold`.
    pub recovery_threshold: f64,
    /// 协议字段 `latency_threshold_ms`。 / Wire contract field `latency_threshold_ms`.
    pub latency_threshold_ms: Option<u64>,
    /// 协议字段 `stale_after_ms`。 / Wire contract field `stale_after_ms`.
    pub stale_after_ms: i64,
    /// 协议字段 `location_quorum`。 / Wire contract field `location_quorum`.
    pub location_quorum: u32,
    /// 协议字段 `fingerprint_template`。 / Wire contract field `fingerprint_template`.
    pub fingerprint_template: Value,
    /// 协议字段 `status_mapping`。 / Wire contract field `status_mapping`.
    pub status_mapping: Value,
}
/// 调度边界记录。 / Typed ClaimedMonitor scheduling boundary record.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimedMonitor {
    /// 协议字段 `locations`。 / Wire contract field `locations`.
    pub locations: Vec<String>,
    /// 协议字段 `claim_revision`。 / Wire contract field `claim_revision`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claim_revision: Option<u64>,
    /// 协议字段 `monitor_id`。 / Wire contract field `monitor_id`.
    pub monitor_id: String,
    /// 协议字段 `target`。 / Wire contract field `target`.
    pub target: StatusTarget,
    /// 协议字段 `probe`。 / Wire contract field `probe`.
    pub probe: Value,
    /// 协议字段 `timeout_ms`。 / Wire contract field `timeout_ms`.
    pub timeout_ms: u64,
    /// 协议字段 `interval_ms`。 / Wire contract field `interval_ms`.
    pub interval_ms: i64,
    /// 协议字段 `scheduled_for`。 / Wire contract field `scheduled_for`.
    pub scheduled_for: String,
    /// 协议字段 `next_run_at`。 / Wire contract field `next_run_at`.
    pub next_run_at: String,
    /// 协议字段 `critical`。 / Wire contract field `critical`.
    pub critical: bool,
    /// 协议字段 `policy`。 / Wire contract field `policy`.
    pub policy: Policy,
    /// 协议字段 `deployment_id`。 / Wire contract field `deployment_id`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deployment_id: Option<String>,
    /// 协议字段 `environment`。 / Wire contract field `environment`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<String>,
}
/// 调度边界记录。 / Typed ExecutionProvenance scheduling boundary record.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionProvenance {
    /// 协议字段 `runtime`。 / Wire contract field `runtime`.
    pub runtime: String,
    /// 协议字段 `location`。 / Wire contract field `location`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    /// 协议字段 `executor_id`。 / Wire contract field `executor_id`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executor_id: Option<String>,
    /// 协议字段 `actual_colo`。 / Wire contract field `actual_colo`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actual_colo: Option<String>,
}
/// 调度边界记录。 / Typed Observation scheduling boundary record.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    /// 协议字段 `observation_id`。 / Wire contract field `observation_id`.
    pub observation_id: String,
    /// 协议字段 `monitor_id`。 / Wire contract field `monitor_id`.
    pub monitor_id: String,
    /// 协议字段 `observed_at`。 / Wire contract field `observed_at`.
    pub observed_at: String,
    /// 协议字段 `execution`。 / Wire contract field `execution`.
    pub execution: ExecutionProvenance,
    /// 协议字段 `outcome`。 / Wire contract field `outcome`.
    pub outcome: String,
    /// 协议字段 `latency_ms`。 / Wire contract field `latency_ms`.
    pub latency_ms: f64,
    /// 协议字段 `protocol_status`。 / Wire contract field `protocol_status`.
    pub protocol_status: Option<String>,
    /// 协议字段 `error_type`。 / Wire contract field `error_type`.
    pub error_type: Option<String>,
    /// 协议字段 `correlation_id`。 / Wire contract field `correlation_id`.
    pub correlation_id: String,
}
/// 调度边界记录。 / Typed MonitorCheckpoint scheduling boundary record.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorCheckpoint {
    /// 协议字段 `monitor_id`。 / Wire contract field `monitor_id`.
    pub monitor_id: String,
    /// 协议字段 `location`。 / Wire contract field `location`.
    pub location: String,
    /// 协议字段 `executor_id`。 / Wire contract field `executor_id`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executor_id: Option<String>,
    /// 协议字段 `actual_colo`。 / Wire contract field `actual_colo`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actual_colo: Option<String>,
    /// 协议字段 `window_started_at`。 / Wire contract field `window_started_at`.
    pub window_started_at: String,
    /// 协议字段 `last_observed_at`。 / Wire contract field `last_observed_at`.
    pub last_observed_at: String,
    /// 协议字段 `consecutive_successes`。 / Wire contract field `consecutive_successes`.
    pub consecutive_successes: u32,
    /// 协议字段 `consecutive_failures`。 / Wire contract field `consecutive_failures`.
    pub consecutive_failures: u32,
    /// 协议字段 `window_samples`。 / Wire contract field `window_samples`.
    pub window_samples: u32,
    /// 协议字段 `window_unhealthy_samples`。 / Wire contract field `window_unhealthy_samples`.
    pub window_unhealthy_samples: u32,
    /// 协议字段 `window_latency_p95_ms`。 / Wire contract field `window_latency_p95_ms`.
    pub window_latency_p95_ms: Option<f64>,
    /// 协议字段 `evaluation_status`。 / Wire contract field `evaluation_status`.
    pub evaluation_status: status_domain::Status,
    /// 协议字段 `evaluated_at`。 / Wire contract field `evaluated_at`.
    pub evaluated_at: String,
    /// 协议字段 `fresh_until`。 / Wire contract field `fresh_until`.
    pub fresh_until: String,
    /// 协议字段 `policy_id`。 / Wire contract field `policy_id`.
    pub policy_id: String,
    /// 协议字段 `policy_revision`。 / Wire contract field `policy_revision`.
    pub policy_revision: u64,
    /// 协议字段 `revision`。 / Wire contract field `revision`.
    pub revision: u64,
}
/// 调度边界记录。 / Typed MonitorEvaluationResult scheduling boundary record.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorEvaluationResult {
    /// 协议字段 `checkpoint`。 / Wire contract field `checkpoint`.
    pub checkpoint: MonitorCheckpoint,
    /// 协议字段 `diagnostic_severity`。 / Wire contract field `diagnostic_severity`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostic_severity: Option<String>,
    /// 协议字段 `diagnostic_kind`。 / Wire contract field `diagnostic_kind`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostic_kind: Option<String>,
    /// 协议字段 `diagnostic_summary`。 / Wire contract field `diagnostic_summary`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostic_summary: Option<String>,
}

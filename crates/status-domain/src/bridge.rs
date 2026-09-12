//! 原生与 Wasm 共用的 JSON 调度桥。 / JSON dispatch bridge shared by native and Wasm callers.

use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    aggregate_status, canonical_fingerprint, compute_dependency_risk, evaluate_diagnostic,
    evaluate_monitor, AggregationInput, DependencyGraph, DiagnosticEvaluationInput, DomainError,
    DomainResult, EvaluationPolicy, EvaluationState, Incident, IncidentCommand, Issue,
    IssueCommand, LocationWindow, Status, TelemetryReference, Validation,
};
use crate::{DeploymentManifest, IncidentUpdate};

#[derive(Debug, Deserialize)]
#[serde(
    tag = "operation",
    content = "payload",
    rename_all = "snake_case",
    deny_unknown_fields
)]
enum Request {
    EvaluateMonitor(EvaluateMonitorPayload),
    // 恢复快照较大，间接存储避免放大所有请求的栈占用。 / Indirect the large recovery snapshot to avoid inflating every request's stack footprint.
    EvaluateDiagnostic(Box<DiagnosticEvaluationInput>),
    AggregateStatus(AggregationInput),
    CanonicalFingerprint(FingerprintPayload),
    DependencyRisk(DependencyPayload),
    IssueTransition(IssueTransitionPayload),
    IncidentTransition(IncidentTransitionPayload),
    ValidateDeployment(DeploymentManifest),
    ValidateTelemetryReference(TelemetryReference),
    ValidateDiagnosticEvent(crate::DiagnosticEvent),
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EvaluateMonitorPayload {
    policy: EvaluationPolicy,
    previous_state: EvaluationState,
    locations: Vec<LocationWindow>,
    now: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FingerprintPayload {
    kind: String,
    service_name: String,
    fingerprint: Value,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DependencyPayload {
    graph: DependencyGraph,
    source_service: String,
    direct_statuses: BTreeMap<String, Status>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct IssueTransitionPayload {
    issue: Issue,
    expected_revision: u64,
    command: IssueCommand,
    at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct IncidentTransitionPayload {
    incident: Incident,
    expected_revision: u64,
    command: IncidentCommand,
    at: DateTime<Utc>,
}

#[derive(Serialize)]
struct IssueTransitionResult {
    issue: Issue,
}

#[derive(Serialize)]
struct IncidentTransitionResult {
    incident: Incident,
    update: IncidentUpdate,
}

/// 调用与 Wasm 完全相同的 JSON 协议，便于原生 conformance test。 / Invokes the exact Wasm JSON protocol for native conformance tests.
pub fn dispatch_json_native(input: &str) -> DomainResult<String> {
    let request: Request = serde_json::from_str(input)?;
    match request {
        Request::EvaluateMonitor(payload) => encode(&evaluate_monitor(
            &payload.policy,
            payload.previous_state,
            &payload.locations,
            payload.now,
        )?),
        Request::EvaluateDiagnostic(payload) => encode(&evaluate_diagnostic(&payload)?),
        Request::AggregateStatus(payload) => encode(&aggregate_status(&payload)?),
        Request::CanonicalFingerprint(payload) => encode(&canonical_fingerprint(
            &payload.kind,
            &payload.service_name,
            &payload.fingerprint,
        )?),
        Request::DependencyRisk(payload) => encode(&compute_dependency_risk(
            &payload.graph,
            &payload.source_service,
            &payload.direct_statuses,
        )?),
        Request::IssueTransition(payload) => {
            let mut issue = payload.issue;
            issue.apply(payload.expected_revision, payload.command, payload.at)?;
            encode(&IssueTransitionResult { issue })
        }
        Request::IncidentTransition(payload) => {
            let mut incident = payload.incident;
            let update = incident.apply(payload.expected_revision, payload.command, payload.at)?;
            encode(&IncidentTransitionResult { incident, update })
        }
        Request::ValidateDeployment(manifest) => {
            manifest.validate()?;
            encode(&Validation { valid: true })
        }
        Request::ValidateTelemetryReference(reference) => {
            reference.validate()?;
            encode(&Validation { valid: true })
        }
        Request::ValidateDiagnosticEvent(event) => {
            event.validate()?;
            encode(&Validation { valid: true })
        }
    }
}

fn encode<T: Serialize>(value: &T) -> DomainResult<String> {
    serde_json::to_string(value).map_err(DomainError::from)
}

/// Wasm 的唯一业务导出；接收并返回 UTF-8 JSON 字符串。 / Sole Wasm business export; accepts and returns UTF-8 JSON strings.
#[cfg(feature = "wasm")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn dispatch_json(input: &str) -> Result<String, wasm_bindgen::JsValue> {
    dispatch_json_native(input).map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn dispatcher_rejects_unknown_fields() {
        let input = json!({
            "operation": "canonical_fingerprint",
            "payload": {
                "kind": "dependency.unavailable",
                "service_name": "identity",
                "fingerprint": {"dependency": "d1"},
                "surprise": true
            }
        });
        assert!(dispatch_json_native(&input.to_string()).is_err());
    }

    #[test]
    fn native_dispatch_returns_canonical_fingerprint() {
        let input = json!({
            "operation": "canonical_fingerprint",
            "payload": {
                "kind": "dependency.unavailable",
                "service_name": "identity",
                "fingerprint": {"operation": "get", "dependency": "d1"}
            }
        });
        let output: Value =
            serde_json::from_str(&dispatch_json_native(&input.to_string()).unwrap()).unwrap();
        assert_eq!(output["hash"].as_str().unwrap().len(), 64);
    }

    #[test]
    fn shared_contract_fixtures_cross_native_json_boundary() {
        let deployment = json!({"operation":"validate_deployment","payload":{
            "deployment_id":"0199d09a-b692-7ce0-a1c0-5138a43d7402","service_name":"identity",
            "environment":"production","service_version":"1.0.0",
            "repository_url":"https://github.com/moesegfault/identity",
            "git_commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","git_ref":"refs/heads/main",
            "artifact_digest":format!("sha256:{}","b".repeat(64)),"ci_provider":"github-actions",
            "ci_run_id":"42","deployed_at":"2026-09-08T15:00:00Z","region":["global"],
            "artifacts":[
              {"kind":"other","file_name":"worker.js","media_type":"application/javascript","size_bytes":1024,
               "artifact_digest":format!("sha256:{}","b".repeat(64))},
              {"kind":"source_map","file_name":"worker.js.map","media_type":"application/json","size_bytes":2048,
               "artifact_digest":format!("sha256:{}","c".repeat(64))}
            ]
        }});
        assert_eq!(
            dispatch_json_native(&deployment.to_string()).unwrap(),
            "{\"valid\":true}"
        );

        let diagnostic = json!({"event_id":"0199d0a8-2e12-7a59-a51e-44aa9b6d1001","schema_version":"1.0",
            "kind":"dependency.unavailable","severity":"error","service_name":"identity","environment":"production",
            "deployment_id":"0199d09a-b692-7ce0-a1c0-5138a43d7402",
            "occurred_at":"2026-09-08T15:00:00Z","correlation_id":"0199d0a7-d771-7435-a388-bb6fa5d533fc",
            "trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","summary":"D1 unavailable",
            "fingerprint":{"dependency":"d1"},"evidence":[],"attributes":{}});
        let validate = json!({"operation":"validate_diagnostic_event","payload":diagnostic});
        assert_eq!(
            dispatch_json_native(&validate.to_string()).unwrap(),
            "{\"valid\":true}"
        );
        let evaluate_diagnostic = json!({"operation":"evaluate_diagnostic","payload":{
            "event":validate["payload"].clone(),"current_issue":null,
            "policy":{"policy_id":"default","revision":"1","minimum_occurrences":1,
              "status_by_severity":{"info":"operational","warning":"degraded","error":"partial_outage","critical":"major_outage"}},
            "current_service_status":"operational","now":"2026-09-08T15:00:00Z"
        }});
        let diagnostic_result: Value =
            serde_json::from_str(&dispatch_json_native(&evaluate_diagnostic.to_string()).unwrap())
                .unwrap();
        assert_eq!(diagnostic_result["action"], "create_active");

        let telemetry = json!({"operation":"validate_telemetry_reference","payload":{
            "id":"0199d0a8-2e12-7a59-a51e-44aa9b6d1001","kind":"trace","backend":"grafana-cloud",
            "locator":{"trace_id":"4bf92f3577b34da6a3ce929d0e0e4736"},
            "service_name":"identity","deployment_id":"0199d09a-b692-7ce0-a1c0-5138a43d7402"
        }});
        assert_eq!(
            dispatch_json_native(&telemetry.to_string()).unwrap(),
            "{\"valid\":true}"
        );

        let monitor = json!({"operation":"evaluate_monitor","payload":{
            "policy":{"revision":"1","window_seconds":300,"minimum_samples":2,
              "failure_threshold":{"numerator":1,"denominator":2},"recovery_threshold":{"numerator":0,"denominator":1},
              "latency_threshold_ms":500,"stale_after_seconds":120,
              "quorum":{"minimum_locations":1,"failure_locations":1,"recovery_locations":1},"failure_status":"degraded"},
            "previous_state":"healthy","locations":[{"location":"sin","window_started_at":"2026-09-08T14:55:00Z",
              "sample_count":2,"unhealthy_count":1,"last_observed_at":"2026-09-08T15:00:00Z"}],"now":"2026-09-08T15:00:00Z"}});
        let result: Value =
            serde_json::from_str(&dispatch_json_native(&monitor.to_string()).unwrap()).unwrap();
        assert_eq!(result["state"], "failing");

        let dependency = json!({"operation":"dependency_risk","payload":{
            "graph":{"dependencies":[{"source_service":"identity","target_service":"d1",
                "kind":"required","capability":"lookup","criticality":"critical"}]},
            "source_service":"identity","direct_statuses":{"d1":"major_outage"}
        }});
        let risk: Value =
            serde_json::from_str(&dispatch_json_native(&dependency.to_string()).unwrap()).unwrap();
        assert_eq!(risk["status"], "major_outage");

        let aggregate = json!({"operation":"aggregate_status","payload":{
            "issues":[],"maintenance":[{"active":true}],"monitors":[],
            "operator_override":null,"evaluated_at":"2026-09-08T15:00:00Z"
        }});
        assert_eq!(
            dispatch_json_native(&aggregate.to_string()).unwrap(),
            "\"maintenance\""
        );

        let issue_transition = json!({"operation":"issue_transition","payload":{
            "issue":{"issue_id":"0199d0a8-2e12-7a59-a51e-44aa9b6d1001","fingerprint_hash":"f",
              "service_name":"identity","kind":"dependency.unavailable","impact":"degraded","state":"observed",
              "first_seen_at":"2026-09-08T15:00:00Z","last_seen_at":"2026-09-08T15:00:00Z",
              "occurrence_count":1,"policy_revision":"1","recurrence_of":null,"suppressed_until":null,"revision":1},
            "expected_revision":1,"command":{"type":"confirm"},"at":"2026-09-08T15:00:00Z"
        }});
        let issue_result: Value =
            serde_json::from_str(&dispatch_json_native(&issue_transition.to_string()).unwrap())
                .unwrap();
        assert_eq!(issue_result["issue"]["state"], "active");

        let incident_transition = json!({"operation":"incident_transition","payload":{
            "incident":{"incident_id":"0199d0a8-2e12-7a59-a51e-44aa9b6d1001","title":"Login failures",
              "state":"investigating","impact":"degraded","started_at":"2026-09-08T15:00:00Z",
              "detected_at":"2026-09-08T15:00:00Z","resolved_at":null,"affected_components":["login"],
              "issue_ids":[],"cause":null,"revision":1},
            "expected_revision":1,"command":{"type":"monitor"},"at":"2026-09-08T15:01:00Z"
        }});
        let incident_result: Value =
            serde_json::from_str(&dispatch_json_native(&incident_transition.to_string()).unwrap())
                .unwrap();
        assert_eq!(incident_result["incident"]["state"], "monitoring");
    }
}

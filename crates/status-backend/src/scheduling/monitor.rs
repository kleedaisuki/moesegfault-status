//! 有界监控折叠；只调用类型化领域函数。 / Bounded monitor folding using typed domain calls only.
use super::types::*;
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{json, Value};
use status_domain::{EvaluationPolicy, EvaluationState, LocationWindow, Quorum, Ratio, Status};
use std::collections::HashSet;

fn time(value: &str) -> Result<DateTime<Utc>, String> {
    DateTime::parse_from_rfc3339(value)
        .map(|v| v.with_timezone(&Utc))
        .map_err(|_| "invalid_observation_time".into())
}
fn iso(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn object(row: &Value, key: &str) -> Result<Value, String> {
    match &row[key] {
        Value::String(s) => serde_json::from_str(s).map_err(|e| e.to_string()),
        value if value.is_object() => Ok(value.clone()),
        _ => Err(format!("invalid_{key}")),
    }
}
/// 转换 SQL 快照；不伪造执行位置。 / Convert a SQL snapshot without inventing execution provenance.
pub fn from_row(
    row: &Value,
    locations: Vec<String>,
    next_run: String,
    claim_revision: u64,
) -> Result<ClaimedMonitor, String> {
    let mut probe = object(row, "probe_config_json")?;
    probe["kind"] = row["probe_kind"].clone();
    let due = row["next_run_at"].as_str().ok_or("missing_due_time")?;
    let next_ms = time(&next_run)?.timestamp_millis();
    let cadence = match row["schedule_kind"].as_str() {
        Some("interval") => row["interval_seconds"]
            .as_i64()
            .and_then(|v| v.checked_mul(1000))
            .filter(|v| *v > 0)
            .ok_or("invalid_interval_schedule")?,
        Some("cron") => super::schedule::next_standard_cron(
            row["schedule_expression"]
                .as_str()
                .ok_or("missing_cron_expression")?,
            next_ms,
        )?
        .checked_sub(next_ms)
        .ok_or("schedule_overflow")?,
        _ => return Err("invalid_schedule_kind".into()),
    };
    serde_json::from_value(json!({
        "monitorId":row["monitor_id"], "locations":locations,"claimRevision":claim_revision,
        "target":{"type":row["target_type"],"id":row["target_id"],"serviceName":row["service_name"]},
        "probe":probe,"timeoutMs":row["timeout_ms"],"intervalMs":cadence,"scheduledFor":due,"nextRunAt":next_run,
        "critical":row["critical"].as_i64()==Some(1),"deploymentId":row["deployment_id"],"environment":row["environment"],
        "policy":{"policyId":row["policy_id"],"revision":row["policy_revision"],
        "observationWindowMs":row["observation_window_seconds"].as_i64().ok_or("invalid_window")?.checked_mul(1000).ok_or("invalid_window")?,
        "minimumSamples":row["minimum_samples"],"failureThreshold":row["failure_threshold"],"recoveryThreshold":row["recovery_threshold"],
        "latencyThresholdMs":row["latency_threshold_ms"],"staleAfterMs":row["stale_after_seconds"].as_i64().ok_or("invalid_staleness")?.checked_mul(1000).ok_or("invalid_staleness")?,
        "locationQuorum":row["location_quorum"],"fingerprintTemplate":object(row,"fingerprint_template_json")?,"statusMapping":object(row,"status_mapping_json")?}
    })).map_err(|e| e.to_string())
}
fn unhealthy(monitor: &ClaimedMonitor, observation: &Observation) -> bool {
    observation.outcome != "success"
        || monitor
            .policy
            .latency_threshold_ms
            .is_some_and(|limit| observation.latency_ms > limit as f64)
}
fn fraction(value: f64) -> Result<Ratio, String> {
    if !value.is_finite() || !(0.0..=1.0).contains(&value) {
        return Err("invalid_policy_threshold".into());
    }
    Ok(Ratio {
        numerator: (value * 1_000_000.0).round() as u32,
        denominator: 1_000_000,
    })
}
fn policy(monitor: &ClaimedMonitor) -> Result<EvaluationPolicy, String> {
    let p = &monitor.policy;
    let failure_status = match p.status_mapping["failure_status"].as_str() {
        Some("degraded") => Status::Degraded,
        Some("partial_outage") => Status::PartialOutage,
        Some("major_outage") => Status::MajorOutage,
        _ => return Err("missing_policy_failure_status".into()),
    };
    Ok(EvaluationPolicy {
        revision: format!("{}:{}", p.policy_id, p.revision),
        window_seconds: p.observation_window_ms.div_euclid(1000)
            + i64::from(p.observation_window_ms.rem_euclid(1000) > 0),
        minimum_samples: p.minimum_samples,
        failure_threshold: fraction(p.failure_threshold)?,
        recovery_threshold: fraction(p.recovery_threshold)?,
        latency_threshold_ms: p.latency_threshold_ms,
        stale_after_seconds: p.stale_after_ms.div_euclid(1000)
            + i64::from(p.stale_after_ms.rem_euclid(1000) > 0),
        quorum: Quorum {
            minimum_locations: p.location_quorum,
            failure_locations: p.location_quorum,
            recovery_locations: p.location_quorum,
        },
        failure_status,
    })
}
fn fold(
    monitor: &ClaimedMonitor,
    previous: Option<&MonitorCheckpoint>,
    o: &Observation,
) -> Result<MonitorCheckpoint, String> {
    let now = time(&o.observed_at)?;
    let reset = match previous {
        None => true,
        Some(p) => {
            p.executor_id != o.execution.executor_id
                || p.actual_colo != o.execution.actual_colo
                || p.policy_id != monitor.policy.policy_id
                || p.policy_revision != monitor.policy.revision
                || now
                    .signed_duration_since(time(&p.window_started_at)?)
                    .num_milliseconds()
                    >= monitor.policy.observation_window_ms
        }
    };
    let prior = previous.filter(|_| !reset);
    let bad = unhealthy(monitor, o);
    let add = |v: u32| {
        v.checked_add(1)
            .ok_or_else(|| "checkpoint_counter_overflow".to_string())
    };
    Ok(MonitorCheckpoint {
        monitor_id: monitor.monitor_id.clone(),
        location: o.execution.location.clone().ok_or("missing_location")?,
        executor_id: o.execution.executor_id.clone(),
        actual_colo: o.execution.actual_colo.clone(),
        window_started_at: prior
            .map_or_else(|| o.observed_at.clone(), |p| p.window_started_at.clone()),
        last_observed_at: o.observed_at.clone(),
        consecutive_successes: if bad {
            0
        } else {
            add(prior.map_or(0, |p| p.consecutive_successes))?
        },
        consecutive_failures: if bad {
            add(prior.map_or(0, |p| p.consecutive_failures))?
        } else {
            0
        },
        window_samples: add(prior.map_or(0, |p| p.window_samples))?,
        window_unhealthy_samples: prior
            .map_or(0, |p| p.window_unhealthy_samples)
            .checked_add(u32::from(bad))
            .ok_or("checkpoint_counter_overflow")?,
        window_latency_p95_ms: None,
        evaluation_status: Status::Unknown,
        evaluated_at: o.observed_at.clone(),
        fresh_until: o.observed_at.clone(),
        policy_id: monitor.policy.policy_id.clone(),
        policy_revision: monitor.policy.revision,
        revision: previous
            .map_or(0, |p| p.revision)
            .checked_add(1)
            .ok_or("checkpoint_revision_overflow")?,
    })
}
/// 同轮先折叠，再以真实机房去重进行一次仲裁。 / Fold the run then evaluate once, deduplicating actual colos.
pub fn evaluate_batch(
    monitor: &ClaimedMonitor,
    previous: &[MonitorCheckpoint],
    observations: &[Observation],
) -> Result<Vec<MonitorEvaluationResult>, String> {
    let observations: Vec<_> = observations
        .iter()
        .filter(|o| {
            o.monitor_id == monitor.monitor_id
                && o.execution
                    .executor_id
                    .as_ref()
                    .is_some_and(|v| !v.is_empty())
                && o.execution
                    .actual_colo
                    .as_ref()
                    .is_some_and(|v| !v.is_empty())
                && o.execution
                    .location
                    .as_ref()
                    .is_some_and(|v| monitor.locations.contains(v))
        })
        .collect();
    if observations.is_empty() {
        return Ok(vec![]);
    }
    let now = observations
        .iter()
        .map(|o| time(&o.observed_at))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .max()
        .ok_or("missing_observations")?;
    let aggregates = observations
        .iter()
        .map(|o| {
            fold(
                monitor,
                previous
                    .iter()
                    .find(|p| Some(&p.location) == o.execution.location.as_ref()),
                o,
            )
        })
        .collect::<Result<Vec<_>, _>>()?;
    let peers = previous.iter().filter(|p| {
        p.policy_id == monitor.policy.policy_id
            && p.policy_revision == monitor.policy.revision
            && !aggregates.iter().any(|a| a.location == p.location)
    });
    let mut seen = HashSet::new();
    let mut windows = vec![];
    for p in aggregates.iter().chain(peers) {
        let Some(colo) = p.actual_colo.as_ref().filter(|v| !v.is_empty()) else {
            continue;
        };
        let last = time(&p.last_observed_at)?;
        if p.executor_id.as_ref().is_none_or(|v| v.is_empty())
            || !monitor.locations.contains(&p.location)
            || last > now
            || now.signed_duration_since(last).num_milliseconds() > monitor.policy.stale_after_ms
            || !seen.insert(colo.clone())
        {
            continue;
        }
        windows.push(LocationWindow {
            location: colo.clone(),
            window_started_at: time(&p.window_started_at)?,
            sample_count: p.window_samples,
            unhealthy_count: p.window_unhealthy_samples,
            last_observed_at: Some(last),
        });
    }
    let first = previous
        .iter()
        .find(|p| Some(&p.location) == observations[0].execution.location.as_ref());
    let state = match first.map(|p| p.evaluation_status) {
        None | Some(Status::Unknown) => EvaluationState::Unknown,
        Some(Status::Operational) => EvaluationState::Healthy,
        _ => EvaluationState::Failing,
    };
    let result = status_domain::evaluate_monitor(&policy(monitor)?, state, &windows, now)
        .map_err(|e| e.to_string())?;
    let expiry = result.fresh_until.ok_or("invalid_evaluator_freshness")?;
    Ok(aggregates
        .into_iter()
        .zip(observations)
        .map(|(mut checkpoint, o)| {
            checkpoint.evaluation_status = result.status;
            checkpoint.evaluated_at = iso(now);
            checkpoint.fresh_until = iso(expiry);
            let bad = result.state == EvaluationState::Failing && unhealthy(monitor, o);
            let severity = monitor.policy.status_mapping["diagnostic_severity"]
                .as_str()
                .filter(|s| matches!(*s, "warning" | "error" | "critical"))
                .unwrap_or(match result.status {
                    Status::MajorOutage => "critical",
                    Status::PartialOutage => "error",
                    _ => "warning",
                });
            MonitorEvaluationResult {
                checkpoint,
                diagnostic_severity: bad.then(|| severity.into()),
                diagnostic_kind: bad.then(|| "health.probe_failed".into()),
                diagnostic_summary: bad.then(|| {
                    format!(
                        "Active {} health probe failed",
                        monitor.probe["kind"].as_str().unwrap_or("unknown")
                    )
                }),
            }
        })
        .collect())
}

/// 转换数据库 snake_case 检查点。 / Decode a snake_case database checkpoint.
pub fn checkpoint_from_row(row: &Value) -> Result<MonitorCheckpoint, String> {
    let mut wire = serde_json::Map::new();
    for (key, value) in row.as_object().ok_or("invalid_checkpoint_row")? {
        let mut pieces = key.split('_');
        let mut name = pieces.next().unwrap_or_default().to_string();
        for piece in pieces {
            let mut chars = piece.chars();
            if let Some(first) = chars.next() {
                name.extend(first.to_uppercase());
                name.extend(chars);
            }
        }
        wire.insert(name, value.clone());
    }
    serde_json::from_value(Value::Object(wire)).map_err(|e| e.to_string())
}
/// 编码数据库 snake_case 检查点。 / Encode a snake_case database checkpoint.
pub fn checkpoint_to_row(checkpoint: &MonitorCheckpoint) -> Value {
    let Value::Object(wire) =
        serde_json::to_value(checkpoint).expect("finite checkpoint serialization")
    else {
        unreachable!()
    };
    let row = wire
        .into_iter()
        .map(|(key, value)| {
            let mut name = String::new();
            for ch in key.chars() {
                if ch.is_ascii_uppercase() {
                    name.push('_');
                    name.push(ch.to_ascii_lowercase());
                } else {
                    name.push(ch);
                }
            }
            (name, value)
        })
        .collect();
    Value::Object(row)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn row_cadence_does_not_include_missed_runs() {
        let mut row = json!({"monitor_id":"m","target_type":"service","target_id":"s","service_name":"s","probe_kind":"http","probe_config_json":"{\"url\":\"https://example.org\"}","timeout_ms":1000,"schedule_kind":"interval","interval_seconds":60,"next_run_at":"2026-09-12T00:00:00Z","critical":1,"policy_id":"p","policy_revision":1,"observation_window_seconds":300,"minimum_samples":1,"failure_threshold":0.5,"recovery_threshold":0.1,"latency_threshold_ms":null,"stale_after_seconds":120,"location_quorum":1,"fingerprint_template_json":"{}","status_mapping_json":"{\"failure_status\":\"degraded\"}"});
        let next = "2026-09-12T00:15:00Z".to_string();
        assert_eq!(
            from_row(&row, vec![], next.clone(), 2).unwrap().interval_ms,
            60_000
        );
        row["schedule_kind"] = json!("cron");
        row["schedule_expression"] = json!("*/5 * * * *");
        assert_eq!(
            from_row(&row, vec![], next, 2).unwrap().interval_ms,
            300_000
        );
    }
    fn monitor() -> ClaimedMonitor {
        serde_json::from_value(json!({"monitorId":"m","locations":["a","b"],"target":{"type":"service","id":"s","serviceName":"s"},"probe":{"kind":"http","url":"https://example.org"},"timeoutMs":1000,"intervalMs":60000,"scheduledFor":"2026-09-12T00:00:00Z","nextRunAt":"2026-09-12T00:01:00Z","critical":true,"policy":{"policyId":"p","revision":1,"observationWindowMs":300000,"minimumSamples":1,"failureThreshold":0.5,"recoveryThreshold":0.1,"latencyThresholdMs":500,"staleAfterMs":120000,"locationQuorum":2,"fingerprintTemplate":{},"statusMapping":{"failure_status":"partial_outage"}}})).unwrap()
    }
    fn observation(location: &str, colo: &str) -> Observation {
        Observation {
            observation_id: location.into(),
            monitor_id: "m".into(),
            observed_at: "2026-09-12T00:00:00Z".into(),
            execution: ExecutionProvenance {
                runtime: "cloudflare-worker".into(),
                location: Some(location.into()),
                executor_id: Some(format!("executor-{location}")),
                actual_colo: Some(colo.into()),
            },
            outcome: "success".into(),
            latency_ms: 20.0,
            protocol_status: None,
            error_type: None,
            correlation_id: "c".into(),
        }
    }
    #[test]
    fn quorum_deduplicates_actual_colo() {
        let m = monitor();
        let same =
            evaluate_batch(&m, &[], &[observation("a", "SIN"), observation("b", "SIN")]).unwrap();
        assert!(same
            .iter()
            .all(|r| r.checkpoint.evaluation_status == Status::Unknown));
        let distinct =
            evaluate_batch(&m, &[], &[observation("a", "SIN"), observation("b", "FRA")]).unwrap();
        assert!(distinct
            .iter()
            .all(|r| r.checkpoint.evaluation_status == Status::Operational));
    }
    #[test]
    fn migration_and_window_boundary_reset_aggregate() {
        let mut m = monitor();
        m.policy.location_quorum = 1;
        let o = observation("a", "SIN");
        let p = evaluate_batch(&m, &[], std::slice::from_ref(&o))
            .unwrap()
            .remove(0)
            .checkpoint;
        let mut next = o.clone();
        next.observed_at = "2026-09-12T00:01:00Z".into();
        assert_eq!(
            evaluate_batch(&m, std::slice::from_ref(&p), std::slice::from_ref(&next)).unwrap()[0]
                .checkpoint
                .window_samples,
            2
        );
        next.execution.executor_id = Some("replacement".into());
        assert_eq!(
            evaluate_batch(&m, std::slice::from_ref(&p), std::slice::from_ref(&next)).unwrap()[0]
                .checkpoint
                .window_samples,
            1
        );
        next = o.clone();
        next.execution.actual_colo = Some("FRA".into());
        assert_eq!(
            evaluate_batch(&m, std::slice::from_ref(&p), &[next]).unwrap()[0]
                .checkpoint
                .window_samples,
            1
        );
        m.policy.revision += 1;
        assert_eq!(
            evaluate_batch(&m, std::slice::from_ref(&p), std::slice::from_ref(&o)).unwrap()[0]
                .checkpoint
                .window_samples,
            1
        );
        m.policy.revision -= 1;
        next = o;
        next.observed_at = "2026-09-12T00:05:00Z".into();
        assert_eq!(
            evaluate_batch(&m, &[p], &[next]).unwrap()[0]
                .checkpoint
                .window_samples,
            1
        );
    }
    #[test]
    fn stale_and_old_policy_peers_do_not_vote() {
        let m = monitor();
        let previous = evaluate_batch(&m, &[], &[observation("a", "SIN"), observation("b", "FRA")])
            .unwrap()
            .into_iter()
            .map(|v| v.checkpoint)
            .collect::<Vec<_>>();
        let mut o = observation("a", "SIN");
        o.observed_at = "2026-09-12T00:02:01Z".into();
        assert_eq!(
            evaluate_batch(&m, &previous, &[o]).unwrap()[0]
                .checkpoint
                .evaluation_status,
            Status::Unknown
        );
        let mut m2 = m;
        m2.policy.revision += 1;
        assert_eq!(
            evaluate_batch(&m2, &previous, &[observation("a", "SIN")]).unwrap()[0]
                .checkpoint
                .evaluation_status,
            Status::Unknown
        );
    }
    #[test]
    fn unhealthy_is_union_and_latency_is_strict() {
        let mut m = monitor();
        m.policy.location_quorum = 1;
        let mut o = observation("a", "SIN");
        o.latency_ms = 500.0;
        let r = evaluate_batch(&m, &[], std::slice::from_ref(&o))
            .unwrap()
            .remove(0);
        assert_eq!(r.checkpoint.window_unhealthy_samples, 0);
        o.outcome = "failure".into();
        o.latency_ms = 501.0;
        let r = evaluate_batch(&m, &[], std::slice::from_ref(&o))
            .unwrap()
            .remove(0);
        assert_eq!(r.checkpoint.window_unhealthy_samples, 1);
        assert_eq!(r.diagnostic_severity.as_deref(), Some("error"));
        o.outcome = "success".into();
        assert_eq!(
            evaluate_batch(&m, &[], &[o]).unwrap()[0]
                .checkpoint
                .window_unhealthy_samples,
            1
        );
    }
    #[test]
    fn checkpoint_wire_and_sql_roundtrip() {
        let r = evaluate_batch(&monitor(), &[], &[observation("a", "SIN")])
            .unwrap()
            .remove(0)
            .checkpoint;
        let row = checkpoint_to_row(&r);
        assert_eq!(row["window_unhealthy_samples"], 0);
        assert_eq!(checkpoint_from_row(&row).unwrap().monitor_id, "m");
        assert!(serde_json::to_value(r).unwrap().get("monitorId").is_some());
    }
}

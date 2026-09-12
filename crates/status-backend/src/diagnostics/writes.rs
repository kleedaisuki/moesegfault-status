//! 纯诊断事务计划；所有副作用均受认领令牌门控。
//! Pure diagnostic transaction planning; every effect is gated by claim ownership.
use crate::database::{DatabaseError, Query, SqlValue};
use serde_json::{json, Value};

/// 同一数据库快照中的行。 / Rows read from one database snapshot.
pub(crate) struct Snapshot {
    /// 不可变策略及绑定版本。 / Immutable policy and binding revisions.
    pub policy: Value,
    /// 尚未解决的 Issue。 / Unresolved issue.
    pub issue: Option<Value>,
    /// 服务当前状态。 / Current service status.
    pub status: Option<Value>,
}
/// 调用方生成的不透明标识。 / Caller-generated opaque identifiers.
pub(crate) struct Ids {
    /// 认领令牌。 / Claim token.
    pub token: String,
    /// 新 Issue。 / New issue.
    pub issue: String,
    /// 故障 occurrence。 / Fault occurrence.
    pub occurrence: String,
    /// 事务断言。 / Transaction assertion.
    pub assertion: String,
    /// 审计。 / Audit.
    pub audit: String,
    /// 发件箱。 / Outbox.
    pub outbox: String,
    /// 与证据数组一一对应。 / One identifier per evidence item.
    pub evidence: Vec<String>,
}
const OWNED: &str =
    "EXISTS(SELECT 1 FROM diagnostic_event_dedup WHERE event_id=? AND processing_token=?)";

/// 只允许 SQL 标量；拒绝对象以防静默损坏。 / Accept only SQL scalars, rejecting silent object corruption.
fn query(sql: impl Into<String>, values: Value) -> Result<Query, DatabaseError> {
    let values = values
        .as_array()
        .ok_or(DatabaseError::InvalidParameter)?
        .iter()
        .map(|v| match v {
            Value::Null => Ok(SqlValue::Null),
            Value::String(s) => Ok(SqlValue::Text(s.clone())),
            Value::Number(n) => n
                .as_i64()
                .map(SqlValue::Integer)
                .ok_or(DatabaseError::InvalidParameter),
            Value::Bool(b) => Ok(SqlValue::Integer(i64::from(*b))),
            _ => Err(DatabaseError::InvalidParameter),
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Query::new(sql, values))
}

/// 构建原子写集，最后一个查询返回去重所有权；调用方插入状态计划。
/// Build atomic writes ending in dedup ownership; the caller inserts status plans.
pub(crate) fn build(
    envelope: &Value,
    snapshot: &Snapshot,
    evaluation: &Value,
    ids: &Ids,
    now: &str,
    digest: &str,
) -> Result<Vec<Query>, DatabaseError> {
    let event = &envelope["event"];
    let p = &snapshot.policy;
    let recovery = event["signal"] == "recovery";
    let evidence = event["evidence"]
        .as_array()
        .ok_or(DatabaseError::InvalidParameter)?;
    if (snapshot.issue.is_some() || !recovery) && evidence.len() != ids.evidence.len() {
        return Err(DatabaseError::InvalidParameter);
    }
    let mut writes = vec![query("INSERT INTO diagnostic_event_dedup(event_id,event_schema_version,service_name,deployment_id,kind,severity,occurred_at,received_at,processed_at,fingerprint_hash,payload_digest,envelope_schema_version,processing_token,producer_subject,correlation_id,trace_id,span_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(event_id) DO NOTHING", json!([event["event_id"],event["schema_version"],event["service_name"],event["deployment_id"],event["kind"],event["severity"],event["occurred_at"],envelope["received_at"],now,evaluation["fingerprint_hash"],digest,envelope["schema_version"],ids.token,envelope["producer"]["subject"],event["correlation_id"],event["trace_id"],event["span_id"]]))?];
    let mut args = vec![json!(ids.assertion)];
    let policy_guard = if p["policy_from_issue"] == 1 {
        args.extend([p["policy_id"].clone(), p["policy_revision"].clone()]);
        "EXISTS(SELECT 1 FROM evaluation_policies WHERE policy_id=? AND revision=?)"
    } else {
        args.extend([
            p["assignment_id"].clone(),
            p["policy_id"].clone(),
            p["policy_revision"].clone(),
            p["policy_binding_revision"].clone(),
        ]);
        "EXISTS(SELECT 1 FROM service_diagnostic_policies WHERE assignment_id=? AND policy_id=? AND policy_revision=? AND revision=?)"
    };
    let mut guards = vec![policy_guard.to_owned()];
    if !recovery {
        guards.push("EXISTS(SELECT 1 FROM service_retention_policies WHERE service_name=? AND policy_id=? AND policy_revision=? AND revision=?)".into());
        args.extend([
            event["service_name"].clone(),
            p["retention_policy_id"].clone(),
            p["retention_policy_revision"].clone(),
            p["retention_binding_revision"].clone(),
        ]);
    }
    let creates = snapshot.issue.is_none() || evaluation["action"] == "create_recurrence";
    if let Some(issue) = &snapshot.issue {
        let state = if recovery {
            " AND state<>'resolved'"
        } else if creates {
            " AND state='resolved'"
        } else {
            ""
        };
        guards.push(format!(
            "EXISTS(SELECT 1 FROM issues WHERE issue_id=? AND revision=?{state})"
        ));
        args.extend([issue["issue_id"].clone(), issue["revision"].clone()]);
    }
    if snapshot.issue.is_none() || (!recovery && creates) {
        guards.push("NOT EXISTS(SELECT 1 FROM issues WHERE service_name=? AND kind=? AND fingerprint_hash=? AND state<>'resolved')".into());
        args.extend([
            event["service_name"].clone(),
            event["kind"].clone(),
            evaluation["fingerprint_hash"].clone(),
        ]);
    }
    args.push(event["service_name"].clone());
    if let Some(status) = &snapshot.status {
        guards.push("EXISTS(SELECT 1 FROM current_statuses WHERE target_type='service' AND target_id=? AND revision=?)".into());
        args.push(status["revision"].clone());
    } else {
        guards.push("NOT EXISTS(SELECT 1 FROM current_statuses WHERE target_type='service' AND target_id=?)".into());
    }
    args.extend([event["event_id"].clone(), json!(ids.token)]);
    writes.push(query(format!("INSERT INTO transaction_assertions(assertion_id,passed) SELECT ?,CASE WHEN {} THEN 1 ELSE 0 END WHERE {OWNED}", guards.join(" AND ")), Value::Array(args))?);
    if recovery {
        append_recovery(&mut writes, envelope, snapshot, evaluation, ids, now)?;
    } else {
        append_fault(
            &mut writes,
            envelope,
            snapshot,
            evaluation,
            ids,
            now,
            creates,
        )?;
    }
    writes.push(query("SELECT event_id,payload_digest,processing_token FROM diagnostic_event_dedup WHERE event_id=?",json!([event["event_id"]]))?);
    Ok(writes)
}

/// 故障写入保持乱序与复发语义。 / Fault writes preserve out-of-order and recurrence semantics.
fn append_fault(
    writes: &mut Vec<Query>,
    envelope: &Value,
    snapshot: &Snapshot,
    evaluation: &Value,
    ids: &Ids,
    now: &str,
    creates: bool,
) -> Result<(), DatabaseError> {
    let event = &envelope["event"];
    let issue_id = if creates {
        json!(ids.issue)
    } else {
        snapshot.issue.as_ref().ok_or(DatabaseError::RowContract)?["issue_id"].clone()
    };
    let before_revision = if creates {
        Value::Null
    } else {
        snapshot.issue.as_ref().ok_or(DatabaseError::RowContract)?["revision"].clone()
    };
    writes.push(query(format!(r#"INSERT INTO issues(issue_id,recurrence_of_issue_id,fingerprint_hash,service_name,kind,severity,state,
    first_seen_at,last_seen_at,occurrence_count,affected_instance_count,policy_id,policy_revision,revision,
    last_fault_event_id,recovery_count,last_recovery_at)
    SELECT ?, (SELECT issue_id FROM issues WHERE service_name=? AND kind=? AND fingerprint_hash=? AND state='resolved'
      ORDER BY resolved_at DESC LIMIT 1), ?, ?, ?, ?, 'observed', ?, ?, 1, 0, ?, ?, 1,?,0,NULL WHERE {OWNED}
      AND NOT EXISTS(SELECT 1 FROM issues WHERE service_name=? AND kind=? AND fingerprint_hash=? AND state<>'resolved')"#), json!([ids.issue,
      event["service_name"],
      event["kind"],
      evaluation["fingerprint_hash"],
      evaluation["fingerprint_hash"],
      event["service_name"],
      event["kind"],
      event["severity"],
      event["occurred_at"],
      event["occurred_at"],
      snapshot.policy["policy_id"],
      snapshot.policy["policy_revision"],
      event["event_id"],
      event["event_id"],
      ids.token,
      event["service_name"],
      event["kind"],
      evaluation["fingerprint_hash"]]))?);
    if !creates {
        writes.push(query(format!(r#"UPDATE issues SET severity=?,state=?,last_seen_at=CASE WHEN last_seen_at>? THEN last_seen_at ELSE ? END,
      occurrence_count=?,policy_id=?,policy_revision=?,resolved_at=CASE WHEN ?='resolved' THEN ? ELSE resolved_at END,
      last_fault_event_id=CASE WHEN ?='record_out_of_order' THEN last_fault_event_id ELSE ? END,
      recovery_count=CASE WHEN ?='record_out_of_order' THEN recovery_count ELSE 0 END,
      last_recovery_at=CASE WHEN ?='record_out_of_order' THEN last_recovery_at ELSE NULL END,
      revision=revision+1 WHERE issue_id=? AND {OWNED}"#), json!([evaluation["severity"],
        evaluation["issue_state"],
        event["occurred_at"],
        event["occurred_at"],
        evaluation["occurrence_count"],
        snapshot.policy["policy_id"],
        snapshot.policy["policy_revision"],
        evaluation["issue_state"],
        now,
        evaluation["action"],
        event["event_id"],
        evaluation["action"],
        evaluation["action"],
        issue_id,
        event["event_id"],
        ids.token]))?);
    } else if evaluation["issue_state"] != "observed" {
        writes.push(query(format!(r#"UPDATE issues SET severity=?,state=?,resolved_at=CASE WHEN ?='resolved' THEN ? ELSE NULL END,
      last_fault_event_id=?,recovery_count=0,last_recovery_at=NULL,
      revision=revision+1 WHERE issue_id=? AND {OWNED}"#), json!([evaluation["severity"],
        evaluation["issue_state"],
        evaluation["issue_state"],
        now,
        event["event_id"],
        issue_id,
        event["event_id"],
        ids.token]))?);
    }
    if !event["instance_id"].is_null() {
        writes.push(query(format!(r#"INSERT INTO issue_instances(issue_id,instance_id,first_seen_at,last_seen_at)
      SELECT ?,?,?,? WHERE {OWNED} ON CONFLICT(issue_id,instance_id) DO UPDATE SET
      last_seen_at=CASE WHEN issue_instances.last_seen_at>excluded.last_seen_at THEN issue_instances.last_seen_at ELSE excluded.last_seen_at END"#), json!([issue_id,
        event["instance_id"],
        event["occurred_at"],
        event["occurred_at"],
        event["event_id"],
        ids.token]))?);
        writes.push(query(format!(r#"UPDATE issues SET affected_instance_count=(SELECT COUNT(*) FROM issue_instances WHERE issue_id=?),
      revision=revision+1 WHERE issue_id=? AND {OWNED}"#), json!([issue_id,
        issue_id,
        event["event_id"],
        ids.token]))?);
    }
    writes.push(query(format!(r#"INSERT INTO issue_occurrences(occurrence_id,issue_id,event_id,service_name,deployment_id,occurred_at,
    observed_at,instance_id,summary,correlation_id,evidence_count,retention_policy_id,retention_policy_revision,purge_after)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ',?,'+'||?||' days') WHERE {OWNED}"#), json!([ids.occurrence,
      issue_id,
      event["event_id"],
      event["service_name"],
      event["deployment_id"],
      event["occurred_at"],
      envelope["received_at"],
      event["instance_id"],
      event["summary"],
      event["correlation_id"],
      event["evidence"].as_array().ok_or(DatabaseError::InvalidParameter)?.len(),
      snapshot.policy["retention_policy_id"],
      snapshot.policy["retention_policy_revision"],
      event["occurred_at"],
      snapshot.policy["occurrence_retention_days"],
      event["event_id"],
      ids.token]))?);
    writes.push(query(
        format!(
            r#"INSERT OR IGNORE INTO incident_occurrences(incident_id,occurrence_id,update_sequence)
      SELECT ii.incident_id,?,ii.update_sequence FROM incident_issues ii
      JOIN incident_current ic ON ic.incident_id=ii.incident_id
      WHERE ii.issue_id=? AND ic.state<>'resolved' AND {OWNED}"#
        ),
        json!([ids.occurrence, issue_id, event["event_id"], ids.token]),
    )?);
    append_evidence(
        writes,
        envelope,
        &issue_id,
        &json!(ids.occurrence),
        ids,
        now,
    )?;
    writes.push(query(format!(r#"INSERT INTO audit_log(audit_id,actor_type,actor_subject,actor_roles_json,action,target_type,target_id,
    before_revision,after_revision,correlation_id,occurred_at,details_json)
    SELECT ?,'machine',?,'[]','diagnostic.issue_aggregated','issue',?, ?,revision,?,?,json_object('event_id',?,'domain_action',?)
    FROM issues WHERE issue_id=? AND {OWNED}"#), json!([ids.audit,
      envelope["producer"]["subject"],
      issue_id,
      before_revision,
      event["correlation_id"],
      now,
      event["event_id"],
      evaluation["action"],
      issue_id,
      event["event_id"],
      ids.token]))?);
    writes.push(query(format!(r#"INSERT INTO outbox(outbox_id,aggregate_type,aggregate_id,event_type,schema_version,payload_json,
    state,attempt_count,available_at,next_attempt_at,created_at)
    SELECT ?,'issue',?,'diagnostic.issue.aggregated','1.0',json_object('issue_id',?,'event_id',?,'action',?),
      'pending',0,?,?,? WHERE {OWNED}"#), json!([ids.outbox,
      issue_id,
      issue_id,
      event["event_id"],
      evaluation["action"],
      now,
      now,
      now,
      event["event_id"],
      ids.token]))?);
    Ok(())
}
/// 恢复不产生故障 occurrence。 / Recovery never creates a fault occurrence.
fn append_recovery(
    writes: &mut Vec<Query>,
    envelope: &Value,
    snapshot: &Snapshot,
    evaluation: &Value,
    ids: &Ids,
    now: &str,
) -> Result<(), DatabaseError> {
    let event = &envelope["event"];
    let Some(issue) = &snapshot.issue else {
        writes.push(query(format!(r#"INSERT INTO audit_log(audit_id,actor_type,actor_subject,actor_roles_json,action,target_type,target_id,
      before_revision,after_revision,correlation_id,occurred_at,details_json)
      SELECT ?,'machine',?,'[]','diagnostic.recovery_unmatched','service',?,NULL,NULL,?,?,
        json_object('event_id',?,'recovery_of_event_id',?,'domain_action',?) WHERE {OWNED}"#), json!([ids.audit,
      envelope["producer"]["subject"],
      event["service_name"],
      event["correlation_id"],
      now,
      event["event_id"],
      event["recovery_of_event_id"],
      evaluation["action"],
      event["event_id"],
      ids.token]))?);
        writes.push(query(format!(r#"INSERT INTO outbox(outbox_id,aggregate_type,aggregate_id,event_type,schema_version,payload_json,
      state,attempt_count,available_at,next_attempt_at,created_at)
      SELECT ?,'service',?,'diagnostic.recovery.unmatched','1.0',json_object('service_name',?,'event_id',?),
      'pending',0,?,?,? WHERE {OWNED}"#), json!([ids.outbox,
      event["service_name"],
      event["service_name"],
      event["event_id"],
      now,
      now,
      now,
      event["event_id"],
      ids.token]))?);
        return Ok(());
    };
    let issue_id = &issue["issue_id"];
    if evaluation["action"] == "begin_recovery" || evaluation["action"] == "resolve_recovery" {
        writes.push(query(
            format!(
                r#"UPDATE issues SET state=?,recovery_count=?,last_recovery_at=?,
          resolved_at=CASE WHEN ?='resolved' THEN ? ELSE NULL END,
          suppression_until=CASE WHEN ?='resolved' THEN NULL ELSE suppression_until END,
          suppression_reason=CASE WHEN ?='resolved' THEN NULL ELSE suppression_reason END,
          revision=revision+1 WHERE issue_id=? AND revision=? AND {OWNED}"#
            ),
            json!([
                evaluation["issue_state"],
                evaluation["recovery_count"],
                evaluation["last_recovery_at"],
                evaluation["issue_state"],
                now,
                evaluation["issue_state"],
                evaluation["issue_state"],
                issue_id,
                snapshot.issue.as_ref().ok_or(DatabaseError::RowContract)?["revision"],
                event["event_id"],
                ids.token
            ]),
        )?);
    }
    append_evidence(writes, envelope, issue_id, &Value::Null, ids, now)?;
    writes.push(query(format!(r#"INSERT INTO audit_log(audit_id,actor_type,actor_subject,actor_roles_json,action,target_type,target_id,
        before_revision,after_revision,correlation_id,occurred_at,details_json)
        SELECT ?,'machine',?,'[]','diagnostic.recovery_evaluated','issue',?,?,revision,?,?,
          json_object('event_id',?,'recovery_of_event_id',?,'domain_action',?,'policy_id',?,'policy_revision',?)
        FROM issues WHERE issue_id=? AND {OWNED}"#), json!([ids.audit,
        envelope["producer"]["subject"],
        issue_id,
        snapshot.issue.as_ref().ok_or(DatabaseError::RowContract)?["revision"],
        event["correlation_id"],
        now,
        event["event_id"],
        event["recovery_of_event_id"],
        evaluation["action"],
        snapshot.policy["policy_id"],
        snapshot.policy["policy_revision"],
        issue_id,
        event["event_id"],
        ids.token]))?);
    writes.push(query(format!(r#"INSERT INTO outbox(outbox_id,aggregate_type,aggregate_id,event_type,schema_version,payload_json,
        state,attempt_count,available_at,next_attempt_at,created_at)
        SELECT ?,'issue',?,'diagnostic.issue.recovery_evaluated','1.0',
          json_object('issue_id',?,'event_id',?,'action',?,'state',state,'revision',revision),
          'pending',0,?,?,? FROM issues WHERE issue_id=? AND {OWNED}"#), json!([ids.outbox,
        issue_id,
        issue_id,
        event["event_id"],
        evaluation["action"],
        now,
        now,
        now,
        issue_id,
        event["event_id"],
        ids.token]))?);
    Ok(())
}
/// 证据来源同时引用 Issue 和活动 incident。 / Link evidence provenance to the issue and active incidents.
fn append_evidence(
    writes: &mut Vec<Query>,
    envelope: &Value,
    issue_id: &Value,
    occurrence_id: &Value,
    ids: &Ids,
    now: &str,
) -> Result<(), DatabaseError> {
    let event = &envelope["event"];
    let token = &ids.token;
    for (evidence, reference_id) in event["evidence"]
        .as_array()
        .ok_or(DatabaseError::InvalidParameter)?
        .iter()
        .zip(&ids.evidence)
    {
        let locator_trace = if evidence["kind"] == "trace" {
            &evidence["locator"]["trace_id"]
        } else {
            &event["trace_id"]
        };
        let locator_span = if evidence["kind"] == "trace" {
            &evidence["locator"]["span_id"]
        } else {
            &event["span_id"]
        };
        writes.push(query(r#"INSERT INTO telemetry_references(telemetry_reference_id,kind,backend_name,locator_json,
      range_start,range_end,service_name,deployment_id,correlation_id,trace_id,span_id,expires_at,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,NULL,? WHERE EXISTS(
        SELECT 1 FROM diagnostic_event_dedup WHERE event_id=? AND processing_token=?)"#, json!([reference_id,
        evidence["kind"],
        evidence["backend"],
        serde_json::to_string(&evidence["locator"]).map_err(|_| DatabaseError::InvalidParameter)?,
        evidence["time_range"]["start"],
        evidence["time_range"]["end"],
        event["service_name"],
        event["deployment_id"],
        event["correlation_id"],
        locator_trace,
        locator_span,
        now,
        event["event_id"],
        token]))?);
        writes.push(query(r#"INSERT INTO issue_telemetry_references(issue_id,telemetry_reference_id,occurrence_id,linked_at)
      SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM diagnostic_event_dedup WHERE event_id=? AND processing_token=?)"#, json!([issue_id,
        reference_id,
        occurrence_id,
        now,
        event["event_id"],
        token]))?);
        writes.push(query(r#"INSERT OR IGNORE INTO incident_telemetry_references(incident_id,telemetry_reference_id,update_sequence)
        SELECT ii.incident_id,?,ii.update_sequence FROM incident_issues ii
        JOIN incident_current ic ON ic.incident_id=ii.incident_id
        WHERE ii.issue_id=? AND ic.state<>'resolved' AND EXISTS(
          SELECT 1 FROM diagnostic_event_dedup WHERE event_id=? AND processing_token=?)"#, json!([reference_id,
        issue_id,
        event["event_id"],
        token]))?);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 穷举领域分支并校验 SQL 参数/所有权。 / Exercise domain branches and check SQL bindings/ownership.
    #[test]
    fn branches_preserve_binding_and_claim_contracts() {
        let ids = Ids {
            token: "token".into(),
            issue: "new".into(),
            occurrence: "occ".into(),
            assertion: "assert".into(),
            audit: "audit".into(),
            outbox: "out".into(),
            evidence: vec!["ref".into()],
        };
        for signal in ["fault", "recovery"] {
            for existing in [false, true] {
                for from_issue in [0, 1] {
                    for action in [
                        "create_issue",
                        "create_recurrence",
                        "record_out_of_order",
                        "begin_recovery",
                        "resolve_recovery",
                    ] {
                        let envelope = json!({"schema_version":"1.0", "received_at":"now", "producer":{"subject":"machine"},"event":{"event_id":"event","signal":signal,"instance_id":"instance","evidence":[{"kind":"trace","backend":"tempo","locator":{"trace_id":"trace","span_id":"span"}}]}});
                        let snapshot = Snapshot {
                            policy: json!({"policy_from_issue":from_issue}),
                            issue: existing.then(|| json!({"issue_id":"existing","revision":3})),
                            status: existing.then(|| json!({"revision":4})),
                        };
                        let evaluation = json!({"action":action,"issue_state":"active"});
                        let writes =
                            build(&envelope, &snapshot, &evaluation, &ids, "now", "digest")
                                .unwrap();
                        for q in &writes {
                            assert_eq!(
                                q.sql().matches('?').count(),
                                q.values().len(),
                                "{}",
                                q.sql()
                            );
                        }
                        assert!(writes[0].sql().contains("ON CONFLICT(event_id) DO NOTHING"));
                        assert!(writes
                            .last()
                            .unwrap()
                            .sql()
                            .starts_with("SELECT event_id,payload_digest,processing_token"));
                        for q in &writes[1..writes.len() - 1] {
                            assert!(
                                q.sql().contains("processing_token=?"),
                                "unguarded write: {}",
                                q.sql()
                            );
                        }
                        if signal == "recovery" {
                            assert!(!writes
                                .iter()
                                .any(|q| q.sql().starts_with("INSERT INTO issue_occurrences")));
                            if existing {
                                let link = writes
                                    .iter()
                                    .find(|q| {
                                        q.sql()
                                            .starts_with("INSERT INTO issue_telemetry_references")
                                    })
                                    .unwrap();
                                assert_eq!(link.values()[2], SqlValue::Null);
                            } else {
                                assert!(!writes.iter().any(|q| q
                                    .sql()
                                    .starts_with("INSERT INTO telemetry_references")));
                            }
                        }
                    }
                }
            }
        }
    }

    /// 严禁通过 zip 丢弃证据。 / Never silently truncate evidence through zip.
    #[test]
    fn rejects_missing_evidence_identifiers() {
        let ids = Ids {
            token: String::new(),
            issue: String::new(),
            occurrence: String::new(),
            assertion: String::new(),
            audit: String::new(),
            outbox: String::new(),
            evidence: vec![],
        };
        let snapshot = Snapshot {
            policy: Value::Null,
            issue: None,
            status: None,
        };
        assert_eq!(
            build(
                &json!({"event":{"evidence":[{}]}}),
                &snapshot,
                &Value::Null,
                &ids,
                "now",
                "digest"
            )
            .unwrap_err(),
            DatabaseError::InvalidParameter
        );
    }
}

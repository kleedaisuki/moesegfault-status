//! 生命周期命令的事务计划；历史只追加，状态迁移直接调用领域核心。
//! Transaction plans for lifecycle commands; append-only history and direct domain transitions.
use super::{assert_changed, decode, now, query, required, row, uuid, Failure, Plan};
use crate::{
    database::{Database, Query, SqlValue},
    wire::{Id, UtcTime},
};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use status_domain::{Incident, IncidentCommand, IncidentState, Issue, IssueCommand};
use std::collections::BTreeSet;

/// 仅分派既有命名命令。 / Dispatch only established named commands.
pub(super) async fn plan(db: &Database, op: &str, raw: &Value) -> Result<Plan, Failure> {
    match op {
        "createIncident" | "updateIncident" => incident(db, op, raw).await,
        "acknowledgeIssue" | "suppressIssue" => issue(db, op, raw).await,
        "createMaintenanceWindow" | "updateMaintenanceWindow" => maintenance(db, op, raw).await,
        "setStatusOverride" => status_override(db, raw).await,
        _ => Err(Failure::invalid("Unknown lifecycle command")),
    }
}
/// 未知字段不是静默的 no-op。 / Unknown fields must not silently become no-ops.
fn fields(v: &Value, allowed: &[&str]) -> Result<(), Failure> {
    let o = v.as_object().ok_or(Failure::invalid("Invalid command"))?;
    if o.keys().any(|k| !allowed.contains(&k.as_str())) {
        return Err(Failure::invalid("Unknown command field"));
    }
    if let Some(id) = o.get("command_id") {
        let _: Id = decode(id)?;
    }
    Ok(())
}
/// Unicode 字符边界长度校验。 / Validate text at Unicode character boundaries.
fn text(v: &Value, key: &str, min: usize, max: usize) -> Result<String, Failure> {
    let s = required(v, key)?;
    if !(min..=max).contains(&s.chars().count()) {
        return Err(Failure::invalid("Invalid text length"));
    }
    Ok(s.into())
}
/// 规范时间解码。 / Decode a canonical timestamp.
fn time(v: &Value, key: &str) -> Result<DateTime<Utc>, Failure> {
    let _: UtcTime = decode(&v[key])?;
    DateTime::parse_from_rfc3339(required(v, key)?)
        .map(|t| t.with_timezone(&Utc))
        .map_err(|_| Failure::invalid("Invalid timestamp"))
}
/// SQL 标量保持 NULL 语义。 / Preserve SQL NULL semantics.
fn sql(v: &Value) -> SqlValue {
    match v {
        Value::String(s) => s.clone().into(),
        Value::Number(n) => n.as_i64().unwrap_or(0).into(),
        _ => SqlValue::Null,
    }
}
/// 有界去重身份集合。 / Bounded deduplicated identity set.
fn ids(
    v: &Value,
    key: &str,
    min: usize,
    max: usize,
    uuid_ids: bool,
) -> Result<Vec<String>, Failure> {
    let a = v[key]
        .as_array()
        .ok_or(Failure::invalid("Invalid relation list"))?;
    if !(min..=max).contains(&a.len()) {
        return Err(Failure::invalid("Invalid relation count"));
    }
    let mut out = BTreeSet::new();
    for x in a {
        let s = x.as_str().ok_or(Failure::invalid("Invalid relation"))?;
        if s.is_empty() || s.len() > 128 {
            return Err(Failure::invalid("Invalid relation"));
        }
        if uuid_ids {
            let _: Id = decode(x)?;
        }
        out.insert(s.to_owned());
    }
    Ok(out.into_iter().collect())
}
/// 仅内部固定表名进入 SQL。 / Only internal fixed table names enter SQL.
async fn validate_ids(
    db: &Database,
    table: &str,
    column: &str,
    ids: &[String],
) -> Result<(), Failure> {
    let found = row(db, format!("SELECT COUNT(*) AS count FROM {table} WHERE {column} IN (SELECT value FROM json_each(?))"), vec![json!(ids).to_string().into()]).await?.ok_or(Failure::internal("Missing relation count"))?;
    if found["count"].as_u64() != Some(ids.len() as u64) {
        return Err(Failure::invalid("Unknown relation target"));
    }
    Ok(())
}
/// 加载稳定排序的关系。 / Load deterministically sorted relations.
async fn relations(
    db: &Database,
    table: &str,
    column: &str,
    id: &str,
) -> Result<Vec<String>, Failure> {
    let rows = db
        .all::<Value>(&query(
            format!("SELECT {column} AS id FROM {table} WHERE incident_id=? ORDER BY {column}"),
            vec![id.into()],
        ))
        .await?;
    rows.iter()
        .map(|r| required(r, "id").map(str::to_owned))
        .collect()
}
/// 验证 revision，不把浮点值当作版本。 / Reject noninteger revisions.
fn revision(raw: &Value, current: &Value) -> Result<i64, Failure> {
    let n = raw["expected_revision"]
        .as_i64()
        .filter(|n| *n > 0 && *n < 9_007_199_254_740_991)
        .ok_or(Failure::invalid("Invalid revision"))?;
    if current["revision"].as_i64() != Some(n) {
        return Err(Failure::conflict("Revision conflict"));
    }
    Ok(n)
}
/// 缺失 patch 字段继承快照，显式 NULL 保留。 / Missing patch fields inherit; explicit NULL is retained.
fn merged(current: &Value, command: &Value) -> Value {
    let mut v = current.clone();
    for (k, x) in command.as_object().into_iter().flatten() {
        v[k] = x.clone();
    }
    v
}
/// 追加关系差分及有限证据固定。 / Append relation deltas and bounded evidence pins.
fn relation_writes(
    out: &mut Vec<Query>,
    table: &str,
    column: &str,
    id: &str,
    seq: i64,
    old: &[String],
    new: &[String],
) {
    for (members, other, action) in [(new, old, "added"), (old, new, "removed")] {
        for item in members {
            if other.contains(item) {
                continue;
            }
            out.push(query(format!("INSERT INTO {table} (incident_id,{column},update_sequence,action) VALUES (?,?,?,?)"),vec![id.into(),item.clone().into(),seq.into(),action.into()]));
            if table == "incident_issue_relations" && action == "added" {
                out.push(query("INSERT OR IGNORE INTO incident_occurrences (incident_id,occurrence_id,update_sequence) SELECT ?,occurrence_id,? FROM issue_occurrences WHERE issue_id=? ORDER BY occurred_at DESC,occurrence_id DESC LIMIT 20",vec![id.into(),seq.into(),item.clone().into()]));
                out.push(query("INSERT OR IGNORE INTO incident_telemetry_references (incident_id,telemetry_reference_id,update_sequence) SELECT ?,telemetry_reference_id,? FROM issue_telemetry_references WHERE issue_id=? ORDER BY linked_at DESC,telemetry_reference_id DESC LIMIT 32",vec![id.into(),seq.into(),item.clone().into()]));
            }
        }
    }
}
/// 创建和 patch 共用一个持久化形状；领域状态机只处理迁移。 / Creation and patch share persistence; domain handles state transitions.
async fn incident(db: &Database, op: &str, raw: &Value) -> Result<Plan, Failure> {
    let create = op == "createIncident";
    let c = &raw["command"];
    fields(
        c,
        if create {
            &[
                "command_id",
                "title",
                "impact",
                "started_at",
                "affected_components",
                "issue_ids",
                "initial_message",
            ]
        } else {
            &[
                "command_id",
                "message",
                "title",
                "state",
                "impact",
                "affected_components",
                "issue_ids",
                "cause",
            ]
        },
    )?;
    let at = now();
    let id = if create {
        uuid()?
    } else {
        let _: Id = decode(&raw["incident_id"])?;
        required(raw, "incident_id")?.into()
    };
    let mut current = if create {
        json!({"revision":0,"cause":null,"resolved_at":null,"state":"investigating","detected_at":at,"updates":[]})
    } else {
        row(
            db,
            "SELECT * FROM incident_current WHERE incident_id=?",
            vec![id.clone().into()],
        )
        .await?
        .ok_or(Failure::missing("Incident not found"))?
    };
    let previous = if create { 0 } else { revision(raw, &current)? };
    let old_issues = if create {
        vec![]
    } else {
        relations(db, "incident_issues", "issue_id", &id).await?
    };
    let old_components = if create {
        vec![]
    } else {
        relations(db, "incident_components", "component_id", &id).await?
    };
    let old_services = if create {
        vec![]
    } else {
        relations(db, "incident_services", "service_name", &id).await?
    };
    if !create {
        current["issue_ids"] = json!(old_issues);
        current["affected_components"] = json!(old_components);
    }
    let next = merged(&current, c);
    let title = text(&next, "title", 1, 256)?;
    let impact = decode(&next["impact"])?;
    let components = ids(
        &next,
        "affected_components",
        usize::from(create),
        256,
        false,
    )?;
    let issues = ids(&next, "issue_ids", 0, 1024, true)?;
    validate_ids(db, "components", "component_id", &components).await?;
    validate_ids(db, "issues", "issue_id", &issues).await?;
    let started = time(&next, "started_at")?;
    let detected = time(&next, "detected_at")?;
    let now_dt = DateTime::parse_from_rfc3339(&at)
        .map_err(|_| Failure::internal("Invalid clock"))?
        .with_timezone(&Utc);
    if started > now_dt {
        return Err(Failure::invalid("Incident cannot start in future"));
    }
    let mut domain = Incident::new(
        id.clone(),
        title.clone(),
        impact,
        started,
        detected,
        components.clone(),
        issues.clone(),
    )
    .map_err(|_| Failure::invalid("Invalid incident"))?;
    domain.state = decode(&current["state"])?;
    domain.revision = previous as u64;
    domain.resolved_at = if current["resolved_at"].is_null() {
        None
    } else {
        Some(time(&current, "resolved_at")?)
    };
    let state: IncidentState = decode(&next["state"])?;
    if domain.state != state {
        let command = match state {
            IncidentState::Identified => IncidentCommand::Identify { cause: None },
            IncidentState::Monitoring => IncidentCommand::Monitor,
            IncidentState::Investigating => IncidentCommand::Regress,
            IncidentState::Resolved => IncidentCommand::Resolve,
        };
        domain
            .apply(previous as u64, command, now_dt)
            .map_err(|_| Failure::conflict("Invalid incident transition"))?;
    }
    if !next["cause"].is_null() {
        text(&next, "cause", 0, 4096)?;
    }
    let message = text(
        c,
        if create { "initial_message" } else { "message" },
        1,
        4096,
    )?;
    let mut services = BTreeSet::new();
    for (table, col, list) in [
        ("issues", "issue_id", &issues),
        ("components", "component_id", &components),
    ] {
        let owners = db.all::<Value>(&query(format!("SELECT DISTINCT service_name FROM {table} WHERE {col} IN (SELECT value FROM json_each(?))"), vec![json!(list).to_string().into()])).await?;
        for owner in owners {
            services.insert(required(&owner, "service_name")?.to_owned());
        }
    }
    let services: Vec<_> = services.into_iter().collect();
    let seq = previous + 1;
    let mut q = vec![];
    if create {
        q.push(query("INSERT INTO incidents (incident_id,started_at,detected_at,created_at,created_by) VALUES (?,?,?,?,?)",vec![id.clone().into(),sql(&next["started_at"]),at.clone().into(),at.clone().into(),sql(&raw["principal"]["subject"])]));
    }
    let resolved = if state == IncidentState::Resolved {
        if current["resolved_at"].is_null() {
            json!(at)
        } else {
            current["resolved_at"].clone()
        }
    } else {
        Value::Null
    };
    let mut values = vec![
        uuid()?.into(),
        id.clone().into(),
        seq.into(),
        title.clone().into(),
        sql(&next["state"]),
        sql(&next["impact"]),
        sql(&next["cause"]),
        message.clone().into(),
        sql(&resolved),
        sql(&raw["principal"]["subject"]),
        sql(&raw["correlation_id"]),
        at.clone().into(),
    ];
    let insert="INSERT INTO incident_updates (update_id,incident_id,sequence,title,state,impact,cause,public_message,resolved_at,actor_subject,correlation_id,occurred_at)";
    if create {
        q.push(query(
            format!("{insert} VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"),
            values,
        ));
    } else {
        values.extend([id.clone().into(), previous.into()]);
        q.push(query(format!("{insert} SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT revision FROM incident_current WHERE incident_id=?)=?"),values));
        q.push(assert_changed());
    }
    relation_writes(
        &mut q,
        "incident_issue_relations",
        "issue_id",
        &id,
        seq,
        &old_issues,
        &issues,
    );
    relation_writes(
        &mut q,
        "incident_component_relations",
        "component_id",
        &id,
        seq,
        &old_components,
        &components,
    );
    relation_writes(
        &mut q,
        "incident_service_relations",
        "service_name",
        &id,
        seq,
        &old_services,
        &services,
    );
    let mut updates = if create {
        vec![]
    } else {
        db.all::<Value>(&query("SELECT sequence,state,impact,public_message AS message,occurred_at AS published_at FROM incident_updates WHERE incident_id=? ORDER BY sequence",vec![id.clone().into()])).await?
    };
    updates.push(json!({"sequence":seq,"state":next["state"],"impact":next["impact"],"message":message,"published_at":at}));
    let response = json!({"incident_id":id,"title":title,"state":next["state"],"impact":next["impact"],"started_at":next["started_at"],"detected_at":next["detected_at"],"resolved_at":resolved,"affected_components":components,"affected_services":services,"issue_ids":issues,"cause":next["cause"],"updates":updates,"revision":seq});
    let mut p = Plan::new(
        q,
        response,
        "incident",
        id,
        if create {
            "incident.created"
        } else {
            "incident.updated"
        },
    );
    p.before_revision = if create { None } else { Some(previous) };
    p.after_revision = Some(seq);
    Ok(p)
}
/// Issue 确认是协作动作；抑制由真实领域状态机验证。 / Acknowledgement is collaboration; suppression uses the real domain state machine.
async fn issue(db: &Database, op: &str, raw: &Value) -> Result<Plan, Failure> {
    let suppress = op == "suppressIssue";
    let _: Id = decode(&raw["issue_id"])?;
    let id = required(raw, "issue_id")?.to_owned();
    let at = now();
    let current=row(db,"SELECT i.*,(SELECT occurred_at FROM issue_actions a WHERE a.issue_id=i.issue_id AND action='acknowledged' ORDER BY issue_revision DESC LIMIT 1) AS acknowledged_at,(SELECT actor_subject FROM issue_actions a WHERE a.issue_id=i.issue_id AND action='acknowledged' ORDER BY issue_revision DESC LIMIT 1) AS acknowledged_by FROM issues i WHERE issue_id=?",vec![id.clone().into()]).await?.ok_or(Failure::missing("Issue not found"))?;
    let rev = revision(raw, &current)?;
    if current["state"] == "resolved" {
        return Err(Failure::conflict("Resolved issue is immutable"));
    }
    let mut q = vec![];
    let action = if suppress {
        "suppressed"
    } else {
        "acknowledged"
    };
    let mut overlay = Value::Null;
    if suppress {
        let until = time(raw, "until")?;
        let reason = text(raw, "reason", 1, 1024)?;
        let at_dt = DateTime::parse_from_rfc3339(&at)
            .map_err(|_| Failure::internal("Invalid clock"))?
            .with_timezone(&Utc);
        if until <= at_dt {
            return Err(Failure::invalid("Suppression must expire in future"));
        }
        let mut domain = Issue {
            issue_id: id.clone(),
            fingerprint_hash: required(&current, "fingerprint_hash")?.into(),
            service_name: required(&current, "service_name")?.into(),
            kind: required(&current, "kind")?.into(),
            impact: status_domain::Status::Degraded,
            state: decode(&current["state"])?,
            first_seen_at: time(&current, "first_seen_at")?,
            last_seen_at: time(&current, "last_seen_at")?,
            occurrence_count: current["occurrence_count"]
                .as_u64()
                .ok_or(Failure::internal("Invalid issue count"))?,
            policy_revision: current["policy_revision"].to_string(),
            recurrence_of: None,
            suppressed_until: None,
            revision: rev as u64,
        };
        domain
            .apply(
                rev as u64,
                IssueCommand::Suppress {
                    until,
                    reason: reason.clone(),
                },
                at_dt,
            )
            .map_err(|_| Failure::conflict("Only active issue can be suppressed"))?;
        q.push(query("UPDATE issues SET state='suppressed',suppression_until=?,suppression_reason=?,revision=revision+1 WHERE issue_id=? AND revision=? AND state='active'",vec![sql(&raw["until"]),reason.into(),id.clone().into(),rev.into()]));
        let policy=row(db,"SELECT diagnostic_rules_json FROM evaluation_policies WHERE policy_id=? AND revision=?",vec![sql(&current["policy_id"]),sql(&current["policy_revision"])]).await?.ok_or(Failure::internal("Missing issue policy"))?;
        overlay = json!({"evaluatedAt":at,"issue":{"issueId":id,"state":"suppressed","severity":current["severity"],"fingerprintHash":current["fingerprint_hash"],"diagnosticRulesJson":policy["diagnostic_rules_json"]}});
    } else {
        q.push(query("UPDATE issues SET revision=revision+1 WHERE issue_id=? AND revision=? AND state<>'resolved'",vec![id.clone().into(),rev.into()]));
    }
    q.push(assert_changed());
    q.push(query("INSERT INTO issue_actions (action_id,issue_id,issue_revision,action,reason,until_at,actor_subject,correlation_id,occurred_at) VALUES (?,?,?,?,?,?,?,?,?)",vec![uuid()?.into(),id.clone().into(),(rev+1).into(),action.into(),if suppress{sql(&raw["reason"])}else{"".into()},if suppress{sql(&raw["until"])}else{SqlValue::Null},sql(&raw["principal"]["subject"]),sql(&raw["correlation_id"]),at.clone().into()]));
    let evidence_rows=db.all::<Value>(&query("SELECT t.* FROM issue_telemetry_references r JOIN telemetry_references t ON t.telemetry_reference_id=r.telemetry_reference_id WHERE r.issue_id=? ORDER BY r.linked_at DESC,r.telemetry_reference_id DESC LIMIT 32",vec![id.clone().into()])).await?;
    let mut evidence = vec![];
    for e in evidence_rows {
        let locator: Value = serde_json::from_str(required(&e, "locator_json")?)
            .map_err(|_| Failure::internal("Invalid evidence locator"))?;
        let mut v = json!({"id":e["telemetry_reference_id"],"kind":e["kind"],"backend":e["backend_name"],"locator":locator,"service_name":e["service_name"],"deployment_id":e["deployment_id"]});
        for key in ["correlation_id", "trace_id", "span_id", "expires_at"] {
            if !e[key].is_null() {
                v[key] = e[key].clone();
            }
        }
        if !e["range_start"].is_null() && !e["range_end"].is_null() {
            v["time_range"] = json!({"start":e["range_start"],"end":e["range_end"]});
        }
        evidence.push(v);
    }
    let mut response = json!({"issue_id":id,"fingerprint_hash":format!("sha256:{}",required(&current,"fingerprint_hash")?),"policy_revision":format!("{}:{}",required(&current,"policy_id")?,current["policy_revision"]),"latest_evidence":evidence,"revision":rev+1});
    for key in [
        "service_name",
        "kind",
        "severity",
        "state",
        "first_seen_at",
        "last_seen_at",
        "occurrence_count",
        "affected_instance_count",
        "acknowledged_at",
        "acknowledged_by",
        "suppression_reason",
    ] {
        response[key] = current[key].clone();
    }
    response["suppressed_until"] = current["suppression_until"].clone();
    if suppress {
        response["state"] = json!("suppressed");
        response["suppressed_until"] = raw["until"].clone();
        response["suppression_reason"] = raw["reason"].clone();
    } else {
        response["acknowledged_at"] = json!(at);
        response["acknowledged_by"] = raw["principal"]["subject"].clone();
    }
    let mut p = Plan::new(
        q,
        response,
        "issue",
        id,
        if suppress {
            "issue.suppressed"
        } else {
            "issue.acknowledged"
        },
    );
    p.before_revision = Some(rev);
    p.after_revision = Some(rev + 1);
    if suppress {
        p.reevaluate
            .push(("service".into(), required(&current, "service_name")?.into()));
        p.details =
            json!({"until":raw["until"],"reason":raw["reason"],"reevaluation_overlay":overlay});
    }
    Ok(p)
}
/// 维护状态由半开时间区间决定，显式取消优先。 / Maintenance state follows a half-open interval, with cancellation taking precedence.
async fn maintenance(db: &Database, op: &str, raw: &Value) -> Result<Plan, Failure> {
    let create = op == "createMaintenanceWindow";
    let c = &raw["command"];
    fields(
        c,
        if create {
            &[
                "command_id",
                "title",
                "description",
                "starts_at",
                "ends_at",
                "expected_impact",
                "target_services",
                "target_components",
            ]
        } else {
            &[
                "command_id",
                "title",
                "description",
                "starts_at",
                "ends_at",
                "expected_impact",
                "target_services",
                "target_components",
                "state",
            ]
        },
    )?;
    if !create && c.as_object().is_some_and(|o| o.len() < 2) {
        return Err(Failure::invalid("Empty maintenance patch"));
    }
    let id = if create {
        uuid()?
    } else {
        let _: Id = decode(&raw["id"])?;
        required(raw, "id")?.into()
    };
    let at = now();
    let mut old = if create {
        json!({"revision":0,"target_services":[],"target_components":[]})
    } else {
        row(
            db,
            "SELECT * FROM maintenance_windows WHERE maintenance_id=?",
            vec![id.clone().into()],
        )
        .await?
        .ok_or(Failure::missing("Maintenance not found"))?
    };
    let rev = if create { 0 } else { revision(raw, &old)? };
    if old["state"] == "completed" || old["state"] == "cancelled" {
        return Err(Failure::conflict("Terminal maintenance is immutable"));
    }
    if !create {
        let targets=db.all::<Value>(&query("SELECT target_type,target_id FROM maintenance_targets WHERE maintenance_id=? ORDER BY target_id",vec![id.clone().into()])).await?;
        for (kind, key) in [
            ("service", "target_services"),
            ("component", "target_components"),
        ] {
            old[key] = json!(targets
                .iter()
                .filter(|t| t["target_type"] == kind)
                .map(|t| t["target_id"].clone())
                .collect::<Vec<_>>());
        }
    }
    let next = merged(&old, c);
    let title = text(&next, "title", 1, 256)?;
    let description = text(&next, "description", 1, 4096)?;
    let _: status_domain::IncidentImpact = decode(&next["expected_impact"])?;
    let starts = time(&next, "starts_at")?;
    let ends = time(&next, "ends_at")?;
    if starts >= ends {
        return Err(Failure::invalid("Invalid maintenance interval"));
    }
    let now_dt = DateTime::parse_from_rfc3339(&at)
        .map_err(|_| Failure::internal("Invalid clock"))?
        .with_timezone(&Utc);
    if let Some(state) = c.get("state") {
        if !["scheduled", "active", "cancelled"]
            .iter()
            .any(|s| state == s)
        {
            return Err(Failure::invalid("Invalid maintenance state"));
        }
    }
    let state = if c["state"] == "cancelled" {
        "cancelled"
    } else if ends <= now_dt {
        "completed"
    } else if starts <= now_dt {
        "active"
    } else {
        "scheduled"
    };
    let services = ids(&next, "target_services", 0, 256, false)?;
    let components = ids(&next, "target_components", 0, 256, false)?;
    if services.is_empty() && components.is_empty() {
        return Err(Failure::invalid("Maintenance requires target"));
    }
    validate_ids(db, "services", "service_name", &services).await?;
    validate_ids(db, "components", "component_id", &components).await?;
    let mut q = vec![];
    if create {
        q.push(query("INSERT INTO maintenance_windows (maintenance_id,title,description,expected_impact,starts_at,ends_at,state,created_by,created_at,updated_at,revision) VALUES (?,?,?,?,?,?,?,?,?,?,1)",vec![id.clone().into(),title.clone().into(),description.clone().into(),sql(&next["expected_impact"]),sql(&next["starts_at"]),sql(&next["ends_at"]),state.into(),sql(&raw["principal"]["subject"]),at.clone().into(),at.clone().into()]));
    } else {
        q.push(query("UPDATE maintenance_windows SET title=?,description=?,expected_impact=?,starts_at=?,ends_at=?,state=?,updated_at=?,revision=revision+1 WHERE maintenance_id=? AND revision=?",vec![title.clone().into(),description.clone().into(),sql(&next["expected_impact"]),sql(&next["starts_at"]),sql(&next["ends_at"]),state.into(),at.clone().into(),id.clone().into(),rev.into()]));
        q.push(assert_changed());
        q.push(query(
            "DELETE FROM maintenance_targets WHERE maintenance_id=?",
            vec![id.clone().into()],
        ));
    }
    let mut targets = vec![];
    let mut reevaluate = BTreeSet::new();
    for (kind, key, list) in [
        ("service", "target_services", &services),
        ("component", "target_components", &components),
    ] {
        for target in list {
            q.push(query("INSERT INTO maintenance_targets (maintenance_id,target_type,target_id) VALUES (?,?,?)",vec![id.clone().into(),kind.into(),target.clone().into()]));
            targets.push(json!({"type":kind,"id":target}));
            reevaluate.insert((kind.to_owned(), target.clone()));
        }
        for target in ids(&old, key, 0, 256, false)? {
            reevaluate.insert((kind.to_owned(), target));
        }
    }
    let response = json!({"maintenance_id":id,"title":title,"description":description,"expected_impact":next["expected_impact"],"starts_at":next["starts_at"],"ends_at":next["ends_at"],"state":state,"created_by":if create{raw["principal"]["subject"].clone()}else{old["created_by"].clone()},"target_services":services,"target_components":components,"revision":rev+1});
    let mut p = Plan::new(
        q,
        response,
        "maintenance",
        id.clone(),
        if create {
            "maintenance.created"
        } else {
            "maintenance.updated"
        },
    );
    p.before_revision = if create { None } else { Some(rev) };
    p.after_revision = Some(rev + 1);
    p.reevaluate = reevaluate.into_iter().collect();
    p.details = json!({"reevaluation_overlay":{"evaluatedAt":at,"maintenance":{"maintenanceId":id,"state":state,"startsAt":next["starts_at"],"endsAt":next["ends_at"],"targets":targets}}});
    Ok(p)
}
/// 到期覆盖可以原子替换，活跃覆盖不得隐式撤销。 / Expired overrides may be atomically replaced; active overrides cannot be silently revoked.
async fn status_override(db: &Database, raw: &Value) -> Result<Plan, Failure> {
    let c = &raw["command"];
    fields(
        c,
        &["command_id", "target", "status", "expires_at", "reason"],
    )?;
    let target = &c["target"];
    let kind = required(target, "target_type")?;
    fields(
        target,
        if kind == "service" {
            &["target_type", "service_name"]
        } else {
            &["target_type", "service_name", "component_id"]
        },
    )?;
    if !["service", "component"].contains(&kind) {
        return Err(Failure::invalid("Invalid override target"));
    }
    let service = text(target, "service_name", 1, 63)?;
    let target_id = if kind == "service" {
        service.clone()
    } else {
        text(target, "component_id", 1, 128)?
    };
    validate_ids(
        db,
        "services",
        "service_name",
        std::slice::from_ref(&service),
    )
    .await?;
    if kind == "component" {
        let owner = row(
            db,
            "SELECT service_name FROM components WHERE component_id=?",
            vec![target_id.clone().into()],
        )
        .await?
        .ok_or(Failure::invalid("Unknown component"))?;
        if owner["service_name"] != service {
            return Err(Failure::invalid("Component does not belong to service"));
        }
    }
    let status = required(c, "status")?;
    if ![
        "operational",
        "degraded",
        "partial_outage",
        "major_outage",
        "unknown",
    ]
    .contains(&status)
    {
        return Err(Failure::invalid("Invalid override status"));
    }
    let reason = text(c, "reason", 1, 1024)?;
    let expires = time(c, "expires_at")?;
    let at = now();
    let now_dt = DateTime::parse_from_rfc3339(&at)
        .map_err(|_| Failure::internal("Invalid clock"))?
        .with_timezone(&Utc);
    if expires <= now_dt {
        return Err(Failure::invalid("Override expiry must be in future"));
    }
    let existing=row(db,"SELECT override_id,expires_at,revision FROM status_overrides WHERE target_type=? AND target_id=? AND revoked_at IS NULL",vec![kind.into(),target_id.clone().into()]).await?;
    let id = uuid()?;
    let mut q = vec![];
    if let Some(old) = &existing {
        if time(old, "expires_at")? > now_dt {
            return Err(Failure::conflict("Active override already exists"));
        }
        q.push(query("UPDATE status_overrides SET revoked_at=?,revoked_by=?,revision=revision+1 WHERE override_id=? AND revoked_at IS NULL AND expires_at<=? AND revision=?",vec![at.clone().into(),sql(&raw["principal"]["subject"]),sql(&old["override_id"]),at.clone().into(),sql(&old["revision"])]));
        q.push(assert_changed());
        q.push(query("INSERT INTO audit_log (audit_id,actor_type,actor_subject,actor_roles_json,action,target_type,target_id,before_revision,after_revision,correlation_id,occurred_at,details_json) VALUES (?,'human',?,?,'status_override.expired_replaced','status_override',?,?,?,?,?,?)",vec![uuid()?.into(),sql(&raw["principal"]["subject"]),raw["principal"]["roles"].to_string().into(),sql(&old["override_id"]),sql(&old["revision"]),(old["revision"].as_i64().ok_or(Failure::internal("Invalid override revision"))?+1).into(),sql(&raw["correlation_id"]),at.clone().into(),json!({"replacement_override_id":id}).to_string().into()]));
    }
    q.push(query("INSERT INTO status_overrides (override_id,target_type,target_id,status,reason,starts_at,expires_at,actor_subject,correlation_id,created_at,revision) VALUES (?,?,?,?,?,?,?,?,?,?,1)",vec![id.clone().into(),kind.into(),target_id.clone().into(),status.into(),reason.clone().into(),at.clone().into(),sql(&c["expires_at"]),sql(&raw["principal"]["subject"]),sql(&raw["correlation_id"]),at.clone().into()]));
    let response = json!({"override_id":id,"target":target,"status":status,"expires_at":c["expires_at"],"reason":reason,"created_at":at,"created_by":raw["principal"]["subject"],"revision":1});
    let mut p = Plan::new(
        q,
        response,
        "status_override",
        id.clone(),
        "status_override.created",
    );
    p.reevaluate.push((kind.into(), target_id.clone()));
    p.details = json!({"target_type":kind,"target_id":target_id,"status":status,"expires_at":c["expires_at"],"replaced_override_id":existing.as_ref().map(|v|v["override_id"].clone()),"reevaluation_overlay":{"evaluatedAt":at,"override":{"overrideId":id,"target":{"type":kind,"id":target_id},"status":status,"startsAt":at,"expiresAt":c["expires_at"],"revoked":false}}});
    Ok(p)
}

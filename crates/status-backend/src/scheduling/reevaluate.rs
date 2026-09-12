//! 一致快照状态规划与原子提交。 / Consistent-snapshot status planning and atomic commit.
use crate::database::{Database, DatabaseError, Query, SqlValue};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

/// 尚未提交的领域输入；调用方必须把 guard 放在所有 mutation 前面。
/// Pending domain inputs; callers must place the guard before every mutation.
#[derive(Default)]
pub struct EvaluationOverlay {
    /// 完整 issue 行替换，按 issue_id 匹配，含 state/severity/diagnostic_rules_json/fingerprint_hash。
    /// Full issue-row replacements keyed by issue_id, with state, severity, rules and fingerprint.
    pub issues: Vec<Value>,
    /// 诊断 claim 身份及 token。 / Diagnostic claim identity and token.
    pub ownership: Option<(String, String)>,
    /// 因果来源种类及身份。 / Causal source kind and identity.
    pub source: Option<(String, String)>,
    /// 固定策略身份和证据期限。 / Pinned policy identity and evidence deadline.
    pub policy: Option<Value>,
    /// 同 batch 待写服务状态，保证组件支撑平面一致。 / Pending service states preserve component support consistency.
    pub service_statuses: Vec<Value>,
    /// 单个维护窗口替换，含 maintenance_id/state/starts_at/ends_at/targets。
    /// Maintenance replacement with identity, lifecycle, times and targets.
    pub maintenance: Option<Value>,
    /// 单个覆盖替换，含 override_id/target_type/target_id/status/starts_at/expires_at/revoked/audit_id。
    /// Override replacement with identity, target, status, times, revocation and audit ID.
    pub operator_override: Option<Value>,
}

/// 立即评估并提交；失败不留下部分状态。 / Evaluate and commit without partial state on failure.
pub async fn reevaluate(
    db: &Database,
    target_type: &str,
    target_id: &str,
    now: &str,
) -> Result<(), DatabaseError> {
    let writes = plan_reevaluation(db, target_type, target_id, now).await?;
    db.batch(&writes).await?;
    Ok(())
}

/// 规划 guard 与写入；不得先提交触发本次评估的 mutation。
/// Plan guard and writes; do not commit the causal mutation first.
pub async fn plan_reevaluation(
    db: &Database,
    target_type: &str,
    target_id: &str,
    now: &str,
) -> Result<Vec<Query>, DatabaseError> {
    plan_reevaluation_with_overlay(
        db,
        target_type,
        target_id,
        now,
        &EvaluationOverlay::default(),
    )
    .await
}

/// 从单个事务快照规划；返回首项为 generation guard，其余为原子状态写入。
/// Plan from one transactional snapshot; first query is generation guard, remaining queries are status writes.
/// 调用例 / Usage: `batch([plan.remove(0), mutation, ...plan])`.
pub async fn plan_reevaluation_with_overlay(
    db: &Database,
    kind: &str,
    id: &str,
    now: &str,
    overlay: &EvaluationOverlay,
) -> Result<Vec<Query>, DatabaseError> {
    if !matches!(kind, "service" | "component")
        || chrono::DateTime::parse_from_rfc3339(now).is_err()
    {
        return Err(DatabaseError::InvalidParameter);
    }
    let queries = vec![
        q(EVALUATION_GENERATION_SQL, &[]),
        q(
            ISSUE_SIGNALS_SQL,
            &[kind, id, kind, id, now, now, kind, id, kind, id],
        ),
        q(MAINTENANCE_SIGNALS_SQL, &[kind, id, kind, id, now, now]),
        q(MONITOR_SIGNALS_SQL, &[kind, id]),
        q(OVERRIDE_SIGNAL_SQL, &[kind, id, now, now]),
        q(CURRENT_STATUS_SQL, &[kind, id]),
        q(SUPPORTING_SERVICE_STATUS_SQL, &[kind, id]),
        q(TARGET_CONTEXT_SQL, &[kind, kind, id]),
        q(SERVICE_DIRECT_STATUSES_SQL, &[]),
        q(SERVICE_DEPENDENCIES_SQL, &[]),
        q(FANOUT_TARGETS_SQL, &[kind, id, id, kind, id]),
    ];
    let snapshot = db.batch(&queries).await?;
    let mut rows: Vec<Vec<Value>> = snapshot.into_iter().map(|r| r.results).collect();
    if rows.len() != 11 {
        return Err(DatabaseError::RowContract);
    }
    for pending in &overlay.service_statuses {
        for support in &mut rows[6] {
            if support["service_name"] == pending["service_name"] {
                support["effective_impact"] = pending["effective_impact"].clone();
                support["fresh_until"] = pending["fresh_until"].clone();
            }
        }
        for service in &mut rows[8] {
            if service["service_name"] == pending["service_name"] {
                service["direct_status"] = pending["direct_status"].clone();
                service["fresh_until"] = pending["fresh_until"].clone();
            }
        }
    }
    let generation = rows[0]
        .first()
        .and_then(|r| r["generation"].as_i64())
        .ok_or(DatabaseError::RowContract)?;
    let context = rows[7].first().ok_or(DatabaseError::RowContract)?;
    let service = string(context, "service_name")?;
    let mut maintenance = rows[2].clone();
    apply_maintenance(
        &mut maintenance,
        overlay.maintenance.as_ref(),
        kind,
        id,
        service,
        now,
    )?;
    let mut issues = rows[1].clone();
    for issue in &overlay.issues {
        let issue_id = string(issue, "issue_id")?;
        issues.retain(|r| r["issue_id"].as_str() != Some(issue_id));
        if matches!(issue["state"].as_str(), Some("active" | "recovering"))
            && issue["service_name"].as_str().is_none_or(|s| s == service)
        {
            issues.push(issue.clone());
        }
    }
    let fingerprints: BTreeSet<String> =
        rows[3].iter().map(fingerprint).collect::<Result<_, _>>()?;
    let mut signals = Vec::new();
    for issue in issues {
        if kind == "component" && !fingerprints.contains(string(&issue, "fingerprint_hash")?) {
            continue;
        }
        let rules: Value = serde_json::from_str(string(&issue, "diagnostic_rules_json")?)
            .map_err(|_| DatabaseError::RowContract)?;
        let severity = string(&issue, "severity")?;
        let impact = rules["status_by_severity"][severity]
            .as_str()
            .or(rules["contract"]["failure_status"].as_str())
            .ok_or(DatabaseError::RowContract)?;
        if !matches!(impact, "degraded" | "partial_outage" | "major_outage") {
            return Err(DatabaseError::RowContract);
        }
        signals.push(json!({"state":issue["state"],"impact":impact,"covered_by_maintenance":!maintenance.is_empty()}));
    }
    let mut operator = rows[4].first().cloned();
    if let Some(value) = &overlay.operator_override {
        if operator
            .as_ref()
            .is_some_and(|r| r["override_id"] == value["override_id"])
        {
            operator = None;
        }
        if value["target_type"] == kind
            && value["target_id"] == id
            && value["revoked"] != true
            && string(value, "starts_at")? <= now
            && string(value, "expires_at")? > now
        {
            operator = Some(value.clone());
        }
    }
    let direct = aggregate(
        json!({"issues":signals,"maintenance":maintenance.iter().map(|_|json!({"active":true})).collect::<Vec<_>>(),"monitors":monitor_signals(&rows[3],now)?,"operator_override":operator.as_ref().map(|r|json!({"status":r["status"],"expires_at":r["expires_at"],"audit_id":r["audit_id"]})),"evaluated_at":now}),
    )?;
    let direct = direct.as_str().ok_or(DatabaseError::RowContract)?;
    let current = rows[5].first();
    let mut deadlines = monitor_deadlines(&rows[3], now);
    deadlines.extend(
        maintenance
            .iter()
            .chain(rows[6].iter())
            .filter_map(|r| r["fresh_until"].as_str()),
    );
    if let Some(until) = current
        .and_then(|r| r["fresh_until"].as_str())
        .filter(|s| *s > now)
    {
        deadlines.push(until);
    }
    if let Some(until) = operator.as_ref().and_then(|r| r["expires_at"].as_str()) {
        deadlines.push(until);
    }
    if let Some(until) = overlay
        .policy
        .as_ref()
        .and_then(|p| p["fresh_until"].as_str())
    {
        deadlines.push(until);
    }
    let own_deadline = deadlines.into_iter().min().unwrap_or(now);
    let (risk, fresh) = if kind == "service" {
        service_risk(id, direct, own_deadline, now, &rows[8], &rows[9])?
    } else {
        (
            support_risk(&rows[6], now)?.to_owned(),
            own_deadline.to_owned(),
        )
    };
    let effective = if rank(&risk) > rank(direct) {
        risk.as_str()
    } else {
        direct
    };
    let revision = current.and_then(|r| r["revision"].as_i64()).unwrap_or(0);
    let next = revision.checked_add(1).ok_or(DatabaseError::RowContract)?;
    let transition = uuid(now, &format!("{kind}:{id}:{next}:{effective}"))?;
    let policy_id = overlay
        .policy
        .as_ref()
        .or(current)
        .map(|r| sql(&r["policy_id"]))
        .unwrap_or(SqlValue::Null);
    let policy_revision = overlay
        .policy
        .as_ref()
        .or(current)
        .map(|r| sql(&r["policy_revision"]))
        .unwrap_or(SqlValue::Null);
    let fanout_changed = current.is_none_or(|r| {
        r["direct_status"] != direct
            || r["effective_impact"] != effective
            || r["fresh_until"].as_str() != Some(fresh.as_str())
    });
    let mut writes = vec![Query::new("INSERT INTO transaction_assertions(assertion_id,passed) VALUES (?,CASE WHEN COALESCE((SELECT generation FROM evaluation_generation WHERE singleton_id=1),-1)=? THEN 1 ELSE 0 END)",vec![format!("evaluation-generation:{generation}").into(),generation.into()])];
    writes.push(Query::new(
        UPSERT_CURRENT_STATUS_SQL.replace("__OWNED__", "1"),
        vec![
            kind.into(),
            id.into(),
            direct.into(),
            risk.clone().into(),
            effective.into(),
            now.into(),
            fresh.into(),
            policy_id.clone(),
            policy_revision.clone(),
            if current.is_some() {
                revision.into()
            } else {
                SqlValue::Null
            },
            revision.into(),
        ],
    ));
    writes.push(Query::new("INSERT INTO transaction_assertions(assertion_id,passed) VALUES (?,CASE WHEN changes()=1 THEN 1 ELSE 0 END)",vec![format!("status-plan:{kind}:{id}:{next}").into()]));
    if current.and_then(|r| r["effective_impact"].as_str()) != Some(effective) {
        writes.push(Query::new(
            INSERT_STATUS_TRANSITION_SQL.replace("__OWNED__", "1"),
            vec![
                transition.clone().into(),
                kind.into(),
                id.into(),
                kind.into(),
                id.into(),
                current
                    .map(|r| sql(&r["effective_impact"]))
                    .unwrap_or(SqlValue::Null),
                effective.into(),
                overlay
                    .source
                    .as_ref()
                    .map(|s| s.0.clone())
                    .unwrap_or_else(|| "issue".into())
                    .into(),
                overlay
                    .source
                    .as_ref()
                    .map(|s| s.1.clone())
                    .unwrap_or_else(|| transition.clone())
                    .into(),
                policy_id,
                policy_revision,
                now.into(),
                kind.into(),
                id.into(),
                next.into(),
                effective.into(),
            ],
        ));
        writes.push(Query::new(
            INSERT_STATUS_AUDIT_SQL.replace("__OWNED__", "1"),
            vec![
                uuid(now, &format!("{transition}:audit"))?.into(),
                kind.into(),
                id.into(),
                if current.is_some() {
                    revision.into()
                } else {
                    SqlValue::Null
                },
                next.into(),
                transition.clone().into(),
                now.into(),
                kind.into(),
                id.into(),
                next.into(),
                effective.into(),
            ],
        ));
        writes.push(outbox(
            INSERT_STATUS_OUTBOX_SQL,
            now,
            &transition,
            kind,
            id,
            json!({"target_type":kind,"target_id":id,"status":effective,"revision":next}),
            kind,
            id,
            next,
            effective,
        )?);
    }
    // 直接状态和 freshness 变化同样影响下游，即便 effective 不变。
    // Direct status and freshness changes affect downstream even if effective status is unchanged.
    if fanout_changed {
        for target in &rows[10] {
            let target_kind = string(target, "target_type")?;
            let target_id = string(target, "target_id")?;
            writes.push(outbox(INSERT_FANOUT_OUTBOX_SQL,now,&format!("{transition}:fanout:{target_kind}:{target_id}"),target_kind,target_id,json!({"target_type":target_kind,"target_id":target_id,"source_type":"dependency","source_id":transition}),kind,id,next,effective)?);
        }
    }
    Ok(gate_queries(writes, overlay.ownership.as_ref()))
}

/// 仅替换作用域内维护窗口。 / Replace only maintenance within the target scope.
fn apply_maintenance(
    rows: &mut Vec<Value>,
    overlay: Option<&Value>,
    kind: &str,
    id: &str,
    service: &str,
    now: &str,
) -> Result<(), DatabaseError> {
    let Some(value) = overlay else { return Ok(()) };
    rows.retain(|r| r["maintenance_id"] != value["maintenance_id"]);
    let targets = value["targets"]
        .as_array()
        .ok_or(DatabaseError::RowContract)?;
    let applies = targets.iter().any(|t| {
        (t["type"] == kind && t["id"] == id)
            || (kind == "component" && t["type"] == "service" && t["id"] == service)
    });
    if applies
        && value["state"] == "active"
        && string(value, "starts_at")? <= now
        && string(value, "ends_at")? > now
    {
        rows.push(json!({"maintenance_id":value["maintenance_id"],"fresh_until":value["ends_at"]}));
    }
    Ok(())
}
/// 不再参与仲裁的过期位置不得缩短新 quorum 的证据期限。
/// Expired locations excluded from voting cannot shorten the new quorum proof deadline.
fn monitor_deadlines<'a>(rows: &'a [Value], now: &str) -> Vec<&'a str> {
    rows.iter()
        .filter_map(|r| r["fresh_until"].as_str())
        .filter(|until| *until > now)
        .collect()
}
/// 独立新鲜机房满足 quorum 后采用最新批次裁决；旧 peer 不覆盖新裁决。
/// Once independent fresh colos satisfy quorum, use the newest batch verdict, never an old peer verdict.
fn monitor_signals(rows: &[Value], now: &str) -> Result<Vec<Value>, DatabaseError> {
    let mut groups: BTreeMap<&str, Vec<&Value>> = BTreeMap::new();
    for row in rows {
        groups
            .entry(string(row, "monitor_id")?)
            .or_default()
            .push(row);
    }
    groups
        .values()
        .map(|rows| {
            let quorum = rows[0]["location_quorum"]
                .as_u64()
                .filter(|n| *n > 0)
                .ok_or(DatabaseError::RowContract)?;
            let eligible = rows
                .iter()
                .copied()
                .filter(|r| {
                    r["executor_id"].as_str().is_some_and(|s| !s.is_empty())
                        && r["actual_colo"].as_str().is_some_and(|s| !s.is_empty())
                        && r["fresh_until"].as_str().is_some_and(|s| s > now)
                        && r["evaluated_at"].as_str().is_some_and(|s| s <= now)
                })
                .collect::<Vec<_>>();
            let colos = eligible
                .iter()
                .filter_map(|r| r["actual_colo"].as_str())
                .collect::<BTreeSet<_>>();
            let latest = eligible
                .iter()
                .filter_map(|r| r["evaluated_at"].as_str())
                .max();
            let verdicts = eligible
                .iter()
                .filter(|r| r["evaluated_at"].as_str() == latest)
                .collect::<Vec<_>>();
            let state = if colos.len() < (quorum as usize)
                || verdicts.is_empty()
                || verdicts.iter().any(|r| {
                    r["evaluation_status"].is_null() || r["evaluation_status"] == "unknown"
                }) {
                "unknown"
            } else if verdicts
                .iter()
                .any(|r| r["evaluation_status"] != "operational")
            {
                "failing"
            } else {
                "healthy"
            };
            Ok(json!({"critical":rows.iter().any(|r|r["critical"]==1),"state":state}))
        })
        .collect()
}
/// 规范 probe fingerprint 只决定组件直接 issue 归属。 / Canonical probe fingerprint owns component direct issues.
fn fingerprint(row: &Value) -> Result<String, DatabaseError> {
    let mut fields = json!({"operation":"active-health-probe","capability":row["target_id"]});
    if row["target_type"] == "component" {
        fields["component"] = row["target_id"].clone();
    }
    if row["probe_kind"] != "synthetic" {
        fields["protocol"] = row["probe_kind"].clone();
    }
    let result = status_domain::canonical_fingerprint(
        "health.probe_failed",
        string(row, "service_name")?,
        &fields,
    )
    .map_err(|_| DatabaseError::RowContract)?;
    Ok(result.hash)
}
/// 过期绿色证据不再证明健康，故障不会静默消失。 / Expired green proof is unknown; faults do not silently disappear.
fn fresh_status<'a>(status: Option<&'a str>, until: Option<&str>, now: &str) -> &'a str {
    let status = status.unwrap_or("unknown");
    if !matches!(status, "degraded" | "partial_outage" | "major_outage")
        && until.is_none_or(|s| s <= now)
    {
        "unknown"
    } else {
        status
    }
}
/// 循环安全图风险及可达证据最短期限。 / Cycle-safe graph risk and earliest reachable proof deadline.
fn service_risk(
    id: &str,
    direct: &str,
    until: &str,
    now: &str,
    services: &[Value],
    edges: &[Value],
) -> Result<(String, String), DatabaseError> {
    let mut statuses = serde_json::Map::new();
    let mut deadlines = BTreeMap::new();
    for service in services {
        let name = string(service, "service_name")?;
        statuses.insert(
            name.to_owned(),
            json!(fresh_status(
                service["direct_status"].as_str(),
                service["fresh_until"].as_str(),
                now
            )),
        );
        deadlines.insert(name, string(service, "fresh_until")?);
    }
    statuses.insert(
        id.to_owned(),
        json!(fresh_status(Some(direct), Some(until), now)),
    );
    deadlines.insert(id, until);
    let graph: status_domain::DependencyGraph =
        serde_json::from_value(json!({"dependencies":edges}))
            .map_err(|_| DatabaseError::RowContract)?;
    let statuses: BTreeMap<String, status_domain::Status> =
        serde_json::from_value(Value::Object(statuses)).map_err(|_| DatabaseError::RowContract)?;
    let result = serde_json::to_value(
        status_domain::compute_dependency_risk(&graph, id, &statuses)
            .map_err(|_| DatabaseError::RowContract)?,
    )
    .map_err(|_| DatabaseError::RowContract)?;
    let risk = string(&result, "status")?;
    let risk = if risk == "operational" { "none" } else { risk };
    let mut visited = BTreeSet::new();
    let mut pending = vec![id];
    let mut earliest = until;
    while let Some(node) = pending.pop() {
        if !visited.insert(node) {
            continue;
        }
        earliest = earliest.min(deadlines.get(node).copied().unwrap_or(until));
        for edge in edges {
            if edge["source_service"] == node {
                pending.push(string(edge, "target_service")?);
            }
        }
    }
    Ok((risk.to_owned(), earliest.to_owned()))
}
/// 支撑服务独立风险平面。 / Independent supporting-service risk plane.
fn support_risk<'a>(rows: &'a [Value], now: &str) -> Result<&'a str, DatabaseError> {
    let mut risk = "none";
    for row in rows {
        let status = if row["enabled"] != 1 {
            "unknown"
        } else {
            fresh_status(
                row["effective_impact"].as_str(),
                row["fresh_until"].as_str(),
                now,
            )
        };
        let status = if status == "maintenance" {
            "degraded"
        } else {
            status
        };
        if rank(status) > rank(risk) {
            risk = status;
        }
    }
    Ok(risk)
}
/// 显式状态严重度排序。 / Explicit status severity ordering.
fn rank(status: &str) -> u8 {
    match status {
        "major_outage" => 5,
        "partial_outage" => 4,
        "degraded" => 3,
        "unknown" => 2,
        "maintenance" => 1,
        _ => 0,
    }
}
/// 在数据库边界解码强类型输入，直接调用 Rust 领域函数。
/// Decode typed inputs at the database boundary and directly call Rust domain functions.
fn aggregate(payload: Value) -> Result<Value, DatabaseError> {
    let input: status_domain::AggregationInput =
        serde_json::from_value(payload).map_err(|_| DatabaseError::RowContract)?;
    serde_json::to_value(
        status_domain::aggregate_status(&input).map_err(|_| DatabaseError::RowContract)?,
    )
    .map_err(|_| DatabaseError::RowContract)
}
/// 缺失必需文本立即失败。 / Fail immediately on absent required text.
fn string<'a>(row: &'a Value, key: &str) -> Result<&'a str, DatabaseError> {
    row[key].as_str().ok_or(DatabaseError::RowContract)
}
/// 只绑定数据库标量。 / Bind database scalars only.
fn sql(v: &Value) -> SqlValue {
    match v {
        Value::String(s) => s.clone().into(),
        Value::Number(n) => n.as_i64().map(SqlValue::Integer).unwrap_or(SqlValue::Null),
        _ => SqlValue::Null,
    }
}
/// 文本参数便捷构造器。 / Text parameter convenience constructor.
fn q(sql: &str, args: &[&str]) -> Query {
    Query::new(sql, args.iter().map(|s| (*s).into()).collect())
}
/// 与 TS 稳定身份算法兼容。 / Compatible with the TypeScript stable identity algorithm.
fn uuid(now: &str, seed: &str) -> Result<String, DatabaseError> {
    let ms = chrono::DateTime::parse_from_rfc3339(now)
        .map_err(|_| DatabaseError::InvalidParameter)?
        .timestamp_millis()
        .max(0) as u64;
    let mut b = Sha256::digest(seed.as_bytes());
    let time = ms.to_be_bytes();
    b[..6].copy_from_slice(&time[2..]);
    b[6] = (b[6] & 15) | 112;
    b[8] = (b[8] & 63) | 128;
    let hex = b[..16]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    ))
}
/// outbox 与状态版本检查同事务。 / Outbox and status revision check share a transaction.
#[allow(clippy::too_many_arguments)]
fn outbox(
    statement: &str,
    now: &str,
    seed: &str,
    kind: &str,
    id: &str,
    payload: Value,
    source_kind: &str,
    source_id: &str,
    revision: i64,
    effective: &str,
) -> Result<Query, DatabaseError> {
    Ok(Query::new(
        statement.replace("__OWNED__", "1"),
        vec![
            uuid(now, &format!("{seed}:outbox"))?.into(),
            kind.into(),
            id.into(),
            payload.to_string().into(),
            now.into(),
            now.into(),
            now.into(),
            source_kind.into(),
            source_id.into(),
            revision.into(),
            effective.into(),
        ],
    ))
}
/// 参数化 SQL；保持既有存储契约。 / Parameterized SQL preserving the existing storage contract.
const EVALUATION_GENERATION_SQL: &str =
    r#"SELECT generation FROM evaluation_generation WHERE singleton_id=1"#;
/// 参数化 SQL；保持既有存储契约。 / Parameterized SQL preserving the existing storage contract.
const ISSUE_SIGNALS_SQL: &str = r#"SELECT i.issue_id,i.state,i.severity,i.fingerprint_hash,p.diagnostic_rules_json,
CASE WHEN EXISTS(SELECT 1 FROM maintenance_windows mw JOIN maintenance_targets mt USING(maintenance_id)
  WHERE ((mt.target_type=? AND mt.target_id=?) OR
         (?='component' AND mt.target_type='service' AND mt.target_id=(SELECT service_name FROM components WHERE component_id=?)))
    AND mw.state='active' AND mw.starts_at<=? AND mw.ends_at>?) THEN 1 ELSE 0 END AS covered_by_maintenance
FROM issues i JOIN evaluation_policies p ON p.policy_id=i.policy_id AND p.revision=i.policy_revision
WHERE ((?='service' AND i.service_name=?) OR
       (?='component' AND i.service_name=(SELECT service_name FROM components WHERE component_id=?)))
  AND i.state IN ('active','recovering')"#;
/// 参数化 SQL；保持既有存储契约。 / Parameterized SQL preserving the existing storage contract.
const MAINTENANCE_SIGNALS_SQL: &str = r#"SELECT mw.maintenance_id,1 AS active,mw.ends_at AS fresh_until FROM maintenance_windows mw JOIN maintenance_targets mt USING(maintenance_id)
WHERE ((mt.target_type=? AND mt.target_id=?) OR
       (?='component' AND mt.target_type='service' AND mt.target_id=(SELECT service_name FROM components WHERE component_id=?)))
  AND mw.state='active' AND mw.starts_at<=? AND mw.ends_at>?"#;
/// 参数化 SQL；保持既有存储契约。 / Parameterized SQL preserving the existing storage contract.
const MONITOR_SIGNALS_SQL: &str = r#"SELECT m.monitor_id,ml.location,m.target_type,m.target_id,m.probe_kind,m.critical,
  COALESCE(st.service_name,component.service_name) AS service_name,
  CASE WHEN c.executor_id IS NOT NULL AND c.actual_colo IS NOT NULL THEN c.evaluation_status ELSE NULL END AS evaluation_status,
  CASE WHEN c.executor_id IS NOT NULL AND c.actual_colo IS NOT NULL THEN c.fresh_until ELSE NULL END AS fresh_until,
  c.executor_id,c.actual_colo,c.evaluated_at,p.location_quorum
  FROM monitors m JOIN evaluation_policies p ON p.policy_id=m.policy_id AND p.revision=m.policy_revision
  JOIN status_targets st ON st.target_type=m.target_type AND st.target_id=m.target_id
  LEFT JOIN components component ON component.component_id=st.component_id
  LEFT JOIN monitor_locations ml ON ml.monitor_id=m.monitor_id AND ml.enabled=1
  LEFT JOIN monitor_checkpoints c ON c.monitor_id=m.monitor_id AND c.location=ml.location
    AND c.policy_id=m.policy_id AND c.policy_revision=m.policy_revision
  WHERE m.target_type=? AND m.target_id=? AND m.enabled=1"#;
/// 参数化 SQL；保持既有存储契约。 / Parameterized SQL preserving the existing storage contract.
const OVERRIDE_SIGNAL_SQL: &str = r#"SELECT so.override_id,so.status,so.expires_at,COALESCE((SELECT audit_id FROM audit_log a WHERE a.correlation_id=so.correlation_id ORDER BY occurred_at DESC LIMIT 1),so.override_id) audit_id
FROM status_overrides so WHERE so.target_type=? AND so.target_id=? AND so.revoked_at IS NULL AND so.starts_at<=? AND so.expires_at>? LIMIT 1"#;
/// 参数化 SQL；保持既有存储契约。 / Parameterized SQL preserving the existing storage contract.
const CURRENT_STATUS_SQL: &str =
    r#"SELECT * FROM current_statuses WHERE target_type=? AND target_id=?"#;
/// 参数化 SQL；保持既有存储契约。 / Parameterized SQL preserving the existing storage contract.
const SUPPORTING_SERVICE_STATUS_SQL: &str = r#"SELECT service.service_name,service.enabled,cs.effective_impact,cs.fresh_until
FROM component_services relation
JOIN services service ON service.service_name=relation.service_name
LEFT JOIN current_statuses cs ON cs.target_type='service' AND cs.target_id=relation.service_name
WHERE ?='component' AND relation.component_id=? AND relation.role='supporting'
ORDER BY relation.service_name"#;
/// 参数化 SQL；保持既有存储契约。 / Parameterized SQL preserving the existing storage contract.
const TARGET_CONTEXT_SQL: &str = r#"SELECT CASE WHEN ?='service' THEN st.target_id ELSE component.service_name END AS service_name
FROM status_targets st LEFT JOIN components component ON component.component_id=st.component_id
WHERE st.target_type=? AND st.target_id=?"#;
/// 参数化 SQL；保持既有存储契约。 / Parameterized SQL preserving the existing storage contract.
const SERVICE_DIRECT_STATUSES_SQL: &str = r#"SELECT s.service_name,cs.direct_status,
COALESCE(cs.fresh_until,s.updated_at) AS fresh_until FROM services s
LEFT JOIN current_statuses cs ON cs.target_type='service' AND cs.target_id=s.service_name
WHERE s.enabled=1 ORDER BY s.service_name"#;
/// 参数化 SQL；保持既有存储契约。 / Parameterized SQL preserving the existing storage contract.
const SERVICE_DEPENDENCIES_SQL: &str = r#"SELECT d.source_service,d.target_service,d.capability,d.kind,d.criticality
FROM service_dependencies d
JOIN services source ON source.service_name=d.source_service AND source.enabled=1
JOIN services target ON target.service_name=d.target_service AND target.enabled=1
ORDER BY d.source_service,d.target_service,d.capability"#;
/// 参数化 SQL；保持既有存储契约。 / Parameterized SQL preserving the existing storage contract.
const FANOUT_TARGETS_SQL: &str = r#"SELECT 'service' AS target_type,d.source_service AS target_id
FROM service_dependencies d
JOIN services source ON source.service_name=d.source_service AND source.enabled=1
JOIN services changed ON changed.service_name=d.target_service AND changed.enabled=1
WHERE ?='service' AND d.target_service=? AND d.source_service<>?
UNION
SELECT 'component',relation.component_id FROM component_services relation
JOIN components component ON component.component_id=relation.component_id AND component.enabled=1
JOIN services support ON support.service_name=relation.service_name AND support.enabled=1
WHERE ?='service' AND relation.role='supporting' AND relation.service_name=?
ORDER BY target_type,target_id"#;
/// 参数化 SQL；保持既有存储契约。 / Parameterized SQL preserving the existing storage contract.
const UPSERT_CURRENT_STATUS_SQL: &str = r#"INSERT INTO current_statuses(target_type,target_id,direct_status,dependency_risk,effective_impact,evaluated_at,fresh_until,policy_id,policy_revision,revision)
  SELECT ?,?,?,?,?,?,?,?,?,1 WHERE __OWNED__ ON CONFLICT(target_type,target_id) DO UPDATE SET direct_status=excluded.direct_status,
  dependency_risk=excluded.dependency_risk,effective_impact=excluded.effective_impact,evaluated_at=excluded.evaluated_at,
  fresh_until=excluded.fresh_until,policy_id=excluded.policy_id,policy_revision=excluded.policy_revision,revision=current_statuses.revision+1
  WHERE ? IS NULL OR current_statuses.revision=?"#;
/// 参数化 SQL；保持既有存储契约。 / Parameterized SQL preserving the existing storage contract.
const INSERT_STATUS_TRANSITION_SQL: &str = r#"INSERT INTO status_transitions(transition_id,target_type,target_id,sequence,from_status,to_status,source_type,source_id,policy_id,policy_revision,occurred_at,details_json)
SELECT ?,?,?,COALESCE((SELECT MAX(sequence)+1 FROM status_transitions WHERE target_type=? AND target_id=?),1),?,?,?,?,?,?,?,'{}'
WHERE EXISTS(SELECT 1 FROM current_statuses WHERE target_type=? AND target_id=? AND revision=? AND effective_impact=?) AND __OWNED__"#;
/// 参数化 SQL；保持既有存储契约。 / Parameterized SQL preserving the existing storage contract.
const INSERT_STATUS_AUDIT_SQL: &str = r#"INSERT INTO audit_log(audit_id,actor_type,actor_subject,actor_roles_json,action,target_type,target_id,before_revision,after_revision,correlation_id,occurred_at,details_json)
SELECT ?,'system','status-scheduler','[]','status.reevaluated',?,?,?,?,?,?,'{}'
WHERE EXISTS(SELECT 1 FROM current_statuses WHERE target_type=? AND target_id=? AND revision=? AND effective_impact=?) AND __OWNED__"#;
/// 参数化 SQL；保持既有存储契约。 / Parameterized SQL preserving the existing storage contract.
const INSERT_STATUS_OUTBOX_SQL: &str = r#"INSERT INTO outbox(outbox_id,aggregate_type,aggregate_id,event_type,schema_version,payload_json,state,attempt_count,available_at,next_attempt_at,created_at)
SELECT ?,'status_target',?||':'||?,'status.changed','1.0',?,'pending',0,?,?,?
WHERE EXISTS(SELECT 1 FROM current_statuses WHERE target_type=? AND target_id=? AND revision=? AND effective_impact=?) AND __OWNED__"#;
/// 参数化 SQL；保持既有存储契约。 / Parameterized SQL preserving the existing storage contract.
const INSERT_FANOUT_OUTBOX_SQL: &str = r#"INSERT INTO outbox(outbox_id,aggregate_type,aggregate_id,event_type,schema_version,payload_json,state,attempt_count,available_at,next_attempt_at,created_at)
SELECT ?,'status_target',?||':'||?,'status.reevaluation_requested','1.0',?,'pending',0,?,?,?
WHERE EXISTS(SELECT 1 FROM current_statuses WHERE target_type=? AND target_id=? AND revision=? AND effective_impact=?) AND __OWNED__"#;

/// 管理兼容适配器；前 targets.len() 条 guard 必须放在全部领域写入之前。
/// Admin compatibility adapter; first targets.len() guards precede all domain mutations.
pub async fn plan_admin(
    db: &Database,
    targets: &[(String, String)],
    overlay: &Value,
    _actor: &str,
    _correlation: &str,
) -> Result<Vec<Query>, DatabaseError> {
    let now = string(overlay, "evaluatedAt")?;
    let mut input = EvaluationOverlay::default();
    if let Some(issue) = overlay.get("issue") {
        input.source = Some(("issue".into(), string(issue, "issueId")?.into()));
        input.issues.push(json!({"issue_id":issue["issueId"],"state":issue["state"],"severity":issue["severity"],"fingerprint_hash":issue["fingerprintHash"],"diagnostic_rules_json":issue["diagnosticRulesJson"]}));
    }
    if let Some(m) = overlay.get("maintenance") {
        input.source = Some(("maintenance".into(), string(m, "maintenanceId")?.into()));
        input.maintenance = Some(
            json!({"maintenance_id":m["maintenanceId"],"state":m["state"],"starts_at":m["startsAt"],"ends_at":m["endsAt"],"targets":m["targets"]}),
        );
    }
    if let Some(o) = overlay.get("override") {
        input.source = Some(("operator_override".into(), string(o, "overrideId")?.into()));
        input.operator_override = Some(
            json!({"override_id":o["overrideId"],"target_type":o["target"]["type"],"target_id":o["target"]["id"],"status":o["status"],"starts_at":o["startsAt"],"expires_at":o["expiresAt"],"revoked":o["revoked"],"audit_id":o["auditId"]}),
        );
    }
    let mut guards = Vec::new();
    let mut writes = Vec::new();
    let mut ordered = targets.iter().collect::<Vec<_>>();
    ordered.sort_by_key(|(kind, _)| kind != "service");
    for (kind, id) in ordered {
        let mut plan = plan_reevaluation_with_overlay(db, kind, id, now, &input).await?;
        guards.push(plan.remove(0));
        if kind == "service" {
            let values = plan[0].values();
            let text = |index: usize| match &values[index] {
                SqlValue::Text(s) => Value::String(s.clone()),
                _ => Value::Null,
            };
            input.service_statuses.push(json!({"service_name":id,"direct_status":text(2),"effective_impact":text(4),"fresh_until":text(6)}));
        }
        writes.extend(plan);
    }
    guards.extend(writes);
    Ok(guards)
}

/// 重复诊断投递不会写状态，token 防止丢失 claim 的消费者提交。
/// Duplicate diagnostics never write status; tokens prevent stale consumers committing.
fn gate_queries(queries: Vec<Query>, ownership: Option<&(String, String)>) -> Vec<Query> {
    let Some((event, token)) = ownership else {
        return queries;
    };
    let owned =
        "EXISTS(SELECT 1 FROM diagnostic_event_dedup WHERE event_id=? AND processing_token=?)";
    queries
        .into_iter()
        .enumerate()
        .map(|(index, query)| {
            let mut values = query.values().to_vec();
            let mut statement = query.sql().to_owned();
            match index {
                0 => {
                    statement = statement.replace(
                        "CASE WHEN COALESCE",
                        &format!("CASE WHEN NOT ({owned}) OR COALESCE"),
                    );
                    values.splice(1..1, [event.clone().into(), token.clone().into()]);
                }
                1 => {
                    statement = statement
                        .replace("WHERE 1 ON CONFLICT", &format!("WHERE {owned} ON CONFLICT"));
                    values.splice(9..9, [event.clone().into(), token.clone().into()]);
                }
                2 => {
                    statement =
                        statement.replace("changes()=1", &format!("NOT ({owned}) OR changes()=1"));
                    values.extend([event.clone().into(), token.clone().into()]);
                }
                _ => {
                    statement = statement.replace("AND 1", &format!("AND {owned}"));
                    values.extend([event.clone().into(), token.clone().into()]);
                }
            }
            Query::new(statement, values)
        })
        .collect()
}

/// 保留触发事件的来源身份并原子提交。 / Preserve causal event identity and commit atomically.
pub async fn reevaluate_with_source(
    db: &Database,
    kind: &str,
    id: &str,
    now: &str,
    source_type: &str,
    source_id: &str,
) -> Result<(), DatabaseError> {
    let source_type = match source_type {
        "override" => "operator_override",
        "observation" | "diagnostic_event" | "maintenance" | "operator_override" | "issue" => {
            source_type
        }
        _ => "issue",
    };
    let input = EvaluationOverlay {
        source: Some((source_type.into(), source_id.into())),
        ..Default::default()
    };
    let plan = plan_reevaluation_with_overlay(db, kind, id, now, &input).await?;
    db.batch(&plan).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn checkpoint_join_requires_current_policy_revision() {
        assert!(MONITOR_SIGNALS_SQL
            .contains("c.policy_id=m.policy_id AND c.policy_revision=m.policy_revision"));
    }
    #[test]
    fn quorum_one_allows_missing_other_location() {
        let rows = vec![
            json!({"monitor_id":"m","critical":1,"location_quorum":1,"evaluated_at":"2026-01-01","executor_id":"e","actual_colo":"A","evaluation_status":"operational","fresh_until":"2026-12-01"}),
            json!({"monitor_id":"m","critical":1,"location_quorum":1,"evaluated_at":"2026-01-01","executor_id":null,"actual_colo":null,"evaluation_status":null,"fresh_until":null}),
        ];
        assert_eq!(
            monitor_signals(&rows, "2026-01-01").unwrap()[0]["state"],
            "healthy"
        );
    }
    #[test]
    fn two_aliases_of_same_colo_do_not_meet_quorum_two() {
        let row = json!({"monitor_id":"m","critical":1,"location_quorum":2,"executor_id":"e","actual_colo":"A","evaluated_at":"2026-01-01","fresh_until":"2026-12-01","evaluation_status":"operational"});
        assert_eq!(
            monitor_signals(&[row.clone(), row], "2026-01-02").unwrap()[0]["state"],
            "unknown"
        );
    }
    #[test]
    fn newest_batch_verdict_supersedes_old_peer_verdict() {
        let old = json!({"monitor_id":"m","critical":1,"location_quorum":1,"executor_id":"e","actual_colo":"A","evaluated_at":"2026-01-01","fresh_until":"2026-12-01","evaluation_status":"major_outage"});
        let new = json!({"monitor_id":"m","critical":1,"location_quorum":1,"executor_id":"f","actual_colo":"B","evaluated_at":"2026-01-02","fresh_until":"2026-12-01","evaluation_status":"operational"});
        assert_eq!(
            monitor_signals(&[old, new], "2026-01-03").unwrap()[0]["state"],
            "healthy"
        );
    }
    #[test]
    fn expired_unused_peer_does_not_expire_quorum_proof() {
        let rows = vec![
            json!({"fresh_until":"2026-01-01"}),
            json!({"fresh_until":"2026-03-01"}),
        ];
        assert_eq!(monitor_deadlines(&rows, "2026-02-01"), vec!["2026-03-01"]);
    }
    #[test]
    fn fresh_support_reads_candidate_service_failure() {
        let rows =
            vec![json!({"enabled":1,"effective_impact":"major_outage","fresh_until":"2026-12-01"})];
        assert_eq!(support_risk(&rows, "2026-01-01").unwrap(), "major_outage");
    }
    #[test]
    fn stale_green_is_unknown_but_failure_survives() {
        assert_eq!(
            fresh_status(Some("operational"), Some("2026-01-01"), "2026-01-02"),
            "unknown"
        );
        assert_eq!(
            fresh_status(Some("major_outage"), Some("2026-01-01"), "2026-01-02"),
            "major_outage"
        );
    }
    #[test]
    fn unproven_location_never_votes_healthy() {
        let rows = vec![
            json!({"monitor_id":"m","critical":1,"location_quorum":1,"evaluated_at":"2026-01-01","executor_id":null,"actual_colo":null,"evaluation_status":"operational","fresh_until":"2026-12-01"}),
        ];
        assert_eq!(
            monitor_signals(&rows, "2026-01-01").unwrap()[0]["state"],
            "unknown"
        );
    }
    #[test]
    fn ownership_parameter_order_is_preserved() {
        let queries=vec![Query::new("INSERT INTO transaction_assertions(assertion_id,passed) VALUES (?,CASE WHEN COALESCE((SELECT generation FROM evaluation_generation WHERE singleton_id=1),-1)=? THEN 1 ELSE 0 END)",vec!["g".into(),1.into()]),Query::new(UPSERT_CURRENT_STATUS_SQL.replace("__OWNED__","1"),vec![SqlValue::Null;11]),Query::new("INSERT INTO transaction_assertions(assertion_id,passed) VALUES (?,CASE WHEN changes()=1 THEN 1 ELSE 0 END)",vec!["s".into()]),Query::new(INSERT_STATUS_OUTBOX_SQL.replace("__OWNED__","1"),vec![SqlValue::Null;11])];
        let gated = gate_queries(queries, Some(&("event".into(), "token".into())));
        for query in &gated {
            assert_eq!(query.sql().matches('?').count(), query.values().len());
        }
        assert_eq!(gated[1].values()[9], SqlValue::from("event"));
        assert_eq!(gated[0].values()[1], SqlValue::from("event"));
        assert!(gated[0].sql().contains("NOT (EXISTS"));
    }
}

//! 有界诊断图投影，保持管理 API 的关系和截断语义。
//! Bounded diagnostic graph projections preserving administrative relation and truncation semantics.
use crate::database::{Database, DatabaseError, Query, SqlValue};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

/// 已验证对象的字符串字段。 / String field of a validated object.
fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
/// 只生成参数占位符，不插入用户值。 / Generate placeholders, never interpolate user values.
fn marks(_n: usize) -> String {
    "SELECT value FROM json_each(?)".into()
}
/// 绑定字符串集合。 / Bind a string collection.
fn bindings(items: &[String]) -> Vec<SqlValue> {
    vec![json!(items).to_string().into()]
}
/// 取稳定去重身份。 / Extract stable deduplicated identities.
fn ids(items: &[Value], key: &str) -> Vec<String> {
    items
        .iter()
        .map(|v| s(v, key).to_owned())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}
/// 对服务关系进行稳定去重。 / Stably deduplicate service relations.
fn add(map: &mut BTreeMap<String, BTreeMap<String, Value>>, name: &str, relation: Value) {
    map.entry(name.into())
        .or_default()
        .insert(relation.to_string(), relation);
}

/// 补充有界关系、来源和审计数据；数据库失败不会变成空结果。
/// Enrich bounded relations, provenance and audit data; database failures never become empty results.
///
/// ```ignore
/// let extra = enrich(&db, &locator, &issues, &incidents, &evidence, &rows, &deployments).await?;
/// ```
pub async fn enrich(
    db: &Database,
    locator: &Value,
    issues: &[Value],
    incidents: &[Value],
    evidence: &[Value],
    evidence_rows: &[Value],
    deployments: &[Value],
) -> Result<Value, DatabaseError> {
    let (services, affected_truncated) =
        affected(db, locator, issues, incidents, evidence, deployments).await?;
    let names = ids(&services, "service_name");
    let (paths, paths_truncated) = paths(db, &names).await?;
    let range = time_range(locator, issues, incidents, evidence_rows, deployments);
    let (transitions, transitions_truncated) = transitions(db, &names, range.as_ref()).await?;
    let (audit, audit_truncated) = audit(
        db,
        locator,
        &[
            ("issue", issues, "issue_id"),
            ("incident", incidents, "incident_id"),
            ("deployment", deployments, "deployment_id"),
            ("service", services.as_slice(), "service_name"),
            ("telemetry_reference", evidence, "id"),
        ],
        evidence,
        range.as_ref(),
    )
    .await?;
    Ok(
        json!({"affected_services":services,"dependency_paths":paths,"source_locations":sources(evidence,deployments),"status_transitions":transitions,"audit_summary":audit,"truncated":affected_truncated || paths_truncated || transitions_truncated || audit_truncated}),
    )
}

/// 聚合最多一百个服务，每个最多一百个关系。 / Aggregate at most 100 services and 100 relations per service.
async fn affected(
    db: &Database,
    locator: &Value,
    issues: &[Value],
    incidents: &[Value],
    evidence: &[Value],
    deployments: &[Value],
) -> Result<(Vec<Value>, bool), DatabaseError> {
    let mut relations = BTreeMap::new();
    if s(locator, "kind") == "service" {
        add(
            &mut relations,
            s(locator, "service_name"),
            json!({"kind":"locator"}),
        );
    }
    for item in issues {
        add(
            &mut relations,
            s(item, "service_name"),
            json!({"kind":"issue","issue_id":item["issue_id"]}),
        );
    }
    for item in incidents {
        for service in item["affected_services"].as_array().into_iter().flatten() {
            add(
                &mut relations,
                service.as_str().unwrap_or(""),
                json!({"kind":"incident","incident_id":item["incident_id"]}),
            );
        }
    }
    for item in evidence {
        add(
            &mut relations,
            s(item, "service_name"),
            json!({"kind":"evidence","telemetry_reference_id":item["id"]}),
        );
    }
    for item in deployments {
        add(
            &mut relations,
            s(item, "service_name"),
            json!({"kind":"deployment","deployment_id":item["deployment_id"]}),
        );
    }
    let incident_ids = ids(incidents, "incident_id");
    let mut truncated = false;
    if !incident_ids.is_empty() {
        let p = marks(incident_ids.len());
        let mut args = bindings(&incident_ids);
        args.extend(bindings(&incident_ids));
        let rows = db.all::<Value>(&Query::new(format!("SELECT DISTINCT related.incident_id,related.component_id,related.service_name FROM (SELECT x.incident_id,x.component_id,c.service_name FROM incident_components x JOIN components c ON c.component_id=x.component_id WHERE x.incident_id IN ({p}) UNION ALL SELECT x.incident_id,x.component_id,cs.service_name FROM incident_components x JOIN component_services cs ON cs.component_id=x.component_id WHERE x.incident_id IN ({p})) related ORDER BY related.incident_id,related.component_id,related.service_name LIMIT 501"),args)).await?;
        truncated |= rows.len() > 500;
        for row in rows.iter().take(500) {
            add(
                &mut relations,
                s(row, "service_name"),
                json!({"kind":"component","component_id":row["component_id"]}),
            );
        }
    }
    truncated |= relations.len() > 100;
    let names: Vec<_> = relations.keys().take(100).cloned().collect();
    let mut statuses = BTreeMap::new();
    if !names.is_empty() {
        let rows = db.all::<Value>(&Query::new(format!("SELECT target_id,direct_status,dependency_risk,effective_impact,evaluated_at,fresh_until,revision FROM current_statuses WHERE target_type='service' AND target_id IN ({})",marks(names.len())),bindings(&names))).await?;
        for mut row in rows {
            let name = s(&row, "target_id").to_owned();
            row.as_object_mut()
                .ok_or(DatabaseError::RowContract)?
                .remove("target_id");
            statuses.insert(name, row);
        }
    }
    let mut result = Vec::new();
    for name in names {
        let values = &relations[&name];
        truncated |= values.len() > 100;
        result.push(json!({"service_name":name,"relations":values.values().take(100).collect::<Vec<_>>(),"current_status":statuses.get(&name)}));
    }
    Ok((result, truncated))
}

/// 广度优先展开八跳；路径内不允许重复服务。 / Expand breadth-first to eight hops without repeated services in a path.
async fn paths(db: &Database, roots: &[String]) -> Result<(Vec<Value>, bool), DatabaseError> {
    let mut frontier: Vec<(String, Vec<String>, Vec<Value>)> = roots
        .iter()
        .map(|r| (r.clone(), vec![r.clone()], vec![]))
        .collect();
    let mut result = Vec::new();
    let mut truncated = false;
    for _ in 0..8 {
        if frontier.is_empty() {
            break;
        }
        let names: Vec<_> = frontier
            .iter()
            .filter_map(|(_, nodes, _)| nodes.last().cloned())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let rows = db.all::<Value>(&Query::new(format!("SELECT source_service,target_service,capability,kind,criticality FROM service_dependencies WHERE source_service IN ({}) ORDER BY source_service,target_service,capability LIMIT 501",marks(names.len())),bindings(&names))).await?;
        truncated |= rows.len() > 500;
        let mut next = Vec::new();
        for (root, nodes, edges) in frontier {
            for edge in rows
                .iter()
                .take(500)
                .filter(|e| Some(s(e, "source_service")) == nodes.last().map(String::as_str))
            {
                let target = s(edge, "target_service").to_owned();
                if nodes.contains(&target) {
                    continue;
                }
                let mut extended = edges.clone();
                extended.push(edge.clone());
                result.push(json!({"root_service":root,"leaf_service":target,"edges":extended}));
                if result.len() == 100 {
                    return Ok((result, true));
                }
                let mut services = nodes.clone();
                services.push(target);
                next.push((root.clone(), services, extended));
            }
        }
        frontier = next;
    }
    Ok((result, truncated || !frontier.is_empty()))
}

/// 仓库来源比较忽略尾部斜杠和 .git。 / Compare repository provenance without trailing slash and .git.
fn canonical(raw: &str) -> Option<String> {
    let url = url::Url::parse(raw).ok()?;
    Some(format!(
        "{}{}",
        url.origin().ascii_serialization(),
        url.path()
            .strip_suffix('/')
            .unwrap_or(url.path())
            .strip_suffix(".git")
            .unwrap_or(url.path().strip_suffix('/').unwrap_or(url.path()))
    ))
}
/// 只投影已返回的源码证据。 / Project only returned source evidence.
fn sources(evidence: &[Value], deployments: &[Value]) -> Vec<Value> {
    let mut result = Vec::new();
    for item in evidence.iter().filter(|v| s(v, "kind") == "source") {
        let location = &item["locator"];
        let repository = canonical(s(location, "repository_url"));
        let verified = deployments.iter().any(|d| {
            d["deployment_id"] == item["deployment_id"]
                && repository.is_some()
                && canonical(s(d, "repository_url")) == repository
                && d["git_commit"] == location["git_commit"]
        });
        let mut row = json!({"telemetry_reference_id":item["id"],"deployment_id":item["deployment_id"],"repository_url":location["repository_url"],"git_commit":location["git_commit"],"path":location["path"],"provenance_verified":verified});
        for key in ["line", "column"] {
            if let Some(value) = location.get(key) {
                row[key] = value.clone();
            }
        }
        result.push(row);
    }
    result.sort_by_key(|v| format!("{}\0{}", s(v, "telemetry_reference_id"), s(v, "path")));
    result
}

/// 从事实时间推导闭区间，不将无效日期纳入范围。 / Derive a closed interval from facts, excluding invalid dates.
fn time_range(
    locator: &Value,
    issues: &[Value],
    incidents: &[Value],
    evidence: &[Value],
    deployments: &[Value],
) -> Option<(String, String)> {
    if s(locator, "kind") == "service" {
        return Some((s(locator, "start").into(), s(locator, "end").into()));
    }
    let mut starts = Vec::new();
    let mut ends = Vec::new();
    for item in issues {
        starts.push(s(item, "first_seen_at"));
        ends.extend([s(item, "last_seen_at"), s(item, "acknowledged_at")]);
    }
    for item in incidents {
        starts.push(s(item, "started_at"));
        ends.push(
            item["resolved_at"]
                .as_str()
                .unwrap_or(s(item, "detected_at")),
        );
        for update in item["updates"].as_array().into_iter().flatten() {
            ends.push(s(update, "published_at"));
        }
    }
    for item in evidence {
        starts.push(
            item["range_start"]
                .as_str()
                .unwrap_or(s(item, "created_at")),
        );
        ends.push(item["range_end"].as_str().unwrap_or(s(item, "created_at")));
    }
    for item in deployments {
        starts.push(s(item, "deployed_at"));
        ends.push(s(item, "deployed_at"));
    }
    let ordered = |values: Vec<&str>| -> Vec<(i64, String)> {
        let mut valid: Vec<_> = values
            .into_iter()
            .filter_map(|v| {
                chrono::DateTime::parse_from_rfc3339(v)
                    .ok()
                    .map(|d| (d.timestamp_millis(), v.to_owned()))
            })
            .collect();
        valid.sort_by_key(|v| v.0);
        valid
    };
    let starts = ordered(starts);
    let ends = ordered(ends);
    Some((starts.first()?.1.clone(), ends.last()?.1.clone()))
}

/// 返回诊断窗口内前两百个状态事实。 / Return the first 200 status facts in the diagnostic window.
async fn transitions(
    db: &Database,
    names: &[String],
    range: Option<&(String, String)>,
) -> Result<(Vec<Value>, bool), DatabaseError> {
    let Some((start, end)) = range.filter(|_| !names.is_empty()) else {
        return Ok((vec![], false));
    };
    let p = marks(names.len());
    let mut args = vec![start.clone().into(), end.clone().into()];
    args.extend(bindings(names));
    args.extend(bindings(names));
    let rows=db.all::<Value>(&Query::new(format!("SELECT t.transition_id,t.target_type,t.target_id,t.sequence,t.from_status,t.to_status,t.source_type,t.source_id,t.policy_id,t.policy_revision,t.correlation_id,t.occurred_at,CASE WHEN t.target_type='service' THEN t.target_id ELSE c.service_name END AS service_name FROM status_transitions t LEFT JOIN components c ON t.target_type='component' AND c.component_id=t.target_id WHERE t.occurred_at>=? AND t.occurred_at<=? AND (t.target_type='service' AND t.target_id IN ({p}) OR t.target_type='component' AND c.service_name IN ({p})) ORDER BY t.occurred_at,t.target_type,t.target_id,t.sequence LIMIT 201"),args)).await?;
    let truncated = rows.len() > 200;
    let mut result = Vec::new();
    for mut row in rows.into_iter().take(200) {
        row["policy"] = if row["policy_id"].is_null() || row["policy_revision"].is_null() {
            Value::Null
        } else {
            json!({"policy_id":row["policy_id"],"revision":row["policy_revision"]})
        };
        if status_domain::validate_uuid_v7(s(&row, "correlation_id"), "correlation_id").is_err() {
            row["correlation_id"] = Value::Null;
        }
        let object = row.as_object_mut().ok_or(DatabaseError::RowContract)?;
        object.remove("policy_id");
        object.remove("policy_revision");
        result.push(row);
    }
    Ok((result, truncated))
}

/// 只统计选中节点和关联身份的前五百个审计事件。 / Count the first 500 audit events for selected nodes and correlation identities only.
async fn audit(
    db: &Database,
    locator: &Value,
    targets: &[(&str, &[Value], &str)],
    evidence: &[Value],
    range: Option<&(String, String)>,
) -> Result<(Value, bool), DatabaseError> {
    let mut clauses = Vec::new();
    let mut args = Vec::new();
    // 节点类别与身份字段是一组数据，不为每种节点增加参数。 / Node kinds and identity fields are data, not separate arguments.
    for &(kind, items, key) in targets {
        let values = ids(items, key);
        if values.is_empty() {
            continue;
        }
        clauses.push(format!(
            "(target_type=? AND target_id IN ({}))",
            marks(values.len())
        ));
        args.push(kind.into());
        args.extend(bindings(&values));
    }
    let mut correlations: BTreeSet<String> = evidence
        .iter()
        .filter_map(|v| v["correlation_id"].as_str().map(str::to_owned))
        .collect();
    if s(locator, "kind") == "correlation" {
        correlations.insert(s(locator, "correlation_id").into());
    }
    if !correlations.is_empty() {
        clauses.push(format!("correlation_id IN ({})", marks(correlations.len())));
        args.push(json!(correlations).to_string().into());
    }
    let mut rows = Vec::new();
    if !clauses.is_empty() {
        let time = if let Some((start, end)) = range {
            args.extend([start.clone().into(), end.clone().into()]);
            "AND occurred_at>=? AND occurred_at<=?"
        } else {
            ""
        };
        rows=db.all::<Value>(&Query::new(format!("SELECT audit_id,actor_type,actor_subject,action,occurred_at FROM audit_log WHERE ({}) {time} ORDER BY occurred_at,audit_id LIMIT 501",clauses.join(" OR ")),args)).await?;
    }
    let mut truncated = rows.len() > 500;
    rows.truncate(500);
    let mut actions: BTreeMap<String, usize> = BTreeMap::new();
    let mut actors: BTreeMap<(String, String), usize> = BTreeMap::new();
    for row in &rows {
        *actions.entry(s(row, "action").into()).or_default() += 1;
        *actors
            .entry((s(row, "actor_type").into(), s(row, "actor_subject").into()))
            .or_default() += 1;
    }
    truncated |= actions.len() > 100 || actors.len() > 100;
    Ok((
        json!({"event_count":rows.len(),"first_occurred_at":rows.first().map(|v|&v["occurred_at"]),"last_occurred_at":rows.last().map(|v|&v["occurred_at"]),"actions":actions.into_iter().take(100).map(|(action,count)|json!({"action":action,"count":count})).collect::<Vec<_>>(),"actors":actors.into_iter().take(100).map(|((kind,subject),count)|json!({"actor_type":kind,"actor_subject":subject,"event_count":count})).collect::<Vec<_>>()}),
        truncated,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 来源必须同时匹配仓库和提交。 / Provenance must match both repository and commit.
    #[test]
    fn verifies_source_provenance() {
        let evidence = vec![
            json!({"kind":"source","id":"ref","deployment_id":"deploy","locator":{"repository_url":"https://example.com/repo.git/","git_commit":"abc","path":"src/main.rs","line":3}}),
        ];
        let deployments = vec![
            json!({"deployment_id":"deploy","repository_url":"https://example.com/repo","git_commit":"abc"}),
        ];
        let rows = sources(&evidence, &deployments);
        assert_eq!(rows[0]["provenance_verified"], true);
        assert_eq!(rows[0]["line"], 3);
        assert!(rows[0].get("column").is_none());
        assert_eq!(sources(&evidence, &[])[0]["provenance_verified"], false);
    }

    /// 时间范围按实际时刻排序并忽略损坏日期。 / Sort by actual instants and ignore malformed dates.
    #[test]
    fn derives_fact_window() {
        let issues = vec![
            json!({"first_seen_at":"2026-01-01T08:00:00+08:00","last_seen_at":"2026-01-01T02:00:00Z","acknowledged_at":"invalid"}),
        ];
        let range = time_range(&json!({"kind":"issue"}), &issues, &[], &[], &[]);
        assert_eq!(
            range,
            Some((
                "2026-01-01T08:00:00+08:00".into(),
                "2026-01-01T02:00:00Z".into()
            ))
        );
        assert!(time_range(&Value::Null, &[], &[], &[], &[]).is_none());
    }

    /// 大集合始终只消耗一个 D1 绑定参数。 / Large collections always consume one D1 binding.
    #[test]
    fn binds_lists_as_single_json_parameter() {
        let names = vec!["service".to_owned(); 200];
        assert_eq!(bindings(&names).len(), 1);
        assert_eq!(marks(names.len()), "SELECT value FROM json_each(?)");
    }
}

//! 直接调用 Rust 领域依赖算法的公开状态投影，不经过 JSON/JS 领域桥。
//! Public status projection calls Rust dependency algorithms directly, without a JSON/JS domain bridge.

use super::{
    self_link, single,
    validation::{service_name, text, timestamp},
    PublicContext, INTERNAL, INVALID,
};
use crate::{
    cursor::{Binding, CursorSigner},
    database::Query,
    http::{parse_limit, HttpError},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use status_domain::{
    compute_dependency_risk, validate_uuid_v7, Dependency, DependencyGraph, Status,
};
use std::collections::{BTreeMap, BTreeSet};
use url::Url;

/// 单次 SQL 快照中的服务/组件行。 / Service/component row from a single SQL snapshot.
#[derive(Clone, Deserialize)]
struct Row {
    /// 所属服务。 / Owning service.
    service_name: String,
    /// 公开目标 ID。 / Public target identity.
    target_id: String,
    /// 显示名。 / Display name.
    display_name: String,
    /// 服务说明，组件快照不携带此字段。 / Service description, absent from component snapshots.
    #[serde(default)]
    description: String,
    /// 持久直接状态。 / Persisted direct status.
    direct_status: Option<Status>,
    /// 将由新鲜证据重算，绝不盲信缓存。 / Recomputed from fresh evidence, never blindly trusted.
    effective_impact: Option<Status>,
    /// 评估时间。 / Evaluation time.
    evaluated_at: Option<String>,
    /// 健康证明期限。 / Health evidence deadline.
    fresh_until: Option<String>,
    /// 无证明时的目录更新时间。 / Catalog update fallback without evidence.
    fallback_at: String,
    /// 组件显示顺序。 / Component display order.
    #[serde(default)]
    sort_order: i64,
}

/// 与 direct_status 分离的公开风险状态。 / Public risk state, distinct from direct_status.
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum RiskStatus {
    None,
    Degraded,
    PartialOutage,
    MajorOutage,
    Unknown,
}

/// 公开风险摘要不含内部路径。 / Public risk summary excludes internal paths.
#[derive(Serialize)]
struct Risk {
    /// 最强风险。 / Strongest risk.
    status: RiskStatus,
    /// 受影响能力。 / Affected capabilities.
    affected_capabilities: Vec<String>,
    /// 去重依赖数量。 / Distinct dependency count.
    dependency_count: usize,
}

/// 完整一致性视图。 / Complete consistent view.
struct Snapshot {
    /// 排序服务列表。 / Sorted services.
    services: Vec<Row>,
    /// 排序公开组件。 / Sorted public components.
    components: Vec<Row>,
    /// 服务关联的组件。 / Components associated with each service.
    by_service: BTreeMap<String, Vec<Value>>,
    /// 直接证据状态。 / Direct evidence states.
    direct: BTreeMap<String, Status>,
    /// 单独计算的风险。 / Separately computed risks.
    risks: BTreeMap<String, Risk>,
}

/// 读取一次快照后完成纯 Rust 投影。 / Read one snapshot, then project entirely in Rust.
async fn snapshot(context: &PublicContext<'_>) -> Result<Snapshot, HttpError> {
    #[derive(Deserialize)]
    struct Record {
        kind: String,
        payload: String,
    }
    #[derive(Deserialize)]
    struct Support {
        component_id: String,
        service_name: String,
    }
    let records: Vec<Record> = context
        .db
        .all(&Query::new(include_str!("snapshot.sql"), vec![]))
        .await
        .map_err(|_| INTERNAL)?;
    let mut services: Vec<Row> = Vec::new();
    let mut components: Vec<Row> = Vec::new();
    let mut graph = DependencyGraph::default();
    let mut support = BTreeMap::<String, Vec<String>>::new();
    for record in records {
        match record.kind.as_str() {
            "service" => {
                services.push(serde_json::from_str(&record.payload).map_err(|_| INTERNAL)?)
            }
            "component" => {
                components.push(serde_json::from_str(&record.payload).map_err(|_| INTERNAL)?)
            }
            "dependency" => graph
                .dependencies
                .push(serde_json::from_str(&record.payload).map_err(|_| INTERNAL)?),
            "support" => {
                let row: Support = serde_json::from_str(&record.payload).map_err(|_| INTERNAL)?;
                support
                    .entry(row.component_id)
                    .or_default()
                    .push(row.service_name);
            }
            _ => return Err(INTERNAL),
        }
    }
    services.sort_by(|a, b| a.service_name.cmp(&b.service_name));
    let locales = js_sys::Array::new();
    let options = js_sys::Object::new();
    components.sort_by(|a, b| {
        a.sort_order.cmp(&b.sort_order).then_with(|| {
            js_sys::JsString::from(a.target_id.as_str())
                .locale_compare(&b.target_id, &locales, &options)
                .cmp(&0)
        })
    });
    let direct = services
        .iter()
        .map(|row| {
            (
                row.service_name.clone(),
                fresh(
                    row.direct_status,
                    row.fresh_until.as_deref(),
                    context.now_millis,
                ),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let mut risks = BTreeMap::new();
    for row in &services {
        risks.insert(
            row.service_name.clone(),
            risk(&graph, &row.service_name, &direct)?,
        );
    }
    let deadlines = deadlines(&services, &graph.dependencies);
    for row in &mut services {
        row.fresh_until = deadlines.get(&row.service_name).cloned();
        row.effective_impact = Some(effective(
            direct[&row.service_name],
            risks[&row.service_name].status,
        ));
    }
    project_components(&mut components, &services, &support, context.now_millis);
    let mut by_service: BTreeMap<String, Vec<Value>> = services
        .iter()
        .map(|row| (row.service_name.clone(), Vec::new()))
        .collect();
    for row in &components {
        let names: BTreeSet<&str> = std::iter::once(row.service_name.as_str())
            .chain(
                support
                    .get(&row.target_id)
                    .into_iter()
                    .flatten()
                    .map(String::as_str),
            )
            .collect();
        for name in names {
            if let Some(values) = by_service.get_mut(name) {
                values.push(component(row, context.now_millis)?);
            }
        }
    }
    Ok(Snapshot {
        services,
        components,
        by_service,
        direct,
        risks,
    })
}

/// 领域调用是普通 Rust 函数，而非序列化后的 dispatch。 / Domain invocation is an ordinary Rust call, not serialized dispatch.
fn risk(
    graph: &DependencyGraph,
    name: &str,
    direct: &BTreeMap<String, Status>,
) -> Result<Risk, HttpError> {
    let result = compute_dependency_risk(graph, name, direct).map_err(|_| INTERNAL)?;
    let status = match result.status {
        Status::Operational => RiskStatus::None,
        Status::Degraded => RiskStatus::Degraded,
        Status::PartialOutage => RiskStatus::PartialOutage,
        Status::MajorOutage => RiskStatus::MajorOutage,
        Status::Unknown => RiskStatus::Unknown,
        Status::Maintenance => return Err(INTERNAL),
    };
    let names = result
        .contributors
        .iter()
        .map(|c| &c.service_name)
        .collect::<BTreeSet<_>>();
    let capabilities = result
        .contributors
        .iter()
        .map(|c| c.root_capability.clone())
        .collect::<BTreeSet<_>>();
    if capabilities.len() > 128 || capabilities.iter().any(|s| !text(s, 1, 128)) {
        return Err(INTERNAL);
    }
    Ok(Risk {
        status,
        affected_capabilities: capabilities.into_iter().collect(),
        dependency_count: names.len(),
    })
}

/// 循环只访问一次；缓存期限包含所有可达依赖证明。
/// Visit cycles once; cache deadline includes every reachable dependency's evidence.
fn deadlines(services: &[Row], edges: &[Dependency]) -> BTreeMap<String, String> {
    let own: BTreeMap<&str, &str> = services
        .iter()
        .map(|s| {
            (
                s.service_name.as_str(),
                s.fresh_until.as_deref().unwrap_or(&s.fallback_at),
            )
        })
        .collect();
    let mut adjacency = BTreeMap::<&str, Vec<&str>>::new();
    for edge in edges {
        adjacency
            .entry(&edge.source_service)
            .or_default()
            .push(&edge.target_service);
    }
    let mut result = BTreeMap::new();
    for row in services {
        let mut seen = BTreeSet::new();
        let mut pending = vec![row.service_name.as_str()];
        let mut earliest = own[row.service_name.as_str()];
        while let Some(name) = pending.pop() {
            if !seen.insert(name) {
                continue;
            }
            earliest = earliest.min(own.get(name).copied().unwrap_or(&row.fallback_at));
            pending.extend(adjacency.get(name).into_iter().flatten().copied());
        }
        result.insert(row.service_name.clone(), earliest.to_owned());
    }
    result
}

/// 组件支持方影响不能被旧 effective_impact 缓存掩盖。 / Supporting-service impact cannot be hidden by cached effective_impact.
fn project_components(
    components: &mut [Row],
    services: &[Row],
    support: &BTreeMap<String, Vec<String>>,
    now: i64,
) {
    let by_name: BTreeMap<&str, &Row> = services
        .iter()
        .map(|s| (s.service_name.as_str(), s))
        .collect();
    for row in components {
        let mut states = vec![fresh(row.direct_status, row.fresh_until.as_deref(), now)];
        let mut deadline = row
            .fresh_until
            .clone()
            .unwrap_or_else(|| row.fallback_at.clone());
        for name in support.get(&row.target_id).into_iter().flatten() {
            let service = by_name.get(name.as_str());
            states.push(service.map_or(Status::Unknown, |s| {
                fresh(s.effective_impact, s.fresh_until.as_deref(), now)
            }));
            deadline = deadline.min(
                service
                    .and_then(|s| s.fresh_until.clone())
                    .unwrap_or_else(|| row.fallback_at.clone()),
            );
        }
        row.fresh_until = Some(deadline);
        row.effective_impact = Some(aggregate(&states));
    }
}

/// 新鲜健康证明过期后变 unknown，已证实故障仍保留。 / Expired health proof becomes unknown; demonstrated failure remains.
fn fresh(status: Option<Status>, deadline: Option<&str>, now: i64) -> Status {
    let Some(status) = status else {
        return Status::Unknown;
    };
    let Some(deadline) = deadline.and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()) else {
        return Status::Unknown;
    };
    if deadline.timestamp_millis() < now
        && !matches!(
            status,
            Status::Degraded | Status::PartialOutage | Status::MajorOutage
        )
    {
        return Status::Unknown;
    }
    status
}

/// 保守的公开状态优先级，空集不等于健康。 / Conservative public precedence; an empty set is not healthy.
fn aggregate(states: &[Status]) -> Status {
    for status in [
        Status::MajorOutage,
        Status::PartialOutage,
        Status::Degraded,
        Status::Unknown,
        Status::Maintenance,
    ] {
        if states.contains(&status) {
            return status;
        }
    }
    if states.is_empty() {
        Status::Unknown
    } else {
        Status::Operational
    }
}

/// 保持直接状态和依赖风险分离。 / Keep direct state separate from dependency risk.
fn effective(direct: Status, risk: RiskStatus) -> Status {
    let risk = match risk {
        RiskStatus::None => Status::Operational,
        RiskStatus::Degraded => Status::Degraded,
        RiskStatus::PartialOutage => Status::PartialOutage,
        RiskStatus::MajorOutage => Status::MajorOutage,
        RiskStatus::Unknown => Status::Unknown,
    };
    aggregate(&[direct, risk])
}

/// 验证公开输出后序列化组件。 / Validate public output before serializing a component.
fn component(row: &Row, now: i64) -> Result<Value, HttpError> {
    if !text(&row.target_id, 1, 128) || !text(&row.display_name, 1, 128) {
        return Err(INTERNAL);
    }
    Ok(
        json!({"id":row.target_id,"display_name":row.display_name,"status":fresh(row.effective_impact.or(row.direct_status),row.fresh_until.as_deref(),now)}),
    )
}

/// 验证服务输出的字符串和时间约束。 / Validate service output string and timestamp constraints.
fn validate_service(row: &Row) -> Result<(), HttpError> {
    if !service_name(&row.service_name)
        || !text(&row.display_name, 1, 128)
        || !text(&row.description, 0, 1024)
        || !timestamp(row.evaluated_at.as_deref().unwrap_or(&row.fallback_at))
        || !timestamp(row.fresh_until.as_deref().unwrap_or(&row.fallback_at))
    {
        return Err(INTERNAL);
    }
    Ok(())
}

/// 平台整体公开状态。 / Public platform status.
pub(super) async fn platform(url: &Url, context: &PublicContext<'_>) -> Result<Value, HttpError> {
    if url.query_pairs().next().is_some() {
        return Err(INVALID);
    }
    #[derive(Deserialize)]
    struct Count {
        count: u64,
    }
    let snapshot = snapshot(context).await?;
    let count: Option<Count> = context
        .db
        .first(&Query::new(
            "SELECT COUNT(*) AS count FROM incident_current WHERE state <> 'resolved'",
            vec![],
        ))
        .await
        .map_err(|_| INTERNAL)?;
    let components = snapshot
        .components
        .iter()
        .map(|row| component(row, context.now_millis))
        .collect::<Result<Vec<_>, _>>()?;
    let states = snapshot
        .components
        .iter()
        .map(|r| {
            fresh(
                r.effective_impact.or(r.direct_status),
                r.fresh_until.as_deref(),
                context.now_millis,
            )
        })
        .collect::<Vec<_>>();
    let now = chrono::DateTime::from_timestamp_millis(context.now_millis)
        .ok_or(INTERNAL)?
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let evaluated = snapshot
        .components
        .iter()
        .map(|r| r.evaluated_at.as_deref().unwrap_or(&r.fallback_at))
        .min()
        .unwrap_or(&now);
    let deadline = snapshot
        .components
        .iter()
        .map(|r| r.fresh_until.as_deref().unwrap_or(&r.fallback_at))
        .min()
        .unwrap_or(&now);
    if !timestamp(evaluated) || !timestamp(deadline) {
        return Err(INTERNAL);
    }
    Ok(
        json!({"data":{"status":aggregate(&states),"evaluated_at":evaluated,"fresh_until":deadline,"active_incident_count":count.map_or(0,|c|c.count),"components":components},"links":{"self":self_link(url)}}),
    )
}

/// 服务列表，签名游标绑定排序。 / Service list with sort-bound signed cursor.
pub(super) async fn list(url: &Url, context: &PublicContext<'_>) -> Result<Value, HttpError> {
    if url
        .query_pairs()
        .any(|(key, _)| !["cursor", "limit"].contains(&key.as_ref()))
    {
        return Err(INVALID);
    }
    let limit = parse_limit(single(url, "limit")?.as_deref())? as usize;
    let binding = Binding {
        route: "/v1/services".into(),
        query: String::new(),
        sort: "service_name:asc".into(),
    };
    let signer = CursorSigner::new(context.cursor_secret).map_err(|_| INTERNAL)?;
    let after = match single(url, "cursor")? {
        Some(cursor) => {
            if !(16..=2048).contains(&cursor.len()) {
                return Err(INVALID);
            }
            let key = signer
                .verify(&cursor, &binding, context.now_seconds())
                .map_err(|_| INVALID)?;
            Some(
                key.get("service_name")
                    .and_then(Value::as_str)
                    .ok_or(INVALID)?
                    .to_owned(),
            )
        }
        None => None,
    };
    let snapshot = snapshot(context).await?;
    let rows: Vec<&Row> = snapshot
        .services
        .iter()
        .filter(|r| after.as_ref().is_none_or(|key| r.service_name > *key))
        .take(limit + 1)
        .collect();
    let more = rows.len() > limit;
    let rows = &rows[..rows.len().min(limit)];
    let mut data = Vec::new();
    for row in rows {
        validate_service(row)?;
        data.push(json!({"service_name":row.service_name,"display_name":row.display_name,"description":if row.description.is_empty(){None}else{Some(&row.description)},"status":fresh(row.effective_impact,row.fresh_until.as_deref(),context.now_millis),"evaluated_at":row.evaluated_at.as_deref().unwrap_or(&row.fallback_at),"fresh_until":row.fresh_until.as_deref().unwrap_or(&row.fallback_at),"components":snapshot.by_service[&row.service_name]}));
    }
    let next = match rows.last().filter(|_| more) {
        Some(row) => Some(
            signer
                .sign(
                    binding,
                    json!({"service_name":row.service_name})
                        .as_object()
                        .ok_or(INTERNAL)?
                        .clone(),
                    context.now_seconds(),
                )
                .map_err(|_| INTERNAL)?,
        ),
        None => None,
    };
    Ok(json!({"data":data,"page":{"next_cursor":next},"links":{"self":self_link(url)}}))
}

/// 单服务直接状态、独立风险与活跃 Incident。 / Per-service direct state, separate risk, and active incidents.
pub(super) async fn detail(
    name: &str,
    url: &Url,
    context: &PublicContext<'_>,
) -> Result<Value, HttpError> {
    if !service_name(name) || url.query_pairs().next().is_some() {
        return Err(INVALID);
    }
    let snapshot = snapshot(context).await?;
    let row = snapshot
        .services
        .iter()
        .find(|r| r.service_name == name)
        .ok_or(HttpError::new(
            404,
            "not-found",
            "The public service does not exist.",
        ))?;
    validate_service(row)?;
    #[derive(Deserialize)]
    struct Incident {
        incident_id: String,
    }
    let incidents: Vec<Incident> = context.db.all(&Query::new("SELECT relation.incident_id FROM incident_services AS relation JOIN incident_current AS incident ON incident.incident_id=relation.incident_id WHERE relation.service_name=? AND incident.state<>'resolved' ORDER BY incident.started_at DESC,relation.incident_id DESC",vec![name.into()])).await.map_err(|_|INTERNAL)?;
    for incident in &incidents {
        validate_uuid_v7(&incident.incident_id, "incident_id").map_err(|_| INTERNAL)?;
    }
    let risk = &snapshot.risks[name];
    Ok(
        json!({"data":{"service_name":row.service_name,"display_name":row.display_name,"description":if row.description.is_empty(){None}else{Some(&row.description)},"direct_status":snapshot.direct[name],"dependency_risk":risk,"effective_impact":effective(snapshot.direct[name],risk.status),"evaluated_at":row.evaluated_at.as_deref().unwrap_or(&row.fallback_at),"fresh_until":row.fresh_until.as_deref().unwrap_or(&row.fallback_at),"components":snapshot.by_service[name],"active_incident_ids":incidents.into_iter().map(|i|i.incident_id).collect::<Vec<_>>()},"links":{"self":self_link(url)}}),
    )
}

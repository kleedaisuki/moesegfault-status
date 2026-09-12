//! Incident 查询、分页和公开证据聚合。 / Incident queries, pagination, and public evidence aggregation.

use super::{self_link, single, PublicContext, INTERNAL, INVALID, NOT_FOUND};
use crate::{
    cursor::{Binding, CursorSigner},
    database::{Query, SqlValue},
    http::{parse_limit, HttpError},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use status_domain::{validate_uuid_v7, IncidentImpact, IncidentState, TelemetryKind};
use std::collections::{BTreeMap, BTreeSet};
use url::Url;

/// 数据库 Incident 投影，不包含私有操作者字段。 / Database Incident projection without private actor fields.
#[derive(Deserialize)]
struct IncidentRow {
    /// 标识。 / Identity.
    incident_id: String,
    /// 标题。 / Title.
    title: String,
    /// 状态。 / State.
    state: IncidentState,
    /// 影响。 / Impact.
    impact: IncidentImpact,
    /// 起始时间。 / Start time.
    started_at: String,
    /// 发现时间。 / Detection time.
    detected_at: String,
    /// 恢复时间。 / Resolution time.
    resolved_at: Option<String>,
    /// 最新版本。 / Latest revision.
    revision: u64,
    /// 公开消息。 / Public message.
    public_message: String,
    /// 更新时间。 / Update time.
    updated_at: String,
    /// 已公开原因。 / Published cause.
    cause: Option<String>,
}

/// 公开时间线行；别名只作用于输入，不泄漏数据库列名。
/// Public timeline row; aliases affect input only, not public column names.
#[derive(Deserialize, Serialize)]
struct Update {
    /// 递增序列。 / Increasing sequence.
    sequence: u64,
    /// 生命周期状态。 / Lifecycle state.
    state: IncidentState,
    /// 影响。 / Impact.
    impact: IncidentImpact,
    /// 公开消息。 / Public message.
    #[serde(alias = "public_message")]
    message: String,
    /// 公布时间。 / Publication time.
    #[serde(alias = "occurred_at")]
    published_at: String,
}

/// 仅暴露证据类别与计数，刻意不包含 locator。 / Expose evidence kind and count, never locators.
#[derive(Deserialize, Serialize)]
struct Evidence {
    /// 遥测类别。 / Telemetry kind.
    kind: TelemetryKind,
    /// 计数。 / Count.
    count: u64,
    /// 首次观察。 / First observation.
    first_observed_at: String,
    /// 最后观察。 / Last observation.
    last_observed_at: String,
}

/// 显式投影字段，禁止 SELECT *。 / Explicit projection; no SELECT *.
const SELECT: &str = "SELECT ic.incident_id, ic.title, ic.state, ic.impact, ic.started_at, ic.detected_at, ic.resolved_at, ic.revision, ic.public_message, ic.updated_at, ic.cause FROM incident_current AS ic";

/// 公开列表，维持稳定的筛选绑定与降序 keyset。 / Public list with stable filter binding and descending keyset.
pub(super) async fn list(url: &Url, context: &PublicContext<'_>) -> Result<Value, HttpError> {
    if url
        .query_pairs()
        .any(|(key, _)| !["states", "cursor", "limit"].contains(&key.as_ref()))
    {
        return Err(INVALID);
    }
    let limit = parse_limit(single(url, "limit")?.as_deref())? as usize;
    let states: BTreeSet<String> = url
        .query_pairs()
        .filter(|(key, _)| key == "states")
        .map(|(_, value)| value.into_owned())
        .collect();
    if states
        .iter()
        .any(|s| !["investigating", "identified", "monitoring", "resolved"].contains(&s.as_str()))
    {
        return Err(INVALID);
    }
    let binding = Binding {
        route: "/v1/incidents".into(),
        query: format!(
            "states={}",
            states.iter().cloned().collect::<Vec<_>>().join(",")
        ),
        sort: "started_at:desc,incident_id:desc".into(),
    };
    let signer = CursorSigner::new(context.cursor_secret).map_err(|_| INTERNAL)?;
    let mut predicates = Vec::new();
    let mut values: Vec<SqlValue> = states.iter().cloned().map(Into::into).collect();
    if !states.is_empty() {
        predicates.push(format!("ic.state IN ({})", placeholders(states.len())));
    }
    if let Some(cursor) = single(url, "cursor")? {
        if !(16..=2048).contains(&cursor.len()) {
            return Err(INVALID);
        }
        let key = signer
            .verify(&cursor, &binding, context.now)
            .map_err(|_| INVALID)?;
        let started = key
            .get("started_at")
            .and_then(Value::as_str)
            .ok_or(INVALID)?;
        let id = key
            .get("incident_id")
            .and_then(Value::as_str)
            .ok_or(INVALID)?;
        predicates.push("(ic.started_at < ? OR (ic.started_at = ? AND ic.incident_id < ?))".into());
        values.extend([started.into(), started.into(), id.into()]);
    }
    values.push(((limit + 1) as i64).into());
    let filter = if predicates.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", predicates.join(" AND "))
    };
    let mut rows: Vec<IncidentRow> = context
        .db
        .all(&Query::new(
            format!("{SELECT} {filter} ORDER BY ic.started_at DESC, ic.incident_id DESC LIMIT ?"),
            values,
        ))
        .await
        .map_err(|_| INTERNAL)?;
    let has_next = rows.len() > limit;
    rows.truncate(limit);
    for row in &rows {
        validate_row(row)?;
    }
    let components = components(
        context,
        &rows
            .iter()
            .map(|r| r.incident_id.clone())
            .collect::<Vec<_>>(),
    )
    .await?;
    let next = match rows.last().filter(|_| has_next) {
        Some(last) => Some(
            signer
                .sign(
                    binding,
                    json!({"started_at": last.started_at, "incident_id": last.incident_id})
                        .as_object()
                        .ok_or(INTERNAL)?
                        .clone(),
                    context.now,
                )
                .map_err(|_| INTERNAL)?,
        ),
        None => None,
    };
    let data = rows
        .iter()
        .map(|row| {
            summary(
                row,
                components
                    .get(&row.incident_id)
                    .cloned()
                    .unwrap_or_default(),
            )
        })
        .collect::<Vec<_>>();
    Ok(json!({"data": data, "page": {"next_cursor": next}, "links": {"self": self_link(url)}}))
}

/// 公开详情与脱敏证据。 / Public details and redacted evidence.
pub(super) async fn detail(
    id: &str,
    url: &Url,
    context: &PublicContext<'_>,
) -> Result<Value, HttpError> {
    if url.query_pairs().next().is_some() {
        return Err(INVALID);
    }
    validate_uuid_v7(id, "incident_id").map_err(|_| INVALID)?;
    let row: IncidentRow = context
        .db
        .first(&Query::new(
            format!("{SELECT} WHERE ic.incident_id = ?"),
            vec![id.into()],
        ))
        .await
        .map_err(|_| INTERNAL)?
        .ok_or(NOT_FOUND)?;
    validate_row(&row)?;
    let ids = vec![id.to_owned()];
    let components = components(context, &ids);
    let updates_query = Query::new("SELECT sequence, state, impact, public_message, occurred_at FROM incident_updates WHERE incident_id = ? ORDER BY sequence ASC", vec![id.into()]);
    let evidence_query = Query::new("SELECT tr.kind, COUNT(*) AS count, MIN(tr.created_at) AS first_observed_at, MAX(tr.created_at) AS last_observed_at FROM incident_telemetry_references AS link JOIN telemetry_references AS tr ON tr.telemetry_reference_id = link.telemetry_reference_id WHERE link.incident_id = ? GROUP BY tr.kind ORDER BY tr.kind ASC", vec![id.into()]);
    let (components, updates, evidence) = futures_util::join!(
        components,
        context.db.all::<Update>(&updates_query),
        context.db.all::<Evidence>(&evidence_query)
    );
    let mut body = summary(&row, components?.remove(id).unwrap_or_default());
    body["cause"] = row
        .cause
        .as_ref()
        .filter(|c| !c.is_empty())
        .map_or(Value::Null, |c| json!(c));
    let updates = updates.map_err(|_| INTERNAL)?;
    if updates
        .iter()
        .any(|u| u.sequence == 0 || !text(&u.message, 1, 4096) || !timestamp(&u.published_at))
    {
        return Err(INTERNAL);
    }
    let evidence = evidence.map_err(|_| INTERNAL)?;
    if evidence.iter().any(|e| {
        e.count == 0 || !timestamp(&e.first_observed_at) || !timestamp(&e.last_observed_at)
    }) {
        return Err(INTERNAL);
    }
    body["updates"] = json!(updates);
    body["evidence"] = json!(evidence);
    Ok(json!({"data": body, "links": {"self": self_link(url)}}))
}

/// 私有、禁用组件及禁用服务必须从公开列表移除。 / Hide private/disabled components and disabled services.
async fn components(
    context: &PublicContext<'_>,
    ids: &[String],
) -> Result<BTreeMap<String, Vec<String>>, HttpError> {
    #[derive(Deserialize)]
    struct Row {
        incident_id: String,
        component_id: String,
    }
    if ids.is_empty() {
        return Ok(BTreeMap::new());
    }
    let sql = format!("SELECT relation.incident_id, relation.component_id FROM incident_components AS relation JOIN components AS component ON component.component_id = relation.component_id JOIN services AS service ON service.service_name = component.service_name WHERE relation.incident_id IN ({}) AND component.public = 1 AND component.enabled = 1 AND service.enabled = 1 ORDER BY relation.incident_id ASC, component.sort_order ASC, relation.component_id ASC", placeholders(ids.len()));
    let rows: Vec<Row> = context
        .db
        .all(&Query::new(
            sql,
            ids.iter().cloned().map(Into::into).collect(),
        ))
        .await
        .map_err(|_| INTERNAL)?;
    let mut result: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for row in rows {
        if !text(&row.component_id, 1, 128) {
            return Err(INTERNAL);
        }
        result
            .entry(row.incident_id)
            .or_default()
            .push(row.component_id);
    }
    if result.values().any(|components| components.len() > 256) {
        return Err(INTERNAL);
    }
    Ok(result)
}

/// 保留原有公开响应的运行时约束；数据库脏值不能穿透到用户。
/// Preserve public response runtime constraints; invalid database values cannot reach users.
fn validate_row(row: &IncidentRow) -> Result<(), HttpError> {
    validate_uuid_v7(&row.incident_id, "incident_id").map_err(|_| INTERNAL)?;
    if !text(&row.title, 1, 256)
        || !text(&row.public_message, 1, 4096)
        || row.revision == 0
        || row.cause.as_ref().is_some_and(|c| !text(c, 0, 4096))
    {
        return Err(INTERNAL);
    }
    if [&row.started_at, &row.detected_at, &row.updated_at]
        .iter()
        .any(|s| !timestamp(s))
        || row.resolved_at.as_ref().is_some_and(|s| !timestamp(s))
    {
        return Err(INTERNAL);
    }
    Ok(())
}

/// 与 JavaScript 字符串契约一样使用 UTF-16 长度。 / Match JavaScript string contracts using UTF-16 length.
fn text(value: &str, minimum: usize, maximum: usize) -> bool {
    (minimum..=maximum).contains(&value.encode_utf16().count())
}

/// 严格 UTC RFC3339，最多纳秒精度，不接受闰秒或偏移。
/// Strict UTC RFC3339, at most nanosecond precision, without leap seconds or offsets.
fn timestamp(value: &str) -> bool {
    if !value.is_ascii()
        || !(20..=30).contains(&value.len())
        || !value.ends_with('Z')
        || value.as_bytes().get(10) != Some(&b'T')
    {
        return false;
    }
    if value.len() > 20
        && (value.as_bytes()[19] != b'.'
            || !(1..=9).contains(&(value.len() - 21))
            || !value.as_bytes()[20..value.len() - 1]
                .iter()
                .all(u8::is_ascii_digit))
    {
        return false;
    }
    if &value[17..19] == "60" {
        return false;
    }
    chrono::DateTime::parse_from_rfc3339(value).is_ok()
}

/// 公开投影不传播 cause 或私有查询列到列表。 / Public list projection does not propagate cause or private query columns.
fn summary(row: &IncidentRow, affected: Vec<String>) -> Value {
    json!({"incident_id": row.incident_id, "title": row.title, "state": row.state, "impact": row.impact, "started_at": row.started_at, "detected_at": row.detected_at, "resolved_at": row.resolved_at, "affected_components": affected, "latest_update": {"sequence": row.revision, "state": row.state, "impact": row.impact, "message": row.public_message, "published_at": row.updated_at}})
}

/// 只有参数个数影响 SQL，值永不插入结构。 / Only parameter count affects SQL; values never enter its structure.
fn placeholders(count: usize) -> String {
    vec!["?"; count].join(",")
}

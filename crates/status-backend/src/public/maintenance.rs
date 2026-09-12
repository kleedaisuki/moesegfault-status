//! 维护窗口公开查询；游标固定首次扫描的时间下界。
//! Public maintenance queries; cursors pin the initial scan's lower time boundary.

use super::{
    self_link, single,
    validation::{service_name, text, timestamp},
    PublicContext, INTERNAL, INVALID,
};
use crate::{
    cursor::{Binding, CursorSigner},
    database::{Query, SqlValue},
    http::{parse_limit, HttpError},
};
use chrono::{DateTime, SecondsFormat};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use status_domain::{validate_uuid_v7, IncidentImpact};
use std::collections::BTreeMap;
use url::Url;

/// 维护窗口有限状态。 / Finite maintenance states.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum State {
    Scheduled,
    Active,
    Completed,
    Cancelled,
}

/// 明确公开列，不读取操作者或内部配置。 / Explicit public columns, excluding actors and private configuration.
#[derive(Deserialize, Serialize)]
struct Window {
    /// 窗口标识。 / Window identity.
    maintenance_id: String,
    /// 标题。 / Title.
    title: String,
    /// 公开说明。 / Public description.
    description: String,
    /// 预期影响。 / Expected impact.
    expected_impact: IncidentImpact,
    /// 起始时间。 / Start time.
    starts_at: String,
    /// 结束时间。 / End time.
    ends_at: String,
    /// 生命周期状态。 / Lifecycle state.
    state: State,
}

/// 当前扫描的可信上下界与排序键。 / Trusted scan bounds and ordering key.
struct Scan {
    /// 固定首次请求的下界。 / Pinned first-request lower bound.
    from: String,
    /// 可选上界。 / Optional upper bound.
    to: Option<String>,
    /// 已验签排序键。 / Verified ordering key.
    after: Option<(String, String)>,
    /// 筛选绑定。 / Filter binding.
    binding: Binding,
    /// 页大小。 / Page size.
    limit: usize,
}

impl Scan {
    /// 先解析并验证查询与游标，再执行任何 SQL。 / Validate query and cursor before executing SQL.
    fn parse(url: &Url, context: &PublicContext<'_>) -> Result<Self, HttpError> {
        if url
            .query_pairs()
            .any(|(key, _)| !["from", "to", "cursor", "limit"].contains(&key.as_ref()))
        {
            return Err(INVALID);
        }
        let from = single(url, "from")?;
        let to = single(url, "to")?;
        if from.iter().chain(to.iter()).any(|s| !timestamp(s)) {
            return Err(INVALID);
        }
        let limit = parse_limit(single(url, "limit")?.as_deref())? as usize;
        let binding = Binding {
            route: "/v1/maintenance-windows".into(),
            query: format!(
                "from={}&to={}",
                from.as_deref().unwrap_or("<current>"),
                to.as_deref().unwrap_or("")
            ),
            sort: "starts_at:asc,maintenance_id:asc".into(),
        };
        let key = match single(url, "cursor")? {
            Some(cursor) => {
                if !(16..=2048).contains(&cursor.len()) {
                    return Err(INVALID);
                }
                Some(
                    CursorSigner::new(context.cursor_secret)
                        .map_err(|_| INTERNAL)?
                        .verify(&cursor, &binding, context.now_seconds())
                        .map_err(|_| INVALID)?,
                )
            }
            None => None,
        };
        let (after, scan_from) = match key {
            Some(key) => {
                let get = |name: &str| {
                    key.get(name)
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                        .ok_or(INVALID)
                };
                (
                    Some((get("starts_at")?, get("maintenance_id")?)),
                    Some(get("scan_from")?),
                )
            }
            None => (None, None),
        };
        let now = DateTime::from_timestamp_millis(context.now_millis)
            .ok_or(INTERNAL)?
            .to_rfc3339_opts(SecondsFormat::Millis, true);
        let from = from.or(scan_from).unwrap_or(now);
        if to.as_ref().is_some_and(|to| *to <= from) {
            return Err(INVALID);
        }
        Ok(Self {
            from,
            to,
            after,
            binding,
            limit,
        })
    }

    /// 使用原有时间重叠条件与升序排序。 / Preserve overlap predicate and ascending order.
    fn query(&self) -> Query {
        let mut predicates = vec!["mw.ends_at > ?"];
        let mut values: Vec<SqlValue> = vec![self.from.clone().into()];
        if let Some(to) = &self.to {
            predicates.push("mw.starts_at < ?");
            values.push(to.clone().into());
        }
        if let Some((starts_at, id)) = &self.after {
            predicates.push("(mw.starts_at > ? OR (mw.starts_at = ? AND mw.maintenance_id > ?))");
            values.extend([
                starts_at.clone().into(),
                starts_at.clone().into(),
                id.clone().into(),
            ]);
        }
        values.push(((self.limit + 1) as i64).into());
        Query::new(format!("SELECT mw.maintenance_id,mw.title,mw.description,mw.expected_impact,mw.starts_at,mw.ends_at,mw.state FROM maintenance_windows AS mw WHERE {} ORDER BY mw.starts_at ASC,mw.maintenance_id ASC LIMIT ?", predicates.join(" AND ")), values)
    }
}

/// 查询有界公开页。 / Query a bounded public page.
pub(super) async fn list(url: &Url, context: &PublicContext<'_>) -> Result<Value, HttpError> {
    let scan = Scan::parse(url, context)?;
    let mut rows: Vec<Window> = context.db.all(&scan.query()).await.map_err(|_| INTERNAL)?;
    let more = rows.len() > scan.limit;
    rows.truncate(scan.limit);
    let targets = targets(context, &rows).await?;
    let mut data = Vec::with_capacity(rows.len());
    for row in &rows {
        validate_uuid_v7(&row.maintenance_id, "maintenance_id").map_err(|_| INTERNAL)?;
        if !text(&row.title, 1, 256)
            || !text(&row.description, 1, 4096)
            || !timestamp(&row.starts_at)
            || !timestamp(&row.ends_at)
        {
            return Err(INTERNAL);
        }
        let mut value = serde_json::to_value(row).map_err(|_| INTERNAL)?;
        let target = targets
            .get(&row.maintenance_id)
            .cloned()
            .unwrap_or_default();
        value["target_services"] = json!(target.services);
        value["target_components"] = json!(target.components);
        data.push(value);
    }
    let next = match rows.last().filter(|_| more) {
        Some(row) => Some(CursorSigner::new(context.cursor_secret).map_err(|_| INTERNAL)?.sign(scan.binding, json!({"starts_at": row.starts_at, "maintenance_id": row.maintenance_id, "scan_from": scan.from}).as_object().ok_or(INTERNAL)?.clone(), context.now_seconds()).map_err(|_| INTERNAL)?),
        None => None,
    };
    Ok(json!({"data": data, "page": {"next_cursor": next}, "links": {"self": self_link(url)}}))
}

/// 已筛选的公开目标。 / Filtered public targets.
#[derive(Clone, Default)]
struct Targets {
    /// 启用的服务。 / Enabled services.
    services: Vec<String>,
    /// 启用的公开组件。 / Enabled public components.
    components: Vec<String>,
}

/// 一次查询所有页内目标，避免逐行查询。 / Query all page targets at once, avoiding per-row queries.
async fn targets(
    context: &PublicContext<'_>,
    rows: &[Window],
) -> Result<BTreeMap<String, Targets>, HttpError> {
    #[derive(Deserialize)]
    struct Row {
        maintenance_id: String,
        target_type: String,
        target_id: String,
    }
    if rows.is_empty() {
        return Ok(BTreeMap::new());
    }
    let placeholders = vec!["?"; rows.len()].join(",");
    let sql = format!("SELECT mt.maintenance_id, mt.target_type, mt.target_id FROM maintenance_targets AS mt LEFT JOIN services AS s ON mt.target_type='service' AND s.service_name=mt.target_id LEFT JOIN components AS c ON mt.target_type='component' AND c.component_id=mt.target_id LEFT JOIN services AS component_service ON c.service_name=component_service.service_name WHERE mt.maintenance_id IN ({placeholders}) AND ((mt.target_type='service' AND s.enabled=1) OR (mt.target_type='component' AND c.public=1 AND c.enabled=1 AND component_service.enabled=1)) ORDER BY mt.maintenance_id ASC,mt.target_type ASC,mt.target_id ASC");
    let values = rows
        .iter()
        .map(|row| row.maintenance_id.clone().into())
        .collect();
    let rows: Vec<Row> = context
        .db
        .all(&Query::new(sql, values))
        .await
        .map_err(|_| INTERNAL)?;
    let mut result = BTreeMap::<String, Targets>::new();
    for row in rows {
        let target = result.entry(row.maintenance_id).or_default();
        match row.target_type.as_str() {
            "service" => {
                if !service_name(&row.target_id) {
                    return Err(INTERNAL);
                }
                target.services.push(row.target_id);
            }
            "component" => {
                if !text(&row.target_id, 1, 128) {
                    return Err(INTERNAL);
                }
                target.components.push(row.target_id);
            }
            _ => return Err(INTERNAL),
        }
        if target.services.len() > 256 || target.components.len() > 256 {
            return Err(INTERNAL);
        }
    }
    Ok(result)
}

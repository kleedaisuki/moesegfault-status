//! 私有诊断读取与有界证据图；不执行后端任意查询。 / Private diagnostic reads and bounded evidence graphs, without arbitrary backend queries.
//! D1 parameters: https://developers.cloudflare.com/d1/worker-api/prepared-statements/
mod graph;
use super::{RpcContext, RpcProblem};
use crate::{
    access::AdminRole,
    cursor::{Binding, CursorSigner},
    database::{Database, DatabaseError, Query, SqlValue},
    wire::{Id, Slug, Text, UtcTime},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

/// 只投影必要事实，避免 SELECT * 泄露新增内部列。 / Project required facts rather than exposing new internal columns.
const ISSUE_COLUMNS:&str="i.issue_id,i.fingerprint_hash,i.service_name,i.kind,i.severity,i.state,i.first_seen_at,i.last_seen_at,i.occurrence_count,i.affected_instance_count,i.policy_id,i.policy_revision,i.suppression_until,i.suppression_reason,i.revision,(SELECT a.occurred_at FROM issue_actions a WHERE a.issue_id=i.issue_id AND a.action='acknowledged' ORDER BY a.occurred_at DESC LIMIT 1) AS acknowledged_at,(SELECT a.actor_subject FROM issue_actions a WHERE a.issue_id=i.issue_id AND a.action='acknowledged' ORDER BY a.occurred_at DESC LIMIT 1) AS acknowledged_by";
/// 严格搜索边界。 / Strict search boundary.
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Search {
    /// 服务。 / Service.
    service_name: Option<Slug<63>>,
    /// 状态。 / States.
    states: Option<Vec<status_domain::IssueState>>,
    /// 严重度。 / Severities.
    severities: Option<Vec<status_domain::DiagnosticSeverity>>,
    /// 类别。 / Kind.
    kind: Option<Text<3, 128>>,
    /// 下界。 / Lower bound.
    seen_after: Option<UtcTime>,
    /// 上界。 / Upper bound.
    seen_before: Option<UtcTime>,
    /// 签名游标。 / Signed cursor.
    #[serde(skip_serializing)]
    cursor: Option<Text<16, 2048>>,
    /// 页大小。 / Page size.
    #[serde(default = "page_size")]
    limit: usize,
}
/// 默认页大小。 / Default page size.
fn page_size() -> usize {
    50
}
/// 参数占位符；数量来自有界集合。 / Placeholders from bounded collections.
fn marks(n: usize) -> String {
    vec!["?"; n].join(",")
}
/// 无损绑定文本字段。 / Bind a required text field without coercion.
fn text(v: &Value, k: &str) -> Result<String, DatabaseError> {
    v[k].as_str()
        .map(str::to_owned)
        .ok_or(DatabaseError::RowContract)
}
/// 保留证据引用；验证失败不静默丢弃。 / Preserve evidence references; never silently discard validation failures.
fn reference(row: &Value) -> Result<Value, DatabaseError> {
    crate::evidence::map_reference(row).map_err(|_| DatabaseError::RowContract)
}
/// 批量加载每 Issue 最新 32 个引用，总预算 3200。 / Load 32 latest references per issue within a 3200-row budget.
async fn evidence_for(
    db: &Database,
    ids: &[String],
) -> Result<BTreeMap<String, Vec<Value>>, DatabaseError> {
    let mut out = BTreeMap::<String, Vec<Value>>::new();
    if ids.is_empty() {
        return Ok(out);
    }
    let rows=db.all::<Value>(&Query::new(format!("SELECT * FROM (SELECT r.issue_id,t.*,ROW_NUMBER() OVER (PARTITION BY r.issue_id ORDER BY r.linked_at DESC,t.telemetry_reference_id DESC) AS evidence_rank FROM issue_telemetry_references r JOIN telemetry_references t ON t.telemetry_reference_id=r.telemetry_reference_id WHERE r.issue_id IN ({})) WHERE evidence_rank<=32 ORDER BY issue_id,evidence_rank LIMIT 3200",marks(ids.len())),ids.iter().cloned().map(Into::into).collect())).await?;
    for row in rows {
        let list = out.entry(text(&row, "issue_id")?).or_default();
        if list.len() < 32 {
            list.push(reference(&row)?);
        }
    }
    Ok(out)
}
/// 从数据库事实构建 Issue 协议。 / Build issue protocol from database facts.
fn issue(mut row: Value, evidence: Vec<Value>) -> Result<Value, DatabaseError> {
    // 数据库存量损坏不可降格为看似有效的诊断事实。 / Corrupt stored facts must not appear valid.
    serde_json::from_value::<Id>(row["issue_id"].clone())
        .map_err(|_| DatabaseError::RowContract)?;
    serde_json::from_value::<Slug<63>>(row["service_name"].clone())
        .map_err(|_| DatabaseError::RowContract)?;
    serde_json::from_value::<status_domain::IssueState>(row["state"].clone())
        .map_err(|_| DatabaseError::RowContract)?;
    serde_json::from_value::<status_domain::DiagnosticSeverity>(row["severity"].clone())
        .map_err(|_| DatabaseError::RowContract)?;
    for key in ["first_seen_at", "last_seen_at"] {
        serde_json::from_value::<UtcTime>(row[key].clone())
            .map_err(|_| DatabaseError::RowContract)?;
    }
    for key in [
        "occurrence_count",
        "affected_instance_count",
        "policy_revision",
        "revision",
    ] {
        if row[key].as_u64().is_none_or(|n| {
            (n == 0 && key != "affected_instance_count") || n > 9_007_199_254_740_991
        }) {
            return Err(DatabaseError::RowContract);
        }
    }
    let hash = text(&row, "fingerprint_hash")?;
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(DatabaseError::RowContract);
    }

    row["fingerprint_hash"] = json!(format!("sha256:{}", text(&row, "fingerprint_hash")?));
    row["policy_revision"] = json!(format!(
        "{}:{}",
        text(&row, "policy_id")?,
        row["policy_revision"]
    ));
    row["latest_evidence"] = json!(evidence);
    row["suppressed_until"] = row["suppression_until"].clone();
    let obj = row.as_object_mut().ok_or(DatabaseError::RowContract)?;
    obj.remove("policy_id");
    obj.remove("suppression_until");
    Ok(row)
}
/// 读取完整不可变 Incident 时间线；只映射已声明字段。 / Read complete immutable incident timeline, projecting declared fields only.
pub async fn incident(db: &Database, id: &str) -> Result<Option<Value>, DatabaseError> {
    let Some(mut row)=db.first::<Value>(&Query::new("SELECT incident_id,title,state,impact,started_at,detected_at,resolved_at,cause,revision FROM incident_current WHERE incident_id=?",vec![id.into()])).await? else{return Ok(None)};
    for (table, column, field) in [
        ("incident_components", "component_id", "affected_components"),
        ("incident_services", "service_name", "affected_services"),
        ("incident_issues", "issue_id", "issue_ids"),
    ] {
        let rows = db
            .all::<Value>(&Query::new(
                format!("SELECT {column} FROM {table} WHERE incident_id=? ORDER BY {column}"),
                vec![id.into()],
            ))
            .await?;
        row[field] = json!(rows.iter().map(|r| r[column].clone()).collect::<Vec<_>>());
    }
    row["updates"]=json!(db.all::<Value>(&Query::new("SELECT sequence,state,impact,public_message AS message,occurred_at AS published_at FROM incident_updates WHERE incident_id=? ORDER BY sequence",vec![id.into()])).await?);
    Ok(Some(row))
}
/// 搜索使用路由和过滤器绑定的限时 HMAC 游标。 / Search uses expiring HMAC cursors bound to route and filters.
async fn search(db: &Database, q: Search, env: &worker::Env) -> Result<Value, (u16, &'static str)> {
    let internal = |_: DatabaseError| (500, "Diagnostic read failed");
    let secret = env
        .secret("CURSOR_SIGNING_KEY")
        .map_err(|_| (500, "Cursor configuration unavailable"))?
        .to_string();
    let signer =
        CursorSigner::new(&secret).map_err(|_| (500, "Cursor configuration unavailable"))?;
    let binding = Binding {
        route: "searchIssues".into(),
        query: serde_json::to_string(&q).map_err(|_| (400, "Invalid query"))?,
        sort: "last_seen_at:desc,issue_id:desc".into(),
    };
    let now = (js_sys::Date::now() / 1000.0) as i64;
    let cursor = q
        .cursor
        .as_ref()
        .map(|c| signer.verify(c.as_str(), &binding, now))
        .transpose()
        .map_err(|_| (400, "Invalid cursor"))?;
    let value = serde_json::to_value(&q).map_err(|_| (400, "Invalid query"))?;
    let mut clauses = Vec::new();
    let mut args = Vec::<SqlValue>::new();
    for (field, column, op) in [
        ("service_name", "service_name", "="),
        ("kind", "kind", "="),
        ("seen_after", "last_seen_at", ">="),
        ("seen_before", "last_seen_at", "<="),
    ] {
        if let Some(v) = value[field].as_str() {
            clauses.push(format!("i.{column}{op}?"));
            args.push(v.into());
        }
    }
    for (field, column) in [("states", "state"), ("severities", "severity")] {
        if let Some(v) = value[field].as_array().filter(|v| !v.is_empty()) {
            clauses.push(format!("i.{column} IN ({})", marks(v.len())));
            for item in v {
                args.push(item.as_str().ok_or((400, "Invalid query"))?.into());
            }
        }
    }
    if let Some(c) = cursor {
        let c = Value::Object(c);
        let time = text(&c, "last_seen_at").map_err(|_| (400, "Invalid cursor"))?;
        let id = text(&c, "issue_id").map_err(|_| (400, "Invalid cursor"))?;
        if serde_json::from_value::<UtcTime>(json!(time)).is_err() || Id::new(id.clone()).is_err() {
            return Err((400, "Invalid cursor"));
        }
        clauses.push("(i.last_seen_at<? OR (i.last_seen_at=? AND i.issue_id<?))".into());
        args.extend([time.clone().into(), time.into(), id.into()]);
    }
    let filter = if clauses.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", clauses.join(" AND "))
    };
    args.push(((q.limit + 1) as i64).into());
    let mut rows=db.all::<Value>(&Query::new(format!("SELECT {ISSUE_COLUMNS} FROM issues i {filter} ORDER BY i.last_seen_at DESC,i.issue_id DESC LIMIT ?"),args)).await.map_err(internal)?;
    let more = rows.len() > q.limit;
    rows.truncate(q.limit);
    let ids = rows
        .iter()
        .map(|r| text(r, "issue_id"))
        .collect::<Result<Vec<_>, _>>()
        .map_err(internal)?;
    let mut refs = evidence_for(db, &ids).await.map_err(internal)?;
    let next = if more {
        let last = rows.last().ok_or((500, "Diagnostic read failed"))?;
        Some(
            signer
                .sign(
                    binding,
                    json!({"last_seen_at":last["last_seen_at"],"issue_id":last["issue_id"]})
                        .as_object()
                        .cloned()
                        .ok_or((500, "Diagnostic read failed"))?,
                    now,
                )
                .map_err(|_| (500, "Cursor signing failed"))?,
        )
    } else {
        None
    };
    let data = rows
        .into_iter()
        .zip(ids)
        .map(|(r, id)| issue(r, refs.remove(&id).unwrap_or_default()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(internal)?;
    Ok(json!({"data":data,"next_cursor":next}))
}
/// 严格定位器验证；SQL 列只能来自静态分支。 / Strict locator validation; SQL columns come only from static branches.
fn valid_locator(v: &Value) -> bool {
    let Some(o) = v.as_object() else { return false };
    let kind = v["kind"].as_str().unwrap_or("");
    let field = match kind {
        "issue" => "issue_id",
        "incident" => "incident_id",
        "correlation" => "correlation_id",
        "trace" => "trace_id",
        "deployment" => "deployment_id",
        "service" => "service_name",
        _ => return false,
    };
    if kind == "service" {
        return o.len() == 4
            && serde_json::from_value::<Slug<63>>(v[field].clone()).is_ok()
            && serde_json::from_value::<UtcTime>(v["start"].clone()).is_ok()
            && serde_json::from_value::<UtcTime>(v["end"].clone()).is_ok()
            && match (
                v["start"]
                    .as_str()
                    .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()),
                v["end"]
                    .as_str()
                    .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()),
            ) {
                (Some(a), Some(b)) => a <= b,
                _ => false,
            };
    }
    if o.len() != 2 {
        return false;
    }
    let Some(s) = v[field].as_str() else {
        return false;
    };
    if kind == "trace" {
        return s.len() == 32
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            && s.bytes().any(|b| b != b'0');
    }
    Id::new(s.into()).is_ok()
}
/// 部署只返回清单字段，不返回凭证或内部状态。 / Deployments expose manifest fields, never credentials or internal state.
async fn deployments(db: &Database, ids: &[String]) -> Result<Vec<Value>, DatabaseError> {
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let mut rows=db.all::<Value>(&Query::new(format!("SELECT deployment_id,service_name,environment,service_version,repository_url,git_commit,git_ref,artifact_digest,ci_provider,ci_run_id,deployed_at FROM deployments WHERE deployment_id IN ({}) ORDER BY deployment_id",marks(ids.len())),ids.iter().cloned().map(Into::into).collect())).await?;
    for row in &mut rows {
        let id = text(row, "deployment_id")?;
        let regions = db
            .all::<Value>(&Query::new(
                "SELECT region FROM deployment_regions WHERE deployment_id=? ORDER BY region",
                vec![id.clone().into()],
            ))
            .await?;
        row["region"] = json!(regions
            .into_iter()
            .map(|r| r["region"].clone())
            .collect::<Vec<_>>());
        let mut artifacts=db.all::<Value>(&Query::new("SELECT kind,file_name,media_type,size_bytes,artifact_digest,build_id FROM deployment_artifact_requirements WHERE deployment_id=? AND size_bytes>0 ORDER BY kind,file_name",vec![id.into()])).await?;
        for a in &mut artifacts {
            if a["build_id"].is_null() {
                if let Some(o) = a.as_object_mut() {
                    o.remove("build_id");
                }
            }
        }
        row["artifacts"] = json!(artifacts);
    }
    Ok(rows)
}
/// 解析有界关联图，不删除已过期证据。 / Resolve a bounded association graph without deleting expired evidence.
async fn context(db: &Database, l: &Value) -> Result<Value, DatabaseError> {
    let kind = text(l, "kind")?;
    let mut direct = "0".to_owned();
    let mut direct_args = vec![];
    let (sql,args)=match kind.as_str(){
 "issue"=>(format!("SELECT {ISSUE_COLUMNS} FROM issues i WHERE i.issue_id=? LIMIT 101"),vec![text(l,"issue_id")?.into()]),
 "incident"=>(format!("SELECT {ISSUE_COLUMNS} FROM issues i JOIN incident_issues x ON x.issue_id=i.issue_id WHERE x.incident_id=? ORDER BY i.issue_id LIMIT 101"),vec![text(l,"incident_id")?.into()]),
 "service"=>{direct="t.service_name=? AND COALESCE(t.range_end,t.created_at)>=? AND COALESCE(t.range_start,t.created_at)<=?".into();direct_args=vec![text(l,"service_name")?.into(),text(l,"start")?.into(),text(l,"end")?.into()];(format!("SELECT {ISSUE_COLUMNS} FROM issues i WHERE i.service_name=? AND i.last_seen_at>=? AND i.first_seen_at<=? ORDER BY i.last_seen_at DESC,i.issue_id DESC LIMIT 101"),direct_args.clone())},
 _=>{let column=match kind.as_str(){"trace"=>"trace_id","correlation"=>"correlation_id",_=>"deployment_id"};let value=text(l,column)?;direct=format!("t.{column}=?");direct_args.push(value.clone().into());let occurrence=if kind=="trace"{"0".into()}else{format!("o.{column}=?")};let mut args=vec![value.clone().into()];if kind!="trace"{args.push(value.into());}(format!("SELECT DISTINCT {ISSUE_COLUMNS} FROM issues i LEFT JOIN issue_telemetry_references x ON x.issue_id=i.issue_id LEFT JOIN telemetry_references t ON t.telemetry_reference_id=x.telemetry_reference_id LEFT JOIN issue_occurrences o ON o.issue_id=i.issue_id WHERE t.{column}=? OR {occurrence} ORDER BY i.issue_id LIMIT 101"),args)}
 };
    let mut rows = db.all::<Value>(&Query::new(sql, args)).await?;
    let mut truncated = rows.len() > 100;
    rows.truncate(100);
    let ids = rows
        .iter()
        .map(|r| text(r, "issue_id"))
        .collect::<Result<Vec<_>, _>>()?;
    let mut incident_ids = BTreeSet::new();
    if kind == "incident" {
        incident_ids.insert(text(l, "incident_id")?);
    }
    if !ids.is_empty() {
        for row in db.all::<Value>(&Query::new(format!("SELECT DISTINCT incident_id FROM incident_issues WHERE issue_id IN ({}) ORDER BY incident_id LIMIT 101",marks(ids.len())),ids.iter().cloned().map(Into::into).collect())).await?{incident_ids.insert(text(&row,"incident_id")?);}
    }
    truncated |= incident_ids.len() > 100;
    let selected = incident_ids.into_iter().take(100).collect::<Vec<_>>();
    let mut incidents = vec![];
    for id in &selected {
        if let Some(i) = incident(db, id).await? {
            incidents.push(i)
        }
    }
    let mut clauses = vec![format!("({direct})")];
    let mut args = direct_args;
    for (table, column, values) in [
        ("issue_telemetry_references", "issue_id", &ids),
        ("incident_telemetry_references", "incident_id", &selected),
    ] {
        if !values.is_empty() {
            clauses.push(format!("EXISTS (SELECT 1 FROM {table} x WHERE x.telemetry_reference_id=t.telemetry_reference_id AND x.{column} IN (SELECT value FROM json_each(?)))"));
            args.push(
                serde_json::to_string(values)
                    .map_err(|_| DatabaseError::InvalidParameter)?
                    .into(),
            );
        }
    }
    let mut evidence_rows=db.all::<Value>(&Query::new(format!("SELECT t.* FROM telemetry_references t WHERE {} ORDER BY t.created_at DESC,t.telemetry_reference_id DESC LIMIT 201",clauses.join(" OR ")),args)).await?;
    truncated |= evidence_rows.len() > 200;
    evidence_rows.truncate(200);
    let evidence = evidence_rows
        .iter()
        .map(reference)
        .collect::<Result<Vec<_>, _>>()?;
    let mut grouped = evidence_for(db, &ids).await?;
    let issues = rows
        .into_iter()
        .zip(ids)
        .map(|(r, id)| issue(r, grouped.remove(&id).unwrap_or_default()))
        .collect::<Result<Vec<_>, _>>()?;
    let mut deployment_ids = evidence
        .iter()
        .map(|r| text(r, "deployment_id"))
        .collect::<Result<BTreeSet<_>, _>>()?;
    if kind == "deployment" {
        deployment_ids.insert(text(l, "deployment_id")?);
    }
    truncated |= deployment_ids.len() > 100;
    let deployment_ids = deployment_ids.into_iter().take(100).collect::<Vec<_>>();
    let deployments = deployments(db, &deployment_ids).await?;
    let mut output = graph::enrich(
        db,
        l,
        &issues,
        &incidents,
        &evidence,
        &evidence_rows,
        &deployments,
    )
    .await?;
    truncated |= output["truncated"].as_bool().unwrap_or(false);
    output["issues"] = json!(issues);
    output["incidents"] = json!(incidents);
    output["evidence"] = json!(evidence);
    output["deployments"] = json!(deployments);
    output["truncated"] = json!(truncated);
    Ok(output)
}
/// 命名私有入口；身份和每个输入在任何查询之前验证。 / Named private entrypoint; validate identity and inputs before any query.
/// `dispatch(db, "getIncident", request, env)` returns `{data}` or a sanitized `{problem}`.
pub async fn dispatch(db: &Database, operation: &str, raw: Value, env: &worker::Env) -> Value {
    let field = match operation {
        "getIncident" => "incident_id",
        "searchIssues" => "query",
        "queryDiagnosticContext" => "locator",
        _ => return json!({"problem":RpcProblem::new(404,"Unknown operation",&raw,operation)}),
    };
    let auth = match RpcContext::parse(&raw, &[field]) {
        Ok(c) => c,
        Err(p) => return json!({"problem":p}),
    };
    if !auth.require(AdminRole::Viewer) {
        return json!({"problem":RpcProblem::new(403,"Forbidden",&raw,operation)});
    }
    let result = match operation {
        "getIncident" => {
            if serde_json::from_value::<Id>(raw[field].clone()).is_err() {
                Err((400, "Invalid incident ID"))
            } else {
                match incident(db, raw[field].as_str().unwrap_or("")).await {
                    Ok(Some(v)) => Ok(v),
                    Ok(None) => Err((404, "Incident not found")),
                    Err(_) => Err((500, "Diagnostic read failed")),
                }
            }
        }
        "searchIssues" => match serde_json::from_value::<Search>(raw[field].clone()) {
            Ok(q)
                if (1..=100).contains(&q.limit)
                    && q.states.as_ref().is_none_or(|v| v.len() <= 5)
                    && q.severities.as_ref().is_none_or(|v| v.len() <= 4) =>
            {
                search(db, q, env).await
            }
            _ => Err((400, "Invalid query")),
        },
        _ => {
            if valid_locator(&raw[field]) {
                context(db, &raw[field])
                    .await
                    .map_err(|_| (500, "Diagnostic read failed"))
            } else {
                Err((400, "Invalid locator"))
            }
        }
    };
    match result {
        Ok(data) => json!({"data":data}),
        Err((status, title)) => json!({"problem":RpcProblem::new(status,title,&raw,operation)}),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn locator_rejects_unknown_and_zero_trace() {
        assert!(!valid_locator(
            &json!({"kind":"trace","trace_id":"00000000000000000000000000000000"})
        ));
        assert!(valid_locator(
            &json!({"kind":"trace","trace_id":"10000000000000000000000000000000"})
        ));
        assert!(!valid_locator(
            &json!({"kind":"trace","trace_id":"10000000000000000000000000000000","sql":"x"})
        ));
    }
    #[test]
    fn search_rejects_injection_shapes() {
        assert!(serde_json::from_value::<Search>(json!({"states":["active' OR 1=1"]})).is_err());
        assert!(serde_json::from_value::<Search>(json!({"limit":-1})).is_err());
        assert!(serde_json::from_value::<Search>(json!({"sql":"SELECT 1"})).is_err());
    }
    #[test]
    fn search_binding_excludes_cursor() {
        let a: Search = serde_json::from_value(json!({})).unwrap();
        let b: Search = serde_json::from_value(json!({"cursor":"0123456789012345"})).unwrap();
        assert_eq!(
            serde_json::to_value(a).unwrap(),
            serde_json::to_value(b).unwrap()
        );
    }
}

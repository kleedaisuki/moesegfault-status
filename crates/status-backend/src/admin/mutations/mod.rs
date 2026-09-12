//! 原生管理命令事务协调：领域写、审计、outbox 和幂等结果必须一起提交。
//! Native command coordination: domain writes, audit, outbox and replay results commit together.

mod catalog;
mod lifecycle;
mod monitors;
mod policies;

use crate::{
    access::AdminRole,
    admin::{RpcContext, RpcProblem},
    database::{Database, DatabaseError, Query, SqlValue},
    wire::Id,
};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// 已验证命令的事务计划；SQL 顺序属于契约。 / Validated command plan; SQL order is contractual.
pub(super) struct Plan {
    /// 原子写入。 / Atomic writes.
    pub queries: Vec<Query>,
    /// 首次提交的不可变响应。 / Immutable first-commit response.
    pub response: Value,
    /// 审计聚合类型。 / Audit aggregate type.
    pub target_type: &'static str,
    /// 审计聚合身份。 / Audit aggregate identity.
    pub target_id: String,
    /// 稳定审计动作。 / Stable audit action.
    pub action: &'static str,
    /// 下游领域事件类型。 / Downstream domain event type.
    pub event_type: &'static str,
    /// 显式安全事件载荷。 / Explicit safe event payload.
    pub event_payload: Option<Value>,
    /// 前修订。 / Prior revision.
    pub before_revision: Option<i64>,
    /// 后修订。 / Resulting revision.
    pub after_revision: Option<i64>,
    /// 安全审计摘要，非原始请求。 / Safe audit summary, not the raw request.
    pub details: Value,
    /// 需要重评的目标。 / Targets requiring reevaluation.
    pub reevaluate: Vec<(String, String)>,
}
impl Plan {
    /// 构造没有额外状态影响的计划。 / Construct a plan without additional status effects.
    pub fn new(
        queries: Vec<Query>,
        response: Value,
        target_type: &'static str,
        target_id: String,
        action: &'static str,
    ) -> Self {
        Self {
            queries,
            response,
            target_type,
            target_id,
            action,
            event_type: action,
            event_payload: None,
            before_revision: None,
            after_revision: Some(1),
            details: json!({}),
            reevaluate: vec![],
        }
    }
}
/// 不泄漏底层异常的命令错误。 / Command failure without platform exception leakage.
#[derive(Debug)]
pub(super) struct Failure {
    status: u16,
    title: &'static str,
}
impl Failure {
    /// 输入违反契约。 / Invalid input contract.
    pub fn invalid(title: &'static str) -> Self {
        Self { status: 400, title }
    }
    /// 乐观并发冲突。 / Optimistic concurrency conflict.
    pub fn conflict(title: &'static str) -> Self {
        Self { status: 409, title }
    }
    /// 资源不存在。 / Missing resource.
    pub fn missing(title: &'static str) -> Self {
        Self { status: 404, title }
    }
    /// 安全内部错误。 / Safe internal error.
    pub fn internal(title: &'static str) -> Self {
        Self { status: 500, title }
    }
}
impl From<DatabaseError> for Failure {
    fn from(error: DatabaseError) -> Self {
        match error {
            DatabaseError::Constraint => Self::conflict("Database constraint conflict"),
            DatabaseError::Unavailable => Self {
                status: 503,
                title: "Database unavailable",
            },
            _ => Self::internal("Database operation failed"),
        }
    }
}
/// 平台 UTC 时间。 / Platform UTC timestamp.
pub(super) fn now() -> String {
    js_sys::Date::new_0()
        .to_iso_string()
        .as_string()
        .unwrap_or_default()
}
/// CSPRNG UUIDv7，无共享可变状态。 / CSPRNG UUIDv7 without shared mutable state.
pub(super) fn uuid() -> Result<String, Failure> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|_| Failure::internal("Random source unavailable"))?;
    let millis = js_sys::Date::now() as u64;
    bytes[..6].copy_from_slice(&millis.to_be_bytes()[2..]);
    bytes[6] = (bytes[6] & 15) | 0x70;
    bytes[8] = (bytes[8] & 63) | 0x80;
    let h = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &h[..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..]
    ))
}
/// 参数化 SQL 构造。 / Parameterized SQL construction.
pub(super) fn query(sql: impl Into<String>, values: Vec<SqlValue>) -> Query {
    Query::new(sql, values)
}
/// 类型化可失败边界解析。 / Typed fallible boundary parsing.
pub(super) fn decode<T: DeserializeOwned>(value: &Value) -> Result<T, Failure> {
    serde_json::from_value(value.clone()).map_err(|_| Failure::invalid("Invalid command"))
}
/// 获取必需字符串。 / Obtain a required string.
pub(super) fn required<'a>(value: &'a Value, key: &str) -> Result<&'a str, Failure> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| Failure::invalid("Missing command field"))
}
/// 读取至多一行。 / Read at most one row.
pub(super) async fn row(
    db: &Database,
    sql: impl Into<String>,
    values: Vec<SqlValue>,
) -> Result<Option<Value>, Failure> {
    Ok(db.first(&query(sql, values)).await?)
}
/// 必须紧跟主 OCC UPDATE；零行会触发异常回滚整个 batch。
/// Must immediately follow the primary OCC UPDATE; zero rows abort the entire batch.
pub(super) fn assert_changed() -> Query {
    query(
        "SELECT CASE WHEN changes()=1 THEN 1 ELSE json('occ-conflict') END AS ok",
        vec![],
    )
}

/// 私有 RPC 管理写入口；不提供公开 HTTP 或 TypeScript 转发。
/// Private RPC mutation entrypoint, with no public HTTP route or TypeScript forwarding.
///
/// ```ignore
/// let result = mutations::dispatch(&db, "createIncident", request, &env).await;
/// ```
pub async fn dispatch(db: &Database, operation: &str, raw: Value, env: &worker::Env) -> Value {
    match execute(db, operation, &raw, env).await {
        Ok(data) => json!({"data":data}),
        Err(e) => json!({"problem":RpcProblem::new(e.status,e.title,&raw,operation)}),
    }
}
/// 一处授权/幂等/事务，避免每个业务复制失败路径。 / One authorization/replay/transaction path for every command.
async fn execute(
    db: &Database,
    op: &str,
    raw: &Value,
    _env: &worker::Env,
) -> Result<Value, Failure> {
    let (fields, role) = operation_contract(op)?;
    let ctx =
        RpcContext::parse(raw, fields).map_err(|_| Failure::invalid("Invalid RPC request"))?;
    if !ctx.require(role) {
        return Err(Failure {
            status: 403,
            title: "Insufficient role",
        });
    }
    let key = required(
        if matches!(op, "acknowledgeIssue" | "suppressIssue") {
            raw
        } else {
            &raw["command"]
        },
        "command_id",
    )?;
    Id::new(key.into()).map_err(|_| Failure::invalid("Invalid command ID"))?;
    let mut input = raw.clone();
    if let Some(o) = input.as_object_mut() {
        o.remove("correlation_id");
        o.remove("trace_context");
        o.remove("principal");
    }
    // 身份纳入 digest，禁止跨主体窃取其他命令的成功响应。
    // Include identity in the digest to prevent cross-principal replay theft.
    let digest = format!(
        "sha256:{:x}",
        Sha256::digest(
            serde_json::to_vec(&json!({"subject":ctx.principal().subject(),"input":input}))
                .map_err(|_| Failure::invalid("Invalid command"))?
        )
    );
    if let Some(result) = replay(db, op, key, &digest).await? {
        return Ok(result);
    }
    let mut plan = match op {
        "registerService"
        | "updateServiceCatalog"
        | "createComponent"
        | "updateComponentCatalog" => catalog::plan(db, op, raw).await?,
        "createMonitor" | "updateMonitor" => monitors::plan(db, op, raw).await?,
        "registerEvaluationPolicy"
        | "registerBackend"
        | "registerTelemetryBackend"
        | "assignDiagnosticPolicy"
        | "registerAndAssignRetentionPolicy"
        | "activateDeployment" => policies::plan(db, op, raw).await?,
        _ => lifecycle::plan(db, op, raw).await?,
    };
    let audit_id = uuid()?;
    let mut evaluation_writes = Vec::new();
    let mut overlay = plan
        .details
        .as_object_mut()
        .and_then(|o| o.remove("reevaluation_overlay"))
        .unwrap_or_else(|| json!({"evaluatedAt":now()}));
    if let Some(o) = overlay.get_mut("override").and_then(Value::as_object_mut) {
        o.insert("auditId".into(), json!(audit_id));
    }
    if !plan.reevaluate.is_empty() {
        let direct = json!(plan
            .reevaluate
            .iter()
            .map(|(kind, id)| json!({"kind":kind,"id":id}))
            .collect::<Vec<_>>())
        .to_string();
        let expanded=db.all::<Value>(&query("WITH requested AS (SELECT json_extract(value,'$.kind') kind,json_extract(value,'$.id') id FROM json_each(?)) SELECT 'component' kind,c.component_id id FROM components c JOIN requested r ON r.kind='service' AND r.id=c.service_name UNION SELECT 'component' kind,c.component_id id FROM component_services c JOIN requested r ON r.kind='service' AND r.id=c.service_name UNION SELECT 'service' kind,c.service_name id FROM components c JOIN requested r ON r.kind='component' AND r.id=c.component_id",vec![direct.into()])).await?;
        for target in expanded {
            plan.reevaluate.push((
                required(&target, "kind")?.into(),
                required(&target, "id")?.into(),
            ));
        }
        plan.reevaluate.sort();
        plan.reevaluate.dedup();
        let mut evaluation = crate::scheduling::reevaluate::plan_admin(
            db,
            &plan.reevaluate,
            &overlay,
            ctx.principal().subject(),
            ctx.correlation_id(),
        )
        .await?;
        if evaluation.len() < plan.reevaluate.len() {
            return Err(Failure::internal("Invalid evaluation plan"));
        }
        evaluation_writes = evaluation.split_off(plan.reevaluate.len());
        evaluation.append(&mut plan.queries);

        plan.queries = evaluation;
    }
    let time = now();
    let response = plan.response.clone();
    let before = plan
        .before_revision
        .map(SqlValue::Integer)
        .unwrap_or(SqlValue::Null);
    let after = plan
        .after_revision
        .map(SqlValue::Integer)
        .unwrap_or(SqlValue::Null);
    plan.queries.push(query("INSERT INTO audit_log(audit_id,actor_type,actor_subject,actor_roles_json,action,target_type,target_id,before_revision,after_revision,correlation_id,occurred_at,details_json) VALUES (?,'human',?,?,?,?,?,?,?,?,?,?)",vec![audit_id.into(),ctx.principal().subject().into(),raw["principal"]["roles"].to_string().into(),plan.action.into(),plan.target_type.into(),plan.target_id.clone().into(),before,after,ctx.correlation_id().into(),time.clone().into(),plan.details.to_string().into()]));
    plan.queries.extend(evaluation_writes);
    plan.queries.push(query("INSERT INTO outbox(outbox_id,aggregate_type,aggregate_id,event_type,schema_version,payload_json,state,attempt_count,available_at,next_attempt_at,created_at) VALUES (?,?,?,?,'1.0',?,'pending',0,?,?,?)",vec![uuid()?.into(),plan.target_type.into(),plan.target_id.clone().into(),plan.event_type.into(),plan.event_payload.clone().unwrap_or_else(||json!({"target_type":plan.target_type,"target_id":plan.target_id,"revision":plan.after_revision,"correlation_id":ctx.correlation_id()})).to_string().into(),time.clone().into(),time.clone().into(),time.clone().into()]));
    plan.queries.push(query("INSERT INTO idempotency_keys(scope,idempotency_key,request_digest,resource_type,resource_id,response_status,response_json,created_at,expires_at) VALUES (?,?,?,?,?,200,?,?,strftime('%Y-%m-%dT%H:%M:%fZ',?,'+7 days'))",vec![op.into(),key.into(),digest.clone().into(),plan.target_type.into(),plan.target_id.into(),response.to_string().into(),time.clone().into(),time.into()]));
    if let Err(error) = db.batch(&plan.queries).await {
        if let Some(result) = replay(db, op, key, &digest).await? {
            return Ok(result);
        }
        if error == DatabaseError::Execution
            && conflict_observed(db, op, raw, &plan.queries).await?
        {
            return Err(Failure::conflict("Command revision conflict"));
        }
        return Err(error.into());
    }
    Ok(response)
}
/// 失败后重新观察 OCC 前置条件；未知数据库异常绝不伪装成冲突。
/// Reobserve OCC preconditions after failure; unknown database errors never masquerade as conflicts.
async fn conflict_observed(
    db: &Database,
    op: &str,
    raw: &Value,
    queries: &[Query],
) -> Result<bool, Failure> {
    let resource = match op {
        "updateServiceCatalog" => Some(("services", "service_name")),
        "updateComponentCatalog" => Some(("components", "component_id")),
        "updateMonitor" => Some(("monitors", "monitor_id")),
        "updateIncident" => Some(("incident_current", "incident_id")),
        "acknowledgeIssue" | "suppressIssue" => Some(("issues", "issue_id")),
        "updateMaintenanceWindow" => Some(("maintenance_windows", "maintenance_id")),
        _ => None,
    };
    if let Some((table, column)) = resource {
        let key = if op == "updateMaintenanceWindow" {
            "id"
        } else {
            column
        };
        let current = row(
            db,
            format!("SELECT revision FROM {table} WHERE {column}=?"),
            vec![required(raw, key)?.into()],
        )
        .await?;
        if current.as_ref().map(|v| &v["revision"]) != Some(&raw["expected_revision"]) {
            return Ok(true);
        }
    }
    for statement in queries {
        if let Some(probe) = update_precondition(statement) {
            if db
                .first::<Value>(&probe)
                .await?
                .is_some_and(|v| v["valid"] == json!(0))
            {
                return Ok(true);
            }
        }
        // 仅重跑我们自己定义的只读 guard，不执行写入或 changes() 会话状态。
        // Only replay our own read-only guards, never writes or session-local changes().
        if (statement.sql().starts_with("SELECT CASE WHEN NOT EXISTS ")
            || statement
                .sql()
                .starts_with("SELECT CASE WHEN EXISTS (SELECT 1 FROM deployment_current_status "))
            && statement
                .sql()
                .ends_with(" THEN 1 ELSE json('invalid') END")
        {
            let probe = statement.sql().replace(
                " THEN 1 ELSE json('invalid') END",
                " THEN 1 ELSE 0 END AS valid",
            );
            if row(db, probe, statement.values().to_vec())
                .await?
                .is_some_and(|v| v["valid"] == json!(0))
            {
                return Ok(true);
            }
        }
    }
    Ok(false)
}
/// 从封闭 SQL 模板重建只读 WHERE；仅接受无编号占位符且尾部绑定的本模块 UPDATE。
/// Rebuild read-only WHERE from closed SQL templates using trailing anonymous parameter bindings.
fn update_precondition(statement: &Query) -> Option<Query> {
    let update = statement.sql().strip_prefix("UPDATE ")?;
    let (table, _) = update.split_once(" SET ")?;
    if ![
        "services",
        "components",
        "monitors",
        "issues",
        "maintenance_windows",
        "status_overrides",
        "service_diagnostic_policies",
        "service_retention_policies",
        "service_environment_deployments",
    ]
    .contains(&table)
    {
        return None;
    }
    let (_, predicate) = update.split_once(" WHERE ")?;
    let count = predicate.bytes().filter(|b| *b == b'?').count();
    let offset = statement.values().len().checked_sub(count)?;
    Some(query(
        format!("SELECT EXISTS (SELECT 1 FROM {table} WHERE {predicate}) AS valid"),
        statement.values()[offset..].to_vec(),
    ))
}
/// 回放确切提交结果，不读取后续变更后的资源。 / Replay the exact committed result, not a subsequently changed resource.
async fn replay(
    db: &Database,
    op: &str,
    key: &str,
    digest: &str,
) -> Result<Option<Value>, Failure> {
    let Some(prior)=row(db,"SELECT request_digest,response_json FROM idempotency_keys WHERE scope=? AND idempotency_key=?",vec![op.into(),key.into()]).await? else {return Ok(None)};
    if prior["request_digest"].as_str() != Some(digest) {
        return Err(Failure::conflict(
            "Idempotency key reused with different command",
        ));
    }
    let data = serde_json::from_str(required(&prior, "response_json")?)
        .map_err(|_| Failure::internal("Stored command response invalid"))?;
    Ok(Some(data))
}
/// 命令允许字段与最小角色是静态封闭集合。 / Allowed fields and minimum roles form a closed static set.
fn operation_contract(op: &str) -> Result<(&'static [&'static str], AdminRole), Failure> {
    let admin = AdminRole::Admin;
    let operator = AdminRole::Operator;
    Ok(match op {
        "registerService"
        | "createComponent"
        | "createMonitor"
        | "registerEvaluationPolicy"
        | "registerBackend"
        | "registerTelemetryBackend"
        | "assignDiagnosticPolicy"
        | "registerAndAssignRetentionPolicy" => (&["command"], admin),
        "updateServiceCatalog" => (&["command", "service_name", "expected_revision"], admin),
        "updateComponentCatalog" => (&["command", "component_id", "expected_revision"], admin),
        "updateMonitor" => (&["command", "monitor_id", "expected_revision"], admin),
        "activateDeployment" => (&["command", "deployment_id"], admin),
        "createIncident" | "createMaintenanceWindow" | "setStatusOverride" => {
            (&["command"], operator)
        }
        "updateIncident" => (&["command", "incident_id", "expected_revision"], operator),
        "acknowledgeIssue" => (&["command_id", "issue_id", "expected_revision"], operator),
        "suppressIssue" => (
            &[
                "command_id",
                "issue_id",
                "expected_revision",
                "until",
                "reason",
            ],
            operator,
        ),
        "updateMaintenanceWindow" => (&["command", "id", "expected_revision"], operator),
        _ => return Err(Failure::missing("Unknown administrative operation")),
    })
}

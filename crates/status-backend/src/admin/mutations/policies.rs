//! 不可变策略注册与 CAS 绑定计划；调用者拥有事务与审计。
//! Immutable policy registration and CAS assignment plans; caller owns transaction and audit.
use super::{assert_changed, now, query, required, row, uuid, Failure, Plan};
use crate::{
    database::{Database, Query, SqlValue},
    wire::Id,
};
use serde_json::{json, Value};

/// 严格字段集合，禁止静默丢弃未知参数。 / Strict fields, never silently discard unknown arguments.
fn fields(v: &Value, allowed: &[&str]) -> Result<(), Failure> {
    let o = v.as_object().ok_or(Failure::invalid("Expected object"))?;
    if o.keys().any(|k| !allowed.contains(&k.as_str())) {
        return Err(Failure::invalid("Unknown field"));
    }
    Ok(())
}
/// 有界整数。 / Bounded integer.
fn num(v: &Value, k: &str, min: i64, max: i64) -> Result<i64, Failure> {
    v[k].as_i64()
        .filter(|n| (min..=max).contains(n))
        .ok_or(Failure::invalid("Invalid integer"))
}
/// 可空预期版本；缺失不等同 null。 / Nullable expected revision; absence is not null.
fn expected(v: &Value, k: &str) -> Result<Option<i64>, Failure> {
    if v.get(k).is_some_and(Value::is_null) {
        Ok(None)
    } else {
        Ok(Some(num(v, k, 1, 9_007_199_254_740_991)?))
    }
}
/// UUID 校验。 / UUID validation.
fn id(v: &Value, k: &str) -> Result<String, Failure> {
    let s = required(v, k)?;
    Id::new(s.into()).map_err(|_| Failure::invalid("Invalid UUID"))?;
    Ok(s.into())
}
/// JSON 标量绑定，不隐式字符串化对象。 / Bind JSON scalar without implicit object stringification.
fn val(v: &Value) -> SqlValue {
    match v {
        Value::String(s) => s.clone().into(),
        Value::Number(n) => n.as_i64().map(SqlValue::Integer).unwrap_or(SqlValue::Null),
        _ => SqlValue::Null,
    }
}
/// SQL 断言在同一事务内失败即整体回滚。 / SQL assertion rolls back the entire transaction on failure.
fn guard(sql: &str, values: Vec<SqlValue>) -> Query {
    query(
        format!("SELECT CASE WHEN {sql} THEN 1 ELSE json('invalid') END"),
        values,
    )
}
/// 构建五类私有管理写计划。 / Build five private administrative mutation plans.
pub(super) async fn plan(db: &Database, op: &str, raw: &Value) -> Result<Plan, Failure> {
    id(&raw["command"], "command_id")?;
    match op {
        "registerEvaluationPolicy" => evaluation(raw),
        "registerBackend" | "registerTelemetryBackend" => backend(raw),
        "assignDiagnosticPolicy" => assignment(db, raw).await,
        "registerAndAssignRetentionPolicy" => retention(db, raw).await,
        "activateDeployment" => activate(db, raw).await,
        _ => Err(Failure::invalid("Unknown policy operation")),
    }
}
/// 注册精确阈值，浮点列仅兼容旧查询。 / Register exact thresholds; float columns only preserve legacy queries.
fn evaluation(raw: &Value) -> Result<Plan, Failure> {
    let c = &raw["command"];
    fields(c, &["command_id", "policy"])?;
    let p = &c["policy"];
    fields(
        p,
        &[
            "policy_id",
            "revision",
            "window_seconds",
            "minimum_samples",
            "failure_threshold",
            "recovery_threshold",
            "latency_threshold_ms",
            "stale_after_seconds",
            "quorum",
            "issue_fingerprint_template",
            "failure_status",
            "recovery_min_occurrences",
        ],
    )?;
    let pid = id(p, "policy_id")?;
    let rev = num(p, "revision", 1, 9_007_199_254_740_991)?;
    for (k, max) in [
        ("window_seconds", 86400),
        ("minimum_samples", 100000),
        ("stale_after_seconds", 604800),
    ] {
        num(p, k, 1, max)?;
    }
    if !p.get("latency_threshold_ms").is_some_and(Value::is_null) {
        num(p, "latency_threshold_ms", 1, 3600000)?;
    }
    if p.get("recovery_min_occurrences").is_some() {
        num(p, "recovery_min_occurrences", 2, 100000)?;
    }
    let mut ratios = Vec::new();
    for k in ["failure_threshold", "recovery_threshold"] {
        let r = &p[k];
        fields(r, &["numerator", "denominator"])?;
        let n = num(r, "numerator", 0, 1000000000)?;
        let d = num(r, "denominator", 1, 1000000000)?;
        let (mut a, mut b) = (n, d);
        while b != 0 {
            (a, b) = (b, a % b);
        }
        if n > d || a != 1 {
            return Err(Failure::invalid("Invalid exact ratio"));
        }
        ratios.push(SqlValue::Real(n as f64 / d as f64));
    }
    fields(
        &p["quorum"],
        &[
            "minimum_locations",
            "failure_locations",
            "recovery_locations",
        ],
    )?;
    for k in [
        "minimum_locations",
        "failure_locations",
        "recovery_locations",
    ] {
        num(&p["quorum"], k, 1, 256)?;
    }
    let template = p["issue_fingerprint_template"]
        .as_array()
        .ok_or(Failure::invalid("Invalid fingerprint"))?;
    if !(1..=7).contains(&template.len())
        || template.iter().any(|v| {
            !matches!(
                v.as_str(),
                Some(
                    "dependency"
                        | "operation"
                        | "error_type"
                        | "component"
                        | "capability"
                        | "region"
                        | "protocol"
                )
            )
        })
    {
        return Err(Failure::invalid("Invalid fingerprint"));
    }
    if !matches!(
        p["failure_status"].as_str(),
        Some("degraded" | "partial_outage" | "major_outage")
    ) {
        return Err(Failure::invalid("Invalid failure status"));
    }
    let q=query("INSERT INTO evaluation_policies (policy_id,revision,schema_version,name,observation_window_seconds,minimum_samples,failure_threshold,recovery_threshold,latency_threshold_ms,stale_after_seconds,location_quorum,fingerprint_template_json,status_mapping_json,diagnostic_rules_json,created_by,created_at) VALUES (?,?,'1.0',?,?,?,?,?,?,?,?,?,?,?,?,?)",vec![pid.clone().into(),rev.into(),format!("{pid}@{rev}").into(),val(&p["window_seconds"]),val(&p["minimum_samples"]),ratios[0].clone(),ratios[1].clone(),val(&p["latency_threshold_ms"]),val(&p["stale_after_seconds"]),val(&p["quorum"]["minimum_locations"]),json!({"fields":template}).to_string().into(),json!({"failure":p["failure_status"]}).to_string().into(),json!({"contract":p,"exact_thresholds":{"failure":p["failure_threshold"],"recovery":p["recovery_threshold"]},"quorum":p["quorum"]}).to_string().into(),val(&raw["principal"]["subject"]),now().into()]);
    let mut plan = Plan::new(
        vec![q],
        p.clone(),
        "evaluation_policy",
        format!("{pid}:{rev}"),
        "evaluation_policy.registered",
    );
    plan.after_revision = Some(rev);
    plan.event_payload = Some(json!({"policy_id":pid,"revision":rev}));
    Ok(plan)
}
/// 遥测凭据只接受引用名称。 / Telemetry credentials accept reference names only.
fn backend(raw: &Value) -> Result<Plan, Failure> {
    let c = &raw["command"];
    fields(c, &["command_id", "backend"])?;
    let b = &c["backend"];
    fields(
        b,
        &[
            "name",
            "capabilities",
            "query_adapter",
            "ui_url_template",
            "retention_class",
            "auth_reference",
        ],
    )?;
    let name = required(b, "name")?;
    if name.len() > 64
        || !name.split(['.', '_', '-']).all(|s| {
            !s.is_empty()
                && s.bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        })
    {
        return Err(Failure::invalid("Invalid backend name"));
    }
    let auth = required(b, "auth_reference")?;
    if auth.len() > 256
        || !auth.starts_with(|c: char| c.is_ascii_uppercase())
        || !auth
            .bytes()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_')
    {
        return Err(Failure::invalid("Invalid secret reference"));
    }
    let caps = b["capabilities"]
        .as_array()
        .ok_or(Failure::invalid("Invalid capabilities"))?;
    if !(1..=6).contains(&caps.len())
        || caps.iter().any(|v| {
            !matches!(
                v.as_str(),
                Some("trace" | "log_query" | "profile" | "metric_query" | "source" | "artifact")
            )
        })
    {
        return Err(Failure::invalid("Invalid capabilities"));
    }
    if !matches!(
        b["query_adapter"].as_str(),
        Some("tempo" | "loki" | "pyroscope" | "prometheus" | "source-commit" | "artifact-registry")
    ) {
        return Err(Failure::invalid("Invalid adapter"));
    }
    let url = required(b, "ui_url_template")?;
    if url.len() > 2048 || url::Url::parse(url).is_err() {
        return Err(Failure::invalid("Invalid UI URL"));
    }
    if !(1..=64).contains(&required(b, "retention_class")?.encode_utf16().count()) {
        return Err(Failure::invalid("Invalid retention class"));
    }
    let t = now();
    let q=query("INSERT INTO telemetry_backends (backend_name,capabilities_json,query_adapter,ui_url_template,retention_class,auth_reference,enabled,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,1,1,?,?)",vec![name.into(),json!(caps).to_string().into(),val(&b["query_adapter"]),url.into(),val(&b["retention_class"]),auth.into(),t.clone().into(),t.into()]);
    let mut plan = Plan::new(
        vec![q],
        b.clone(),
        "telemetry_backend",
        name.into(),
        "telemetry_backend.registered",
    );
    plan.after_revision = Some(1);
    plan.event_payload = Some(json!({"name":name,"revision":1}));
    Ok(plan)
}
/// 三种选择器归一成一条 CAS 更新路径。 / Normalize three selectors into one CAS update path.
async fn assignment(db: &Database, raw: &Value) -> Result<Plan, Failure> {
    let c = &raw["command"];
    fields(
        c,
        &["command_id", "selector", "policy_id", "policy_revision"],
    )?;
    let pid = id(c, "policy_id")?;
    let rev = num(c, "policy_revision", 1, 9_007_199_254_740_991)?;
    if row(
        db,
        "SELECT 1 FROM evaluation_policies WHERE policy_id=? AND revision=?",
        vec![pid.clone().into(), rev.into()],
    )
    .await?
    .is_none()
    {
        return Err(Failure::invalid("Evaluation policy not found"));
    }
    let s = &c["selector"];
    let kind = required(s, "kind")?;
    let mut monitor = SqlValue::Null;
    let mut service = SqlValue::Null;
    let mut diagnostic = SqlValue::Null;
    let (sql, values) = match kind {
        "monitor" => {
            fields(s, &["kind", "monitor_id"])?;
            monitor = id(s, "monitor_id")?.into();
            if row(
                db,
                "SELECT 1 FROM monitors WHERE monitor_id=?",
                vec![monitor.clone()],
            )
            .await?
            .is_none()
            {
                return Err(Failure::invalid("Monitor not found"));
            }
            ("SELECT assignment_id,revision FROM service_diagnostic_policies WHERE selector_kind='monitor' AND monitor_id=?",vec![monitor.clone()])
        }
        "service_kind" | "service_default" => {
            fields(
                s,
                if kind == "service_kind" {
                    &["kind", "service_name", "diagnostic_kind"]
                } else {
                    &["kind", "service_name"]
                },
            )?;
            let name = required(s, "service_name")?;
            service = name.into();
            if row(
                db,
                "SELECT 1 FROM services WHERE service_name=?",
                vec![service.clone()],
            )
            .await?
            .is_none()
            {
                return Err(Failure::invalid("Service not found"));
            }
            if kind == "service_kind" {
                let d = required(s, "diagnostic_kind")?;
                if d.len() > 128
                    || d.split('.').count() < 2
                    || !d.split('.').all(|s| {
                        s.starts_with(|c: char| c.is_ascii_lowercase())
                            && s.bytes()
                                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
                    })
                {
                    return Err(Failure::invalid("Invalid diagnostic kind"));
                }
                diagnostic = d.into();
                ("SELECT assignment_id,revision FROM service_diagnostic_policies WHERE selector_kind='service_kind' AND service_name=? AND diagnostic_kind=?",vec![service.clone(),diagnostic.clone()])
            } else {
                ("SELECT assignment_id,revision FROM service_diagnostic_policies WHERE selector_kind='service_default' AND service_name=?",vec![service.clone()])
            }
        }
        _ => return Err(Failure::invalid("Invalid selector")),
    };
    let existing = row(db, sql, values).await?;
    let before = existing.as_ref().and_then(|r| r["revision"].as_i64());
    let aid = match &existing {
        Some(v) => required(v, "assignment_id")?.into(),
        None => uuid()?,
    };
    let next = before.unwrap_or(0) + 1;
    let t = now();
    let actor = &raw["principal"]["subject"];
    let q = if let Some(old) = before {
        query("UPDATE service_diagnostic_policies SET policy_id=?,policy_revision=?,assigned_by=?,assigned_at=?,revision=revision+1 WHERE assignment_id=? AND revision=?",vec![pid.clone().into(),rev.into(),val(actor),t.clone().into(),aid.clone().into(),old.into()])
    } else {
        query("INSERT INTO service_diagnostic_policies (assignment_id,selector_kind,monitor_id,service_name,diagnostic_kind,policy_id,policy_revision,assigned_by,assigned_at,revision) VALUES (?,?,?,?,?,?,?,?,?,1)",vec![aid.clone().into(),kind.into(),monitor,service,diagnostic,pid.clone().into(),rev.into(),val(actor),t.clone().into()])
    };
    let response = json!({"assignment_id":aid,"selector":s,"policy_id":pid,"policy_revision":rev,"assigned_at":t,"assigned_by":actor,"revision":next});
    let mut p = Plan::new(
        vec![q, assert_changed()],
        response,
        "diagnostic_policy_assignment",
        aid,
        "diagnostic_policy.assigned",
    );
    p.before_revision = before;
    p.after_revision = Some(next);
    p.event_payload = Some(json!({"assignment_id":p.target_id,"revision":next}));
    p.details = json!({"selector":s,"policy_id":pid,"policy_revision":rev});
    Ok(p)
}
/// 不可变保留策略与显式预期版本绑定原子提交。 / Atomically register immutable retention and explicitly versioned assignment.
async fn retention(db: &Database, raw: &Value) -> Result<Plan, Failure> {
    let c = &raw["command"];
    fields(
        c,
        &[
            "command_id",
            "service_name",
            "policy",
            "expected_assignment_revision",
        ],
    )?;
    let policy = &c["policy"];
    fields(
        policy,
        &[
            "policy_id",
            "revision",
            "occurrence_retention_days",
            "cleanup_batch_size",
        ],
    )?;
    let name = required(c, "service_name")?;
    let pid = required(policy, "policy_id")?;
    if pid.len() > 64
        || !pid.starts_with(|c: char| c.is_ascii_lowercase())
        || !pid.split(['-', '_', '.']).all(|s| {
            !s.is_empty()
                && s.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
    {
        return Err(Failure::invalid("Invalid retention policy id"));
    }
    let rev = num(policy, "revision", 1, 9_007_199_254_740_991)?;
    let days = num(policy, "occurrence_retention_days", 1, 3650)?;
    let batch = num(policy, "cleanup_batch_size", 1, 10000)?;
    let exp = expected(c, "expected_assignment_revision")?;
    if row(
        db,
        "SELECT 1 FROM services WHERE service_name=?",
        vec![name.into()],
    )
    .await?
    .is_none()
    {
        return Err(Failure::missing("Service not found"));
    }
    let current = row(
        db,
        "SELECT revision FROM service_retention_policies WHERE service_name=?",
        vec![name.into()],
    )
    .await?;
    let before = current.as_ref().and_then(|v| v["revision"].as_i64());
    if before != exp {
        return Err(Failure::conflict("Retention assignment revision conflict"));
    }
    let old_policy = row(
        db,
        "SELECT * FROM data_retention_policies WHERE policy_id=? AND revision=?",
        vec![pid.into(), rev.into()],
    )
    .await?;
    if old_policy.as_ref().is_some_and(|p| {
        p["occurrence_retention_days"] != json!(days) || p["cleanup_batch_size"] != json!(batch)
    }) {
        return Err(Failure::conflict("Immutable retention policy conflict"));
    }
    let t = now();
    let actor = &raw["principal"]["subject"];
    let next = before.unwrap_or(0) + 1;
    let mut qs=vec![query("INSERT INTO data_retention_policies (policy_id,revision,occurrence_retention_days,cleanup_batch_size,created_by,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(policy_id,revision) DO NOTHING",vec![pid.into(),rev.into(),days.into(),batch.into(),val(actor),t.clone().into()]),guard("EXISTS (SELECT 1 FROM data_retention_policies WHERE policy_id=? AND revision=? AND occurrence_retention_days=? AND cleanup_batch_size=?)",vec![pid.into(),rev.into(),days.into(),batch.into()])];
    // 仅实际插入的不可变 revision 生成登记审计。 / Audit registration only when the immutable revision was inserted.
    qs.insert(1, query("INSERT INTO audit_log (audit_id,actor_type,actor_subject,actor_roles_json,action,target_type,target_id,before_revision,after_revision,correlation_id,occurred_at,details_json) SELECT ?,'human',?,?,'retention_policy.registered','retention_policy',?,NULL,?,?,?,? WHERE changes()=1", vec![uuid()?.into(),val(actor),raw["principal"]["roles"].to_string().into(),format!("{pid}:{rev}").into(),rev.into(),val(&raw["correlation_id"]),t.clone().into(),policy.to_string().into()]));
    // 防止并发登记导致响应中的创建主体/时间与已提交行不一致。
    // Prevent a concurrent registration from making returned registration metadata inaccurate.
    if old_policy.is_none() {
        qs.insert(0,guard("NOT EXISTS (SELECT 1 FROM data_retention_policies WHERE policy_id=? AND revision=?)",vec![pid.into(),rev.into()]));
    }
    qs.push(if let Some(old)=before{query("UPDATE service_retention_policies SET policy_id=?,policy_revision=?,assigned_by=?,assigned_at=?,revision=revision+1 WHERE service_name=? AND revision=?",vec![pid.into(),rev.into(),val(actor),t.clone().into(),name.into(),old.into()])}else{query("INSERT INTO service_retention_policies (service_name,policy_id,policy_revision,assigned_by,assigned_at,revision) VALUES (?,?,?,?,?,1)",vec![name.into(),pid.into(),rev.into(),val(actor),t.clone().into()])});
    qs.push(assert_changed());
    let registered_at = old_policy
        .as_ref()
        .map(|v| v["created_at"].clone())
        .unwrap_or(json!(t));
    let registered_by = old_policy
        .as_ref()
        .map(|v| v["created_by"].clone())
        .unwrap_or(actor.clone());
    let mut p = Plan::new(
        qs,
        json!({"service_name":name,"policy":policy,"assignment_revision":next,"assigned_at":t,"assigned_by":actor,"policy_registered_at":registered_at,"policy_registered_by":registered_by}),
        "service_retention_policy",
        name.into(),
        "retention_policy.assigned",
    );
    p.before_revision = before;
    p.after_revision = Some(next);
    p.event_payload = Some(
        json!({"service_name":name,"policy_id":pid,"policy_revision":rev,"assignment_revision":next}),
    );
    p.details = policy.clone();
    Ok(p)
}
/// 激活新部署并追加旧部署 retired 历史，以指针 CAS 防止丢失更新。 / Activate and retire using append-only history and pointer CAS.
async fn activate(db: &Database, raw: &Value) -> Result<Plan, Failure> {
    let c = &raw["command"];
    fields(
        c,
        &[
            "command_id",
            "expected_deployment_revision",
            "expected_pointer_revision",
            "reason",
        ],
    )?;
    let did = id(raw, "deployment_id")?;
    let expected_rev = num(c, "expected_deployment_revision", 1, 9_007_199_254_740_991)?;
    let pointer_rev = expected(c, "expected_pointer_revision")?;
    let reason = required(c, "reason")?.trim();
    if reason.is_empty() || reason.encode_utf16().count() > 1024 {
        return Err(Failure::invalid("Invalid reason"));
    }
    let target=row(db,"SELECT d.deployment_id,d.service_name,d.environment,s.state,s.revision FROM deployments d JOIN deployment_current_status s ON s.deployment_id=d.deployment_id WHERE d.deployment_id=?",vec![did.clone().into()]).await?.ok_or(Failure::missing("Deployment not found"))?;
    if target["state"] != "ready" || target["revision"] != json!(expected_rev) {
        return Err(Failure::conflict(
            "Deployment is not the expected ready revision",
        ));
    }
    let service = required(&target, "service_name")?;
    let env = required(&target, "environment")?;
    let pointer=row(db,"SELECT deployment_id,revision FROM service_environment_deployments WHERE service_name=? AND environment=?",vec![service.into(),env.into()]).await?;
    let before = pointer.as_ref().and_then(|p| p["revision"].as_i64());
    if before != pointer_rev {
        return Err(Failure::conflict(
            "Current deployment pointer revision conflict",
        ));
    }
    let t = now();
    let actor = &raw["principal"]["subject"];
    let mut qs=vec![guard("EXISTS (SELECT 1 FROM deployment_current_status WHERE deployment_id=? AND state='ready' AND revision=?)",vec![did.clone().into(),expected_rev.into()])];
    let previous = pointer
        .as_ref()
        .and_then(|p| p["deployment_id"].as_str())
        .filter(|id| *id != did);
    if let Some(prev) = previous {
        let old = row(
            db,
            "SELECT state,revision FROM deployment_current_status WHERE deployment_id=?",
            vec![prev.into()],
        )
        .await?
        .ok_or(Failure::conflict("Previous deployment missing"))?;
        if old["state"] != "active" {
            return Err(Failure::conflict("Previous deployment is not active"));
        }
        let rev = old["revision"]
            .as_i64()
            .ok_or(Failure::internal("Invalid deployment revision"))?;
        qs.push(guard("EXISTS (SELECT 1 FROM deployment_current_status WHERE deployment_id=? AND state='active' AND revision=?)",vec![prev.into(),rev.into()]));
        qs.push(query("INSERT INTO deployment_status_history (deployment_id,sequence,state,reason,actor_subject,correlation_id,occurred_at) VALUES (?,?,'retired',?,?,?,?)",vec![prev.into(),(rev+1).into(),format!("Superseded by {did}").into(),val(actor),val(&raw["correlation_id"]),t.clone().into()]));
    }
    qs.push(query("INSERT INTO deployment_status_history (deployment_id,sequence,state,reason,actor_subject,correlation_id,occurred_at) VALUES (?,?,'active',?,?,?,?)",vec![did.clone().into(),(expected_rev+1).into(),reason.into(),val(actor),val(&raw["correlation_id"]),t.clone().into()]));
    qs.push(if let Some(rev)=before{query("UPDATE service_environment_deployments SET deployment_id=?,activated_at=?,revision=revision+1 WHERE service_name=? AND environment=? AND revision=?",vec![did.clone().into(),t.clone().into(),service.into(),env.into(),rev.into()])}else{query("INSERT INTO service_environment_deployments (service_name,environment,deployment_id,activated_at,revision) VALUES (?,?,?,?,1)",vec![service.into(),env.into(),did.clone().into(),t.clone().into()])});
    qs.push(assert_changed());
    let next = before.unwrap_or(0) + 1;
    let response = json!({"deployment_id":did,"service_name":service,"environment":env,"deployment_state":"active","deployment_revision":expected_rev+1,"pointer_revision":next,"activated_at":t,"activated_by":actor});
    let mut p = Plan::new(
        qs,
        response,
        "deployment",
        did.clone(),
        "deployment.activated",
    );
    p.event_payload = Some(
        json!({"deployment_id":did,"service_name":service,"environment":env,"deployment_revision":expected_rev+1,"pointer_revision":next,"previous_deployment_id":previous}),
    );
    p.before_revision = Some(expected_rev);
    p.after_revision = Some(expected_rev + 1);
    p.details = json!({"service_name":service,"environment":env,"pointer_before_revision":before,"pointer_after_revision":next,"previous_deployment_id":previous,"reason":reason});
    Ok(p)
}

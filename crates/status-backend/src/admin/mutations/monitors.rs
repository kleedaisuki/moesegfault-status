//! Monitor 配置写入与合并验证；事务和审计由父模块负责。
//! Monitor configuration writes and merged validation; parent owns transactions and audit.
use super::{assert_changed, now, query, required, row, Failure, Plan};
use crate::{
    database::{Database, SqlValue},
    wire::{Id, Slug},
};
use serde_json::{json, Value};

/// 可变字段白名单。 / Mutable field allowlist.
const MUTABLE: &[&str] = &[
    "probe_kind",
    "probe_config",
    "schedule_kind",
    "schedule_expression",
    "interval_seconds",
    "timeout_ms",
    "locations",
    "policy_id",
    "policy_revision",
    "enabled",
];
/// 拒绝未知字段。 / Reject unknown fields.
fn fields(v: &Value, allowed: &[&str]) -> Result<(), Failure> {
    let o = v.as_object().ok_or(Failure::invalid("Expected object"))?;
    if o.keys().any(|k| !allowed.contains(&k.as_str())) {
        return Err(Failure::invalid("Unknown monitor field"));
    }
    Ok(())
}
/// 校验有界整数。 / Validate bounded integer.
fn number(v: &Value, k: &str, min: i64, max: i64) -> Result<i64, Failure> {
    v[k].as_i64()
        .filter(|n| (min..=max).contains(n))
        .ok_or(Failure::invalid("Invalid monitor integer"))
}
/// 校验有界文本。 / Validate bounded text.
fn text<'a>(v: &'a Value, k: &str, min: usize, max: usize) -> Result<&'a str, Failure> {
    let s = required(v, k)?;
    if !(min..=max).contains(&s.encode_utf16().count()) {
        return Err(Failure::invalid("Invalid monitor text"));
    }
    Ok(s)
}
/// UUID 不接受任意字符串。 / UUIDs are not arbitrary strings.
fn id(v: &Value, k: &str) -> Result<(), Failure> {
    Id::new(required(v, k)?.into()).map_err(|_| Failure::invalid("Invalid UUID"))?;
    Ok(())
}
/// 安全绑定可空标量。 / Bind nullable scalars safely.
fn sql(v: &Value) -> SqlValue {
    match v {
        Value::String(s) => s.clone().into(),
        Value::Number(n) => n.as_i64().map(SqlValue::Integer).unwrap_or(SqlValue::Null),
        Value::Bool(b) => (*b).into(),
        _ => SqlValue::Null,
    }
}
/// 有限 RPC 能力标识。 / Bounded RPC capability identifier.
fn identifier(v: &Value, k: &str) -> Result<(), Failure> {
    let s = text(v, k, 1, 128)?;
    if !s.as_bytes()[0].is_ascii_alphabetic()
        || !s
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
    {
        return Err(Failure::invalid("Invalid probe identifier"));
    }
    Ok(())
}
/// 注册时拒绝本地目标；执行时仍须检查部署许可和全部 DNS 地址。
/// Reject local targets at registration; execution still checks deployment allowlists and all DNS answers.
fn public_host(value: &str) -> Result<(), Failure> {
    let host = crate::probes::security::normalize_hostname(value)
        .map_err(|_| Failure::invalid("Invalid public probe hostname"))?;
    if host.parse::<std::net::IpAddr>().is_ok()
        && !crate::probes::security::is_public_address(&host)
    {
        return Err(Failure::invalid("Private or reserved probe address"));
    }
    Ok(())
}
/// 对不同探针应用封闭配置，避免任意 RPC 或隐藏凭据。
/// Apply closed probe configurations to prevent arbitrary RPC or hidden credentials.
fn probe(v: &mut Value) -> Result<(), Failure> {
    let kind = required(v, "kind")?.to_owned();
    match kind.as_str() {
        "http" => {
            fields(
                v,
                &[
                    "kind",
                    "url",
                    "method",
                    "expected_statuses",
                    "max_redirects",
                ],
            )?;
            let u = url::Url::parse(text(v, "url", 1, 2048)?)
                .map_err(|_| Failure::invalid("Invalid HTTPS URL"))?;
            if u.scheme() != "https"
                || u.host_str().is_none()
                || !u.username().is_empty()
                || u.password().is_some()
            {
                return Err(Failure::invalid("Invalid HTTPS URL"));
            }
            public_host(u.host_str().unwrap())?;
            if !matches!(u.port_or_known_default(), Some(80 | 443)) {
                return Err(Failure::invalid("HTTP port not allowed"));
            }
            if v.get("method").is_none() {
                v["method"] = json!("HEAD");
            }
            if !matches!(required(v, "method")?, "GET" | "HEAD") {
                return Err(Failure::invalid("Invalid HTTP method"));
            }
            if v.get("expected_statuses").is_none() {
                v["expected_statuses"] = json!([200]);
            }
            let statuses = v["expected_statuses"]
                .as_array()
                .ok_or(Failure::invalid("Invalid expected statuses"))?;
            if statuses.is_empty()
                || statuses.len() > 32
                || statuses
                    .iter()
                    .any(|s| !s.as_i64().is_some_and(|n| (100..=599).contains(&n)))
            {
                return Err(Failure::invalid("Invalid expected statuses"));
            }
            if v.get("max_redirects").is_none() {
                v["max_redirects"] = json!(0);
            }
            number(v, "max_redirects", 0, 3)?;
        }
        "tcp" => {
            fields(v, &["kind", "hostname", "port"])?;
            let h = text(v, "hostname", 1, 253)?;
            if !h.as_bytes()[0].is_ascii_alphanumeric()
                || !h
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b".:-".contains(&b))
            {
                return Err(Failure::invalid("Invalid TCP hostname"));
            }
            public_host(h)?;
            number(v, "port", 1, 65535)?;
        }
        "dns" => {
            fields(v, &["kind", "hostname", "record_type"])?;
            public_host(text(v, "hostname", 1, 253)?)?;
            if !matches!(required(v, "record_type")?, "A" | "AAAA") {
                return Err(Failure::invalid("Invalid DNS record type"));
            }
        }
        "rpc" => {
            fields(v, &["kind", "binding", "operation"])?;
            identifier(v, "binding")?;
            identifier(v, "operation")?;
        }
        "synthetic" => {
            fields(v, &["kind", "binding", "scenario"])?;
            identifier(v, "binding")?;
            identifier(v, "scenario")?;
        }
        _ => return Err(Failure::invalid("Invalid probe kind")),
    }
    Ok(())
}
/// 验证完整配置，更新先合并再检查跨字段不变量。
/// Validate complete configuration after merging updates and cross-field invariants.
fn validate(v: &mut Value) -> Result<(), Failure> {
    id(v, "monitor_id")?;
    id(v, "policy_id")?;
    number(v, "policy_revision", 1, 9_007_199_254_740_991)?;
    number(v, "revision", 1, 9_007_199_254_740_991)?;
    Slug::<63>::new(required(v, "service_name")?.into())
        .map_err(|_| Failure::invalid("Invalid service name"))?;
    text(v, "target_id", 1, 128)?;
    if !matches!(required(v, "target_type")?, "service" | "component") {
        return Err(Failure::invalid("Invalid target type"));
    }
    probe(&mut v["probe_config"])?;
    if v["probe_kind"] != v["probe_config"]["kind"] {
        return Err(Failure::invalid("Probe kind mismatch"));
    }
    let timeout = number(v, "timeout_ms", 1, 300000)?;
    match required(v, "schedule_kind")? {
        "interval" => {
            let n = number(v, "interval_seconds", 10, 86400)?;
            if v.get("schedule_expression") != Some(&Value::Null) || timeout >= n * 1000 {
                return Err(Failure::invalid("Invalid interval schedule"));
            }
        }
        "cron" => {
            let s = text(v, "schedule_expression", 9, 128)?;
            if v.get("interval_seconds") != Some(&Value::Null)
                || s.split_whitespace().count() != 5
                || s.contains(['L', 'W', '#', '?'])
            {
                return Err(Failure::invalid("Invalid cron schedule"));
            }
            crate::scheduling::schedule::validate_cron(s)
                .map_err(|_| Failure::invalid("Invalid cron schedule"))?;
        }
        _ => return Err(Failure::invalid("Invalid schedule kind")),
    }
    if !v["enabled"].is_boolean() {
        return Err(Failure::invalid("Invalid enabled flag"));
    }
    let locations = v["locations"]
        .as_array()
        .ok_or(Failure::invalid("Invalid locations"))?;
    if locations.is_empty()
        || locations.len() > 64
        || locations.iter().any(|l| {
            !l.as_str()
                .is_some_and(|s| (1..=64).contains(&s.encode_utf16().count()))
        })
    {
        return Err(Failure::invalid("Invalid locations"));
    }
    let mut locations = locations.clone();
    locations.sort_by(|a, b| a.as_str().cmp(&b.as_str()));
    locations.dedup();
    v["locations"] = json!(locations);
    Ok(())
}
/// 读取规范快照而不是将数据库内部列暴露给调用者。
/// Read a canonical snapshot rather than exposing internal database columns.
async fn load(db: &Database, id: &str) -> Result<Value, Failure> {
    let mut r=row(db,"SELECT m.*,CASE WHEN m.target_type='service' THEN m.target_id ELSE c.service_name END AS service_name FROM monitors m LEFT JOIN components c ON m.target_type='component' AND c.component_id=m.target_id WHERE m.monitor_id=?",vec![id.into()]).await?.ok_or(Failure::missing("Monitor not found"))?;
    let locations=row(db,"SELECT COALESCE(json_group_array(location),'[]') AS locations FROM (SELECT location FROM monitor_locations WHERE monitor_id=? AND enabled=1 ORDER BY location)",vec![id.into()]).await?.ok_or(Failure::internal("Invalid monitor snapshot"))?;
    r["locations"] = serde_json::from_str(required(&locations, "locations")?)
        .map_err(|_| Failure::internal("Invalid monitor snapshot"))?;
    r["probe_config"] = serde_json::from_str(required(&r, "probe_config_json")?)
        .map_err(|_| Failure::internal("Invalid monitor snapshot"))?;
    r["enabled"] = json!(r["enabled"].as_i64() == Some(1));
    let mut out = json!({});
    for key in MUTABLE.iter().copied().chain([
        "monitor_id",
        "service_name",
        "target_type",
        "target_id",
        "revision",
    ]) {
        out[key] = r[key].clone();
    }
    Ok(out)
}
/// 创建或乐观并发更新；所有查询必须在同一 batch 中执行。
/// Create or optimistic update; all queries must execute in one batch.
pub(super) async fn plan(db: &Database, op: &str, raw: &Value) -> Result<Plan, Failure> {
    let command = &raw["command"];
    id(command, "command_id")?;
    let create = op == "createMonitor";
    if !create && op != "updateMonitor" {
        return Err(Failure::invalid("Unknown monitor operation"));
    }
    let mut allowed = MUTABLE.to_vec();
    allowed.push("command_id");
    if create {
        allowed.extend(["monitor_id", "service_name", "target_type", "target_id"]);
    }
    fields(command, &allowed)?;
    let mut data;
    let before;
    if create {
        data = command.clone();
        data.as_object_mut().unwrap().remove("command_id");
        data["revision"] = json!(1);
        before = None;
    } else {
        id(raw, "monitor_id")?;
        let revision = number(raw, "expected_revision", 1, 9_007_199_254_740_990)?;
        before = Some(revision);
        data = load(db, required(raw, "monitor_id")?).await?;
        if data["revision"] != json!(revision) {
            return Err(Failure::conflict("Monitor revision conflict"));
        }
        if command.as_object().unwrap().len() < 2
            || command.get("probe_kind").is_some() != command.get("probe_config").is_some()
        {
            return Err(Failure::invalid("Invalid monitor patch"));
        }
        for key in MUTABLE {
            if let Some(value) = command.get(*key) {
                data[*key] = value.clone();
            }
        }
        data["revision"] = json!(revision + 1);
    }
    validate(&mut data)?;
    let monitor = required(&data, "monitor_id")?.to_owned();
    let target = required(&data, "target_id")?;
    let service = required(&data, "service_name")?;
    if data["target_type"] == "service" {
        if target != service {
            return Err(Failure::invalid(
                "Monitor target does not belong to service",
            ));
        }
    } else {
        let component = row(
            db,
            "SELECT service_name FROM components WHERE component_id=?",
            vec![target.into()],
        )
        .await?;
        if component.as_ref().and_then(|r| r["service_name"].as_str()) != Some(service) {
            return Err(Failure::invalid(
                "Monitor target does not belong to service",
            ));
        }
    }
    if row(
        db,
        "SELECT 1 AS ok FROM evaluation_policies WHERE policy_id=? AND revision=?",
        vec![sql(&data["policy_id"]), sql(&data["policy_revision"])],
    )
    .await?
    .is_none()
    {
        return Err(Failure::invalid("Evaluation policy not found"));
    }
    let at = now();
    let mut queries = vec![];
    if create {
        queries.push(query("INSERT INTO monitors (monitor_id,target_type,target_id,probe_kind,schedule_kind,schedule_expression,interval_seconds,timeout_ms,probe_config_json,policy_id,policy_revision,next_run_at,critical,enabled,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,1,?,?)",vec![monitor.clone().into(),sql(&data["target_type"]),sql(&data["target_id"]),sql(&data["probe_kind"]),sql(&data["schedule_kind"]),sql(&data["schedule_expression"]),sql(&data["interval_seconds"]),sql(&data["timeout_ms"]),data["probe_config"].to_string().into(),sql(&data["policy_id"]),sql(&data["policy_revision"]),at.clone().into(),sql(&data["enabled"]),at.clone().into(),at.into()]));
    } else {
        queries.push(query("UPDATE monitors SET probe_kind=?,probe_config_json=?,schedule_kind=?,schedule_expression=?,interval_seconds=?,timeout_ms=?,policy_id=?,policy_revision=?,enabled=?,updated_at=?,revision=revision+1 WHERE monitor_id=? AND revision=?",vec![sql(&data["probe_kind"]),data["probe_config"].to_string().into(),sql(&data["schedule_kind"]),sql(&data["schedule_expression"]),sql(&data["interval_seconds"]),sql(&data["timeout_ms"]),sql(&data["policy_id"]),sql(&data["policy_revision"]),sql(&data["enabled"]),at.into(),monitor.clone().into(),before.unwrap().into()]));
        queries.push(assert_changed());
        queries.push(query(
            "DELETE FROM monitor_locations WHERE monitor_id=?",
            vec![monitor.clone().into()],
        ));
    }
    for location in data["locations"].as_array().unwrap() {
        queries.push(query(
            "INSERT INTO monitor_locations (monitor_id,location,enabled) VALUES (?,?,1)",
            vec![monitor.clone().into(), sql(location)],
        ));
    }
    let revision = data["revision"].as_i64();
    let mut p = Plan::new(
        queries,
        data,
        "monitor",
        monitor,
        if create {
            "monitor.created"
        } else {
            "monitor.updated"
        },
    );
    p.before_revision = before;
    p.after_revision = revision;
    p.event_payload = Some(json!({"monitor_id": p.target_id, "revision": revision}));
    Ok(p)
}

#[cfg(test)]
mod tests {
    use super::*;
    /// 默认 HTTP 配置以及关闭未知字段。 / HTTP defaults and unknown-field rejection.
    #[test]
    fn http_contract() {
        let mut p = json!({"kind":"http","url":"https://example.com"});
        assert!(probe(&mut p).is_ok());
        assert_eq!(p["method"], "HEAD");
        p["headers"] = json!({"authorization":"secret"});
        assert!(probe(&mut p).is_err());
    }
    /// 仅允许有限 RPC 能力。 / Only bounded RPC capabilities are accepted.
    #[test]
    fn rpc_contract() {
        assert!(
            probe(&mut json!({"kind":"rpc","binding":"health","operation":"getHealth"})).is_ok()
        );
        assert!(
            probe(&mut json!({"kind":"rpc","binding":"https://evil","operation":"getHealth"}))
                .is_err()
        );
    }
    /// 注册拒绝静态 SSRF 与非标准 HTTPS 端口。 / Registration rejects static SSRF and nonstandard HTTPS ports.
    #[test]
    fn rejects_private_targets() {
        for url in [
            "https://127.0.0.1",
            "https://[::1]",
            "https://metadata.internal",
            "https://example.com:8443",
            "https://user:secret@example.com",
        ] {
            assert!(probe(&mut json!({"kind":"http","url":url})).is_err());
        }
        assert!(probe(&mut json!({"kind":"tcp","hostname":"10.0.0.1","port":443})).is_err());
        assert!(
            probe(&mut json!({"kind":"dns","hostname":"localhost","record_type":"A"})).is_err()
        );
    }
}

//! D1 注册项驱动真实 Workers Fetch，凭据不进入 RPC。 / D1 registrations drive real Workers Fetch; credentials never enter RPC.
use super::{
    config::{self, Config},
    map_reference, normalize, query,
};
use crate::{
    access::AdminRole,
    admin::{RpcContext, RpcProblem},
    database::{Database, Query, SqlValue},
    wire::Id,
};
use futures_util::{
    future::{select, Either},
    StreamExt,
};
use serde_json::{json, Value};
use std::time::Duration;
use url::Url;
use worker::{AbortController, Delay, Env, Fetch, Request, RequestInit, RequestRedirect};
/// 查询已注册 ID 的遥测；调用方必须是可信私有 RPC。 / Query telemetry by registered ID; callers must be trusted private RPC.
///
/// ```ignore
/// let result = query_telemetry_reference(&env, request).await?;
/// ```
pub async fn query_telemetry_reference(env: &Env, raw: Value) -> worker::Result<Value> {
    let operation = "queryTelemetryReference";
    let context = match RpcContext::parse(&raw, &["telemetry_reference_id"]) {
        Ok(c) => c,
        Err(p) => return Ok(json!({"problem":p})),
    };
    if !context.require(AdminRole::Viewer) {
        return Ok(json!({"problem":RpcProblem::new(403,"Forbidden",&raw,operation)}));
    }
    let Some(id) = raw["telemetry_reference_id"]
        .as_str()
        .filter(|s| Id::new((*s).into()).is_ok())
    else {
        return Ok(
            json!({"problem":RpcProblem::new(400,"Invalid evidence query request",&raw,operation)}),
        );
    };
    let db = Database::new(env.d1("DB")?);
    let row=db.first::<Value>(&Query::new("SELECT t.*,b.capabilities_json,b.query_adapter,b.ui_url_template,b.auth_reference,b.enabled,d.repository_url,d.git_commit FROM telemetry_references t JOIN telemetry_backends b ON b.backend_name=t.backend_name JOIN deployments d ON d.deployment_id=t.deployment_id WHERE t.telemetry_reference_id=?",vec![id.into()])).await.map_err(|_|worker::Error::RustError("Evidence database unavailable".into()))?;
    let Some(row) = row else {
        return Ok(
            json!({"problem":RpcProblem::new(404,"Telemetry reference not found",&raw,operation)}),
        );
    };
    let reference = match map_reference(&row) {
        Ok(r) => r,
        Err(_) => {
            return Ok(
                json!({"problem":RpcProblem::new(503,"Stored telemetry reference is invalid",&raw,operation)}),
            )
        }
    };
    let now = js_sys::Date::now() as i64;
    let mut result = execute(env, &db, &row, &reference, now).await;
    result["telemetry_reference"] = reference;
    result["queried_at"] = json!(normalize::timestamp(now));
    Ok(json!({"data":result}))
}
/// 返回终态，不泄漏供应商响应。 / Return a terminal state without leaking vendor responses.
fn terminal(status: &str, detail: &str) -> Value {
    json!({"status":status,"detail":detail,"ui_url":null,"records":[],"truncated":false})
}
/// 依次检查保留期、能力和来源。 / Check retention, capability and provenance in order.
async fn execute(env: &Env, db: &Database, row: &Value, r: &Value, now: i64) -> Value {
    if r["expires_at"]
        .as_str()
        .and_then(epoch)
        .is_some_and(|t| t <= now)
    {
        return terminal("expired", "Telemetry retention has expired");
    }
    if row["enabled"] != 1 {
        return terminal("unavailable", "Telemetry backend is disabled");
    }
    let capabilities = row["capabilities_json"]
        .as_str()
        .and_then(|s| serde_json::from_str::<Vec<String>>(s).ok());
    if capabilities.as_ref().is_none_or(|v| {
        v.len() > 6
            || v.iter().any(|k| {
                ![
                    "trace",
                    "log_query",
                    "metric_query",
                    "profile",
                    "source",
                    "artifact",
                ]
                .contains(&k.as_str())
            })
    }) {
        return terminal("unavailable", "Stored backend capabilities are invalid");
    }
    if !capabilities
        .unwrap_or_default()
        .iter()
        .any(|k| Some(k.as_str()) == r["kind"].as_str())
    {
        return terminal("unsupported", "Backend does not declare this capability");
    }
    let adapter = row["query_adapter"].as_str().unwrap_or("");
    let expected = match adapter {
        "tempo" => "trace",
        "loki" => "log_query",
        "prometheus" => "metric_query",
        "pyroscope" => "profile",
        "source-commit" => "source",
        "artifact-registry" => "artifact",
        _ => return terminal("unsupported", "Backend query adapter is not supported"),
    };
    if r["kind"] != expected {
        return terminal("unsupported", "Adapter cannot query this evidence kind");
    }
    if adapter == "artifact-registry" {
        let l = &r["locator"];
        let build = l["build_id"]
            .as_str()
            .map(SqlValue::from)
            .unwrap_or(SqlValue::Null);
        let found=db.first::<Value>(&Query::new("SELECT artifact_id FROM deployment_artifacts WHERE deployment_id=? AND artifact_digest=? AND kind=? AND (? IS NULL OR build_id=?) LIMIT 1",vec![r["deployment_id"].as_str().unwrap_or("").into(),l["artifact_digest"].as_str().unwrap_or("").into(),l["artifact_kind"].as_str().unwrap_or("").into(),build.clone(),build])).await;
        if !matches!(found, Ok(Some(_))) {
            return terminal(
                "unavailable",
                "Artifact is not registered for this deployment",
            );
        }
    }
    let raw_config = env
        .var("TELEMETRY_BACKEND_CONFIG_JSON")
        .ok()
        .map(|v| v.to_string());
    let configs = config::configs(raw_config.as_deref());
    let Some(c) = configs.get(r["backend"].as_str().unwrap_or("")) else {
        return terminal(
            "unavailable",
            "Backend runtime configuration is unavailable",
        );
    };
    if adapter == "source-commit" {
        return source(row, r, c);
    }
    if adapter == "artifact-registry" {
        let l = &r["locator"];
        let mut attrs = json!({"artifact_digest":l["artifact_digest"]});
        if let Some(build) = l.get("build_id") {
            attrs["build_id"] = build.clone();
        }
        return json!({"status":"ok","ui_url":ui(row,c,l),"records":[normalize::record(l["artifact_kind"].as_str().unwrap_or("artifact"),None,&attrs)],"truncated":false});
    }
    let Some((url, values)) = request_url(c, r, adapter) else {
        return terminal(
            "unsupported",
            "Locator requires finite structured keys with matching service and deployment identity",
        );
    };
    let secrets_raw = env
        .secret("TELEMETRY_AUTH_JSON")
        .ok()
        .map(|v| v.to_string());
    let secrets = config::secrets(secrets_raw.as_deref());
    let credential = secrets.get(row["auth_reference"].as_str().unwrap_or(""));
    match fetch_json(url, c, credential).await {
        Ok(data) => {
            let (records, truncated) = normalize::normalize(adapter, r, &data);
            json!({"status":"ok","ui_url":ui(row,c,&values),"records":records,"truncated":truncated})
        }
        Err((status, detail)) => {
            let mut result = terminal(status, detail);
            if status == "not_found" {
                result["ui_url"] = json!(ui(row, c, &json!({})));
                result.as_object_mut().map(|m| m.remove("detail"));
            }
            result
        }
    }
}
/// 模板插值仅编码值，主机仍精确许可。 / Template substitutions encode values and still enforce exact hosts.
fn ui(row: &Value, c: &Config, values: &Value) -> Option<String> {
    let mut rendered = row["ui_url_template"].as_str()?.to_string();
    let mut unused = Vec::new();
    for (k, v) in values.as_object()? {
        let Some(v) = v.as_str() else { continue };
        let placeholder = format!("{{{k}}}");
        if rendered.contains(&placeholder) {
            rendered = rendered.replace(&placeholder, &encode(v));
        } else {
            unused.push((k, v));
        }
    }
    if rendered.contains(['{', '}']) {
        return None;
    }
    let mut u = config::allowed(&rendered, c)?;
    for (k, v) in unused {
        u.query_pairs_mut().append_pair(k, v);
    }
    let s = u.to_string();
    (s.len() <= 2048).then_some(s)
}
/// 来源必须匹配不可变 deployment。 / Source must match the immutable deployment.
fn source(row: &Value, r: &Value, c: &Config) -> Value {
    let l = &r["locator"];
    let repository = l["repository_url"].as_str().unwrap_or("");
    if canonical(repository) != canonical(row["repository_url"].as_str().unwrap_or(""))
        || l["git_commit"] != row["git_commit"]
    {
        return terminal(
            "unavailable",
            "Source locator does not match immutable deployment provenance",
        );
    }
    let Some(mut u) = config::allowed(repository, c) else {
        return terminal(
            "unavailable",
            "Source URL is outside the configured HTTPS host allowlist",
        );
    };
    let prefix = u
        .path()
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .to_string();
    let blob = if u.host_str() == Some("gitlab.com") {
        "/-/blob/"
    } else {
        "/blob/"
    };
    let path = l["path"]
        .as_str()
        .unwrap_or("")
        .split('/')
        .map(encode)
        .collect::<Vec<_>>()
        .join("/");
    u.set_path(&format!(
        "{prefix}{blob}{}/{path}",
        l["git_commit"].as_str().unwrap_or("")
    ));
    u.set_query(None);
    u.set_fragment(l["line"].as_u64().map(|n| format!("L{n}")).as_deref());
    if u.as_str().len() > 2048 {
        return terminal("unavailable", "Source URL exceeds the safe length limit");
    }
    let mut attrs = json!({"git_commit":l["git_commit"]});
    for key in ["line", "column"] {
        if let Some(v) = l.get(key) {
            attrs[key] = v.clone();
        }
    }
    json!({"status":"ok","ui_url":u.as_str(),"records":[normalize::record(l["path"].as_str().unwrap_or("source"),None,&attrs)],"truncated":false})
}
fn canonical(raw: &str) -> Option<String> {
    let u = Url::parse(raw).ok()?;
    Some(format!(
        "{}{}",
        u.origin().ascii_serialization(),
        u.path().trim_end_matches('/').trim_end_matches(".git")
    ))
}
fn encode(s: &str) -> String {
    const SET: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
        .remove(b'-')
        .remove(b'_')
        .remove(b'.')
        .remove(b'!')
        .remove(b'~')
        .remove(b'*')
        .remove(b'\'')
        .remove(b'(')
        .remove(b')');
    percent_encoding::utf8_percent_encode(s, SET).to_string()
}
fn epoch(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|d| d.timestamp_millis())
}
/// URL 根只来自部署配置。 / URL roots come exclusively from deployment config.
fn request_url(c: &Config, r: &Value, adapter: &str) -> Option<(Url, Value)> {
    let mut u = config::allowed(&c.endpoint, c)?;
    let start = r["time_range"]["start"].as_str().unwrap_or("");
    let end = r["time_range"]["end"].as_str().unwrap_or("");
    let path = match adapter {
        "tempo" => format!("api/v2/traces/{}", r["locator"]["trace_id"].as_str()?),
        "loki" => "loki/api/v1/query_range".into(),
        "prometheus" => "api/v1/query_range".into(),
        "pyroscope" => "pyroscope/render".into(),
        _ => return None,
    };
    u.set_path(&format!("{}/{path}", u.path().trim_end_matches('/')));
    u.set_query(None);
    u.set_fragment(None);
    if adapter == "tempo" {
        return Some((u, json!({"trace_id":r["locator"]["trace_id"]})));
    }
    let expression = query::compile(r)?;
    let start_ms = epoch(start)?;
    let end_ms = epoch(end)?;
    {
        let mut q = u.query_pairs_mut();
        q.append_pair("query", &expression);
        match adapter {
            "loki" => {
                q.append_pair("start", &format!("{start_ms}000000"))
                    .append_pair("end", &format!("{end_ms}000000"))
                    .append_pair("limit", "100")
                    .append_pair("direction", "backward");
            }
            "prometheus" => {
                q.append_pair("start", start)
                    .append_pair("end", end)
                    .append_pair(
                        "step",
                        &(((end_ms - start_ms).max(1000) + 99999) / 100000)
                            .max(1)
                            .to_string(),
                    );
            }
            "pyroscope" => {
                q.append_pair("from", &(start_ms.div_euclid(1000)).to_string())
                    .append_pair("until", &(end_ms.div_euclid(1000)).to_string())
                    .append_pair("format", "json")
                    .append_pair("maxNodes", "100");
            }
            _ => return None,
        }
    }
    let values = if adapter == "pyroscope" {
        json!({"query":expression,"from":start,"until":end})
    } else {
        json!({"query":expression,"start":start,"end":end})
    };
    Some((u, values))
}
/// 截止时间覆盖流式正文；失败总是取消网络。 / Deadline covers streaming body; failure always cancels the network.
async fn fetch_json(
    url: Url,
    c: &Config,
    credential: Option<&String>,
) -> Result<Value, (&'static str, &'static str)> {
    let unavailable = || {
        (
            "unavailable",
            "Telemetry backend request failed or timed out",
        )
    };
    let mut init = RequestInit::new();
    // Workers只支持manual/follow；手动拒绝重定向避免凭据跨主机泄漏。
    // Workers supports manual/follow; rejecting redirects prevents cross-host credential leakage.
    init.with_redirect(RequestRedirect::Manual);
    init.headers
        .set("accept", "application/json")
        .map_err(|_| unavailable())?;
    if c.auth_scheme != "none" {
        let secret = credential.ok_or((
            "unavailable",
            "Configured auth_reference has no secret value",
        ))?;
        init.headers
            .set(
                "authorization",
                &format!(
                    "{} {secret}",
                    if c.auth_scheme == "basic" {
                        "Basic"
                    } else {
                        "Bearer"
                    }
                ),
            )
            .map_err(|_| unavailable())?;
    }
    if let Some(tenant) = &c.tenant_id {
        init.headers
            .set("x-scope-orgid", tenant)
            .map_err(|_| unavailable())?;
    }
    let req = Request::new_with_init(url.as_str(), &init).map_err(|_| unavailable())?;
    let controller = AbortController::default();
    let signal = controller.signal();
    let fetch = async {
        let mut response = Fetch::Request(req)
            .send_with_signal(&signal)
            .await
            .map_err(|_| unavailable())?;
        if (300..400).contains(&response.status_code()) {
            return Err((
                "unavailable",
                "Telemetry backend redirects are not permitted",
            ));
        }
        if response.status_code() == 404 {
            return Err(("not_found", ""));
        }
        if !(200..300).contains(&response.status_code()) {
            return Err((
                "unavailable",
                "Telemetry backend returned an unsuccessful HTTP status",
            ));
        }
        if response
            .headers()
            .get("content-length")
            .ok()
            .flatten()
            .and_then(|s| s.parse::<usize>().ok())
            .is_some_and(|n| n > c.max_response_bytes)
        {
            return Err((
                "unavailable",
                "Telemetry response exceeds the configured byte limit",
            ));
        }
        let mut stream = response.stream().map_err(|_| unavailable())?;
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| unavailable())?;
            if chunk.len() > c.max_response_bytes.saturating_sub(bytes.len()) {
                return Err((
                    "unavailable",
                    "Telemetry response exceeds the configured byte limit",
                ));
            }
            bytes.extend(chunk);
        }
        serde_json::from_slice(&bytes)
            .map_err(|_| ("unavailable", "Telemetry backend returned invalid JSON"))
    };
    let timer = Delay::from(Duration::from_millis(c.timeout_ms));
    futures_util::pin_mut!(fetch, timer);
    let result = match select(fetch, timer).await {
        Either::Left((result, _)) => result,
        Either::Right(_) => Err(unavailable()),
    };
    controller.abort();
    result
}

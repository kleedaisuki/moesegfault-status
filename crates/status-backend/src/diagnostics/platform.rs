//! 平台绑定只存在于当前 invocation。 / Platform bindings live only within the invocation.
use super::{
    validation,
    writes::{self, Ids, Snapshot},
};
use crate::{
    auth::{cloudflare::authenticate_machine, MachineTrust},
    database::{Database, Query, SqlValue},
    http::{read_json, HttpError},
};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use wasm_bindgen::{JsCast, JsValue};
use worker::{Context, Env, Method, Request, Response};

/// 安全的消费阶段错误。 / Safe staged consumer error.
#[derive(Debug)]
struct Failure {
    stage: &'static str,
    code: &'static str,
}
impl Failure {
    fn new(stage: &'static str, code: &'static str) -> Self {
        Self { stage, code }
    }
}
/// 生成规范UUIDv7；随机位来自平台密码学随机源。 / Generate canonical UUIDv7 using platform cryptographic randomness.
fn id() -> worker::Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes)
        .map_err(|_| worker::Error::RustError("random source unavailable".into()))?;
    let time = worker::Date::now().as_millis();
    for (index, b) in bytes[..6].iter_mut().enumerate() {
        *b = (time >> ((5 - index) * 8)) as u8;
    }
    bytes[6] = (bytes[6] & 15) | 112;
    bytes[8] = (bytes[8] & 63) | 128;
    let h: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &h[..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..]
    ))
}
/// 平台UTC时钟。 / Platform UTC clock.
fn now() -> String {
    js_sys::Date::new_0().to_iso_string().into()
}
/// 安全问题响应；不公开平台异常。 / Safe problem response without platform errors.
fn problem(error: HttpError, correlation: &str) -> worker::Result<Response> {
    let mut response=Response::from_json(&json!({"type":format!("https://status.moesegfault.dev/problems/{}",error.code),"title":error.detail,"status":error.status,"detail":error.detail,"correlation_id":correlation}))?.with_status(error.status);
    response
        .headers_mut()
        .set("content-type", "application/problem+json")?;
    response.headers_mut().set("cache-control", "no-store")?;
    response
        .headers_mut()
        .set("x-moesegfault-correlation-id", correlation)?;
    Ok(response)
}
/// 路由机器摄入；202仅代表Queue已经接受。 / Route machine ingestion; 202 means Queue has accepted the message.
pub async fn handle(
    request: &mut Request,
    env: &Env,
    _ctx: &Context,
) -> worker::Result<Option<Response>> {
    if request.path() != "/v1/diagnostic-events" {
        return Ok(None);
    }
    let correlation = request
        .headers()
        .get("x-moesegfault-correlation-id")?
        .filter(|s| status_domain::validate_uuid_v7(s, "correlation_id").is_ok())
        .map(Ok)
        .unwrap_or_else(id)?;
    handle_with_correlation(request, env, _ctx, &correlation).await
}
/// 使用入口建立的同一个关联身份，不在嵌套handler重新生成。
/// Reuse the entrypoint correlation identity rather than generating another inside the handler.
pub async fn handle_with_correlation(
    request: &mut Request,
    env: &Env,
    _ctx: &Context,
    correlation: &str,
) -> worker::Result<Option<Response>> {
    if request.path() != "/v1/diagnostic-events" {
        return Ok(None);
    }
    status_domain::validate_uuid_v7(correlation, "correlation_id")
        .map_err(|_| worker::Error::RustError("invalid invocation correlation".into()))?;
    if request.method() != Method::Post {
        return problem(
            HttpError::new(405, "method-not-allowed", "POST is required"),
            correlation,
        )
        .map(Some);
    }
    match ingest(request, env, correlation).await {
        Ok(response) => Ok(Some(response)),
        Err(error) => problem(error, correlation).map(Some),
    }
}
/// 验证身份和正文再发布不可变信封。 / Verify identity and body before publishing an immutable envelope.
async fn ingest(
    request: &mut Request,
    env: &Env,
    correlation: &str,
) -> Result<Response, HttpError> {
    let config = || {
        HttpError::new(
            503,
            "machine-auth-unavailable",
            "Machine authentication is unavailable",
        )
    };
    let get = |name: &str| env.var(name).map(|v| v.to_string()).map_err(|_| config());
    let trust = MachineTrust::new(
        &get("MACHINE_ISSUER")?,
        &get("MACHINE_AUDIENCE")?,
        &get("MACHINE_JWKS_URL")?,
    )?;
    let principal = authenticate_machine(request, &trust).await?;
    principal.require_scope("diagnostics:write")?;
    let mut value: Value = read_json(request, 65536).await?;
    let event = validation::event(&value).map_err(|_| {
        HttpError::new(
            422,
            "invalid-diagnostic-event",
            "Diagnostic event validation failed",
        )
    })?;
    if !principal.authorizes(&event.service_name, event.environment, &event.deployment_id) {
        return Err(HttpError::new(
            403,
            "diagnostic-claim-mismatch",
            "Machine identity does not authorize this diagnostic",
        ));
    }
    if event.correlation_id != correlation {
        return Err(HttpError::new(
            403,
            "diagnostic-correlation-mismatch",
            "Correlation identity does not match",
        ));
    }
    // 缺省值规范化使同一事实具有稳定摘要。 / Normalize defaults so one fact has a stable digest.
    let object = value.as_object_mut().ok_or_else(config)?;
    object.entry("signal").or_insert(json!("fault"));
    object.entry("evidence").or_insert(json!([]));
    object.entry("attributes").or_insert(json!({}));
    let mut envelope = json!({"schema_version":"1.0","message_id":id().map_err(|_|config())?,"event":value,"received_at":now(),"producer":{"subject":principal.subject(),"service_name":event.service_name,"environment":event.environment,"deployment_id":event.deployment_id,"scopes":["diagnostics:write"],"token_id":principal.token_id(),"auth_method":"jwt"},"trace_context":{"correlation_id":correlation}});
    if let Some(trace) = request.headers().get("traceparent").map_err(|_| config())? {
        if !validation::traceparent(&trace) {
            return Err(HttpError::new(
                400,
                "invalid-trace-context",
                "Invalid trace context",
            ));
        }
        envelope["trace_context"]["traceparent"] = json!(trace);
    }
    if let Some(state) = request.headers().get("tracestate").map_err(|_| config())? {
        envelope["trace_context"]["tracestate"] = json!(state);
    }
    validation::envelope(&envelope)?;
    env.queue("DIAGNOSTIC_QUEUE")
        .map_err(|_| config())?
        .send_raw(
            worker::RawMessageBuilder::new(
                envelope
                    .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
                    .map_err(|_| config())?,
            )
            .build_with_content_type(worker::QueueContentType::Json),
        )
        .await
        .map_err(|_| {
            HttpError::new(
                503,
                "diagnostic-queue-unavailable",
                "Diagnostic queue is temporarily unavailable",
            )
        })?;
    let mut response = Response::from_json(&json!({"event_id":event.event_id,"accepted":true}))
        .map_err(|_| config())?
        .with_status(202);
    response
        .headers_mut()
        .set("cache-control", "no-store")
        .map_err(|_| config())?;
    response
        .headers_mut()
        .set("x-moesegfault-correlation-id", correlation)
        .map_err(|_| config())?;
    Ok(response)
}
/// 快照读取在一个D1 batch中完成。 / Read the snapshot in one D1 batch.
async fn snapshot(
    db: &Database,
    event: &status_domain::DiagnosticEvent,
    hash: &str,
    monitor: Option<&str>,
) -> Result<Snapshot, Failure> {
    let s = || SqlValue::from(event.service_name.as_str());
    let k = || SqlValue::from(event.kind.as_str());
    let queries=vec![Query::new("SELECT sp.assignment_id,p.policy_id,p.revision AS policy_revision,p.diagnostic_rules_json,p.stale_after_seconds,sp.revision AS policy_binding_revision,CASE WHEN i.issue_id IS NULL THEN 0 ELSE 1 END AS policy_from_issue,rp.policy_id AS retention_policy_id,rp.revision AS retention_policy_revision,rp.occurrence_retention_days,sr.revision AS retention_binding_revision FROM service_diagnostic_policies sp LEFT JOIN issues i ON i.service_name=? AND i.kind=? AND i.fingerprint_hash=? AND i.state<>'resolved' JOIN evaluation_policies p ON p.policy_id=COALESCE(i.policy_id,sp.policy_id) AND p.revision=COALESCE(i.policy_revision,sp.policy_revision) JOIN service_retention_policies sr ON sr.service_name=? JOIN data_retention_policies rp ON rp.policy_id=sr.policy_id AND rp.revision=sr.policy_revision WHERE (sp.selector_kind='monitor' AND sp.monitor_id=?) OR (sp.selector_kind='service_kind' AND sp.service_name=? AND sp.diagnostic_kind=?) OR (sp.selector_kind='service_default' AND sp.service_name=?) ORDER BY CASE sp.selector_kind WHEN 'monitor' THEN 0 WHEN 'service_kind' THEN 1 ELSE 2 END LIMIT 1",vec![s(),k(),hash.into(),s(),monitor.map(SqlValue::from).unwrap_or(SqlValue::Null),s(),k(),s()]),Query::new("SELECT issue_id,state,severity,occurrence_count,recovery_count,last_fault_event_id,last_recovery_at,first_seen_at,last_seen_at,revision,fingerprint_hash,policy_revision FROM issues WHERE service_name=? AND kind=? AND fingerprint_hash=? AND state<>'resolved' LIMIT 1",vec![s(),k(),hash.into()]),Query::new("SELECT direct_status,dependency_risk,effective_impact,evaluated_at,fresh_until,revision FROM current_statuses WHERE target_type='service' AND target_id=?",vec![s()])];
    let rows = db
        .batch(&queries)
        .await
        .map_err(|_| Failure::new("d1_transaction", "diagnostic-snapshot-read-failed"))?;
    Ok(Snapshot {
        policy: rows[0]
            .results
            .first()
            .cloned()
            .ok_or_else(|| Failure::new("policy_evaluation", "diagnostic-policy-missing"))?,
        issue: rows[1].results.first().cloned(),
        status: rows[2].results.first().cloned(),
    })
}
/// 将固定策略与Issue快照转换为原生领域输入。 / Convert pinned policy and issue snapshot to native domain input.
fn evaluate(
    event: status_domain::DiagnosticEvent,
    snapshot: &Snapshot,
    time: &str,
) -> Result<Value, Failure> {
    let invalid = || Failure::new("policy_evaluation", "diagnostic-policy-evaluation-failed");
    let p = &snapshot.policy;
    let rules: Value =
        serde_json::from_str(p["diagnostic_rules_json"].as_str().ok_or_else(invalid)?)
            .map_err(|_| invalid())?;
    let failure = rules["contract"]["failure_status"].as_str();
    let statuses=rules.get("status_by_severity").cloned().unwrap_or_else(||json!({"info":failure.unwrap_or("degraded"),"warning":failure.unwrap_or("degraded"),"error":failure.unwrap_or("degraded"),"critical":failure.unwrap_or("major_outage")}));
    let mut issue = snapshot.issue.clone();
    if let Some(i) = issue.as_mut() {
        let revision = i["policy_revision"].as_i64().ok_or_else(invalid)?;
        i["policy_revision"] = json!(revision.to_string());
        if let Some(o) = i.as_object_mut() {
            o.remove("issue_id");
            o.remove("first_seen_at");
        }
    }
    let input:status_domain::DiagnosticEvaluationInput=serde_json::from_value(json!({"event":event,"policy":{"policy_id":p["policy_id"],"revision":p["policy_revision"].as_i64().ok_or_else(invalid)?.to_string(),"minimum_occurrences":rules.get("minimum_occurrences").cloned().unwrap_or(json!(1)),"recovery_min_occurrences":rules.get("recovery_min_occurrences").or_else(||rules["contract"].get("recovery_min_occurrences")).cloned().unwrap_or(json!(2)),"status_by_severity":statuses},"current_issue":issue,"current_service_status":snapshot.status.as_ref().map(|s|s["direct_status"].clone()).unwrap_or(json!("unknown")),"now":time})).map_err(|_|invalid())?;
    let result = status_domain::evaluate_diagnostic(&input).map_err(|_| invalid())?;
    let mut value = serde_json::to_value(result).map_err(|_| invalid())?;
    value["policy_revision"] = p["policy_revision"].clone();
    Ok(value)
}
/// 直接处理monitor或Queue信封；true为新提交，false为无副作用重复。
/// Process a monitor or Queue envelope directly; true means committed, false means side-effect-free duplicate.
pub async fn process_envelope(env: &Env, input: Value) -> worker::Result<bool> {
    let telemetry = crate::telemetry::for_invocation(env)?;
    traced_process(env, input, telemetry.as_ref(), None)
        .await
        .map_err(|e| worker::Error::RustError(format!("{}:{}", e.stage, e.code)))
}
/// 可信监视器内部入口；来源租约断言与所有诊断效果原子提交。
/// Trusted monitor-only entrypoint; lease assertions commit atomically with every diagnostic effect.
pub async fn process_monitor_envelope(
    env: &Env,
    input: Value,
    guard: Query,
    telemetry: Option<&crate::telemetry::Telemetry>,
) -> worker::Result<bool> {
    traced_process(env, input, telemetry, Some(guard))
        .await
        .map_err(|e| worker::Error::RustError(format!("{}:{}", e.stage, e.code)))
}
/// 一条消息的原生span，与批内共享采集预算。 / Native per-message span with a collection budget shared by the batch.
async fn traced_process(
    env: &Env,
    input: Value,
    telemetry: Option<&crate::telemetry::Telemetry>,
    guard: Option<Query>,
) -> Result<bool, Failure> {
    let env = env.clone();
    let telemetry = telemetry.cloned();
    let attrs = json!({"operation.name":"diagnostic.process","moesegfault.correlation.id":input["event"]["correlation_id"]});
    crate::telemetry::with_span("diagnostic.process", attrs, async move {
        process(&env, input, telemetry.as_ref(), guard).await
    })
    .await
}
/// 消费单个事件并提交全部领域效果。 / Consume one event and commit all domain effects.
async fn process(
    env: &Env,
    mut input: Value,
    telemetry: Option<&crate::telemetry::Telemetry>,
    guard: Option<Query>,
) -> Result<bool, Failure> {
    let started = worker::Date::now().as_millis();
    let event = validation::envelope(&input)
        .map_err(|_| Failure::new("envelope_validation", "invalid-diagnostic-envelope"))?;
    if let Some(object) = input["event"].as_object_mut() {
        object.entry("signal").or_insert(json!("fault"));
        object.entry("evidence").or_insert(json!([]));
        object.entry("attributes").or_insert(json!({}));
    }
    let fingerprint = event
        .validate()
        .map_err(|_| Failure::new("domain_validation", "diagnostic-domain-validation-failed"))?;
    let digest = format!(
        "sha256:{:x}",
        Sha256::digest(
            serde_json::to_vec(&input["event"])
                .map_err(|_| Failure::new("envelope_validation", "invalid-diagnostic-envelope"))?
        )
    );
    let database = Database::new(
        env.d1("DB")
            .map_err(|_| Failure::new("d1_transaction", "diagnostic-database-unavailable"))?,
    );
    let existing: Option<Value> = database
        .first(&Query::new(
            "SELECT payload_digest FROM diagnostic_event_dedup WHERE event_id=?",
            vec![event.event_id.as_str().into()],
        ))
        .await
        .map_err(|_| Failure::new("d1_transaction", "diagnostic-dedup-read-failed"))?;
    if let Some(existing) = existing {
        return if existing["payload_digest"] == digest {
            Ok(false)
        } else {
            Err(Failure::new(
                "idempotency_conflict",
                "diagnostic-event-id-conflict",
            ))
        };
    }
    let time = now();
    let snapshot = snapshot(
        &database,
        &event,
        &fingerprint.hash,
        input["origin"]["monitor_id"].as_str(),
    )
    .await?;
    let evaluation = evaluate(event.clone(), &snapshot, &time)?;
    let make_id =
        || id().map_err(|_| Failure::new("d1_transaction", "diagnostic-random-source-failed"));
    let ids = Ids {
        token: make_id()?,
        issue: make_id()?,
        occurrence: make_id()?,
        assertion: make_id()?,
        audit: make_id()?,
        outbox: make_id()?,
        evidence: (0..event.evidence.len())
            .map(|_| make_id())
            .collect::<Result<Vec<_>, _>>()?,
    };
    let mut queries = writes::build(&input, &snapshot, &evaluation, &ids, &time, &digest)
        .map_err(|_| Failure::new("d1_transaction", "diagnostic-write-plan-failed"))?;
    let previously_public = snapshot
        .issue
        .as_ref()
        .is_some_and(|i| matches!(i["state"].as_str(), Some("active" | "recovering")));
    let becomes_public = matches!(
        evaluation["issue_state"].as_str(),
        Some("active" | "recovering")
    );
    if previously_public || becomes_public {
        use crate::scheduling::reevaluate::{plan_reevaluation_with_overlay, EvaluationOverlay};
        let issue_id = snapshot
            .issue
            .as_ref()
            .map(|i| i["issue_id"].clone())
            .unwrap_or(json!(ids.issue));
        let fresh_until = chrono::DateTime::parse_from_rfc3339(&time)
            .map_err(|_| Failure::new("d1_transaction", "invalid-clock"))?
            .checked_add_signed(chrono::Duration::seconds(
                snapshot.policy["stale_after_seconds"]
                    .as_i64()
                    .ok_or_else(|| Failure::new("policy_evaluation", "invalid-freshness"))?,
            ))
            .ok_or_else(|| Failure::new("policy_evaluation", "invalid-freshness"))?
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let overlay = EvaluationOverlay {
            issues: vec![
                json!({"issue_id":issue_id,"state":evaluation["issue_state"],"severity":evaluation["severity"],"fingerprint_hash":evaluation["fingerprint_hash"],"diagnostic_rules_json":snapshot.policy["diagnostic_rules_json"],"service_name":event.service_name}),
            ],
            ownership: Some((event.event_id.clone(), ids.token.clone())),
            source: Some(("diagnostic_event".into(), event.event_id.clone())),
            policy: Some(
                json!({"policy_id":snapshot.policy["policy_id"],"policy_revision":snapshot.policy["policy_revision"],"fresh_until":fresh_until}),
            ),
            ..Default::default()
        };
        let mut plan = plan_reevaluation_with_overlay(
            &database,
            "service",
            &event.service_name,
            &time,
            &overlay,
        )
        .await
        .map_err(|_| Failure::new("d1_transaction", "diagnostic-status-plan-failed"))?;
        if !plan.is_empty() {
            queries.insert(1, plan.remove(0));
            let last = queries.len() - 1;
            queries.splice(last..last, plan);
        }
    }
    if let Some(guard) = guard {
        queries.insert(0, guard);
    }
    let results = database
        .batch(&queries)
        .await
        .map_err(|_| Failure::new("d1_transaction", "diagnostic-transaction-failed"))?;
    let ownership = results
        .last()
        .and_then(|r| r.results.first())
        .ok_or_else(|| Failure::new("d1_transaction", "diagnostic-ownership-missing"))?;
    if ownership["processing_token"] == ids.token {
        if let Some(telemetry) = telemetry {
            telemetry.metric(
                "status.evaluation.duration",
                worker::Date::now().as_millis().saturating_sub(started) as f64,
                "diagnostic",
                true,
            );
            if snapshot.issue.is_none() && event.signal == status_domain::DiagnosticSignal::Fault {
                telemetry.metric("issue.creation.count", 1.0, "diagnostic", false);
            }
        }
        return Ok(true);
    }
    if ownership["payload_digest"] == digest {
        return Ok(false);
    }
    Err(Failure::new(
        "idempotency_conflict",
        "diagnostic-event-id-conflict",
    ))
}
/// 原始平台入口保留SDK未暴露的attempts以附加DLQ失败证据。
/// Raw platform entrypoint preserves attempts omitted by the SDK, attaching failure evidence to the DLQ.
pub async fn consume_raw(batch: JsValue, env: Env, _ctx: Context) -> worker::Result<()> {
    let telemetry = crate::telemetry::for_invocation(&env)?;
    let messages = js_sys::Reflect::get(&batch, &"messages".into())?;
    let messages = js_sys::Array::from(&messages);
    for message in messages.iter() {
        let body = js_sys::Reflect::get(&message, &"body".into())?;
        let value = serde_wasm_bindgen::from_value::<Value>(body);
        let outcome = match value.as_ref() {
            Ok(value) => traced_process(&env, value.clone(), telemetry.as_ref(), None).await,
            Err(_) => Err(Failure::new(
                "envelope_validation",
                "invalid-diagnostic-envelope",
            )),
        };
        let Err(failure) = outcome else {
            call_message(&message, "ack", None)?;
            continue;
        };
        let attempt = js_sys::Reflect::get(&message, &"attempts".into())?
            .as_f64()
            .unwrap_or(1.0)
            .max(1.0) as u32;
        let maximum = env
            .var("DIAGNOSTIC_MAX_ATTEMPTS")
            .ok()
            .and_then(|v| v.to_string().parse::<u32>().ok())
            .filter(|n| *n > 0)
            .unwrap_or(5);
        if attempt >= maximum {
            if let (Ok(queue), Ok(value)) = (env.queue("DIAGNOSTIC_DLQ"), value) {
                let dlq = json!({"schema_version":"1.0","original":value,"failure":{"stage":failure.stage,"problem_type":format!("https://status.moesegfault.dev/problems/{}",failure.code),"attempt":attempt,"failed_at":now(),"queue_message_id":js_sys::Reflect::get(&message,&"id".into())?.as_string()}});
                if let Ok(raw) = dlq.serialize(&serde_wasm_bindgen::Serializer::json_compatible()) {
                    if queue
                        .send_raw(
                            worker::RawMessageBuilder::new(raw)
                                .build_with_content_type(worker::QueueContentType::Json),
                        )
                        .await
                        .is_ok()
                    {
                        call_message(&message, "ack", None)?;
                        continue;
                    }
                }
            }
        }
        call_message(
            &message,
            "retry",
            Some(json!({"delaySeconds":2u32.saturating_pow(attempt.saturating_sub(1)).min(300)})),
        )?;
    }
    Ok(())
}
/// 保留this调用平台消息方法。 / Invoke platform message methods with their original receiver.
fn call_message(message: &JsValue, name: &str, argument: Option<Value>) -> worker::Result<()> {
    let function = js_sys::Reflect::get(message, &name.into())?
        .dyn_into::<js_sys::Function>()
        .map_err(|_| worker::Error::RustError("invalid queue method".into()))?;
    let argument = argument
        .map(|v| v.serialize(&serde_wasm_bindgen::Serializer::json_compatible()))
        .transpose()?
        .unwrap_or(JsValue::UNDEFINED);
    function.call1(message, &argument)?;
    Ok(())
}

//! Cron 的平台编排；领域判断全部由原生 Rust 函数完成。 / Cron platform orchestration; native Rust functions own all domain decisions.
use super::{
    monitor, probe_lifecycle, reevaluate, retry_delay_ms, schedule, stable_id,
    store::SchedulerStore, types::*,
};
use crate::database::{Database, DatabaseError};
use chrono::{DateTime, SecondsFormat, Utc};
use futures_util::future::{join_all, select, Either};
use serde_json::{json, Value};
use std::{collections::HashMap, future::Future, time::Duration};

/// 一次调度调用的限制；租约必须超过整次调用截止时间。 / Invocation limits; leases must outlive the complete invocation deadline.
struct Limits {
    global: usize,
    per_target: usize,
    monitors: i64,
    outbox: i64,
    deadline: i64,
    lease: i64,
}

/// 执行并等待完整 Cron 工作，不产生脱离生命周期的后台任务。
/// Execute and await complete Cron work without detached background tasks.
pub async fn scheduled(env: worker::Env, _ctx: worker::Context) -> worker::Result<()> {
    let limits = limits(&env)?;
    let db = Database::new(env.d1("DB")?);
    let telemetry = crate::telemetry::for_invocation(&env)?;
    let started = now_ms();
    let mut entropy = [0u8; 16];
    getrandom::getrandom(&mut entropy)
        .map_err(|_| worker::Error::RustError("scheduler_entropy_unavailable".into()))?;
    let owner = format!("scheduler:{}", stable_id(started, &format!("{entropy:?}")));
    let task = tick(
        &env,
        &db,
        telemetry.as_ref(),
        &limits,
        &owner,
        started + limits.deadline,
    );
    let result = deadline(task, limits.deadline as u64).await;
    if let Some(telemetry) = telemetry.as_ref() {
        telemetry.report_drops();
    }
    result?
}

/// 一次有界 tick；状态持久化失败保留租约重试而不编造成功。 / Bounded tick; failed persistence retains retryability instead of inventing success.
async fn tick(
    env: &worker::Env,
    db: &Database,
    telemetry: Option<&crate::telemetry::Telemetry>,
    limits: &Limits,
    owner: &str,
    end: i64,
) -> worker::Result<()> {
    let store = SchedulerStore::new(db);
    record_metrics(db, telemetry).await;
    store
        .enqueue_expired(&iso(now_ms())?, limits.outbox)
        .await
        .map_err(db_error)?;
    let rows = store
        .due(&iso(now_ms())?, limits.monitors)
        .await
        .map_err(db_error)?;
    let mut pending = Vec::new();
    for row in rows {
        let next = match next_run(&row, now_ms()) {
            Ok(next) => next,
            Err(_) => continue,
        };
        let instant = iso(now_ms())?;
        let Some(revision) = store
            .claim_monitor(&row, owner, &instant, &iso(now_ms() + limits.lease)?)
            .await
            .map_err(db_error)?
        else {
            continue;
        };
        let id = string(&row, "monitor_id")?;
        let locations = store.locations(id).await.map_err(db_error)?;
        match monitor::from_row(&row, locations, iso(next)?, revision as u64) {
            Ok(monitor) => pending.push((row, monitor)),
            Err(_) => store.release(id, owner, &instant).await.map_err(db_error)?,
        }
    }
    // 每波同时限制总量和每目标数量；同一 monitor 的区域串行。 / Each wave bounds both global and per-target work; regions within one monitor are serial.
    while !pending.is_empty() && now_ms() < end {
        let mut counts = HashMap::new();
        let mut wave = Vec::new();
        let mut remaining = Vec::new();
        for item in pending {
            let key = format!("{}:{}", item.1.target.target_type, item.1.target.id);
            let count = counts.entry(key).or_insert(0usize);
            if wave.len() < limits.global && *count < limits.per_target {
                *count += 1;
                wave.push(item);
            } else {
                remaining.push(item);
            }
        }
        pending = remaining;
        join_all(wave.iter().map(|(row,m)| async {
            if process_monitor(env,db,telemetry,row,m,owner,end).await.is_err() {
                let _ = store.release(&m.monitor_id,owner,&iso(now_ms()).unwrap_or_default()).await;
                if let Some(t) = telemetry {
                    t.event("status.scheduler.error", true, json!({"operation.name":"monitor","monitor.id":m.monitor_id,"error.type":"monitor_processing_failed"}), None, None);
                }
            }
        })).await;
    }
    for (_, m) in pending {
        store
            .release(&m.monitor_id, owner, &iso(now_ms())?)
            .await
            .map_err(db_error)?;
    }
    if now_ms() >= end {
        return Ok(());
    }
    let events = store
        .claim_outbox(
            &iso(now_ms())?,
            owner,
            &iso(now_ms() + limits.lease)?,
            limits.outbox,
        )
        .await
        .map_err(db_error)?;
    for event in events {
        if now_ms() >= end {
            break;
        }
        let id = string(&event, "outbox_id")?;
        let result = deadline(
            deliver(env, db, &event),
            10_000u64.min((end - now_ms()).max(1) as u64),
        )
        .await;
        if matches!(result, Ok(Ok(()))) {
            store
                .delivered(id, owner, &iso(now_ms())?)
                .await
                .map_err(db_error)?;
        } else {
            let attempt = event["attempt_count"]
                .as_u64()
                .unwrap_or(1)
                .min(u32::MAX as u64) as u32;
            store
                .failed(
                    id,
                    owner,
                    &iso(now_ms() + retry_delay_ms(id, attempt) as i64)?,
                    "delivery_failed",
                    attempt >= 8,
                )
                .await
                .map_err(db_error)?;
        }
    }
    if now_ms() < end {
        store
            .retention(&iso(now_ms())?, limits.outbox)
            .await
            .map_err(db_error)?;
    }
    Ok(())
}

/// 完整区域窗口只提交一次，空观察不会伪造目标故障。 / Commit a complete regional window once; missing observations never fabricate target failure.
async fn process_monitor(
    env: &worker::Env,
    db: &Database,
    telemetry: Option<&crate::telemetry::Telemetry>,
    row: &Value,
    m: &ClaimedMonitor,
    owner: &str,
    end: i64,
) -> worker::Result<()> {
    let store = SchedulerStore::new(db);
    let time = parse_ms(&m.scheduled_for)?;
    let run = stable_id(time, &format!("{}:{}:run", m.monitor_id, m.scheduled_for));
    let correlation = stable_id(
        time,
        &format!("{}:{}:correlation", m.monitor_id, m.scheduled_for),
    );
    let wire = serde_json::to_value(m)?;
    let mut observations = Vec::new();
    for location in &m.locations {
        if now_ms() >= end {
            return Err(worker::Error::RustError("invocation_deadline".into()));
        }
        let timeout = (m.timeout_ms + 2_000).min((end - now_ms()).max(1) as u64);
        let response = deadline(
            crate::probes::dispatch(
                env,
                &wire,
                location,
                &run,
                &correlation,
                &iso(now_ms() + timeout as i64)?,
            ),
            timeout,
        )
        .await;
        let Ok(Ok(Some(value))) = response else {
            continue;
        };
        let Ok(observation) = serde_json::from_value::<Observation>(value) else {
            continue;
        };
        if observation.monitor_id != m.monitor_id
            || observation.correlation_id != correlation
            || observation.execution.location.as_deref() != Some(location)
        {
            continue;
        }
        let observed = parse_ms(&observation.observed_at)?;
        if observed > now_ms() + 5_000 || now_ms() - observed > m.policy.stale_after_ms {
            continue;
        }
        if let Some(t) = telemetry {
            t.observation(
                &m.monitor_id,
                &observation.outcome,
                observation.error_type.as_deref(),
                &observation.execution.runtime,
                location,
                observation.latency_ms,
            );
        }
        observations.push(observation);
    }
    observations.sort_by(|a, b| a.execution.location.cmp(&b.execution.location));
    let checkpoints = store
        .read_checkpoints(&m.monitor_id)
        .await
        .map_err(db_error)?
        .iter()
        .map(monitor::checkpoint_from_row)
        .collect::<Result<Vec<_>, _>>()
        .map_err(worker::Error::RustError)?;
    let evaluations = monitor::evaluate_batch(m, &checkpoints, &observations)
        .map_err(worker::Error::RustError)?;
    let selected = evaluations
        .iter()
        .position(|v| v.diagnostic_severity.is_some())
        .unwrap_or(0);
    if let (Some(e), Some(o)) = (evaluations.get(selected), observations.get(selected)) {
        if e.diagnostic_severity.is_some() && m.deployment_id.is_some() && m.environment.is_some() {
            if !store
                .owns_lease(&m.monitor_id, &m.scheduled_for, owner, &iso(now_ms())?)
                .await
                .map_err(db_error)?
            {
                return Err(worker::Error::RustError("monitor_lease_lost".into()));
            }
            let guard = super::store::lease_guard(
                row,
                owner,
                &iso(now_ms())?,
                &m.locations,
                m.claim_revision.unwrap_or(0) as i64,
            )
            .map_err(db_error)?;
            crate::diagnostics::process_monitor_envelope(
                env,
                health_envelope(m, o, e)?,
                guard,
                telemetry,
            )
            .await?;
        }
    }
    let checkpoints = evaluations
        .iter()
        .map(|v| monitor::checkpoint_to_row(&v.checkpoint))
        .collect::<Vec<_>>();
    store
        .commit_evaluation(
            row,
            &checkpoints,
            owner,
            &iso(now_ms())?,
            &m.next_run_at,
            &m.locations,
            m.claim_revision.unwrap_or(0) as i64,
        )
        .await
        .map_err(db_error)?;
    if let (Some(e), Some(o)) = (evaluations.get(selected), observations.get(selected)) {
        probe_lifecycle::apply(db, m, o, e)
            .await
            .map_err(db_error)?;
    }
    reevaluate::reevaluate_with_source(
        db,
        &m.target.target_type,
        &m.target.id,
        &iso(now_ms())?,
        "observation",
        observations
            .get(selected)
            .map(|o| o.observation_id.as_str())
            .unwrap_or(&run),
    )
    .await
    .map_err(db_error)
}

/// 健康诊断与队列诊断共享同一消费者和稳定幂等身份。 / Health diagnostics use the same consumer and stable idempotency identity as queued diagnostics.
fn health_envelope(
    m: &ClaimedMonitor,
    o: &Observation,
    e: &MonitorEvaluationResult,
) -> worker::Result<Value> {
    let time = parse_ms(&m.scheduled_for)?;
    let id = stable_id(
        time,
        &format!("{}:{}:health-diagnostic", m.monitor_id, m.scheduled_for),
    );
    let kind = m.probe["kind"].as_str().unwrap_or("invalid");
    let mut fingerprint = json!({"operation":"active-health-probe","capability":m.target.id});
    let mut attributes =
        json!({"operation.name":"active-health-probe","deployment.environment.name":m.environment});
    if m.target.target_type == "component" {
        fingerprint["component"] = json!(m.target.id);
        attributes["component.id"] = json!(m.target.id);
    }
    if kind != "synthetic" {
        fingerprint["protocol"] = json!(kind);
    }
    Ok(
        json!({"schema_version":"1.0","message_id":stable_id(time,&format!("{id}:message")),"event":{
        "event_id":id,"schema_version":"1.0","kind":e.diagnostic_kind.as_deref().unwrap_or("health.probe_failed"),"severity":e.diagnostic_severity,"signal":"fault","service_name":m.target.service_name,"environment":m.environment,"deployment_id":m.deployment_id,"occurred_at":o.observed_at,"correlation_id":o.correlation_id,"summary":e.diagnostic_summary.as_deref().unwrap_or("Active health probe failed"),"fingerprint":fingerprint,"attributes":attributes,"evidence":[{"kind":"metric_query","backend":"cloudflare-analytics-engine","locator":{"metric_name":"status.probe.outcome","query":{"monitor_id":m.monitor_id}},"time_range":{"start":o.observed_at,"end":o.observed_at}}]},"received_at":o.observed_at,"origin":{"kind":"monitor","monitor_id":m.monitor_id},"producer":{"subject":"status-scheduler","service_name":m.target.service_name,"environment":m.environment,"deployment_id":m.deployment_id,"scopes":["diagnostics:write"],"token_id":format!("scheduler:{}",m.monitor_id),"auth_method":"service_binding"},"trace_context":{"correlation_id":o.correlation_id}}),
    )
}

/// 内部状态任务不发送通知队列；其他事件只发布有限标识。 / Internal status work never enters notification queues; other events publish bounded IDs only.
async fn deliver(env: &worker::Env, db: &Database, event: &Value) -> worker::Result<()> {
    let kind = string(event, "event_type")?;
    if [
        "maintenance.started",
        "maintenance.expired",
        "override.expired",
        "suppression.expired",
        "status.reevaluation_requested",
    ]
    .contains(&kind)
    {
        let payload: Value = serde_json::from_str(string(event, "payload_json")?)?;
        if kind == "suppression.expired" {
            probe_lifecycle::expire_suppression(
                db,
                string(&payload, "source_id")?,
                &iso(now_ms())?,
            )
            .await
            .map_err(db_error)?;
        }
        return reevaluate::reevaluate_with_source(
            db,
            string(&payload, "target_type")?,
            string(&payload, "target_id")?,
            &iso(now_ms())?,
            string(&payload, "source_type")?,
            string(&payload, "source_id")?,
        )
        .await
        .map_err(db_error);
    }
    let id = string(event, "outbox_id")?;
    let notification = crate::notifications::Notification::new(
        id.into(),
        kind.into(),
        string(event, "aggregate_type")?.into(),
        string(event, "aggregate_id")?.into(),
        id.into(),
        None,
    )
    .map_err(|_| worker::Error::RustError("invalid_notification".into()))?;
    crate::notifications::publish(env, &notification).await
}

/// 跳过错过的 interval，而不是突发补跑历史探针。 / Skip missed intervals rather than burst-replaying historical probes.
fn next_run(row: &Value, now: i64) -> worker::Result<i64> {
    let kind = string(row, "schedule_kind")?;
    let interval = row["interval_seconds"]
        .as_i64()
        .and_then(|v| v.checked_mul(1_000));
    let prior = parse_ms(string(row, "next_run_at")?)?;
    if kind == "interval" {
        let step = interval
            .filter(|v| *v > 0)
            .ok_or_else(|| worker::Error::RustError("invalid_interval".into()))?;
        return Ok(prior + ((now - prior).max(0) / step + 1) * step);
    }
    schedule::next_run_at(kind, interval, row["schedule_expression"].as_str(), now)
        .map_err(worker::Error::RustError)
}
/// 严格解析部署限制，不静默接受错误配置。 / Strict deployment limit parsing never silently accepts invalid configuration.
fn limits(env: &worker::Env) -> worker::Result<Limits> {
    let l = Limits {
        global: setting(env, "SCHEDULER_GLOBAL_CONCURRENCY", 8, 1, 32)? as usize,
        per_target: setting(env, "SCHEDULER_PER_TARGET_CONCURRENCY", 2, 1, 8)? as usize,
        monitors: setting(env, "SCHEDULER_MONITOR_BATCH_SIZE", 64, 1, 500)?,
        outbox: setting(env, "SCHEDULER_OUTBOX_BATCH_SIZE", 64, 1, 500)?,
        deadline: setting(
            env,
            "SCHEDULER_INVOCATION_DEADLINE_MS",
            50_000,
            1_000,
            840_000,
        )?,
        lease: setting(env, "SCHEDULER_LEASE_MS", 90_000, 5_000, 900_000)?,
    };
    if l.per_target > l.global || l.lease < l.deadline + 5_000 {
        return Err(worker::Error::RustError("invalid_scheduler_limits".into()));
    }
    Ok(l)
}
/// 一个整数配置。 / One integer configuration setting.
fn setting(env: &worker::Env, key: &str, fallback: i64, min: i64, max: i64) -> worker::Result<i64> {
    let Ok(value) = env.var(key) else {
        return Ok(fallback);
    };
    let value = value
        .to_string()
        .parse::<i64>()
        .map_err(|_| worker::Error::RustError("invalid_scheduler_limit".into()))?;
    if !(min..=max).contains(&value) {
        return Err(worker::Error::RustError("invalid_scheduler_limit".into()));
    }
    Ok(value)
}
/// 平台时间。 / Platform clock.
fn now_ms() -> i64 {
    js_sys::Date::now() as i64
}
/// 固定毫秒 UTC 时间便于 SQLite 字符串比较。 / Fixed millisecond UTC timestamps preserve SQLite lexical ordering.
fn iso(ms: i64) -> worker::Result<String> {
    DateTime::<Utc>::from_timestamp_millis(ms)
        .map(|t| t.to_rfc3339_opts(SecondsFormat::Millis, true))
        .ok_or_else(|| worker::Error::RustError("invalid_timestamp".into()))
}
/// 解析已验证时间。 / Parse validated timestamps.
fn parse_ms(value: &str) -> worker::Result<i64> {
    DateTime::parse_from_rfc3339(value)
        .map(|t| t.timestamp_millis())
        .map_err(|_| worker::Error::RustError("invalid_timestamp".into()))
}
/// SQL 行必须满足字段契约。 / SQL rows must satisfy the field contract.
fn string<'a>(v: &'a Value, key: &str) -> worker::Result<&'a str> {
    v[key]
        .as_str()
        .ok_or_else(|| worker::Error::RustError("scheduler_row_contract".into()))
}
/// 不泄露数据库 SQL。 / Never expose database SQL.
fn db_error(_: DatabaseError) -> worker::Error {
    worker::Error::RustError("scheduler_database_failed".into())
}
/// 在一个 SQL 快照读取真实 backlog，读取失败不发送伪零值。
/// Read actual backlog in one SQL snapshot; failed reads never emit fabricated zeroes.
async fn record_metrics(db: &Database, telemetry: Option<&crate::telemetry::Telemetry>) {
    let Some(telemetry) = telemetry else { return };
    let Ok(now) = iso(now_ms()) else { return };
    let query = crate::database::Query::new(
        "SELECT (SELECT COUNT(*) FROM monitors WHERE enabled=1 AND next_run_at<=? AND (lease_expires_at IS NULL OR lease_expires_at<=?)) AS due, (SELECT COUNT(*) FROM monitors m WHERE m.enabled=1 AND EXISTS (SELECT 1 FROM monitor_locations l JOIN monitor_checkpoints c ON c.monitor_id=l.monitor_id AND c.location=l.location WHERE l.monitor_id=m.monitor_id AND l.enabled=1 AND c.fresh_until<?)) AS stale, (SELECT COUNT(*) FROM monitors m WHERE m.enabled=1 AND EXISTS (SELECT 1 FROM monitor_locations l LEFT JOIN monitor_checkpoints c ON c.monitor_id=l.monitor_id AND c.location=l.location WHERE l.monitor_id=m.monitor_id AND l.enabled=1 AND c.monitor_id IS NULL)) AS missing, (SELECT COUNT(*) FROM outbox WHERE state IN ('pending','processing')) AS backlog",
        vec![now.clone().into(), now.clone().into(), now.into()],
    );
    if let Ok(Some(row)) = db.first::<Value>(&query).await {
        for (key, name) in [
            ("due", "probe.due"),
            ("stale", "probe.stale"),
            ("missing", "probe.missing"),
            ("backlog", "outbox.backlog"),
        ] {
            if let Some(value) = row[key].as_u64() {
                telemetry.metric(name, value as f64, "cron", false);
            }
        }
    }
}
/// 取消未完成 Rust future；探针传输还具有自己的 AbortSignal。 / Cancel unfinished Rust futures; probe transports additionally own their AbortSignal.
async fn deadline<T>(future: impl Future<Output = T>, ms: u64) -> worker::Result<T> {
    match select(
        Box::pin(future),
        Box::pin(worker::Delay::from(Duration::from_millis(ms))),
    )
    .await
    {
        Either::Left((value, _)) => Ok(value),
        Either::Right(_) => Err(worker::Error::RustError("scheduler_deadline".into())),
    }
}

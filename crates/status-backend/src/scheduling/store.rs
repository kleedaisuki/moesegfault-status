//! 调度持久化边界：租约、事务检查点和重试工作项。
//! Scheduling persistence: leases, transactional checkpoints and retry work items.
use crate::database::{Database, DatabaseError, Query, SqlValue};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

/// 本次调用借用数据库，不持有跨请求状态。 / Invocation-local borrowed database.
pub struct SchedulerStore<'a> {
    /// 平台事务入口。 / Platform transaction boundary.
    db: &'a Database,
}
impl<'a> SchedulerStore<'a> {
    /// 构造存储适配器。 / Construct the storage adapter.
    pub fn new(db: &'a Database) -> Self {
        Self { db }
    }
    /// 读取候选快照，领取时再次检查版本。 / Read candidates; claim rechecks revision.
    pub async fn due(&self, now: &str, limit: i64) -> Result<Vec<Value>, DatabaseError> {
        self.db
            .all(&Query::new(
                DUE_MONITORS_SQL,
                vec![now.into(), now.into(), limit.clamp(1, 500).into()],
            ))
            .await
    }
    /// 原子比较并领取；配置变化返回空。 / Atomically compare and claim; changed configuration returns none.
    pub async fn claim_monitor(
        &self,
        row: &Value,
        owner: &str,
        now: &str,
        lease_until: &str,
    ) -> Result<Option<i64>, DatabaseError> {
        let rows: Vec<Value> = self.db.all(&Query::new("UPDATE monitors SET lease_owner=?,lease_expires_at=?,updated_at=?,revision=revision+1 WHERE monitor_id=? AND revision=? AND enabled=1 AND next_run_at<=? AND (lease_expires_at IS NULL OR lease_expires_at<=?) RETURNING revision",vec![owner.into(),lease_until.into(),now.into(),field(row,"monitor_id")?,field(row,"monitor_revision")?,now.into(),now.into()])).await?;
        Ok(rows.first().and_then(|v| v["revision"].as_i64()))
    }
    /// 只读取真实启用位置。 / Read actual enabled locations only.
    pub async fn locations(&self, id: &str) -> Result<Vec<String>, DatabaseError> {
        let rows:Vec<Value>=self.db.all(&Query::new("SELECT location FROM monitor_locations WHERE monitor_id=? AND enabled=1 ORDER BY location",vec![id.into()])).await?;
        rows.iter()
            .map(|r| {
                r["location"]
                    .as_str()
                    .map(str::to_owned)
                    .ok_or(DatabaseError::RowContract)
            })
            .collect()
    }
    /// 保留数据库列名解码检查点。 / Read checkpoints using database column names.
    pub async fn read_checkpoints(&self, id: &str) -> Result<Vec<Value>, DatabaseError> {
        self.db
            .all(&Query::new(READ_CHECKPOINTS_SQL, vec![id.into()]))
            .await
    }
    /// 副作用前检查所有权与有效时间。 / Verify ownership and expiry before side effects.
    pub async fn owns_lease(
        &self,
        id: &str,
        scheduled: &str,
        owner: &str,
        now: &str,
    ) -> Result<bool, DatabaseError> {
        Ok(self
            .db
            .first::<Value>(&Query::new(
                OWNS_MONITOR_LEASE_SQL,
                vec![id.into(), owner.into(), scheduled.into(), now.into()],
            ))
            .await?
            .is_some())
    }
    /// 释放仍属于自己的租约。 / Release only a lease still owned by this invocation.
    pub async fn release(&self, id: &str, owner: &str, now: &str) -> Result<(), DatabaseError> {
        self.db
            .batch(&[Query::new(
                RELEASE_MONITOR_SQL,
                vec![now.into(), id.into(), owner.into()],
            )])
            .await?;
        Ok(())
    }
    /// 原子检查版本、位置与租约后提交整个窗口并推进调度。
    /// Atomically guard revision, locations and lease, commit windows and advance schedule.
    #[allow(clippy::too_many_arguments)] // SQL 栅栏各参数保持显式。 / Keep each independent SQL fence explicit.
    pub async fn commit_evaluation(
        &self,
        row: &Value,
        checkpoints: &[Value],
        owner: &str,
        now: &str,
        next_run: &str,
        locations: &[String],
        claim_revision: i64,
    ) -> Result<(), DatabaseError> {
        let id = field(row, "monitor_id")?;
        let mut queries = vec![lease_guard(row, owner, now, locations, claim_revision)?];
        for checkpoint in checkpoints {
            queries.extend(checkpoint_queries(checkpoint)?);
        }
        queries.push(Query::new(
            COMPLETE_MONITOR_SQL,
            vec![
                field(row, "next_run_at")?,
                next_run.into(),
                now.into(),
                id,
                owner.into(),
            ],
        ));
        // 检查点成功即保证状态重算可重试，不依赖下一轮探针。
        // A committed checkpoint guarantees retryable status recomputation without another probe.
        let scheduled_ms = chrono::DateTime::parse_from_rfc3339(
            row["next_run_at"]
                .as_str()
                .ok_or(DatabaseError::RowContract)?,
        )
        .map_err(|_| DatabaseError::RowContract)?
        .timestamp_millis();
        let run_id = super::stable_id(
            scheduled_ms,
            &format!(
                "{}:{}:run",
                row["monitor_id"]
                    .as_str()
                    .ok_or(DatabaseError::RowContract)?,
                row["next_run_at"]
                    .as_str()
                    .ok_or(DatabaseError::RowContract)?
            ),
        );
        let payload = json!({"source_type":"observation", "source_id":run_id,
            "source_revision":claim_revision, "target_type":row["target_type"],
            "target_id":row["target_id"]});
        let seed = format!(
            "checkpoint:{}:{}:{claim_revision}",
            row["monitor_id"], row["next_run_at"]
        );
        queries.push(Query::new(
            INSERT_EXPIRY_OUTBOX_SQL,
            vec![
                stable_work_id(&seed).into(),
                field(row, "target_id")?,
                "status.reevaluation_requested".into(),
                payload.to_string().into(),
                now.into(),
                now.into(),
                now.into(),
            ],
        ));
        self.db.batch(&queries).await?;
        Ok(())
    }
    /// 原子领取重试事件并递增尝试次数。 / Atomically lease retry events and increment attempts.
    pub async fn claim_outbox(
        &self,
        now: &str,
        owner: &str,
        lease_until: &str,
        limit: i64,
    ) -> Result<Vec<Value>, DatabaseError> {
        self.db
            .all(&Query::new(
                CLAIM_OUTBOX_SQL,
                vec![
                    owner.into(),
                    lease_until.into(),
                    now.into(),
                    now.into(),
                    limit.clamp(1, 500).into(),
                ],
            ))
            .await
    }
    /// 所有者限定确认投递。 / Acknowledge delivery guarded by owner.
    pub async fn delivered(&self, id: &str, owner: &str, now: &str) -> Result<(), DatabaseError> {
        self.db
            .batch(&[Query::new(
                MARK_OUTBOX_DELIVERED_SQL,
                vec![now.into(), id.into(), owner.into()],
            )])
            .await?;
        Ok(())
    }
    /// 有界错误分类；不保存异常正文。 / Bounded error classification; never store exception bodies.
    pub async fn failed(
        &self,
        id: &str,
        owner: &str,
        next_attempt: &str,
        error: &str,
        dead: bool,
    ) -> Result<(), DatabaseError> {
        self.db
            .batch(&[Query::new(
                MARK_OUTBOX_FAILED_SQL,
                vec![
                    if dead { "dead" } else { "pending" }.into(),
                    next_attempt.into(),
                    error.chars().take(128).collect::<String>().into(),
                    id.into(),
                    owner.into(),
                ],
            )])
            .await?;
        Ok(())
    }
    /// 依固定策略版本批量清理，删除时再次检查 Incident pin。 / Purge by pinned policy revision, rechecking incident pins at deletion.
    pub async fn retention(&self, now: &str, limit: i64) -> Result<u64, DatabaseError> {
        let rows: Vec<Value> = self
            .db
            .all(&Query::new(
                RETENTION_CANDIDATES_SQL,
                vec![now.into(), limit.clamp(1, 500).into()],
            ))
            .await?;
        let mut counts = HashMap::<String, i64>::new();
        let mut queries = Vec::new();
        for row in rows {
            let key = format!(
                "{}:{}",
                row["retention_policy_id"], row["retention_policy_revision"]
            );
            let count = counts.entry(key).or_default();
            if *count
                >= row["cleanup_batch_size"]
                    .as_i64()
                    .ok_or(DatabaseError::RowContract)?
            {
                continue;
            }
            *count += 1;
            queries.push(Query::new(
                PURGE_OCCURRENCE_SQL,
                vec![
                    field(&row, "occurrence_id")?,
                    field(&row, "retention_policy_id")?,
                    field(&row, "retention_policy_revision")?,
                    field(&row, "purge_after")?,
                    now.into(),
                ],
            ));
        }
        Ok(self
            .db
            .batch(&queries)
            .await?
            .iter()
            .map(|r| r.meta["changes"].as_u64().unwrap_or(0))
            .sum())
    }
    /// 完整源对象一批，以 generation 防止维护目标编辑丢失。 / Batch complete sources, guarding generation against concurrent target edits.
    pub async fn enqueue_expired(&self, now: &str, limit: i64) -> Result<u64, DatabaseError> {
        let generation = self
            .db
            .first::<Value>(&Query::new(
                "SELECT generation FROM evaluation_generation WHERE singleton_id=1",
                vec![],
            ))
            .await?
            .ok_or(DatabaseError::RowContract)?;
        let rows: Vec<Value> = self
            .db
            .all(&Query::new(
                EXPIRED_TARGETS_SQL,
                vec![
                    now.into(),
                    now.into(),
                    now.into(),
                    now.into(),
                    now.into(),
                    now.into(),
                    limit.clamp(1, 500).into(),
                ],
            ))
            .await?;
        if rows.is_empty() {
            return Ok(0);
        }
        let mut queries=vec![Query::new("INSERT INTO transaction_assertions(assertion_id,passed) SELECT ?, CASE WHEN generation=? THEN 1 ELSE 0 END FROM evaluation_generation WHERE singleton_id=1",vec![format!("expiry:{now}").into(),field(&generation,"generation")?])];
        let mut seen = HashSet::new();
        for row in &rows {
            let event = row["event_type"]
                .as_str()
                .ok_or(DatabaseError::RowContract)?;
            let key = format!("{}:{event}", row["source_id"]);
            if !seen.insert(key) {
                continue;
            }
            match event {
                "maintenance.expired" => queries.push(Query::new(
                    COMPLETE_MAINTENANCE_SQL,
                    vec![now.into(), field(row, "source_id")?, now.into()],
                )),
                "maintenance.started" => queries.push(Query::new(
                    ACTIVATE_MAINTENANCE_SQL,
                    vec![now.into(), field(row, "source_id")?, now.into(), now.into()],
                )),
                _ => {}
            }
        }
        let prefix = queries.len();
        for row in rows {
            let payload = json!({"source_type":row["source_type"],"source_id":row["source_id"],"source_revision":row["source_revision"],"target_type":row["target_type"],"target_id":row["target_id"]});
            // 稳定摘要使不同 tick 也生成相同工作项标识。 / Stable digest keeps work IDs identical across ticks.
            let seed = format!(
                "temporal:{}:{}:{}:{}:{}",
                row["event_type"],
                row["source_id"],
                row["source_revision"],
                row["target_type"],
                row["target_id"]
            );
            let id = stable_work_id(&seed);
            queries.push(Query::new(
                INSERT_EXPIRY_OUTBOX_SQL,
                vec![
                    id.into(),
                    field(&row, "target_id")?,
                    field(&row, "event_type")?,
                    payload.to_string().into(),
                    now.into(),
                    now.into(),
                    now.into(),
                ],
            ));
        }
        Ok(self
            .db
            .batch(&queries)
            .await?
            .iter()
            .skip(prefix)
            .map(|r| r.meta["changes"].as_u64().unwrap_or(0))
            .sum())
    }
}
/// 监控副作用的事务栅栏；必须与诊断或检查点写入放在同一个 batch。
/// Transaction fence for monitor side effects; include in the same batch as diagnostics or checkpoints.
pub fn lease_guard(
    row: &Value,
    owner: &str,
    now: &str,
    locations: &[String],
    claim_revision: i64,
) -> Result<Query, DatabaseError> {
    let mut sorted = locations.to_vec();
    sorted.sort();
    Ok(Query::new(
        ASSERT_MONITOR_LEASE_SQL,
        vec![
            format!("monitor:{}:{owner}", row["monitor_id"]).into(),
            field(row, "monitor_id")?,
            owner.into(),
            field(row, "next_run_at")?,
            now.into(),
            field(row, "policy_id")?,
            field(row, "policy_revision")?,
            claim_revision.into(),
            field(row, "monitor_id")?,
            serde_json::to_string(&sorted)
                .map_err(|_| DatabaseError::RowContract)?
                .into(),
        ],
    ))
}
/// 严格将数据库标量转为绑定值。 / Strictly convert database scalars to SQL bindings.
fn field(row: &Value, key: &str) -> Result<SqlValue, DatabaseError> {
    match row.get(key).ok_or(DatabaseError::RowContract)? {
        Value::Null => Ok(SqlValue::Null),
        Value::String(s) => Ok(s.clone().into()),
        Value::Number(n) => n
            .as_i64()
            .map(SqlValue::Integer)
            .or_else(|| n.as_f64().map(SqlValue::Real))
            .ok_or(DatabaseError::RowContract),
        _ => Err(DatabaseError::RowContract),
    }
}
/// 位置约束与聚合写入必须在同一事务。 / Location guard and aggregate write belong in the same transaction.
fn checkpoint_queries(row: &Value) -> Result<Vec<Query>, DatabaseError> {
    let keys = [
        "monitor_id",
        "location",
        "last_observed_at",
        "consecutive_successes",
        "consecutive_failures",
        "window_samples",
        "window_unhealthy_samples",
        "window_started_at",
        "window_latency_p95_ms",
        "evaluation_status",
        "evaluated_at",
        "fresh_until",
        "policy_id",
        "policy_revision",
        "executor_id",
        "actual_colo",
    ];
    let values = keys
        .iter()
        .map(|key| {
            if (*key == "executor_id" || *key == "actual_colo") && row.get(*key).is_none() {
                Ok(SqlValue::Null)
            } else {
                field(row, key)
            }
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(vec![Query::new("INSERT INTO transaction_assertions(assertion_id,passed) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM monitor_locations WHERE monitor_id=? AND location=? AND enabled=1) THEN 1 ELSE 0 END",vec![format!("location:{}:{}",row["monitor_id"],row["location"]).into(),field(row,"monitor_id")?,field(row,"location")?]),Query::new(UPSERT_CHECKPOINT_SQL,values)])
}
/// 固定参数化 SQL。 / Fixed parameterized SQL.
const DUE_MONITORS_SQL: &str = r#"
SELECT m.monitor_id, m.revision AS monitor_revision, m.target_type, m.target_id,
       COALESCE(st.service_name, c.service_name) AS service_name,
       m.probe_kind, m.probe_config_json, m.environment, m.timeout_ms,
       m.schedule_kind, m.schedule_expression, m.interval_seconds,
       m.next_run_at, m.critical, sed.deployment_id,
       p.policy_id, p.revision AS policy_revision,
       p.observation_window_seconds, p.minimum_samples, p.failure_threshold,
       p.recovery_threshold, p.latency_threshold_ms, p.stale_after_seconds,
       p.location_quorum, p.fingerprint_template_json, p.status_mapping_json
FROM monitors AS m
JOIN status_targets AS st ON st.target_type = m.target_type AND st.target_id = m.target_id
LEFT JOIN components AS c ON c.component_id = st.component_id
JOIN evaluation_policies AS p ON p.policy_id = m.policy_id AND p.revision = m.policy_revision
LEFT JOIN service_environment_deployments AS sed
  ON sed.service_name = COALESCE(st.service_name, c.service_name) AND sed.environment = m.environment
WHERE m.enabled = 1 AND m.next_run_at <= ?
  AND (m.lease_expires_at IS NULL OR m.lease_expires_at <= ?)
ORDER BY m.next_run_at, m.monitor_id LIMIT ?"#;
/// 固定参数化 SQL。 / Fixed parameterized SQL.
const RELEASE_MONITOR_SQL: &str = r#"UPDATE monitors SET lease_owner = NULL, lease_expires_at = NULL,
updated_at = ?, revision = revision + 1 WHERE monitor_id = ? AND lease_owner = ?"#;
/// 固定参数化 SQL。 / Fixed parameterized SQL.
const ASSERT_MONITOR_LEASE_SQL: &str = r#"INSERT INTO transaction_assertions(assertion_id, passed)
SELECT ?, CASE WHEN EXISTS(SELECT 1 FROM monitors WHERE monitor_id=? AND lease_owner=? AND next_run_at=? AND lease_expires_at>? AND policy_id=? AND policy_revision=? AND revision=? AND enabled=1) AND (SELECT json_group_array(location) FROM (SELECT location FROM monitor_locations WHERE monitor_id=? AND enabled=1 ORDER BY location))=? THEN 1 ELSE 0 END"#;
/// 固定参数化 SQL。 / Fixed parameterized SQL.
const COMPLETE_MONITOR_SQL: &str = r#"UPDATE monitors SET last_run_at = ?, next_run_at = ?,
lease_owner = NULL, lease_expires_at = NULL, updated_at = ?, revision = revision + 1
WHERE monitor_id = ? AND lease_owner = ?"#;
/// 固定参数化 SQL。 / Fixed parameterized SQL.
const READ_CHECKPOINTS_SQL: &str =
    r#"SELECT * FROM monitor_checkpoints WHERE monitor_id = ? ORDER BY location"#;
/// 固定参数化 SQL。 / Fixed parameterized SQL.
const OWNS_MONITOR_LEASE_SQL: &str = r#"SELECT 1 AS owned FROM monitors
WHERE monitor_id=? AND lease_owner=? AND next_run_at=? AND lease_expires_at>?"#;
/// 固定参数化 SQL。 / Fixed parameterized SQL.
const UPSERT_CHECKPOINT_SQL: &str = r#"
INSERT INTO monitor_checkpoints(
  monitor_id, location, last_observed_at, consecutive_successes, consecutive_failures,
  window_samples, window_unhealthy_samples, window_started_at, window_latency_p95_ms,
  evaluation_status, evaluated_at, fresh_until, policy_id, policy_revision, executor_id, actual_colo, revision
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
ON CONFLICT(monitor_id, location) DO UPDATE SET
  executor_id = excluded.executor_id,
  actual_colo = excluded.actual_colo,
  last_observed_at = excluded.last_observed_at,
  consecutive_successes = excluded.consecutive_successes,
  consecutive_failures = excluded.consecutive_failures,
  window_samples = excluded.window_samples,
  window_unhealthy_samples = excluded.window_unhealthy_samples,
  window_started_at = excluded.window_started_at,
  window_latency_p95_ms = excluded.window_latency_p95_ms,
  evaluation_status = excluded.evaluation_status,
  evaluated_at = excluded.evaluated_at,
  fresh_until = excluded.fresh_until,
  policy_id = excluded.policy_id,
  policy_revision = excluded.policy_revision,
  revision = monitor_checkpoints.revision + 1"#;
/// 固定参数化 SQL。 / Fixed parameterized SQL.
const CLAIM_OUTBOX_SQL: &str = r#"
UPDATE outbox SET state = 'processing', attempt_count = attempt_count + 1,
  lease_owner = ?, lease_expires_at = ?, last_error = NULL
WHERE outbox_id IN (
  SELECT outbox_id FROM outbox
  WHERE ((state = 'pending' AND next_attempt_at <= ?) OR (state = 'processing' AND lease_expires_at <= ?))
  ORDER BY next_attempt_at, created_at LIMIT ?
)
RETURNING outbox_id, aggregate_type, aggregate_id, event_type, schema_version, payload_json, attempt_count"#;
/// 固定参数化 SQL。 / Fixed parameterized SQL.
const MARK_OUTBOX_DELIVERED_SQL: &str = r#"UPDATE outbox SET state = 'delivered', delivered_at = ?,
lease_owner = NULL, lease_expires_at = NULL WHERE outbox_id = ? AND state = 'processing' AND lease_owner = ?"#;
/// 固定参数化 SQL。 / Fixed parameterized SQL.
const MARK_OUTBOX_FAILED_SQL: &str = r#"UPDATE outbox SET state = ?, next_attempt_at = ?, last_error = ?,
lease_owner = NULL, lease_expires_at = NULL WHERE outbox_id = ? AND state = 'processing' AND lease_owner = ?"#;
/// 固定参数化 SQL。 / Fixed parameterized SQL.
const RETENTION_CANDIDATES_SQL: &str = r#"
SELECT o.occurrence_id, o.retention_policy_id, o.retention_policy_revision, o.purge_after,
       p.cleanup_batch_size
FROM issue_occurrences AS o
JOIN data_retention_policies AS p
  ON p.policy_id = o.retention_policy_id AND p.revision = o.retention_policy_revision
WHERE o.purge_after <= ?
  AND NOT EXISTS (SELECT 1 FROM incident_occurrences AS pin WHERE pin.occurrence_id = o.occurrence_id)
ORDER BY o.purge_after, o.occurrence_id LIMIT ?"#;
/// 固定参数化 SQL。 / Fixed parameterized SQL.
const PURGE_OCCURRENCE_SQL: &str = r#"DELETE FROM issue_occurrences
WHERE occurrence_id = ? AND retention_policy_id = ? AND retention_policy_revision = ?
  AND purge_after = ? AND purge_after <= ?
  AND NOT EXISTS (SELECT 1 FROM incident_occurrences AS pin WHERE pin.occurrence_id = issue_occurrences.occurrence_id)"#;
/// 固定参数化 SQL。 / Fixed parameterized SQL.
const EXPIRED_TARGETS_SQL: &str = r#"
WITH maintenance_expanded AS (
  SELECT mw.maintenance_id,mw.revision,mw.state,mw.starts_at,mw.ends_at,mt.target_type,mt.target_id
  FROM maintenance_windows mw JOIN maintenance_targets mt USING(maintenance_id)
  UNION
  SELECT mw.maintenance_id,mw.revision,mw.state,mw.starts_at,mw.ends_at,'component',c.component_id
  FROM maintenance_windows mw JOIN maintenance_targets mt USING(maintenance_id)
  JOIN components c ON mt.target_type='service' AND c.service_name=mt.target_id
), temporal AS (
  SELECT 'maintenance' AS source_type, maintenance_id AS source_id, revision AS source_revision,target_type, target_id,
         'maintenance.started' AS event_type
  FROM maintenance_expanded WHERE state='scheduled' AND starts_at<=? AND ends_at>?
  UNION ALL
  SELECT 'maintenance', maintenance_id, revision,target_type, target_id, 'maintenance.expired'
  FROM maintenance_expanded WHERE state IN ('scheduled','active') AND ends_at<=?
  UNION ALL
  SELECT 'override', so.override_id, so.revision,so.target_type, so.target_id, 'override.expired'
  FROM status_overrides AS so
  WHERE so.revoked_at IS NULL AND so.expires_at <= ?
  UNION ALL
  SELECT 'suppression', i.issue_id, i.revision,'service', i.service_name, 'suppression.expired'
  FROM issues AS i WHERE i.state = 'suppressed' AND i.suppression_until <= ?
  UNION ALL
  SELECT 'suppression', i.issue_id, i.revision,'component', c.component_id, 'suppression.expired'
  FROM issues AS i JOIN components AS c ON c.service_name = i.service_name
  WHERE i.state = 'suppressed' AND i.suppression_until <= ?
), pending AS (
SELECT source_type,source_id,source_revision,target_type,target_id,event_type FROM temporal
WHERE NOT EXISTS (
  SELECT 1 FROM outbox AS o
  WHERE o.aggregate_type = 'status_target' AND o.aggregate_id = temporal.target_id
    AND o.event_type = temporal.event_type
    AND json_extract(o.payload_json, '$.target_type') = temporal.target_type
    AND json_extract(o.payload_json, '$.source_id') = temporal.source_id
    AND json_extract(o.payload_json, '$.source_revision') = temporal.source_revision
)), selected_sources AS (
  SELECT DISTINCT source_type,source_id,source_revision,event_type FROM pending
  ORDER BY source_type,source_id,event_type LIMIT ?
)
SELECT pending.* FROM pending JOIN selected_sources USING(source_type,source_id,source_revision,event_type)
ORDER BY source_type,source_id,target_type,target_id"#;
/// 固定参数化 SQL。 / Fixed parameterized SQL.
const INSERT_EXPIRY_OUTBOX_SQL: &str = r#"INSERT OR IGNORE INTO outbox(
outbox_id, aggregate_type, aggregate_id, event_type, schema_version, payload_json,
state, attempt_count, available_at, next_attempt_at, created_at
) VALUES (?, 'status_target', ?, ?, '1.0', ?, 'pending', 0, ?, ?, ?)"#;
/// 固定参数化 SQL。 / Fixed parameterized SQL.
const COMPLETE_MAINTENANCE_SQL: &str = r#"UPDATE maintenance_windows
SET state = 'completed', updated_at = ?, revision = revision + 1
WHERE maintenance_id = ? AND state IN ('scheduled', 'active') AND ends_at <= ?"#;
/// 固定参数化 SQL。 / Fixed parameterized SQL.
const ACTIVATE_MAINTENANCE_SQL: &str = r#"UPDATE maintenance_windows
SET state = 'active', updated_at = ?, revision = revision + 1
WHERE maintenance_id = ? AND state = 'scheduled' AND starts_at <= ? AND ends_at > ?"#;

/// 内容寻址工作标识；稳定种子防止跨 tick 重复。 / Content-addressed work identity prevents cross-tick duplicates.
fn stable_work_id(seed: &str) -> String {
    let digest = Sha256::digest(seed.as_bytes());
    let hex = digest[..16]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    format!(
        "{}-{}-7{}-8{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[13..16],
        &hex[17..20],
        &hex[20..32]
    )
}

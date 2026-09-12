-- moeSegFault Status initial D1 schema / moeSegFault Status D1 初始模式
--
-- This migration intentionally contains no explicit BEGIN/COMMIT. Wrangler records and
-- applies D1 migrations transactionally; explicit transaction statements break D1 imports.
-- 本迁移有意不写 BEGIN/COMMIT。Wrangler 会以事务方式记录并应用 D1 迁移；显式事务语句会破坏 D1 导入。

-- Service catalog and ownership boundary. Historical/provenance rows use RESTRICT by default.
-- 服务目录与责任边界。历史及来源记录默认使用 RESTRICT，避免误级联删除。
CREATE TABLE services (
    service_name TEXT PRIMARY KEY NOT NULL,
    display_name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    owner TEXT NOT NULL,
    criticality TEXT NOT NULL CHECK (criticality IN ('low', 'medium', 'high', 'critical')),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    created_at TEXT NOT NULL CHECK (length(created_at) >= 20 AND substr(created_at, -1) = 'Z'),
    updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20 AND substr(updated_at, -1) = 'Z'),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
) STRICT;

-- Public status components have globally stable IDs; component_services adds extra supporting services.
-- 公共状态组件使用全局稳定 ID；component_services 可登记额外支撑服务。
CREATE TABLE components (
    component_id TEXT PRIMARY KEY NOT NULL,
    service_name TEXT NOT NULL REFERENCES services(service_name),
    display_name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    public INTEGER NOT NULL DEFAULT 1 CHECK (public IN (0, 1)),
    sort_order INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    created_at TEXT NOT NULL CHECK (length(created_at) >= 20 AND substr(created_at, -1) = 'Z'),
    updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20 AND substr(updated_at, -1) = 'Z'),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    UNIQUE (service_name, component_id)
) STRICT;

CREATE TRIGGER services_revision
BEFORE UPDATE ON services
WHEN NEW.revision <> OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'service revision must increase by one'); END;

CREATE TRIGGER components_revision
BEFORE UPDATE ON components
WHEN NEW.revision <> OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'component revision must increase by one'); END;

CREATE TABLE component_services (
    component_id TEXT NOT NULL REFERENCES components(component_id),
    service_name TEXT NOT NULL REFERENCES services(service_name),
    role TEXT NOT NULL DEFAULT 'supporting' CHECK (role IN ('supporting', 'owner')),
    created_at TEXT NOT NULL CHECK (length(created_at) >= 20 AND substr(created_at, -1) = 'Z'),
    PRIMARY KEY (component_id, service_name)
) STRICT;

CREATE UNIQUE INDEX uq_component_services_owner
    ON component_services(component_id) WHERE role = 'owner';

-- Directed edges may form cycles; graph traversal must maintain a visited set.
-- 有向依赖边允许形成环；图遍历必须维护 visited set。
CREATE TABLE service_dependencies (
    source_service TEXT NOT NULL REFERENCES services(service_name),
    target_service TEXT NOT NULL REFERENCES services(service_name),
    capability TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('required', 'optional', 'degraded_fallback')),
    criticality TEXT NOT NULL CHECK (criticality IN ('low', 'medium', 'high', 'critical')),
    created_at TEXT NOT NULL CHECK (length(created_at) >= 20 AND substr(created_at, -1) = 'Z'),
    PRIMARY KEY (source_service, target_service, capability),
    CHECK (source_service <> target_service)
) STRICT;

-- Polymorphic status target registry: downstream tables receive a real composite foreign key.
-- 多态状态目标注册表：下游表获得真实的复合外键，而不是未校验的 target_id。
CREATE TABLE status_targets (
    target_type TEXT NOT NULL CHECK (target_type IN ('service', 'component')),
    target_id TEXT NOT NULL,
    service_name TEXT REFERENCES services(service_name) ON DELETE CASCADE,
    component_id TEXT REFERENCES components(component_id) ON DELETE CASCADE,
    PRIMARY KEY (target_type, target_id),
    UNIQUE (service_name),
    UNIQUE (component_id),
    CHECK (
        (target_type = 'service' AND service_name = target_id AND component_id IS NULL) OR
        (target_type = 'component' AND component_id = target_id AND service_name IS NULL)
    )
) STRICT;

CREATE TRIGGER services_create_status_target
AFTER INSERT ON services
BEGIN
    INSERT INTO status_targets(target_type, target_id, service_name)
    VALUES ('service', NEW.service_name, NEW.service_name);
END;

CREATE TRIGGER components_create_status_target
AFTER INSERT ON components
BEGIN
    INSERT INTO status_targets(target_type, target_id, component_id)
    VALUES ('component', NEW.component_id, NEW.component_id);
END;

-- Immutable evaluator policy revisions preserve replayability and hysteresis semantics.
-- 不可变评估策略修订保留可重放性与迟滞语义。
CREATE TABLE evaluation_policies (
    policy_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    schema_version TEXT NOT NULL,
    name TEXT NOT NULL,
    observation_window_seconds INTEGER NOT NULL CHECK (observation_window_seconds > 0),
    minimum_samples INTEGER NOT NULL CHECK (minimum_samples > 0),
    failure_threshold REAL NOT NULL CHECK (failure_threshold >= 0.0 AND failure_threshold <= 1.0),
    recovery_threshold REAL NOT NULL CHECK (recovery_threshold >= 0.0 AND recovery_threshold <= 1.0),
    latency_threshold_ms INTEGER CHECK (latency_threshold_ms IS NULL OR latency_threshold_ms > 0),
    stale_after_seconds INTEGER NOT NULL CHECK (stale_after_seconds > 0),
    location_quorum INTEGER NOT NULL CHECK (location_quorum > 0),
    fingerprint_template_json TEXT NOT NULL CHECK (json_valid(fingerprint_template_json) AND json_type(fingerprint_template_json) = 'object'),
    status_mapping_json TEXT NOT NULL CHECK (json_valid(status_mapping_json) AND json_type(status_mapping_json) = 'object'),
    diagnostic_rules_json TEXT NOT NULL CHECK (json_valid(diagnostic_rules_json) AND json_type(diagnostic_rules_json) = 'object'),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL CHECK (length(created_at) >= 20 AND substr(created_at, -1) = 'Z'),
    PRIMARY KEY (policy_id, revision)
) STRICT;

CREATE TRIGGER evaluation_policies_no_update
BEFORE UPDATE ON evaluation_policies BEGIN SELECT RAISE(ABORT, 'evaluation policy revisions are immutable'); END;
CREATE TRIGGER evaluation_policies_no_delete
BEFORE DELETE ON evaluation_policies BEGIN SELECT RAISE(ABORT, 'evaluation policy revisions are immutable'); END;

-- Each service explicitly selects the immutable policy used for DiagnosticEvent aggregation.
-- 每个服务显式选择用于 DiagnosticEvent 聚合的不可变策略，禁止硬编码 severity 映射。
CREATE TABLE service_diagnostic_policies (
    service_name TEXT PRIMARY KEY NOT NULL REFERENCES services(service_name),
    policy_id TEXT NOT NULL,
    policy_revision INTEGER NOT NULL,
    assigned_by TEXT NOT NULL,
    assigned_at TEXT NOT NULL CHECK (length(assigned_at) >= 20 AND substr(assigned_at, -1) = 'Z'),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    FOREIGN KEY (policy_id, policy_revision) REFERENCES evaluation_policies(policy_id, revision)
) STRICT;

CREATE TRIGGER service_diagnostic_policies_revision
BEFORE UPDATE ON service_diagnostic_policies
WHEN NEW.revision <> OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'service diagnostic policy revision must increase by one'); END;

-- Monitor target is validated through status_targets; locations are normalized for checkpoints.
-- Monitor 目标通过 status_targets 校验；执行位置规范化，以供检查点引用。
CREATE TABLE monitors (
    monitor_id TEXT PRIMARY KEY NOT NULL CHECK (
        length(monitor_id) = 36 AND substr(monitor_id, 15, 1) = '7' AND
        substr(monitor_id, 20, 1) GLOB '[89ab]' AND lower(monitor_id) = monitor_id
    ),
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    probe_kind TEXT NOT NULL CHECK (probe_kind IN ('http', 'tcp', 'dns', 'rpc', 'synthetic')),
    environment TEXT NOT NULL DEFAULT 'production' CHECK (environment IN ('development', 'test', 'staging', 'production')),
    schedule_kind TEXT NOT NULL CHECK (schedule_kind IN ('cron', 'interval')),
    schedule_expression TEXT,
    interval_seconds INTEGER CHECK (interval_seconds IS NULL OR interval_seconds > 0),
    timeout_ms INTEGER NOT NULL CHECK (timeout_ms > 0),
    probe_config_json TEXT NOT NULL CHECK (json_valid(probe_config_json) AND json_type(probe_config_json) = 'object'),
    policy_id TEXT NOT NULL,
    policy_revision INTEGER NOT NULL,
    next_run_at TEXT NOT NULL CHECK (length(next_run_at) >= 20 AND substr(next_run_at, -1) = 'Z'),
    last_run_at TEXT,
    lease_owner TEXT,
    lease_expires_at TEXT,
    critical INTEGER NOT NULL DEFAULT 1 CHECK (critical IN (0, 1)),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    created_at TEXT NOT NULL CHECK (length(created_at) >= 20 AND substr(created_at, -1) = 'Z'),
    updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20 AND substr(updated_at, -1) = 'Z'),
    FOREIGN KEY (target_type, target_id) REFERENCES status_targets(target_type, target_id),
    FOREIGN KEY (policy_id, policy_revision) REFERENCES evaluation_policies(policy_id, revision),
    CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
    CHECK (
        (schedule_kind = 'cron' AND schedule_expression IS NOT NULL AND interval_seconds IS NULL) OR
        (schedule_kind = 'interval' AND schedule_expression IS NULL AND interval_seconds IS NOT NULL)
    )
) STRICT;

CREATE INDEX idx_monitors_due ON monitors(enabled, next_run_at, lease_expires_at);
CREATE INDEX idx_monitors_target ON monitors(target_type, target_id, enabled);

CREATE TRIGGER monitors_revision
BEFORE UPDATE ON monitors
WHEN NEW.revision <> OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'monitor revision must increase by one'); END;

CREATE TABLE monitor_locations (
    monitor_id TEXT NOT NULL REFERENCES monitors(monitor_id) ON DELETE CASCADE,
    location TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    PRIMARY KEY (monitor_id, location)
) STRICT;

-- D1 stores only the latest evaluator checkpoint; raw observations belong in Analytics Engine.
-- D1 仅保存最新评估检查点；原始 Observation 属于 Analytics Engine。
CREATE TABLE monitor_checkpoints (
    monitor_id TEXT NOT NULL,
    location TEXT NOT NULL,
    last_observed_at TEXT NOT NULL CHECK (length(last_observed_at) >= 20 AND substr(last_observed_at, -1) = 'Z'),
    consecutive_successes INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_successes >= 0),
    consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
    window_samples INTEGER NOT NULL DEFAULT 0 CHECK (window_samples >= 0),
    window_unhealthy_samples INTEGER NOT NULL DEFAULT 0 CHECK (window_unhealthy_samples >= 0 AND window_unhealthy_samples <= window_samples),
    window_started_at TEXT NOT NULL CHECK (length(window_started_at) >= 20 AND substr(window_started_at, -1) = 'Z'),
    window_latency_p95_ms INTEGER CHECK (window_latency_p95_ms IS NULL OR window_latency_p95_ms >= 0),
    evaluation_status TEXT NOT NULL CHECK (evaluation_status IN ('operational', 'degraded', 'partial_outage', 'major_outage', 'unknown')),
    evaluated_at TEXT NOT NULL CHECK (length(evaluated_at) >= 20 AND substr(evaluated_at, -1) = 'Z'),
    fresh_until TEXT NOT NULL CHECK (length(fresh_until) >= 20 AND substr(fresh_until, -1) = 'Z'),
    policy_id TEXT NOT NULL,
    policy_revision INTEGER NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    PRIMARY KEY (monitor_id, location),
    FOREIGN KEY (monitor_id, location) REFERENCES monitor_locations(monitor_id, location) ON DELETE CASCADE,
    FOREIGN KEY (policy_id, policy_revision) REFERENCES evaluation_policies(policy_id, revision),
    CHECK (fresh_until >= evaluated_at)
) STRICT;

CREATE TRIGGER monitor_checkpoints_revision
BEFORE UPDATE ON monitor_checkpoints
WHEN NEW.revision <> OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'monitor checkpoint revision must increase by one'); END;

-- Current public/internal status snapshot. Dependency risk never overwrites direct_status.
-- 当前公共/内部状态快照。依赖风险绝不覆盖 direct_status。
CREATE TABLE current_statuses (
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    direct_status TEXT NOT NULL CHECK (direct_status IN ('operational', 'degraded', 'partial_outage', 'major_outage', 'maintenance', 'unknown')),
    dependency_risk TEXT NOT NULL DEFAULT 'none' CHECK (dependency_risk IN ('none', 'degraded', 'partial_outage', 'major_outage', 'unknown')),
    effective_impact TEXT NOT NULL CHECK (effective_impact IN ('operational', 'degraded', 'partial_outage', 'major_outage', 'maintenance', 'unknown')),
    evaluated_at TEXT NOT NULL CHECK (length(evaluated_at) >= 20 AND substr(evaluated_at, -1) = 'Z'),
    fresh_until TEXT NOT NULL CHECK (length(fresh_until) >= 20 AND substr(fresh_until, -1) = 'Z'),
    policy_id TEXT,
    policy_revision INTEGER,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    PRIMARY KEY (target_type, target_id),
    FOREIGN KEY (target_type, target_id) REFERENCES status_targets(target_type, target_id),
    FOREIGN KEY (policy_id, policy_revision) REFERENCES evaluation_policies(policy_id, revision),
    CHECK ((policy_id IS NULL) = (policy_revision IS NULL)),
    CHECK (fresh_until >= evaluated_at)
) STRICT;

CREATE TRIGGER current_statuses_revision
BEFORE UPDATE ON current_statuses
WHEN NEW.revision <> OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'current status revision must increase by one'); END;

-- Append-only status history; source_id identifies an Observation, Diagnostic, operator override, or maintenance.
-- 仅追加的状态历史；source_id 标识 Observation、Diagnostic、人工覆盖或维护窗口。
CREATE TABLE status_transitions (
    transition_id TEXT PRIMARY KEY NOT NULL CHECK (
        length(transition_id) = 36 AND substr(transition_id, 15, 1) = '7' AND
        substr(transition_id, 20, 1) GLOB '[89ab]' AND lower(transition_id) = transition_id
    ),
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence >= 1),
    from_status TEXT CHECK (from_status IS NULL OR from_status IN ('operational', 'degraded', 'partial_outage', 'major_outage', 'maintenance', 'unknown')),
    to_status TEXT NOT NULL CHECK (to_status IN ('operational', 'degraded', 'partial_outage', 'major_outage', 'maintenance', 'unknown')),
    source_type TEXT NOT NULL CHECK (source_type IN ('observation', 'diagnostic_event', 'issue', 'maintenance', 'operator_override', 'freshness')),
    source_id TEXT NOT NULL,
    policy_id TEXT,
    policy_revision INTEGER,
    correlation_id TEXT,
    occurred_at TEXT NOT NULL CHECK (length(occurred_at) >= 20 AND substr(occurred_at, -1) = 'Z'),
    details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json) AND json_type(details_json) = 'object'),
    UNIQUE (target_type, target_id, sequence),
    FOREIGN KEY (target_type, target_id) REFERENCES status_targets(target_type, target_id),
    FOREIGN KEY (policy_id, policy_revision) REFERENCES evaluation_policies(policy_id, revision),
    CHECK ((policy_id IS NULL) = (policy_revision IS NULL)),
    CHECK (from_status IS NULL OR from_status <> to_status)
) STRICT;

CREATE INDEX idx_status_transitions_target_time
    ON status_transitions(target_type, target_id, occurred_at DESC);

CREATE TRIGGER status_transitions_validate_sequence
BEFORE INSERT ON status_transitions
BEGIN
    SELECT (CASE WHEN NEW.sequence <> COALESCE((
        SELECT MAX(sequence) + 1 FROM status_transitions
        WHERE target_type = NEW.target_type AND target_id = NEW.target_id
    ), 1) THEN RAISE(ABORT, 'status transition sequence is not next') END);
    SELECT (CASE WHEN NEW.sequence = 1 AND NEW.from_status IS NOT NULL
        THEN RAISE(ABORT, 'first status transition must have NULL from_status') END);
    SELECT (CASE WHEN NEW.sequence > 1 AND NEW.from_status IS NOT (
        SELECT to_status FROM status_transitions
        WHERE target_type = NEW.target_type AND target_id = NEW.target_id
        ORDER BY sequence DESC LIMIT 1
    ) THEN RAISE(ABORT, 'status transition from_status does not match current state') END);
END;

CREATE TRIGGER status_transitions_no_update
BEFORE UPDATE ON status_transitions BEGIN SELECT RAISE(ABORT, 'status transitions are immutable'); END;
CREATE TRIGGER status_transitions_no_delete
BEFORE DELETE ON status_transitions BEGIN SELECT RAISE(ABORT, 'status transitions are immutable'); END;

-- Immutable deployment manifest; mutable deployment state is represented only by status history.
-- 不可变部署清单；可变部署状态仅由状态历史表示。
CREATE TABLE deployments (
    deployment_id TEXT PRIMARY KEY NOT NULL CHECK (
        length(deployment_id) = 36 AND substr(deployment_id, 15, 1) = '7' AND
        substr(deployment_id, 20, 1) GLOB '[89ab]' AND lower(deployment_id) = deployment_id
    ),
    service_name TEXT NOT NULL REFERENCES services(service_name),
    environment TEXT NOT NULL CHECK (environment IN ('development', 'test', 'staging', 'production')),
    service_version TEXT NOT NULL,
    repository_url TEXT NOT NULL,
    git_commit TEXT NOT NULL CHECK (length(git_commit) IN (40, 64) AND lower(git_commit) = git_commit AND git_commit NOT GLOB '*[^0-9a-f]*'),
    git_ref TEXT NOT NULL,
    artifact_digest TEXT NOT NULL CHECK (length(artifact_digest) = 71 AND substr(artifact_digest, 1, 7) = 'sha256:' AND substr(artifact_digest, 8) NOT GLOB '*[^0-9a-f]*'),
    ci_provider TEXT NOT NULL,
    ci_run_id TEXT NOT NULL,
    deployed_at TEXT NOT NULL CHECK (length(deployed_at) >= 20 AND substr(deployed_at, -1) = 'Z'),
    manifest_object_key TEXT NOT NULL UNIQUE,
    manifest_digest TEXT NOT NULL CHECK (length(manifest_digest) = 71 AND substr(manifest_digest, 1, 7) = 'sha256:' AND substr(manifest_digest, 8) NOT GLOB '*[^0-9a-f]*'),
    manifest_schema_version TEXT NOT NULL,
    registered_at TEXT NOT NULL CHECK (length(registered_at) >= 20 AND substr(registered_at, -1) = 'Z'),
    registered_by TEXT NOT NULL,
    UNIQUE (deployment_id, service_name)
) STRICT;

CREATE INDEX idx_deployments_service_time ON deployments(service_name, deployed_at DESC);
CREATE INDEX idx_deployments_service_environment_digest
    ON deployments(service_name, environment, artifact_digest);

CREATE TRIGGER deployments_no_update
BEFORE UPDATE ON deployments BEGIN SELECT RAISE(ABORT, 'deployment manifests are immutable'); END;
CREATE TRIGGER deployments_no_delete
BEFORE DELETE ON deployments BEGIN SELECT RAISE(ABORT, 'deployment manifests are immutable'); END;

CREATE TABLE deployment_regions (
    deployment_id TEXT NOT NULL REFERENCES deployments(deployment_id),
    region TEXT NOT NULL,
    PRIMARY KEY (deployment_id, region)
) STRICT;

CREATE TRIGGER deployment_regions_no_update
BEFORE UPDATE ON deployment_regions BEGIN SELECT RAISE(ABORT, 'deployment regions are immutable'); END;
CREATE TRIGGER deployment_regions_no_delete
BEFORE DELETE ON deployment_regions BEGIN SELECT RAISE(ABORT, 'deployment regions are immutable'); END;

-- Required artifact facts are copied from the manifest into D1; readiness never depends on re-reading R2.
-- 必需产物事实从清单复制进 D1；readiness 判定绝不依赖重新读取 R2。
CREATE TABLE deployment_artifact_requirements (
    deployment_id TEXT NOT NULL REFERENCES deployments(deployment_id),
    kind TEXT NOT NULL CHECK (kind IN ('manifest', 'binary', 'debug_symbols', 'source_map', 'sbom', 'other')),
    file_name TEXT NOT NULL,
    media_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
    artifact_digest TEXT NOT NULL CHECK (length(artifact_digest) = 71 AND substr(artifact_digest, 1, 7) = 'sha256:' AND substr(artifact_digest, 8) NOT GLOB '*[^0-9a-f]*'),
    build_id TEXT,
    created_at TEXT NOT NULL CHECK (length(created_at) >= 20 AND substr(created_at, -1) = 'Z'),
    PRIMARY KEY (deployment_id, kind, file_name)
) STRICT;

CREATE TRIGGER deployment_artifact_requirements_no_update
BEFORE UPDATE ON deployment_artifact_requirements BEGIN SELECT RAISE(ABORT, 'deployment artifact requirements are immutable'); END;
CREATE TRIGGER deployment_artifact_requirements_no_delete
BEFORE DELETE ON deployment_artifact_requirements BEGIN SELECT RAISE(ABORT, 'deployment artifact requirements are immutable'); END;

-- Upload sessions bind an idempotent request to one immutable, digest-addressed R2 object key.
-- 上传会话把幂等请求绑定到唯一、不可变、摘要寻址的 R2 对象键。
CREATE TABLE artifact_upload_sessions (
    upload_id TEXT PRIMARY KEY NOT NULL CHECK (
        length(upload_id) = 36 AND substr(upload_id, 15, 1) = '7' AND
        substr(upload_id, 20, 1) GLOB '[89ab]' AND lower(upload_id) = upload_id
    ),
    deployment_id TEXT NOT NULL REFERENCES deployments(deployment_id),
    idempotency_key TEXT NOT NULL,
    request_digest TEXT NOT NULL CHECK (length(request_digest) = 71 AND substr(request_digest, 1, 7) = 'sha256:' AND substr(request_digest, 8) NOT GLOB '*[^0-9a-f]*'),
    object_key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('manifest', 'binary', 'debug_symbols', 'source_map', 'sbom', 'other')),
    file_name TEXT NOT NULL,
    media_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
    artifact_digest TEXT NOT NULL CHECK (length(artifact_digest) = 71 AND substr(artifact_digest, 1, 7) = 'sha256:' AND substr(artifact_digest, 8) NOT GLOB '*[^0-9a-f]*'),
    build_id TEXT,
    expires_at TEXT NOT NULL CHECK (length(expires_at) >= 20 AND substr(expires_at, -1) = 'Z'),
    created_at TEXT NOT NULL CHECK (length(created_at) >= 20 AND substr(created_at, -1) = 'Z'),
    created_by TEXT NOT NULL,
    UNIQUE (deployment_id, idempotency_key),
    CHECK (expires_at > created_at)
) STRICT;

CREATE TRIGGER artifact_upload_sessions_no_update
BEFORE UPDATE ON artifact_upload_sessions BEGIN SELECT RAISE(ABORT, 'artifact upload sessions are immutable'); END;
CREATE TRIGGER artifact_upload_sessions_no_delete
BEFORE DELETE ON artifact_upload_sessions BEGIN SELECT RAISE(ABORT, 'artifact upload sessions are immutable'); END;

CREATE TABLE deployment_artifacts (
    artifact_id TEXT PRIMARY KEY NOT NULL CHECK (
        length(artifact_id) = 36 AND substr(artifact_id, 15, 1) = '7' AND
        substr(artifact_id, 20, 1) GLOB '[89ab]' AND lower(artifact_id) = artifact_id
    ),
    deployment_id TEXT NOT NULL REFERENCES deployments(deployment_id),
    upload_id TEXT UNIQUE REFERENCES artifact_upload_sessions(upload_id),
    kind TEXT NOT NULL CHECK (kind IN ('manifest', 'binary', 'debug_symbols', 'source_map', 'sbom', 'other')),
    file_name TEXT NOT NULL,
    object_key TEXT NOT NULL UNIQUE,
    media_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
    artifact_digest TEXT NOT NULL CHECK (length(artifact_digest) = 71 AND substr(artifact_digest, 1, 7) = 'sha256:' AND substr(artifact_digest, 8) NOT GLOB '*[^0-9a-f]*'),
    build_id TEXT,
    bundle_path TEXT,
    created_at TEXT NOT NULL CHECK (length(created_at) >= 20 AND substr(created_at, -1) = 'Z'),
    UNIQUE (deployment_id, artifact_digest, kind, object_key)
) STRICT;

CREATE TRIGGER deployment_artifacts_match_upload
BEFORE INSERT ON deployment_artifacts
WHEN NEW.upload_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM artifact_upload_sessions AS s
    WHERE s.upload_id = NEW.upload_id AND s.deployment_id = NEW.deployment_id
      AND s.kind = NEW.kind AND s.file_name = NEW.file_name
      AND s.object_key = NEW.object_key AND s.media_type = NEW.media_type
      AND s.size_bytes = NEW.size_bytes AND s.artifact_digest = NEW.artifact_digest
      AND s.build_id IS NEW.build_id
)
BEGIN SELECT RAISE(ABORT, 'artifact does not match upload session'); END;

CREATE INDEX idx_deployment_artifacts_digest_build
    ON deployment_artifacts(artifact_digest, build_id);

CREATE TRIGGER deployment_artifacts_no_update
BEFORE UPDATE ON deployment_artifacts BEGIN SELECT RAISE(ABORT, 'deployment artifacts are immutable'); END;
CREATE TRIGGER deployment_artifacts_no_delete
BEFORE DELETE ON deployment_artifacts BEGIN SELECT RAISE(ABORT, 'deployment artifacts are immutable'); END;

CREATE TABLE deployment_status_history (
    deployment_id TEXT NOT NULL REFERENCES deployments(deployment_id),
    sequence INTEGER NOT NULL CHECK (sequence >= 1),
    state TEXT NOT NULL CHECK (state IN ('registered', 'artifacts_pending', 'ready', 'active', 'retired', 'failed')),
    reason TEXT NOT NULL DEFAULT '',
    actor_subject TEXT NOT NULL,
    correlation_id TEXT,
    occurred_at TEXT NOT NULL CHECK (length(occurred_at) >= 20 AND substr(occurred_at, -1) = 'Z'),
    PRIMARY KEY (deployment_id, sequence)
) STRICT;

CREATE TRIGGER deployment_status_validate_sequence
BEFORE INSERT ON deployment_status_history
BEGIN
    SELECT (CASE WHEN NEW.sequence <> COALESCE((
        SELECT MAX(sequence) + 1 FROM deployment_status_history WHERE deployment_id = NEW.deployment_id
    ), 1) THEN RAISE(ABORT, 'deployment status sequence is not next') END);
    SELECT (CASE WHEN NEW.sequence = 1 AND NEW.state <> 'registered'
        THEN RAISE(ABORT, 'first deployment status must be registered') END);
    SELECT (CASE WHEN NEW.sequence > 1 AND NEW.state = (
        SELECT state FROM deployment_status_history WHERE deployment_id = NEW.deployment_id ORDER BY sequence DESC LIMIT 1
    ) THEN RAISE(ABORT, 'deployment status must change') END);
    SELECT (CASE WHEN NEW.sequence > 1 AND (
        SELECT state FROM deployment_status_history WHERE deployment_id = NEW.deployment_id ORDER BY sequence DESC LIMIT 1
    ) = 'retired' THEN RAISE(ABORT, 'retired deployment is terminal') END);
END;

CREATE TRIGGER deployment_status_no_update
BEFORE UPDATE ON deployment_status_history BEGIN SELECT RAISE(ABORT, 'deployment status history is immutable'); END;
CREATE TRIGGER deployment_status_no_delete
BEFORE DELETE ON deployment_status_history BEGIN SELECT RAISE(ABORT, 'deployment status history is immutable'); END;

CREATE VIEW deployment_current_status AS
SELECT h.deployment_id, h.sequence AS revision, h.state, h.reason, h.actor_subject, h.correlation_id, h.occurred_at
FROM deployment_status_history AS h
WHERE h.sequence = (SELECT MAX(h2.sequence) FROM deployment_status_history AS h2 WHERE h2.deployment_id = h.deployment_id);

-- Authoritative current deployment pointer per service/environment; probes never guess by timestamp.
-- 每个服务/环境的权威当前部署指针；probe 绝不按时间戳猜测部署。
CREATE TABLE service_environment_deployments (
    service_name TEXT NOT NULL,
    environment TEXT NOT NULL CHECK (environment IN ('development', 'test', 'staging', 'production')),
    deployment_id TEXT NOT NULL,
    activated_at TEXT NOT NULL CHECK (length(activated_at) >= 20 AND substr(activated_at, -1) = 'Z'),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    PRIMARY KEY (service_name, environment),
    FOREIGN KEY (deployment_id, service_name) REFERENCES deployments(deployment_id, service_name)
) STRICT;

CREATE TRIGGER service_environment_deployments_validate
BEFORE INSERT ON service_environment_deployments
BEGIN
    SELECT (CASE WHEN NEW.environment <> (SELECT environment FROM deployments WHERE deployment_id = NEW.deployment_id)
        THEN RAISE(ABORT, 'current deployment environment mismatch') END);
    SELECT (CASE WHEN (SELECT state FROM deployment_current_status WHERE deployment_id = NEW.deployment_id) NOT IN ('ready', 'active')
        THEN RAISE(ABORT, 'current deployment must be ready or active') END);
END;

CREATE TRIGGER service_environment_deployments_validate_update
BEFORE UPDATE ON service_environment_deployments
BEGIN
    SELECT (CASE WHEN NEW.revision <> OLD.revision + 1
        THEN RAISE(ABORT, 'current deployment revision must increase by one') END);
    SELECT (CASE WHEN NEW.service_name <> OLD.service_name OR NEW.environment <> OLD.environment
        THEN RAISE(ABORT, 'current deployment identity is immutable') END);
    SELECT (CASE WHEN NEW.environment <> (SELECT environment FROM deployments WHERE deployment_id = NEW.deployment_id)
        THEN RAISE(ABORT, 'current deployment environment mismatch') END);
    SELECT (CASE WHEN (SELECT state FROM deployment_current_status WHERE deployment_id = NEW.deployment_id) NOT IN ('ready', 'active')
        THEN RAISE(ABORT, 'current deployment must be ready or active') END);
END;

-- Diagnostic dedup rows are durable tombstones: deleting them would permit replay side effects.
-- Diagnostic 去重行是持久墓碑：删除会让重放再次产生领域副作用。
CREATE TABLE diagnostic_event_dedup (
    event_id TEXT PRIMARY KEY NOT NULL CHECK (
        length(event_id) = 36 AND substr(event_id, 15, 1) = '7' AND
        substr(event_id, 20, 1) GLOB '[89ab]' AND lower(event_id) = event_id
    ),
    event_schema_version TEXT NOT NULL,
    service_name TEXT NOT NULL,
    deployment_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error', 'critical')),
    occurred_at TEXT NOT NULL CHECK (length(occurred_at) >= 20 AND substr(occurred_at, -1) = 'Z'),
    received_at TEXT NOT NULL CHECK (length(received_at) >= 20 AND substr(received_at, -1) = 'Z'),
    processed_at TEXT NOT NULL CHECK (length(processed_at) >= 20 AND substr(processed_at, -1) = 'Z'),
    fingerprint_hash TEXT NOT NULL CHECK (length(fingerprint_hash) = 64 AND fingerprint_hash NOT GLOB '*[^0-9a-f]*'),
    payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 71 AND substr(payload_digest, 1, 7) = 'sha256:' AND substr(payload_digest, 8) NOT GLOB '*[^0-9a-f]*'),
    envelope_schema_version TEXT NOT NULL,
    processing_token TEXT NOT NULL UNIQUE,
    producer_subject TEXT NOT NULL,
    correlation_id TEXT,
    trace_id TEXT CHECK (trace_id IS NULL OR (length(trace_id) = 32 AND trace_id NOT GLOB '*[^0-9a-f]*')),
    span_id TEXT CHECK (span_id IS NULL OR (length(span_id) = 16 AND span_id NOT GLOB '*[^0-9a-f]*')),
    FOREIGN KEY (deployment_id, service_name) REFERENCES deployments(deployment_id, service_name)
) STRICT;

CREATE INDEX idx_diagnostic_events_service_time
    ON diagnostic_event_dedup(service_name, occurred_at DESC);

CREATE TRIGGER diagnostic_event_dedup_no_update
BEFORE UPDATE ON diagnostic_event_dedup BEGIN SELECT RAISE(ABORT, 'diagnostic dedup records are immutable'); END;
CREATE TRIGGER diagnostic_event_dedup_no_delete
BEFORE DELETE ON diagnostic_event_dedup BEGIN SELECT RAISE(ABORT, 'diagnostic dedup records are immutable'); END;

-- Ephemeral assertion sink for optimistic concurrency inside D1 batch transactions.
-- D1 batch 事务中的临时断言槽，用于乐观并发校验；AFTER trigger 保证不积累数据。
CREATE TABLE transaction_assertions (
    assertion_id TEXT PRIMARY KEY NOT NULL,
    passed INTEGER NOT NULL
) STRICT;

CREATE TRIGGER transaction_assertions_require_true
BEFORE INSERT ON transaction_assertions
WHEN NEW.passed <> 1
BEGIN SELECT RAISE(ABORT, 'transaction assertion failed'); END;

CREATE TRIGGER transaction_assertions_discard
AFTER INSERT ON transaction_assertions
BEGIN DELETE FROM transaction_assertions WHERE assertion_id = NEW.assertion_id; END;

-- Retention policy revisions make occurrence cleanup decisions reproducible.
-- 保留策略修订使 occurrence 清理决定可重现。
CREATE TABLE data_retention_policies (
    policy_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    occurrence_retention_days INTEGER NOT NULL CHECK (occurrence_retention_days > 0),
    cleanup_batch_size INTEGER NOT NULL CHECK (cleanup_batch_size > 0),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL CHECK (length(created_at) >= 20 AND substr(created_at, -1) = 'Z'),
    PRIMARY KEY (policy_id, revision)
) STRICT;

CREATE TRIGGER data_retention_policies_no_update
BEFORE UPDATE ON data_retention_policies BEGIN SELECT RAISE(ABORT, 'retention policy revisions are immutable'); END;
CREATE TRIGGER data_retention_policies_no_delete
BEFORE DELETE ON data_retention_policies BEGIN SELECT RAISE(ABORT, 'retention policy revisions are immutable'); END;

-- Cleanup selection is explicit per service; consumers never infer the latest policy revision.
-- 每个服务显式选择清理策略；consumer 绝不推断“最新”修订。
CREATE TABLE service_retention_policies (
    service_name TEXT PRIMARY KEY NOT NULL REFERENCES services(service_name),
    policy_id TEXT NOT NULL,
    policy_revision INTEGER NOT NULL,
    assigned_by TEXT NOT NULL,
    assigned_at TEXT NOT NULL CHECK (length(assigned_at) >= 20 AND substr(assigned_at, -1) = 'Z'),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    FOREIGN KEY (policy_id, policy_revision) REFERENCES data_retention_policies(policy_id, revision)
) STRICT;

CREATE TRIGGER service_retention_policies_revision
BEFORE UPDATE ON service_retention_policies
WHEN NEW.revision <> OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'service retention policy revision must increase by one'); END;

-- Issue aggregate. A partial unique index permits exactly one unresolved recurrence per fingerprint.
-- Issue 聚合。部分唯一索引确保每个指纹最多只有一个未解决 recurrence。
CREATE TABLE issues (
    issue_id TEXT PRIMARY KEY NOT NULL CHECK (
        length(issue_id) = 36 AND substr(issue_id, 15, 1) = '7' AND
        substr(issue_id, 20, 1) GLOB '[89ab]' AND lower(issue_id) = issue_id
    ),
    recurrence_of_issue_id TEXT REFERENCES issues(issue_id),
    fingerprint_hash TEXT NOT NULL CHECK (length(fingerprint_hash) = 64 AND fingerprint_hash NOT GLOB '*[^0-9a-f]*'),
    service_name TEXT NOT NULL REFERENCES services(service_name),
    kind TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error', 'critical')),
    state TEXT NOT NULL CHECK (state IN ('observed', 'active', 'recovering', 'suppressed', 'resolved')),
    first_seen_at TEXT NOT NULL CHECK (length(first_seen_at) >= 20 AND substr(first_seen_at, -1) = 'Z'),
    last_seen_at TEXT NOT NULL CHECK (length(last_seen_at) >= 20 AND substr(last_seen_at, -1) = 'Z'),
    occurrence_count INTEGER NOT NULL DEFAULT 1 CHECK (occurrence_count >= 1),
    affected_instance_count INTEGER NOT NULL DEFAULT 0 CHECK (affected_instance_count >= 0),
    policy_id TEXT NOT NULL,
    policy_revision INTEGER NOT NULL,
    suppression_until TEXT,
    suppression_reason TEXT,
    resolved_at TEXT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    FOREIGN KEY (policy_id, policy_revision) REFERENCES evaluation_policies(policy_id, revision),
    CHECK (last_seen_at >= first_seen_at),
    CHECK ((state = 'resolved') = (resolved_at IS NOT NULL)),
    CHECK ((state = 'suppressed') = (suppression_until IS NOT NULL AND suppression_reason IS NOT NULL)),
    CHECK (recurrence_of_issue_id IS NULL OR recurrence_of_issue_id <> issue_id)
) STRICT;

CREATE UNIQUE INDEX uq_issues_unresolved_fingerprint
    ON issues(service_name, kind, fingerprint_hash) WHERE state <> 'resolved';
CREATE INDEX idx_issues_service_state_time
    ON issues(service_name, state, last_seen_at DESC);

CREATE TRIGGER issues_initial_state
BEFORE INSERT ON issues
WHEN NEW.state <> 'observed'
BEGIN SELECT RAISE(ABORT, 'new issue must start in observed state'); END;

CREATE TRIGGER issues_validate_update
BEFORE UPDATE ON issues
BEGIN
    SELECT (CASE WHEN NEW.revision <> OLD.revision + 1
        THEN RAISE(ABORT, 'issue revision must increase by one') END);
    SELECT (CASE WHEN OLD.state = 'resolved'
        THEN RAISE(ABORT, 'resolved issue is immutable; create a recurrence') END);
    SELECT (CASE WHEN NEW.state <> OLD.state AND NOT (
        (OLD.state = 'observed' AND NEW.state IN ('active', 'resolved')) OR
        (OLD.state = 'active' AND NEW.state IN ('recovering', 'suppressed')) OR
        (OLD.state = 'recovering' AND NEW.state IN ('active', 'resolved')) OR
        (OLD.state = 'suppressed' AND NEW.state IN ('active', 'resolved'))
    ) THEN RAISE(ABORT, 'invalid issue state transition') END);
END;

CREATE TRIGGER issues_validate_recurrence
BEFORE INSERT ON issues
WHEN NEW.recurrence_of_issue_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM issues AS prior
    WHERE prior.issue_id = NEW.recurrence_of_issue_id AND prior.state = 'resolved'
      AND prior.service_name = NEW.service_name AND prior.kind = NEW.kind
      AND prior.fingerprint_hash = NEW.fingerprint_hash
)
BEGIN SELECT RAISE(ABORT, 'issue recurrence must reference a matching resolved issue'); END;

-- Exact distinct affected-instance set; summary count in issues is updated in the same consumer transaction.
-- 精确的受影响实例集合；issues 中的汇总计数在同一 consumer 事务更新。
CREATE TABLE issue_instances (
    issue_id TEXT NOT NULL REFERENCES issues(issue_id),
    instance_id TEXT NOT NULL,
    first_seen_at TEXT NOT NULL CHECK (length(first_seen_at) >= 20 AND substr(first_seen_at, -1) = 'Z'),
    last_seen_at TEXT NOT NULL CHECK (length(last_seen_at) >= 20 AND substr(last_seen_at, -1) = 'Z'),
    PRIMARY KEY (issue_id, instance_id),
    CHECK (last_seen_at >= first_seen_at)
) STRICT;

CREATE INDEX idx_issue_instances_last_seen ON issue_instances(issue_id, last_seen_at DESC);

-- Bounded occurrence summaries; incident_occurrences pins summaries against cleanup.
-- 有界 occurrence 摘要；incident_occurrences 会固定摘要，阻止清理。
CREATE TABLE issue_occurrences (
    occurrence_id TEXT PRIMARY KEY NOT NULL CHECK (
        length(occurrence_id) = 36 AND substr(occurrence_id, 15, 1) = '7' AND
        substr(occurrence_id, 20, 1) GLOB '[89ab]' AND lower(occurrence_id) = occurrence_id
    ),
    issue_id TEXT NOT NULL REFERENCES issues(issue_id),
    event_id TEXT UNIQUE REFERENCES diagnostic_event_dedup(event_id),
    service_name TEXT NOT NULL,
    deployment_id TEXT NOT NULL,
    occurred_at TEXT NOT NULL CHECK (length(occurred_at) >= 20 AND substr(occurred_at, -1) = 'Z'),
    observed_at TEXT NOT NULL CHECK (length(observed_at) >= 20 AND substr(observed_at, -1) = 'Z'),
    instance_id TEXT,
    summary TEXT NOT NULL,
    correlation_id TEXT,
    evidence_count INTEGER NOT NULL DEFAULT 0 CHECK (evidence_count >= 0),
    retention_policy_id TEXT NOT NULL,
    retention_policy_revision INTEGER NOT NULL,
    purge_after TEXT NOT NULL CHECK (length(purge_after) >= 20 AND substr(purge_after, -1) = 'Z'),
    FOREIGN KEY (deployment_id, service_name) REFERENCES deployments(deployment_id, service_name),
    FOREIGN KEY (retention_policy_id, retention_policy_revision) REFERENCES data_retention_policies(policy_id, revision)
) STRICT;

CREATE INDEX idx_issue_occurrences_issue_time
    ON issue_occurrences(issue_id, occurred_at DESC);
CREATE INDEX idx_issue_occurrences_purge
    ON issue_occurrences(purge_after);

CREATE TRIGGER issue_occurrences_service_matches_issue
BEFORE INSERT ON issue_occurrences
WHEN NEW.service_name <> (SELECT service_name FROM issues WHERE issue_id = NEW.issue_id)
BEGIN SELECT RAISE(ABORT, 'occurrence service must match issue service'); END;

CREATE TRIGGER issue_occurrences_event_provenance
BEFORE INSERT ON issue_occurrences
WHEN NEW.event_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM diagnostic_event_dedup AS e
    WHERE e.event_id = NEW.event_id AND e.service_name = NEW.service_name
      AND e.deployment_id = NEW.deployment_id
)
BEGIN SELECT RAISE(ABORT, 'occurrence provenance must match diagnostic event'); END;

CREATE TRIGGER issue_occurrences_no_update
BEFORE UPDATE ON issue_occurrences BEGIN SELECT RAISE(ABORT, 'issue occurrences are immutable'); END;

-- Immutable incident identity; the latest IncidentUpdate is the current snapshot and optimistic revision.
-- 不可变 Incident 身份；最新 IncidentUpdate 即当前快照与乐观并发修订。
CREATE TABLE incidents (
    incident_id TEXT PRIMARY KEY NOT NULL CHECK (
        length(incident_id) = 36 AND substr(incident_id, 15, 1) = '7' AND
        substr(incident_id, 20, 1) GLOB '[89ab]' AND lower(incident_id) = incident_id
    ),
    started_at TEXT NOT NULL CHECK (length(started_at) >= 20 AND substr(started_at, -1) = 'Z'),
    detected_at TEXT NOT NULL CHECK (length(detected_at) >= 20 AND substr(detected_at, -1) = 'Z'),
    created_at TEXT NOT NULL CHECK (length(created_at) >= 20 AND substr(created_at, -1) = 'Z'),
    created_by TEXT NOT NULL,
    CHECK (detected_at >= started_at)
) STRICT;

CREATE TRIGGER incidents_no_update
BEFORE UPDATE ON incidents BEGIN SELECT RAISE(ABORT, 'incident identities are immutable'); END;
CREATE TRIGGER incidents_no_delete
BEFORE DELETE ON incidents BEGIN SELECT RAISE(ABORT, 'incidents are long-lived domain records'); END;

CREATE TABLE incident_updates (
    update_id TEXT PRIMARY KEY NOT NULL CHECK (
        length(update_id) = 36 AND substr(update_id, 15, 1) = '7' AND
        substr(update_id, 20, 1) GLOB '[89ab]' AND lower(update_id) = update_id
    ),
    incident_id TEXT NOT NULL REFERENCES incidents(incident_id),
    sequence INTEGER NOT NULL CHECK (sequence >= 1),
    title TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('investigating', 'identified', 'monitoring', 'resolved')),
    impact TEXT NOT NULL CHECK (impact IN ('degraded', 'partial_outage', 'major_outage')),
    cause TEXT,
    public_message TEXT NOT NULL,
    resolved_at TEXT,
    actor_subject TEXT NOT NULL,
    correlation_id TEXT,
    occurred_at TEXT NOT NULL CHECK (length(occurred_at) >= 20 AND substr(occurred_at, -1) = 'Z'),
    UNIQUE (incident_id, sequence),
    CHECK ((state = 'resolved') = (resolved_at IS NOT NULL))
) STRICT;

CREATE INDEX idx_incident_updates_time ON incident_updates(incident_id, occurred_at DESC);

CREATE TRIGGER incident_updates_validate_sequence
BEFORE INSERT ON incident_updates
BEGIN
    SELECT (CASE WHEN NEW.sequence <> COALESCE((
        SELECT MAX(sequence) + 1 FROM incident_updates WHERE incident_id = NEW.incident_id
    ), 1) THEN RAISE(ABORT, 'incident update sequence is not next') END);
    SELECT (CASE WHEN NEW.sequence = 1 AND NEW.state <> 'investigating'
        THEN RAISE(ABORT, 'incident must start in investigating state') END);
    SELECT (CASE WHEN NEW.sequence > 1 AND NOT (
        ((SELECT state FROM incident_updates WHERE incident_id = NEW.incident_id ORDER BY sequence DESC LIMIT 1) = 'investigating' AND NEW.state IN ('investigating', 'identified', 'monitoring')) OR
        ((SELECT state FROM incident_updates WHERE incident_id = NEW.incident_id ORDER BY sequence DESC LIMIT 1) = 'identified' AND NEW.state IN ('identified', 'monitoring', 'resolved')) OR
        ((SELECT state FROM incident_updates WHERE incident_id = NEW.incident_id ORDER BY sequence DESC LIMIT 1) = 'monitoring' AND NEW.state IN ('monitoring', 'investigating', 'resolved'))
    ) THEN RAISE(ABORT, 'invalid incident state transition') END);
END;

CREATE TRIGGER incident_updates_no_update
BEFORE UPDATE ON incident_updates BEGIN SELECT RAISE(ABORT, 'incident updates are immutable'); END;
CREATE TRIGGER incident_updates_no_delete
BEFORE DELETE ON incident_updates BEGIN SELECT RAISE(ABORT, 'incident updates are immutable'); END;

CREATE VIEW incident_current AS
SELECT i.incident_id, i.started_at, i.detected_at, i.created_at, i.created_by,
       u.sequence AS revision, u.title, u.state, u.impact, u.cause, u.public_message,
       u.resolved_at, u.actor_subject AS updated_by, u.occurred_at AS updated_at
FROM incidents AS i
JOIN incident_updates AS u ON u.incident_id = i.incident_id
WHERE u.sequence = (SELECT MAX(u2.sequence) FROM incident_updates AS u2 WHERE u2.incident_id = i.incident_id);

-- Append-only relation events retain association history; views expose the latest membership.
-- 仅追加的关系事件保留关联历史；视图暴露最新成员关系。
CREATE TABLE incident_issue_relations (
    incident_id TEXT NOT NULL,
    issue_id TEXT NOT NULL REFERENCES issues(issue_id),
    update_sequence INTEGER NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('added', 'removed')),
    PRIMARY KEY (incident_id, issue_id, update_sequence),
    FOREIGN KEY (incident_id, update_sequence) REFERENCES incident_updates(incident_id, sequence)
) STRICT;

CREATE TRIGGER incident_issue_relations_validate
BEFORE INSERT ON incident_issue_relations
BEGIN
    SELECT (CASE WHEN COALESCE((SELECT action FROM incident_issue_relations
        WHERE incident_id = NEW.incident_id AND issue_id = NEW.issue_id
        ORDER BY update_sequence DESC LIMIT 1), 'removed') = NEW.action
        THEN RAISE(ABORT, 'incident issue relation action must alternate') END);
END;

CREATE TRIGGER incident_issue_relations_no_update
BEFORE UPDATE ON incident_issue_relations BEGIN SELECT RAISE(ABORT, 'incident issue relation history is immutable'); END;
CREATE TRIGGER incident_issue_relations_no_delete
BEFORE DELETE ON incident_issue_relations BEGIN SELECT RAISE(ABORT, 'incident issue relation history is immutable'); END;

CREATE VIEW incident_issues AS
SELECT r.incident_id, r.issue_id, r.update_sequence
FROM incident_issue_relations AS r
WHERE r.action = 'added' AND NOT EXISTS (
    SELECT 1 FROM incident_issue_relations AS newer
    WHERE newer.incident_id = r.incident_id AND newer.issue_id = r.issue_id
      AND newer.update_sequence > r.update_sequence
);

CREATE TABLE incident_component_relations (
    incident_id TEXT NOT NULL,
    component_id TEXT NOT NULL REFERENCES components(component_id),
    update_sequence INTEGER NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('added', 'removed')),
    PRIMARY KEY (incident_id, component_id, update_sequence),
    FOREIGN KEY (incident_id, update_sequence) REFERENCES incident_updates(incident_id, sequence)
) STRICT;

CREATE TRIGGER incident_component_relations_validate
BEFORE INSERT ON incident_component_relations
BEGIN
    SELECT (CASE WHEN COALESCE((SELECT action FROM incident_component_relations
        WHERE incident_id = NEW.incident_id AND component_id = NEW.component_id
        ORDER BY update_sequence DESC LIMIT 1), 'removed') = NEW.action
        THEN RAISE(ABORT, 'incident component relation action must alternate') END);
END;

CREATE TRIGGER incident_component_relations_no_update
BEFORE UPDATE ON incident_component_relations BEGIN SELECT RAISE(ABORT, 'incident component relation history is immutable'); END;
CREATE TRIGGER incident_component_relations_no_delete
BEFORE DELETE ON incident_component_relations BEGIN SELECT RAISE(ABORT, 'incident component relation history is immutable'); END;

CREATE VIEW incident_components AS
SELECT r.incident_id, r.component_id, r.update_sequence
FROM incident_component_relations AS r
WHERE r.action = 'added' AND NOT EXISTS (
    SELECT 1 FROM incident_component_relations AS newer
    WHERE newer.incident_id = r.incident_id AND newer.component_id = r.component_id
      AND newer.update_sequence > r.update_sequence
);

CREATE TABLE incident_service_relations (
    incident_id TEXT NOT NULL,
    service_name TEXT NOT NULL REFERENCES services(service_name),
    update_sequence INTEGER NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('added', 'removed')),
    PRIMARY KEY (incident_id, service_name, update_sequence),
    FOREIGN KEY (incident_id, update_sequence) REFERENCES incident_updates(incident_id, sequence)
) STRICT;

CREATE TRIGGER incident_service_relations_validate
BEFORE INSERT ON incident_service_relations
BEGIN
    SELECT (CASE WHEN COALESCE((SELECT action FROM incident_service_relations
        WHERE incident_id = NEW.incident_id AND service_name = NEW.service_name
        ORDER BY update_sequence DESC LIMIT 1), 'removed') = NEW.action
        THEN RAISE(ABORT, 'incident service relation action must alternate') END);
END;

CREATE TRIGGER incident_service_relations_no_update
BEFORE UPDATE ON incident_service_relations BEGIN SELECT RAISE(ABORT, 'incident service relation history is immutable'); END;
CREATE TRIGGER incident_service_relations_no_delete
BEFORE DELETE ON incident_service_relations BEGIN SELECT RAISE(ABORT, 'incident service relation history is immutable'); END;

CREATE VIEW incident_services AS
SELECT r.incident_id, r.service_name, r.update_sequence
FROM incident_service_relations AS r
WHERE r.action = 'added' AND NOT EXISTS (
    SELECT 1 FROM incident_service_relations AS newer
    WHERE newer.incident_id = r.incident_id AND newer.service_name = r.service_name
      AND newer.update_sequence > r.update_sequence
);

-- A pin is permanent because incident-referenced summaries have long-lived retention.
-- 固定关系永久存在，因为 Incident 引用摘要需要长期保留。
CREATE TABLE incident_occurrences (
    incident_id TEXT NOT NULL REFERENCES incidents(incident_id),
    occurrence_id TEXT NOT NULL REFERENCES issue_occurrences(occurrence_id),
    update_sequence INTEGER NOT NULL,
    PRIMARY KEY (incident_id, occurrence_id),
    FOREIGN KEY (incident_id, update_sequence) REFERENCES incident_updates(incident_id, sequence)
) STRICT;

CREATE TRIGGER incident_occurrences_no_update
BEFORE UPDATE ON incident_occurrences BEGIN SELECT RAISE(ABORT, 'incident occurrence pins are immutable'); END;
CREATE TRIGGER incident_occurrences_no_delete
BEFORE DELETE ON incident_occurrences BEGIN SELECT RAISE(ABORT, 'incident occurrence pins are permanent'); END;

CREATE TRIGGER issue_occurrences_block_pinned_delete
BEFORE DELETE ON issue_occurrences
WHEN EXISTS (SELECT 1 FROM incident_occurrences WHERE occurrence_id = OLD.occurrence_id)
BEGIN SELECT RAISE(ABORT, 'incident-referenced occurrence cannot be deleted'); END;

-- Operator actions remain append-only even when the Issue aggregate changes.
-- 即使 Issue 聚合会改变，人工操作记录仍只追加。
CREATE TABLE issue_actions (
    action_id TEXT PRIMARY KEY NOT NULL CHECK (
        length(action_id) = 36 AND substr(action_id, 15, 1) = '7' AND
        substr(action_id, 20, 1) GLOB '[89ab]' AND lower(action_id) = action_id
    ),
    issue_id TEXT NOT NULL REFERENCES issues(issue_id),
    issue_revision INTEGER NOT NULL CHECK (issue_revision >= 1),
    action TEXT NOT NULL CHECK (action IN ('acknowledged', 'suppressed', 'unsuppressed', 'resolved')),
    reason TEXT NOT NULL DEFAULT '',
    until_at TEXT,
    actor_subject TEXT NOT NULL,
    correlation_id TEXT,
    occurred_at TEXT NOT NULL CHECK (length(occurred_at) >= 20 AND substr(occurred_at, -1) = 'Z')
) STRICT;

CREATE TRIGGER issue_actions_no_update
BEFORE UPDATE ON issue_actions BEGIN SELECT RAISE(ABORT, 'issue actions are immutable'); END;
CREATE TRIGGER issue_actions_no_delete
BEFORE DELETE ON issue_actions BEGIN SELECT RAISE(ABORT, 'issue actions are immutable'); END;

-- Maintenance window snapshot and targets. Re-evaluation is emitted through the transactional outbox.
-- 维护窗口快照及目标。重评估通过同一事务内的 outbox 发出。
CREATE TABLE maintenance_windows (
    maintenance_id TEXT PRIMARY KEY NOT NULL CHECK (
        length(maintenance_id) = 36 AND substr(maintenance_id, 15, 1) = '7' AND
        substr(maintenance_id, 20, 1) GLOB '[89ab]' AND lower(maintenance_id) = maintenance_id
    ),
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    expected_impact TEXT NOT NULL CHECK (expected_impact IN ('degraded', 'partial_outage', 'major_outage')),
    starts_at TEXT NOT NULL CHECK (length(starts_at) >= 20 AND substr(starts_at, -1) = 'Z'),
    ends_at TEXT NOT NULL CHECK (length(ends_at) >= 20 AND substr(ends_at, -1) = 'Z'),
    state TEXT NOT NULL DEFAULT 'scheduled' CHECK (state IN ('scheduled', 'active', 'completed', 'cancelled')),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL CHECK (length(created_at) >= 20 AND substr(created_at, -1) = 'Z'),
    updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20 AND substr(updated_at, -1) = 'Z'),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    CHECK (ends_at > starts_at)
) STRICT;

CREATE INDEX idx_maintenance_windows_range ON maintenance_windows(starts_at, ends_at, state);

CREATE TRIGGER maintenance_windows_revision
BEFORE UPDATE ON maintenance_windows
WHEN NEW.revision <> OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'maintenance revision must increase by one'); END;

CREATE TABLE maintenance_targets (
    maintenance_id TEXT NOT NULL REFERENCES maintenance_windows(maintenance_id),
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    PRIMARY KEY (maintenance_id, target_type, target_id),
    FOREIGN KEY (target_type, target_id) REFERENCES status_targets(target_type, target_id)
) STRICT;

-- Expiring manual override. A target has at most one non-revoked override.
-- 带过期时间的人工覆盖。每个目标最多一个未撤销覆盖。
CREATE TABLE status_overrides (
    override_id TEXT PRIMARY KEY NOT NULL CHECK (
        length(override_id) = 36 AND substr(override_id, 15, 1) = '7' AND
        substr(override_id, 20, 1) GLOB '[89ab]' AND lower(override_id) = override_id
    ),
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('operational', 'degraded', 'partial_outage', 'major_outage', 'maintenance', 'unknown')),
    reason TEXT NOT NULL,
    starts_at TEXT NOT NULL CHECK (length(starts_at) >= 20 AND substr(starts_at, -1) = 'Z'),
    expires_at TEXT NOT NULL CHECK (length(expires_at) >= 20 AND substr(expires_at, -1) = 'Z'),
    actor_subject TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL CHECK (length(created_at) >= 20 AND substr(created_at, -1) = 'Z'),
    revoked_at TEXT,
    revoked_by TEXT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    FOREIGN KEY (target_type, target_id) REFERENCES status_targets(target_type, target_id),
    CHECK (expires_at > starts_at),
    CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
) STRICT;

CREATE UNIQUE INDEX uq_status_overrides_unrevoked
    ON status_overrides(target_type, target_id) WHERE revoked_at IS NULL;

CREATE TRIGGER status_overrides_revision
BEFORE UPDATE ON status_overrides
WHEN NEW.revision <> OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'status override revision must increase by one'); END;

-- Backend registry stores templates/configuration references, never credentials.
-- 后端注册表只保存模板与配置引用，绝不保存凭据。
CREATE TABLE telemetry_backends (
    backend_name TEXT PRIMARY KEY NOT NULL,
    capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json) AND json_type(capabilities_json) = 'array'),
    query_adapter TEXT NOT NULL,
    ui_url_template TEXT NOT NULL,
    retention_class TEXT NOT NULL,
    auth_reference TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    created_at TEXT NOT NULL CHECK (length(created_at) >= 20 AND substr(created_at, -1) = 'Z'),
    updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20 AND substr(updated_at, -1) = 'Z')
) STRICT;

CREATE TRIGGER telemetry_backends_revision
BEFORE UPDATE ON telemetry_backends
WHEN NEW.revision <> OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'telemetry backend revision must increase by one'); END;

-- Structured, vendor-neutral evidence reference with deployment/service consistency.
-- 结构化、供应商无关的证据引用，并强制部署与服务一致。
CREATE TABLE telemetry_references (
    telemetry_reference_id TEXT PRIMARY KEY NOT NULL CHECK (
        length(telemetry_reference_id) = 36 AND substr(telemetry_reference_id, 15, 1) = '7' AND
        substr(telemetry_reference_id, 20, 1) GLOB '[89ab]' AND lower(telemetry_reference_id) = telemetry_reference_id
    ),
    kind TEXT NOT NULL CHECK (kind IN ('trace', 'log_query', 'profile', 'metric_query', 'source', 'artifact')),
    backend_name TEXT NOT NULL REFERENCES telemetry_backends(backend_name),
    locator_json TEXT NOT NULL CHECK (json_valid(locator_json) AND json_type(locator_json) = 'object'),
    range_start TEXT,
    range_end TEXT,
    service_name TEXT NOT NULL,
    deployment_id TEXT NOT NULL,
    correlation_id TEXT,
    trace_id TEXT CHECK (trace_id IS NULL OR (length(trace_id) = 32 AND trace_id NOT GLOB '*[^0-9a-f]*')),
    span_id TEXT CHECK (span_id IS NULL OR (length(span_id) = 16 AND span_id NOT GLOB '*[^0-9a-f]*')),
    expires_at TEXT,
    created_at TEXT NOT NULL CHECK (length(created_at) >= 20 AND substr(created_at, -1) = 'Z'),
    FOREIGN KEY (deployment_id, service_name) REFERENCES deployments(deployment_id, service_name),
    CHECK ((range_start IS NULL) = (range_end IS NULL)),
    CHECK (range_start IS NULL OR range_end >= range_start),
    CHECK (kind NOT IN ('log_query', 'metric_query', 'profile') OR range_start IS NOT NULL)
) STRICT;

CREATE INDEX idx_telemetry_references_correlation ON telemetry_references(correlation_id);
CREATE INDEX idx_telemetry_references_trace ON telemetry_references(trace_id);
CREATE INDEX idx_telemetry_references_deployment ON telemetry_references(deployment_id);

CREATE TRIGGER telemetry_references_no_update
BEFORE UPDATE ON telemetry_references BEGIN SELECT RAISE(ABORT, 'telemetry references are immutable'); END;
CREATE TRIGGER telemetry_references_no_delete
BEFORE DELETE ON telemetry_references BEGIN SELECT RAISE(ABORT, 'telemetry references are immutable'); END;

CREATE TABLE issue_telemetry_references (
    issue_id TEXT NOT NULL REFERENCES issues(issue_id),
    telemetry_reference_id TEXT NOT NULL REFERENCES telemetry_references(telemetry_reference_id),
    occurrence_id TEXT REFERENCES issue_occurrences(occurrence_id),
    linked_at TEXT NOT NULL CHECK (length(linked_at) >= 20 AND substr(linked_at, -1) = 'Z'),
    PRIMARY KEY (issue_id, telemetry_reference_id)
) STRICT;

CREATE TRIGGER issue_telemetry_references_validate
BEFORE INSERT ON issue_telemetry_references
WHEN NOT EXISTS (
    SELECT 1 FROM issues AS i
    JOIN telemetry_references AS t ON t.telemetry_reference_id = NEW.telemetry_reference_id
    WHERE i.issue_id = NEW.issue_id AND i.service_name = t.service_name
      AND (NEW.occurrence_id IS NULL OR EXISTS (
          SELECT 1 FROM issue_occurrences AS o
          WHERE o.occurrence_id = NEW.occurrence_id AND o.issue_id = NEW.issue_id
      ))
)
BEGIN SELECT RAISE(ABORT, 'issue evidence must match issue and occurrence'); END;

CREATE TRIGGER issue_telemetry_references_no_update
BEFORE UPDATE ON issue_telemetry_references BEGIN SELECT RAISE(ABORT, 'issue evidence links are immutable'); END;
CREATE TRIGGER issue_telemetry_references_no_delete
BEFORE DELETE ON issue_telemetry_references BEGIN SELECT RAISE(ABORT, 'issue evidence links are immutable'); END;

CREATE INDEX idx_issue_telemetry_occurrence ON issue_telemetry_references(occurrence_id);

CREATE TABLE incident_telemetry_references (
    incident_id TEXT NOT NULL REFERENCES incidents(incident_id),
    telemetry_reference_id TEXT NOT NULL REFERENCES telemetry_references(telemetry_reference_id),
    update_sequence INTEGER NOT NULL,
    PRIMARY KEY (incident_id, telemetry_reference_id),
    FOREIGN KEY (incident_id, update_sequence) REFERENCES incident_updates(incident_id, sequence)
) STRICT;

CREATE TRIGGER incident_telemetry_references_no_update
BEFORE UPDATE ON incident_telemetry_references BEGIN SELECT RAISE(ABORT, 'incident evidence links are immutable'); END;
CREATE TRIGGER incident_telemetry_references_no_delete
BEFORE DELETE ON incident_telemetry_references BEGIN SELECT RAISE(ABORT, 'incident evidence links are immutable'); END;

-- Generic HTTP/RPC idempotency ledger. request_digest detects same-key/different-body conflicts.
-- 通用 HTTP/RPC 幂等账本。request_digest 用于检测同键不同请求体冲突。
CREATE TABLE idempotency_keys (
    scope TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_digest TEXT NOT NULL CHECK (length(request_digest) = 71 AND substr(request_digest, 1, 7) = 'sha256:' AND substr(request_digest, 8) NOT GLOB '*[^0-9a-f]*'),
    resource_type TEXT,
    resource_id TEXT,
    response_status INTEGER NOT NULL CHECK (response_status BETWEEN 200 AND 599),
    response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
    created_at TEXT NOT NULL CHECK (length(created_at) >= 20 AND substr(created_at, -1) = 'Z'),
    expires_at TEXT NOT NULL CHECK (length(expires_at) >= 20 AND substr(expires_at, -1) = 'Z'),
    PRIMARY KEY (scope, idempotency_key),
    CHECK ((resource_type IS NULL) = (resource_id IS NULL)),
    CHECK (expires_at > created_at)
) STRICT;

CREATE INDEX idx_idempotency_keys_expiry ON idempotency_keys(expires_at);
CREATE TRIGGER idempotency_keys_no_update
BEFORE UPDATE ON idempotency_keys BEGIN SELECT RAISE(ABORT, 'idempotency records are immutable'); END;

-- Audit events are append-only and contain revisions/correlation, not secrets or raw payloads.
-- 审计事件只追加，包含修订与关联 ID，但不包含密钥或原始载荷。
CREATE TABLE audit_log (
    audit_id TEXT PRIMARY KEY NOT NULL CHECK (
        length(audit_id) = 36 AND substr(audit_id, 15, 1) = '7' AND
        substr(audit_id, 20, 1) GLOB '[89ab]' AND lower(audit_id) = audit_id
    ),
    actor_type TEXT NOT NULL CHECK (actor_type IN ('human', 'machine', 'system')),
    actor_subject TEXT NOT NULL,
    actor_roles_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(actor_roles_json) AND json_type(actor_roles_json) = 'array'),
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    before_revision INTEGER CHECK (before_revision IS NULL OR before_revision >= 1),
    after_revision INTEGER CHECK (after_revision IS NULL OR after_revision >= 1),
    correlation_id TEXT NOT NULL,
    occurred_at TEXT NOT NULL CHECK (length(occurred_at) >= 20 AND substr(occurred_at, -1) = 'Z'),
    details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json) AND json_type(details_json) = 'object')
) STRICT;

CREATE INDEX idx_audit_actor_time ON audit_log(actor_subject, occurred_at DESC);
CREATE INDEX idx_audit_target_time ON audit_log(target_type, target_id, occurred_at DESC);
CREATE INDEX idx_audit_action_time ON audit_log(action, occurred_at DESC);

CREATE TRIGGER audit_log_no_update
BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit log is immutable'); END;
CREATE TRIGGER audit_log_no_delete
BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit log is immutable'); END;

-- Transactional outbox. State is mutable, while event identity and payload are protected by a trigger.
-- 事务 outbox。投递状态可变；事件身份与载荷由触发器保护。
CREATE TABLE outbox (
    outbox_id TEXT PRIMARY KEY NOT NULL CHECK (
        length(outbox_id) = 36 AND substr(outbox_id, 15, 1) = '7' AND
        substr(outbox_id, 20, 1) GLOB '[89ab]' AND lower(outbox_id) = outbox_id
    ),
    aggregate_type TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'processing', 'delivered', 'dead')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    available_at TEXT NOT NULL CHECK (length(available_at) >= 20 AND substr(available_at, -1) = 'Z'),
    next_attempt_at TEXT NOT NULL CHECK (length(next_attempt_at) >= 20 AND substr(next_attempt_at, -1) = 'Z'),
    lease_owner TEXT,
    lease_expires_at TEXT,
    delivered_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL CHECK (length(created_at) >= 20 AND substr(created_at, -1) = 'Z'),
    CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
    CHECK ((state = 'processing') = (lease_owner IS NOT NULL)),
    CHECK ((state = 'delivered') = (delivered_at IS NOT NULL))
) STRICT;

CREATE INDEX idx_outbox_delivery ON outbox(state, next_attempt_at, created_at);

CREATE TRIGGER outbox_protect_event
BEFORE UPDATE ON outbox
WHEN NEW.outbox_id <> OLD.outbox_id OR NEW.aggregate_type <> OLD.aggregate_type OR
     NEW.aggregate_id <> OLD.aggregate_id OR NEW.event_type <> OLD.event_type OR
     NEW.schema_version <> OLD.schema_version OR NEW.payload_json <> OLD.payload_json OR
     NEW.created_at <> OLD.created_at
BEGIN SELECT RAISE(ABORT, 'outbox event identity and payload are immutable'); END;

CREATE TRIGGER outbox_validate_transition
BEFORE UPDATE OF state ON outbox
WHEN NOT (
    (OLD.state = 'pending' AND NEW.state IN ('pending', 'processing', 'dead')) OR
    (OLD.state = 'processing' AND NEW.state IN ('pending', 'processing', 'delivered', 'dead')) OR
    (OLD.state = NEW.state AND OLD.state IN ('delivered', 'dead'))
)
BEGIN SELECT RAISE(ABORT, 'invalid outbox state transition'); END;

-- Refresh planner statistics after creating schema and indexes, as recommended by D1.
-- 按 D1 建议，在创建模式和索引后刷新查询规划统计。
PRAGMA optimize;

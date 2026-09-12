-- A conservative global epoch protects complete status-evaluation snapshots from
-- concurrent input changes between planning and D1 batch commit.
-- 保守的全局纪元保护完整状态评估快照，防止规划与 D1 batch 提交之间输入并发变化。
CREATE TABLE evaluation_generation (
    singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
    generation INTEGER NOT NULL CHECK (generation >= 0)
) STRICT;

INSERT INTO evaluation_generation(singleton_id, generation) VALUES (1, 0);

CREATE TRIGGER evaluation_generation_no_delete
BEFORE DELETE ON evaluation_generation
BEGIN SELECT RAISE(ABORT, 'evaluation generation singleton cannot be deleted'); END;

CREATE TRIGGER evaluation_generation_identity
BEFORE UPDATE OF singleton_id ON evaluation_generation
WHEN NEW.singleton_id <> OLD.singleton_id
BEGIN SELECT RAISE(ABORT, 'evaluation generation singleton identity is immutable'); END;

-- Catalog facts used to resolve target ownership and supporting services.
-- 用于解析目标归属和支撑服务的目录事实。
CREATE TRIGGER evaluation_generation_services_insert AFTER INSERT ON services
BEGIN UPDATE evaluation_generation SET generation = generation + 1 WHERE singleton_id = 1; END;
CREATE TRIGGER evaluation_generation_services_delete AFTER DELETE ON services
BEGIN UPDATE evaluation_generation SET generation = generation + 1 WHERE singleton_id = 1; END;
CREATE TRIGGER evaluation_generation_services_update AFTER UPDATE OF enabled ON services
BEGIN UPDATE evaluation_generation SET generation = generation + 1 WHERE singleton_id = 1; END;

CREATE TRIGGER evaluation_generation_components_insert AFTER INSERT ON components
BEGIN UPDATE evaluation_generation SET generation = generation + 1 WHERE singleton_id = 1; END;
CREATE TRIGGER evaluation_generation_components_delete AFTER DELETE ON components
BEGIN UPDATE evaluation_generation SET generation = generation + 1 WHERE singleton_id = 1; END;
CREATE TRIGGER evaluation_generation_components_update AFTER UPDATE OF service_name, enabled ON components
BEGIN UPDATE evaluation_generation SET generation = generation + 1 WHERE singleton_id = 1; END;

CREATE TRIGGER evaluation_generation_component_services_insert AFTER INSERT ON component_services
BEGIN UPDATE evaluation_generation SET generation = generation + 1 WHERE singleton_id = 1; END;
CREATE TRIGGER evaluation_generation_component_services_delete AFTER DELETE ON component_services
BEGIN UPDATE evaluation_generation SET generation = generation + 1 WHERE singleton_id = 1; END;
CREATE TRIGGER evaluation_generation_component_services_update AFTER UPDATE OF component_id, service_name, role ON component_services
BEGIN UPDATE evaluation_generation SET generation = generation + 1 WHERE singleton_id = 1; END;

CREATE TRIGGER evaluation_generation_dependencies_insert AFTER INSERT ON service_dependencies
BEGIN UPDATE evaluation_generation SET generation = generation + 1 WHERE singleton_id = 1; END;
CREATE TRIGGER evaluation_generation_dependencies_delete AFTER DELETE ON service_dependencies
BEGIN UPDATE evaluation_generation SET generation = generation + 1 WHERE singleton_id = 1; END;
CREATE TRIGGER evaluation_generation_dependencies_update
AFTER UPDATE OF source_service, target_service, capability, kind, criticality ON service_dependencies
BEGIN UPDATE evaluation_generation SET generation = generation + 1 WHERE singleton_id = 1; END;

CREATE TRIGGER evaluation_generation_status_targets_insert AFTER INSERT ON status_targets
BEGIN UPDATE evaluation_generation SET generation = generation + 1 WHERE singleton_id = 1; END;
CREATE TRIGGER evaluation_generation_status_targets_delete AFTER DELETE ON status_targets
BEGIN UPDATE evaluation_generation SET generation = generation + 1 WHERE singleton_id = 1; END;
CREATE TRIGGER evaluation_generation_status_targets_update AFTER UPDATE OF target_type, target_id, service_name, component_id ON status_targets
BEGIN UPDATE evaluation_generation SET generation = generation + 1 WHERE singleton_id = 1; END;

-- Policy, monitor, checkpoint, Issue, maintenance and override facts are direct
-- aggregate_status inputs. Lease/schedule bookkeeping is intentionally excluded.
-- policy、monitor、checkpoint、Issue、维护和覆盖事实是 aggregate_status 的直接输入；
-- lease/schedule 账务字段被有意排除。
CREATE TRIGGER evaluation_generation_policies_insert AFTER INSERT ON evaluation_policies
BEGIN UPDATE evaluation_generation SET generation = generation + 1 WHERE singleton_id = 1; END;
CREATE TRIGGER evaluation_generation_policies_delete AFTER DELETE ON evaluation_policies
BEGIN UPDATE evaluation_generation SET generation = generation + 1 WHERE singleton_id = 1; END;

CREATE TRIGGER evaluation_generation_monitors_insert AFTER INSERT ON monitors
BEGIN UPDATE evaluation_generation SET generation = generation + 1 WHERE singleton_id = 1; END;
CREATE TRIGGER evaluation_generation_monitors_delete AFTER DELETE ON monitors
BEGIN UPDATE evaluation_generation SET generation = generation + 1 WHERE singleton_id = 1; END;
CREATE TRIGGER evaluation_generation_monitors_update
AFTER UPDATE OF target_type, target_id, probe_kind, policy_id, policy_revision, critical, enabled ON monitors
BEGIN UPDATE evaluation_generation SET generation = generation + 1 WHERE singleton_id = 1; END;

CREATE TRIGGER evaluation_generation_monitor_locations_insert AFTER INSERT ON monitor_locations
BEGIN UPDATE evaluation_generation SET generation = generation + 1 WHERE singleton_id = 1; END;
CREATE TRIGGER evaluation_generation_monitor_locations_delete AFTER DELETE ON monitor_locations
BEGIN UPDATE evaluation_generation SET generation = generation + 1 WHERE singleton_id = 1; END;
CREATE TRIGGER evaluation_generation_monitor_locations_update AFTER UPDATE OF monitor_id, location, enabled ON monitor_locations
BEGIN UPDATE evaluation_generation SET generation = generation + 1 WHERE singleton_id = 1; END;

CREATE TRIGGER evaluation_generation_checkpoints_insert AFTER INSERT ON monitor_checkpoints
BEGIN UPDATE evaluation_generation SET generation = generation + 1 WHERE singleton_id = 1; END;
CREATE TRIGGER evaluation_generation_checkpoints_delete AFTER DELETE ON monitor_checkpoints
BEGIN UPDATE evaluation_generation SET generation = generation + 1 WHERE singleton_id = 1; END;
CREATE TRIGGER evaluation_generation_checkpoints_update
AFTER UPDATE OF monitor_id, location, evaluation_status, fresh_until, policy_id, policy_revision ON monitor_checkpoints
BEGIN UPDATE evaluation_generation SET generation = generation + 1 WHERE singleton_id = 1; END;

CREATE TRIGGER evaluation_generation_issues_insert AFTER INSERT ON issues
BEGIN UPDATE evaluation_generation SET generation = generation + 1 WHERE singleton_id = 1; END;
CREATE TRIGGER evaluation_generation_issues_delete AFTER DELETE ON issues
BEGIN UPDATE evaluation_generation SET generation = generation + 1 WHERE singleton_id = 1; END;
CREATE TRIGGER evaluation_generation_issues_update
AFTER UPDATE OF service_name, fingerprint_hash, severity, state, policy_id, policy_revision ON issues
BEGIN UPDATE evaluation_generation SET generation = generation + 1 WHERE singleton_id = 1; END;

CREATE TRIGGER evaluation_generation_maintenance_insert AFTER INSERT ON maintenance_windows
BEGIN UPDATE evaluation_generation SET generation = generation + 1 WHERE singleton_id = 1; END;
CREATE TRIGGER evaluation_generation_maintenance_delete AFTER DELETE ON maintenance_windows
BEGIN UPDATE evaluation_generation SET generation = generation + 1 WHERE singleton_id = 1; END;
CREATE TRIGGER evaluation_generation_maintenance_update
AFTER UPDATE OF starts_at, ends_at, state ON maintenance_windows
BEGIN UPDATE evaluation_generation SET generation = generation + 1 WHERE singleton_id = 1; END;

CREATE TRIGGER evaluation_generation_maintenance_targets_insert AFTER INSERT ON maintenance_targets
BEGIN UPDATE evaluation_generation SET generation = generation + 1 WHERE singleton_id = 1; END;
CREATE TRIGGER evaluation_generation_maintenance_targets_delete AFTER DELETE ON maintenance_targets
BEGIN UPDATE evaluation_generation SET generation = generation + 1 WHERE singleton_id = 1; END;
CREATE TRIGGER evaluation_generation_maintenance_targets_update
AFTER UPDATE OF maintenance_id, target_type, target_id ON maintenance_targets
BEGIN UPDATE evaluation_generation SET generation = generation + 1 WHERE singleton_id = 1; END;

CREATE TRIGGER evaluation_generation_overrides_insert AFTER INSERT ON status_overrides
BEGIN UPDATE evaluation_generation SET generation = generation + 1 WHERE singleton_id = 1; END;
CREATE TRIGGER evaluation_generation_overrides_delete AFTER DELETE ON status_overrides
BEGIN UPDATE evaluation_generation SET generation = generation + 1 WHERE singleton_id = 1; END;
CREATE TRIGGER evaluation_generation_overrides_update
AFTER UPDATE OF target_type, target_id, status, starts_at, expires_at, revoked_at ON status_overrides
BEGIN UPDATE evaluation_generation SET generation = generation + 1 WHERE singleton_id = 1; END;

-- Component dependency risk reads other targets' current snapshots, so current
-- status is an input as well as this planner's output. The guard runs before the
-- planner's own write and is intentionally not repeated afterwards.
-- Component dependency risk 会读取其他目标的当前快照，因此 current status 同时是
-- 输入和输出。guard 在规划器自身写入前运行，之后有意不再重复。
CREATE TRIGGER evaluation_generation_current_status_insert AFTER INSERT ON current_statuses
BEGIN UPDATE evaluation_generation SET generation = generation + 1 WHERE singleton_id = 1; END;
CREATE TRIGGER evaluation_generation_current_status_delete AFTER DELETE ON current_statuses
BEGIN UPDATE evaluation_generation SET generation = generation + 1 WHERE singleton_id = 1; END;
CREATE TRIGGER evaluation_generation_current_status_update
AFTER UPDATE OF direct_status, dependency_risk, effective_impact, fresh_until, policy_id, policy_revision ON current_statuses
BEGIN UPDATE evaluation_generation SET generation = generation + 1 WHERE singleton_id = 1; END;

PRAGMA optimize;

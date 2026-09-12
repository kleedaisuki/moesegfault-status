-- Evolve service-only policy selection into explicit, unique selector assignments.
-- 将仅服务级策略选择演进为显式且唯一的 selector assignment。
PRAGMA defer_foreign_keys = on;

DROP TRIGGER service_diagnostic_policies_revision;

CREATE TABLE service_diagnostic_policies_v2 (
    assignment_id TEXT PRIMARY KEY NOT NULL CHECK (
        length(assignment_id) = 36 AND substr(assignment_id, 15, 1) = '7' AND
        substr(assignment_id, 20, 1) GLOB '[89ab]' AND lower(assignment_id) = assignment_id
    ),
    selector_kind TEXT NOT NULL CHECK (selector_kind IN ('monitor', 'service_kind', 'service_default')),
    monitor_id TEXT REFERENCES monitors(monitor_id),
    service_name TEXT REFERENCES services(service_name),
    diagnostic_kind TEXT,
    policy_id TEXT NOT NULL,
    policy_revision INTEGER NOT NULL,
    assigned_by TEXT NOT NULL,
    assigned_at TEXT NOT NULL CHECK (length(assigned_at) >= 20 AND substr(assigned_at, -1) = 'Z'),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    FOREIGN KEY (policy_id, policy_revision) REFERENCES evaluation_policies(policy_id, revision),
    CHECK (
        (selector_kind = 'monitor' AND monitor_id IS NOT NULL AND service_name IS NULL AND diagnostic_kind IS NULL) OR
        (selector_kind = 'service_kind' AND monitor_id IS NULL AND service_name IS NOT NULL AND diagnostic_kind IS NOT NULL) OR
        (selector_kind = 'service_default' AND monitor_id IS NULL AND service_name IS NOT NULL AND diagnostic_kind IS NULL)
    )
) STRICT;

-- Existing 0001 assignments become service defaults. The fixed UUIDv7-shaped prefix plus
-- old rowid gives every migrated row a stable identity without depending on random SQL state.
-- 现有 0001 assignment 转为服务默认值；固定 UUIDv7 外形前缀加旧 rowid 提供稳定身份。
INSERT INTO service_diagnostic_policies_v2(
    assignment_id, selector_kind, monitor_id, service_name, diagnostic_kind,
    policy_id, policy_revision, assigned_by, assigned_at, revision
)
SELECT '0199d0a8-2e12-7a59-a51e-' || printf('%012x', rowid),
       'service_default', NULL, service_name, NULL,
       policy_id, policy_revision, assigned_by, assigned_at, revision
FROM service_diagnostic_policies;

DROP TABLE service_diagnostic_policies;
ALTER TABLE service_diagnostic_policies_v2 RENAME TO service_diagnostic_policies;

-- Partial uniqueness prevents two active answers at the same selector specificity.
-- 部分唯一约束禁止同一 selector 特异度出现两个有效答案。
CREATE UNIQUE INDEX uq_diagnostic_policy_monitor
    ON service_diagnostic_policies(monitor_id)
    WHERE selector_kind = 'monitor';
CREATE UNIQUE INDEX uq_diagnostic_policy_service_kind
    ON service_diagnostic_policies(service_name, diagnostic_kind)
    WHERE selector_kind = 'service_kind';
CREATE UNIQUE INDEX uq_diagnostic_policy_service_default
    ON service_diagnostic_policies(service_name)
    WHERE selector_kind = 'service_default';

CREATE TRIGGER service_diagnostic_policies_initial_revision
BEFORE INSERT ON service_diagnostic_policies
WHEN NEW.revision <> 1
BEGIN SELECT RAISE(ABORT, 'diagnostic policy assignment must start at revision one'); END;

-- Reassignment may change the pinned policy but never the selector identity.
-- 重新分配可以改变固定策略，但绝不能改变 selector 身份。
CREATE TRIGGER service_diagnostic_policies_revision
BEFORE UPDATE ON service_diagnostic_policies
BEGIN
    SELECT (CASE WHEN NEW.revision <> OLD.revision + 1
        THEN RAISE(ABORT, 'diagnostic policy assignment revision must increase by one') END);
    SELECT (CASE WHEN NEW.assignment_id <> OLD.assignment_id OR
        NEW.selector_kind <> OLD.selector_kind OR
        NEW.monitor_id IS NOT OLD.monitor_id OR
        NEW.service_name IS NOT OLD.service_name OR
        NEW.diagnostic_kind IS NOT OLD.diagnostic_kind
        THEN RAISE(ABORT, 'diagnostic policy selector identity is immutable') END);
END;

PRAGMA defer_foreign_keys = off;
PRAGMA optimize;

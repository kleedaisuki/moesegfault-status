-- Track explicit, causally linked recovery evidence without treating it as a fault occurrence.
-- 跟踪显式且具因果关联的恢复证据，不将它计为故障 occurrence。
ALTER TABLE issues ADD COLUMN last_fault_event_id TEXT REFERENCES diagnostic_event_dedup(event_id);
ALTER TABLE issues ADD COLUMN recovery_count INTEGER NOT NULL DEFAULT 0 CHECK (recovery_count >= 0);
ALTER TABLE issues ADD COLUMN last_recovery_at TEXT CHECK (
    last_recovery_at IS NULL OR (length(last_recovery_at) >= 20 AND substr(last_recovery_at, -1) = 'Z')
);

CREATE INDEX idx_issues_last_fault_event ON issues(last_fault_event_id);

PRAGMA optimize;

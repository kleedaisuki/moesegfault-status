-- Let bounded occurrence summaries expire without deleting permanent Issue evidence provenance.
-- 允许有界 occurrence 摘要到期，同时保留永久 Issue evidence 来源关系。
PRAGMA defer_foreign_keys = on;

DROP TRIGGER issue_telemetry_references_validate;
DROP TRIGGER issue_telemetry_references_no_update;
DROP TRIGGER issue_telemetry_references_no_delete;

CREATE TABLE issue_telemetry_references_v2 (
    issue_id TEXT NOT NULL REFERENCES issues(issue_id),
    telemetry_reference_id TEXT NOT NULL REFERENCES telemetry_references(telemetry_reference_id),
    occurrence_id TEXT REFERENCES issue_occurrences(occurrence_id) ON DELETE SET NULL,
    linked_at TEXT NOT NULL CHECK (length(linked_at) >= 20 AND substr(linked_at, -1) = 'Z'),
    PRIMARY KEY (issue_id, telemetry_reference_id)
) STRICT;

INSERT INTO issue_telemetry_references_v2(
    issue_id, telemetry_reference_id, occurrence_id, linked_at
)
SELECT issue_id, telemetry_reference_id, occurrence_id, linked_at
FROM issue_telemetry_references;

DROP TABLE issue_telemetry_references;
ALTER TABLE issue_telemetry_references_v2 RENAME TO issue_telemetry_references;

CREATE INDEX idx_issue_telemetry_occurrence
    ON issue_telemetry_references(occurrence_id);

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

-- The only legal update is SQLite's FK action detaching an expiring occurrence.
-- 唯一允许的更新是 SQLite 外键动作解绑到期 occurrence。
CREATE TRIGGER issue_telemetry_references_no_update
BEFORE UPDATE ON issue_telemetry_references
WHEN NOT (
    OLD.occurrence_id IS NOT NULL AND NEW.occurrence_id IS NULL AND
    NEW.issue_id = OLD.issue_id AND
    NEW.telemetry_reference_id = OLD.telemetry_reference_id AND
    NEW.linked_at = OLD.linked_at
)
BEGIN SELECT RAISE(ABORT, 'issue evidence links are immutable except occurrence retention detach'); END;

CREATE TRIGGER issue_telemetry_references_no_delete
BEFORE DELETE ON issue_telemetry_references
BEGIN SELECT RAISE(ABORT, 'issue evidence links are immutable'); END;

PRAGMA defer_foreign_keys = off;
PRAGMA optimize;

-- Allow one immutable R2 object to be referenced by multiple sessions and deployments.
-- 允许多个上传会话及部署引用同一个不可变 R2 对象。
--
-- D1 enforces foreign keys during migrations. Rebuilding both related tables under
-- deferred validation preserves existing rows and validates the final graph atomically.
-- D1 会在迁移中强制外键。延迟校验后重建两张关联表，可原子保留旧行并验证最终关系图。
PRAGMA defer_foreign_keys = on;

DROP TRIGGER deployment_artifacts_match_upload;
DROP TRIGGER deployment_artifacts_no_update;
DROP TRIGGER deployment_artifacts_no_delete;
DROP TRIGGER artifact_upload_sessions_no_update;
DROP TRIGGER artifact_upload_sessions_no_delete;

-- Session renewal may reuse a content-addressed key; idempotency remains scoped to a deployment.
-- 会话续签可以复用内容寻址键；幂等性仍限定在单个部署内。
CREATE TABLE artifact_upload_sessions_v2 (
    upload_id TEXT PRIMARY KEY NOT NULL CHECK (
        length(upload_id) = 36 AND substr(upload_id, 15, 1) = '7' AND
        substr(upload_id, 20, 1) GLOB '[89ab]' AND lower(upload_id) = upload_id
    ),
    deployment_id TEXT NOT NULL REFERENCES deployments(deployment_id),
    idempotency_key TEXT NOT NULL,
    request_digest TEXT NOT NULL CHECK (
        length(request_digest) = 71 AND substr(request_digest, 1, 7) = 'sha256:' AND
        substr(request_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    object_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('manifest', 'binary', 'debug_symbols', 'source_map', 'sbom', 'other')),
    file_name TEXT NOT NULL,
    media_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
    artifact_digest TEXT NOT NULL CHECK (
        length(artifact_digest) = 71 AND substr(artifact_digest, 1, 7) = 'sha256:' AND
        substr(artifact_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    build_id TEXT,
    expires_at TEXT NOT NULL CHECK (length(expires_at) >= 20 AND substr(expires_at, -1) = 'Z'),
    created_at TEXT NOT NULL CHECK (length(created_at) >= 20 AND substr(created_at, -1) = 'Z'),
    created_by TEXT NOT NULL,
    UNIQUE (deployment_id, idempotency_key),
    CHECK (expires_at > created_at)
) STRICT;

INSERT INTO artifact_upload_sessions_v2(
    upload_id, deployment_id, idempotency_key, request_digest, object_key,
    kind, file_name, media_type, size_bytes, artifact_digest, build_id,
    expires_at, created_at, created_by
)
SELECT upload_id, deployment_id, idempotency_key, request_digest, object_key,
       kind, file_name, media_type, size_bytes, artifact_digest, build_id,
       expires_at, created_at, created_by
FROM artifact_upload_sessions;

-- Artifact identity is its declaration inside a deployment, not its content digest or R2 key.
-- Artifact 身份是部署内的声明位置，而不是内容摘要或 R2 键。
CREATE TABLE deployment_artifacts_v2 (
    artifact_id TEXT PRIMARY KEY NOT NULL CHECK (
        length(artifact_id) = 36 AND substr(artifact_id, 15, 1) = '7' AND
        substr(artifact_id, 20, 1) GLOB '[89ab]' AND lower(artifact_id) = artifact_id
    ),
    deployment_id TEXT NOT NULL REFERENCES deployments(deployment_id),
    upload_id TEXT UNIQUE REFERENCES artifact_upload_sessions_v2(upload_id),
    kind TEXT NOT NULL CHECK (kind IN ('manifest', 'binary', 'debug_symbols', 'source_map', 'sbom', 'other')),
    file_name TEXT NOT NULL,
    object_key TEXT NOT NULL,
    media_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
    artifact_digest TEXT NOT NULL CHECK (
        length(artifact_digest) = 71 AND substr(artifact_digest, 1, 7) = 'sha256:' AND
        substr(artifact_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    build_id TEXT,
    bundle_path TEXT,
    created_at TEXT NOT NULL CHECK (length(created_at) >= 20 AND substr(created_at, -1) = 'Z'),
    UNIQUE (deployment_id, kind, file_name)
) STRICT;

INSERT INTO deployment_artifacts_v2(
    artifact_id, deployment_id, upload_id, kind, file_name, object_key,
    media_type, size_bytes, artifact_digest, build_id, bundle_path, created_at
)
SELECT artifact_id, deployment_id, upload_id, kind, file_name, object_key,
       media_type, size_bytes, artifact_digest, build_id, bundle_path, created_at
FROM deployment_artifacts;

DROP TABLE deployment_artifacts;
DROP TABLE artifact_upload_sessions;

ALTER TABLE artifact_upload_sessions_v2 RENAME TO artifact_upload_sessions;
ALTER TABLE deployment_artifacts_v2 RENAME TO deployment_artifacts;

-- Non-unique lookup indexes retain efficient reverse lookup without forbidding reuse.
-- 非唯一查询索引保留高效反向查询，同时不再禁止复用。
CREATE INDEX idx_artifact_upload_sessions_object_key
    ON artifact_upload_sessions(object_key);
CREATE INDEX idx_deployment_artifacts_object_key
    ON deployment_artifacts(object_key);
CREATE INDEX idx_deployment_artifacts_digest_build
    ON deployment_artifacts(artifact_digest, build_id);

CREATE TRIGGER artifact_upload_sessions_no_update
BEFORE UPDATE ON artifact_upload_sessions
BEGIN SELECT RAISE(ABORT, 'artifact upload sessions are immutable'); END;
CREATE TRIGGER artifact_upload_sessions_no_delete
BEFORE DELETE ON artifact_upload_sessions
BEGIN SELECT RAISE(ABORT, 'artifact upload sessions are immutable'); END;

-- A committed artifact must repeat exactly the expectations of its immutable upload session.
-- 已提交 artifact 必须精确重复其不可变上传会话中的期望。
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

CREATE TRIGGER deployment_artifacts_no_update
BEFORE UPDATE ON deployment_artifacts
BEGIN SELECT RAISE(ABORT, 'deployment artifacts are immutable'); END;
CREATE TRIGGER deployment_artifacts_no_delete
BEFORE DELETE ON deployment_artifacts
BEGIN SELECT RAISE(ABORT, 'deployment artifacts are immutable'); END;

PRAGMA defer_foreign_keys = off;
PRAGMA optimize;

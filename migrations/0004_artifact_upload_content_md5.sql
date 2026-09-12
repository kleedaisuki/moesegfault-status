-- Bind every new signed upload session to the R2 Content-MD5 transport check.
-- 将每个新签名上传会话绑定到 R2 Content-MD5 传输校验。
--
-- Legacy sessions remain NULL because their checksum cannot be reconstructed honestly.
-- The insert trigger rejects NULL for all new sessions; clients renew an expired/legacy
-- session against the same expected SHA-256 and object key. Existing committed artifacts
-- remain valid and are not rewritten or re-verified retroactively.
-- 旧会话保持 NULL，因为无法诚实重建其校验值。insert trigger 拒绝新会话写 NULL；
-- 客户端以相同预期 SHA-256 与对象键续建会话。已提交 artifact 保持有效，不追溯改写。
ALTER TABLE artifact_upload_sessions
ADD COLUMN content_md5 TEXT CHECK (
    content_md5 IS NULL OR (
        length(content_md5) = 24 AND substr(content_md5, 23, 2) = '==' AND
        substr(content_md5, 1, 22) NOT GLOB '*[^A-Za-z0-9+/]*'
    )
);

CREATE TRIGGER artifact_upload_sessions_require_content_md5
BEFORE INSERT ON artifact_upload_sessions
WHEN NEW.content_md5 IS NULL
BEGIN SELECT RAISE(ABORT, 'new artifact upload session requires content_md5'); END;

-- A legacy outstanding session cannot authorize a new commit. It must be renewed first.
-- 尚未提交的旧会话不能授权新 commit，必须先续建会话。
DROP TRIGGER deployment_artifacts_match_upload;
CREATE TRIGGER deployment_artifacts_match_upload
BEFORE INSERT ON deployment_artifacts
WHEN NEW.upload_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM artifact_upload_sessions AS s
    WHERE s.upload_id = NEW.upload_id AND s.deployment_id = NEW.deployment_id
      AND s.content_md5 IS NOT NULL
      AND s.kind = NEW.kind AND s.file_name = NEW.file_name
      AND s.object_key = NEW.object_key AND s.media_type = NEW.media_type
      AND s.size_bytes = NEW.size_bytes AND s.artifact_digest = NEW.artifact_digest
      AND s.build_id IS NEW.build_id
)
BEGIN SELECT RAISE(ABORT, 'artifact does not match a checksummed upload session'); END;

PRAGMA optimize;

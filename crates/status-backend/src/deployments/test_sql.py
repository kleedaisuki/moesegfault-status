"""在真实 SQLite 上运行 Rust 源码 SQL。 / Execute Rust source SQL against real SQLite."""
from pathlib import Path
import re
import sys
import unittest
ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "tests" / "database"))
from test_schema import SchemaTestCase, uuid7, NOW, LATER
SOURCE = Path(__file__).with_name("platform.rs").read_text(encoding="utf-8")


def sql(prefix):
    """提取生产 SQL 而不是复制实现。 / Extract production SQL rather than duplicate implementation."""
    return next(query for query in re.findall(r'Query::new\(\s*"([^"]+)"', SOURCE) if query.startswith(prefix))


class DeploymentSqlTests(SchemaTestCase):
    """验证真实约束和清理/提交竞争。 / Verify real constraints and cleanup/commit races."""
    def setUp(self):
        """创建真实来源与会话。 / Create real provenance and session fixtures."""
        super().setUp()
        self.add_service("status-api")
        self.deployment = self.add_deployment("status-api", 1)
        self.key = "observability/artifacts/sha256/44/" + "4" * 64 + "/map"
        self.add_upload_session(uuid7(2), self.deployment, "stable-key", self.key)
        self.params = (uuid7(3), self.deployment, uuid7(2), "source_map", self.key,
                       "app.js.map", "application/json", 128, "sha256:" + "4" * 64,
                       None, "app.js", NOW, self.deployment)

    def test_every_production_query_prepares_against_migrated_schema(self):
        """编译全部生产 SQL，捕获表列名和参数语法漂移。 / Compile all production SQL to catch schema/syntax drift."""
        queries = re.findall(r'Query::new\(\s*"([^"]+)"', SOURCE)
        self.assertGreaterEqual(len(queries), 15)
        for statement in queries:
            self.db.execute("EXPLAIN " + statement, [None] * statement.count("?"))
    def test_production_insert_preserves_immutable_session(self):
        """真实会话完全匹配才允许commit。 / Commit requires an exact real session match."""
        statement = sql("INSERT INTO deployment_artifacts")
        invalid = list(self.params)
        invalid[8] = "sha256:" + "5" * 64
        with self.assertRaises(Exception):
            self.db.execute(statement, invalid)
        self.db.execute(statement, self.params)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM deployment_artifacts").fetchone()[0], 1)
        with self.assertRaises(Exception):
            self.db.execute("UPDATE deployment_artifacts SET size_bytes=1")

    def test_retirement_race_prevents_commit_and_allows_cleanup(self):
        """即使请求已通过早期授权，终止后的SQL禁止提交。 / SQL rejects commits even after earlier authorization."""
        self.db.execute("INSERT INTO deployment_status_history(deployment_id,sequence,state,actor_subject,occurred_at) VALUES (?,2,'retired','admin',?)", (self.deployment, NOW))
        self.db.execute(sql("INSERT INTO deployment_artifacts"), self.params)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM deployment_artifacts").fetchone()[0], 0)
        candidates = self.db.execute(sql("SELECT DISTINCT s.object_key"), ("2026-09-14T00:00:00.000Z",)).fetchall()
        self.assertEqual([r[0] for r in candidates], [self.key])

    def test_cleanup_tombstone_makes_bounded_batches_progress(self):
        """已删除对象墓碑防止前100条永久阻塞后续批次。 / Purge tombstones prevent the first 100 rows from starving later batches."""
        self.db.execute("INSERT INTO deployment_status_history(deployment_id,sequence,state,actor_subject,occurred_at) VALUES (?,2,'retired','admin',?)", (self.deployment, NOW))
        self.db.execute(sql("INSERT INTO audit_log(audit_id,actor_type,actor_subject,actor_roles_json,action,target_type,target_id,correlation_id,occurred_at,details_json) VALUES(?,'system'"), (uuid7(10), self.key, uuid7(11), NOW))
        self.assertEqual(self.db.execute(sql("SELECT DISTINCT s.object_key"), ("2026-09-14T00:00:00.000Z",)).fetchall(), [])

    def test_cleanup_waits_for_latest_renewed_session(self):
        """较旧的过期会话不能删除仍有有效签名的同键对象。 / An older expired session cannot purge a key with a still-valid renewed signature."""
        self.db.execute("INSERT INTO artifact_upload_sessions(upload_id,deployment_id,idempotency_key,request_digest,object_key,kind,file_name,media_type,size_bytes,artifact_digest,content_md5,build_id,expires_at,created_at,created_by) SELECT ?,deployment_id,'renewed-key',request_digest,object_key,kind,file_name,media_type,size_bytes,artifact_digest,content_md5,build_id,'2026-09-20T00:00:00.000Z',created_at,created_by FROM artifact_upload_sessions WHERE upload_id=?", (uuid7(12), uuid7(2)))
        self.db.execute("INSERT INTO deployment_status_history(deployment_id,sequence,state,actor_subject,occurred_at) VALUES (?,2,'retired','admin',?)", (self.deployment, NOW))
        self.assertEqual(self.db.execute(sql("SELECT DISTINCT s.object_key"), ("2026-09-14T00:00:00.000Z",)).fetchall(), [])
    def test_committed_objects_never_enter_cleanup(self):
        """终止部署的已登记证据仍永久保留。 / Registered evidence survives deployment retirement."""
        self.db.execute(sql("INSERT INTO deployment_artifacts"), self.params)
        self.db.execute("INSERT INTO deployment_status_history(deployment_id,sequence,state,actor_subject,occurred_at) VALUES (?,2,'retired','admin',?)", (self.deployment, NOW))
        self.assertEqual(self.db.execute(sql("SELECT DISTINCT s.object_key"), ("2026-09-14T00:00:00.000Z",)).fetchall(), [])

if __name__ == "__main__":
    unittest.main()

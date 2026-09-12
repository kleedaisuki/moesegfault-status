"""验证真实迁移上的管理事务边界。 / Verify command transaction boundaries on real migrations."""
import pathlib
import sqlite3
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[6]
NOW = "2026-09-12T00:00:00.000Z"
ID = "01993cb0-0000-7000-8000-000000000001"


class TransactionTests(unittest.TestCase):
    """失败回滚与只追加边界。 / Rollback and append-only boundaries."""

    def setUp(self):
        """加载全部当前迁移。 / Load every current migration."""
        self.db = sqlite3.connect(":memory:")
        self.db.execute("PRAGMA foreign_keys=ON")
        for path in sorted((ROOT / "migrations").glob("*.sql")):
            self.db.executescript(path.read_text(encoding="utf-8-sig"))
        self.db.execute("INSERT INTO services VALUES ('api','API','','owner','high',1,?,?,1)", (NOW, NOW))
        self.db.commit()

    def tearDown(self):
        """关闭测试数据库。 / Close the test database."""
        self.db.close()

    def test_occ_assert_rolls_back_prior_and_following_writes(self):
        """零行不是成功；任何既有变更也必须回滚。 / Zero changes abort prior writes too."""
        with self.assertRaises(sqlite3.OperationalError):
            with self.db:
                self.db.execute("UPDATE services SET revision=revision+1,display_name='Changed' WHERE service_name='api' AND revision=1")
                self.db.execute("UPDATE services SET revision=revision+1 WHERE service_name='api' AND revision=1")
                self.db.execute("SELECT CASE WHEN changes()=1 THEN 1 ELSE json('occ-conflict') END AS ok").fetchall()
        self.assertEqual(self.db.execute("SELECT revision,display_name FROM services").fetchone(), (1, "API"))

    def test_common_sql_prepares_against_schema(self):
        """解析协调器真实 SQL，不维护测试副本。 / Prepare actual coordinator SQL, not copies."""
        import re
        source = (ROOT / "crates/status-backend/src/admin/mutations/mod.rs").read_text(encoding="utf-8-sig")
        queries = re.findall(r'query\("([^"\\]+)"', source)
        self.assertGreaterEqual(len(queries), 3)
        for sql in queries:
            self.db.execute("EXPLAIN " + sql, [None] * sql.count("?"))

    def test_success_replay_and_audit_are_immutable(self):
        """相同响应持久化；审计与幂等不允许覆盖。 / Persist exact response and forbid overwrites."""
        with self.db:
            self.db.execute("INSERT INTO audit_log(audit_id,actor_type,actor_subject,action,target_type,target_id,correlation_id,occurred_at) VALUES (?,'human','operator','service.updated','service','api',?,?)", (ID, ID, NOW))
            self.db.execute("INSERT INTO idempotency_keys VALUES ('updateServiceCatalog',?,?,'service','api',200,?,?,strftime('%Y-%m-%dT%H:%M:%fZ',?,'+7 days'))", (ID, "sha256:" + "0" * 64, '{"revision":2}', NOW, NOW))
        for sql in ["UPDATE audit_log SET action='other'", "DELETE FROM audit_log", "UPDATE idempotency_keys SET response_json='{}'"]:
            with self.assertRaises(sqlite3.IntegrityError):
                self.db.execute(sql)
        self.assertEqual(self.db.execute("SELECT response_json FROM idempotency_keys").fetchone()[0], '{"revision":2}')


if __name__ == "__main__":
    unittest.main()

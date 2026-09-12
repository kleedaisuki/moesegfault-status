"""校验 Rust 管理策略 SQL 的真实迁移兼容与事务约束。
Verify Rust policy SQL against real migrations and transaction invariants.

Run from any directory: python crates/status-backend/src/admin/mutations/native/policies_sql.py
This exercises extracted SQL, not Rust planning or the remote D1 platform.
本脚本执行提取的 SQL，不替代 Rust 计划器或远程 D1 集成测试。
"""
from pathlib import Path
import re
import sqlite3
import unittest

ROOT = Path(__file__).resolve().parents[6]
SOURCE = ROOT / "crates/status-backend/src/admin/mutations/policies.rs"
TIME = "2026-09-12T00:00:00.000Z"
POLICY = "0199d0a8-2e12-7a59-a51e-000000000001"
OLD = "0199d0a8-2e12-7a59-a51e-000000000002"
NEW = "0199d0a8-2e12-7a59-a51e-000000000003"
ASSIGNMENT = "0199d0a8-2e12-7a59-a51e-000000000004"


def statements():
    """提取实际源代码 SQL，防止验证副本与实现漂移。 / Extract production SQL to avoid copy drift."""
    return re.findall(r'(?:query|row|guard)\(\s*(?:db,\s*)?"([^"\n]+)"', SOURCE.read_text(encoding="utf-8"))


def sql(prefix):
    """唯一定位一条源 SQL。 / Locate exactly one source SQL statement."""
    matches = [s for s in statements() if s.startswith(prefix)]
    if len(matches) != 1:
        raise AssertionError((prefix, matches))
    return matches[0]


def changed(db):
    """使用协调器相同的 CAS 断言。 / Use the coordinator's CAS assertion."""
    db.execute("SELECT CASE WHEN changes()=1 THEN 1 ELSE json('occ-conflict') END").fetchone()


class PolicySQL(unittest.TestCase):
    """每个测试隔离全部生产迁移。 / Isolate the complete production schema per test."""

    def setUp(self):
        """启用外键并建立服务 fixture。 / Enable foreign keys and seed a service fixture."""
        self.db = sqlite3.connect(":memory:")
        for migration in sorted((ROOT / "migrations").glob("*.sql")):
            self.db.executescript(migration.read_text(encoding="utf-8-sig"))
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.execute("INSERT INTO services(service_name,display_name,owner,criticality,created_at,updated_at) VALUES ('api','API','team','high',?,?)", (TIME, TIME))
        self.db.commit()

    def tearDown(self):
        """释放隔离数据库。 / Release the isolated database."""
        self.db.close()

    def test_all_extracted_sql_prepares(self):
        """所有静态 SQL 与 guard 均可编译。 / Prepare all static SQL and guards."""
        count = 0
        for statement in statements():
            if statement.startswith(("EXISTS", "NOT EXISTS")):
                statement = f"SELECT CASE WHEN {statement} THEN 1 ELSE json('invalid') END"
            self.db.execute("EXPLAIN " + statement, [None] * statement.count("?"))
            count += 1
        self.assertGreaterEqual(count, 21)
        print(f"Prepared {count} extracted SQL statements")

    def register_evaluation(self):
        """登记策略的真实 INSERT。 / Execute the actual evaluation-policy INSERT."""
        self.db.execute(sql("INSERT INTO evaluation_policies"), (POLICY, 1, "policy@1", 60, 2, 0.5, 0.25, None, 120, 1, '{"fields":["operation"]}', '{"failure":"degraded"}', '{"contract":{}}', "admin", TIME))

    def test_evaluation_backend_and_assignment_success(self):
        """三种操作成功路径与绑定更新。 / Three successful operations plus assignment update."""
        with self.db:
            self.register_evaluation()
            self.db.execute(sql("INSERT INTO telemetry_backends"), ("tempo", '["trace"]', "tempo", "https://example.com/trace/{id}", "standard", "TEMPO_TOKEN", TIME, TIME))
            self.db.execute(sql("INSERT INTO service_diagnostic_policies"), (ASSIGNMENT, "service_default", None, "api", None, POLICY, 1, "admin", TIME))
            changed(self.db)
            self.db.execute(sql("UPDATE service_diagnostic_policies"), (POLICY, 1, "admin", TIME, ASSIGNMENT, 1))
            changed(self.db)
        self.assertEqual(self.db.execute("SELECT revision FROM service_diagnostic_policies").fetchone(), (2,))
        self.assertEqual(self.db.execute("SELECT count(*) FROM telemetry_backends").fetchone(), (1,))

    def retention(self, revision, expected=None):
        """按生产顺序登记并绑定保留策略。 / Register and assign retention in production order."""
        self.db.execute(sql("INSERT INTO data_retention_policies"), ("standard", revision, 30, 100, "admin", TIME))
        self.db.execute(sql("INSERT INTO audit_log"), (f"0199d0a8-2e12-7a59-a51e-{revision:012d}", "admin", '["admin"]', f"standard:{revision}", revision, POLICY, TIME, '{}'))
        if expected is None:
            self.db.execute(sql("INSERT INTO service_retention_policies"), ("api", "standard", revision, "admin", TIME))
        else:
            self.db.execute(sql("UPDATE service_retention_policies"), ("standard", revision, "admin", TIME, "api", expected))
        changed(self.db)

    def test_retention_success_and_stale_cas_rollback(self):
        """旧 CAS 必须回滚策略登记和审计。 / Stale CAS rolls back registration and audit."""
        with self.db:
            self.retention(1)
        with self.db:
            self.retention(2, 1)
        with self.assertRaises(sqlite3.DatabaseError):
            with self.db:
                self.retention(3, 1)
        self.assertEqual(self.db.execute("SELECT policy_revision,revision FROM service_retention_policies").fetchone(), (2, 2))
        self.assertEqual(self.db.execute("SELECT count(*) FROM data_retention_policies").fetchone(), (2,))
        self.assertEqual(self.db.execute("SELECT count(*) FROM audit_log").fetchone(), (2,))

    def seed_deployment(self, did):
        """准备合法 ready deployment。 / Seed a valid ready deployment."""
        self.db.execute("INSERT INTO deployments(deployment_id,service_name,environment,service_version,repository_url,git_commit,git_ref,artifact_digest,ci_provider,ci_run_id,deployed_at,manifest_object_key,manifest_digest,manifest_schema_version,registered_at,registered_by) VALUES (?,'api','production','1','https://example.com/repo',?,'main',?,'ci','run',?,?,?,'1.0',?,'admin')", (did, "a" * 40, "sha256:" + "a" * 64, TIME, did, "sha256:" + "b" * 64, TIME))
        for sequence, state in enumerate(("registered", "ready"), 1):
            self.db.execute("INSERT INTO deployment_status_history(deployment_id,sequence,state,actor_subject,occurred_at) VALUES (?,?,?,'admin',?)", (did, sequence, state, TIME))

    def activate(self, did, pointer_revision=None, previous=None):
        """运行追加历史和指针 CAS 的生产 SQL。 / Execute production history append and pointer CAS SQL."""
        if previous:
            self.db.execute(sql("INSERT INTO deployment_status_history (deployment_id,sequence,state,reason,actor_subject,correlation_id,occurred_at) VALUES (?,?,'retired'"), (previous, 4, "superseded", "admin", POLICY, TIME))
        self.db.execute(sql("INSERT INTO deployment_status_history (deployment_id,sequence,state,reason,actor_subject,correlation_id,occurred_at) VALUES (?,?,'active'"), (did, 3, "activate", "admin", POLICY, TIME))
        if pointer_revision is None:
            self.db.execute(sql("INSERT INTO service_environment_deployments"), ("api", "production", did, TIME))
        else:
            self.db.execute(sql("UPDATE service_environment_deployments"), (did, TIME, "api", "production", pointer_revision))
        changed(self.db)

    def test_activation_atomic_history_pointer(self):
        """失败指针 CAS 不得留下 active/retired 历史。 / Failed pointer CAS leaves no active/retired history."""
        with self.db:
            self.seed_deployment(OLD)
            self.seed_deployment(NEW)
            self.activate(OLD)
        with self.assertRaises(sqlite3.DatabaseError):
            with self.db:
                self.activate(NEW, 9, OLD)
        self.assertEqual(dict(self.db.execute("SELECT deployment_id,state FROM deployment_current_status")), {OLD: "active", NEW: "ready"})
        self.assertEqual(self.db.execute("SELECT deployment_id,revision FROM service_environment_deployments").fetchone(), (OLD, 1))
        with self.db:
            self.activate(NEW, 1, OLD)
        self.assertEqual(dict(self.db.execute("SELECT deployment_id,state FROM deployment_current_status")), {OLD: "retired", NEW: "active"})
        self.assertEqual(self.db.execute("SELECT deployment_id,revision FROM service_environment_deployments").fetchone(), (NEW, 2))
        self.assertEqual(self.db.execute("PRAGMA foreign_key_check").fetchall(), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)

"""验证 D1 初始模式的结构、约束和事务语义。 / Validate the initial D1 schema, constraints, and transactions."""

from __future__ import annotations

import sqlite3
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / "migrations" / "0001_initial.sql"
NOW = "2026-09-12T08:00:00.000Z"
LATER = "2026-09-13T08:00:00.000Z"


def uuid7(serial: int) -> str:
    """生成确定性的测试 UUIDv7。 / Return a deterministic UUIDv7 fixture."""

    return f"0199d0a8-2e12-7a59-a51e-{serial:012x}"


class SchemaTestCase(unittest.TestCase):
    """提供隔离的内存 SQLite 数据库。 / Provide an isolated in-memory SQLite database."""

    def setUp(self) -> None:
        """应用迁移并启用与 D1 等价的外键检查。 / Apply the migration with D1-equivalent foreign keys."""

        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.executescript(MIGRATION.read_text(encoding="utf-8"))

    def tearDown(self) -> None:
        """关闭测试连接。 / Close the test connection."""

        self.db.close()

    def add_service(self, name: str) -> None:
        """插入最小服务目录记录。 / Insert a minimal service catalog record."""

        self.db.execute(
            """
            INSERT INTO services(
                service_name, display_name, owner, criticality, created_at, updated_at
            ) VALUES (?, ?, 'platform', 'high', ?, ?)
            """,
            (name, name.title(), NOW, NOW),
        )

    def add_policy(self, policy_id: str = "default", revision: int = 1) -> None:
        """插入不可变评估策略。 / Insert an immutable evaluation policy."""

        self.db.execute(
            """
            INSERT INTO evaluation_policies(
                policy_id, revision, schema_version, name, observation_window_seconds,
                minimum_samples, failure_threshold, recovery_threshold,
                latency_threshold_ms, stale_after_seconds, location_quorum,
                fingerprint_template_json, status_mapping_json, diagnostic_rules_json,
                created_by, created_at
            ) VALUES (?, ?, '1.0', 'Default', 300, 3, 0.5, 0.9, 500,
                      120, 1, '{}', '{}',
                      '{"confirmation_min_occurrences":2,"severity_status":{}}',
                      'system', ?)
            """,
            (policy_id, revision, NOW),
        )

    def add_retention_policy(self) -> None:
        """插入 occurrence 保留策略。 / Insert an occurrence retention policy."""

        self.db.execute(
            """
            INSERT INTO data_retention_policies(
                policy_id, revision, occurrence_retention_days, cleanup_batch_size,
                created_by, created_at
            ) VALUES ('standard', 1, 30, 100, 'system', ?)
            """,
            (NOW,),
        )

    def add_deployment(
        self,
        service: str,
        serial: int,
        environment: str = "production",
        artifact_hex: str = "a",
    ) -> str:
        """插入不可变部署及初始状态。 / Insert an immutable deployment and its initial status."""

        deployment_id = uuid7(serial)
        self.db.execute(
            """
            INSERT INTO deployments(
                deployment_id, service_name, environment, service_version,
                repository_url, git_commit, git_ref, artifact_digest, ci_provider,
                ci_run_id, deployed_at, manifest_object_key, manifest_digest,
                manifest_schema_version, registered_at, registered_by
            ) VALUES (?, ?, ?, '1.0.0', 'https://github.com/example/repo', ?,
                      'refs/heads/main', ?, 'github-actions', '42', ?, ?, ?,
                      '1.0', ?, 'ci')
            """,
            (
                deployment_id,
                service,
                environment,
                "c" * 40,
                "sha256:" + artifact_hex * 64,
                NOW,
                f"observability/manifests/{deployment_id}.json",
                "sha256:" + "b" * 64,
                NOW,
            ),
        )
        self.db.execute(
            """
            INSERT INTO deployment_status_history(
                deployment_id, sequence, state, actor_subject, occurred_at
            ) VALUES (?, 1, 'registered', 'ci', ?)
            """,
            (deployment_id, NOW),
        )
        return deployment_id

    def add_issue(
        self,
        issue_id: str,
        service: str,
        fingerprint: str = "d" * 64,
        recurrence_of: str | None = None,
    ) -> None:
        """插入 observed Issue。 / Insert an observed Issue."""

        self.db.execute(
            """
            INSERT INTO issues(
                issue_id, recurrence_of_issue_id, fingerprint_hash, service_name,
                kind, severity, state, first_seen_at, last_seen_at,
                policy_id, policy_revision
            ) VALUES (?, ?, ?, ?, 'dependency.unavailable', 'error', 'observed',
                      ?, ?, 'default', 1)
            """,
            (issue_id, recurrence_of, fingerprint, service, NOW, NOW),
        )


class SchemaStructureTests(SchemaTestCase):
    """验证模式对象、STRICT 类型和目录关系。 / Validate schema objects, STRICT typing, and catalog relations."""

    def test_expected_tables_views_and_partial_index_exist(self) -> None:
        """核心表、派生视图和部分唯一索引必须存在。 / Core tables, derived views, and the partial unique index must exist."""

        objects = {
            row["name"]: row["type"]
            for row in self.db.execute(
                "SELECT name, type FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'"
            )
        }
        for table in (
            "services",
            "status_targets",
            "evaluation_policies",
            "monitors",
            "current_statuses",
            "deployments",
            "diagnostic_event_dedup",
            "issues",
            "issue_occurrences",
            "incidents",
            "incident_updates",
            "maintenance_windows",
            "telemetry_references",
            "audit_log",
            "outbox",
        ):
            self.assertEqual(objects.get(table), "table", table)
        self.assertEqual(objects.get("incident_current"), "view")
        self.assertEqual(objects.get("incident_issues"), "view")
        index_sql = self.db.execute(
            "SELECT sql FROM sqlite_schema WHERE name='uq_issues_unresolved_fingerprint'"
        ).fetchone()[0]
        self.assertIn("WHERE state <> 'resolved'", index_sql)
        checkpoint_columns = {
            row["name"] for row in self.db.execute("PRAGMA table_info(monitor_checkpoints)")
        }
        self.assertIn("window_unhealthy_samples", checkpoint_columns)
        self.assertNotIn("window_failures", checkpoint_columns)
        self.assertEqual(self.db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_strict_booleans_and_enums_reject_invalid_values(self) -> None:
        """STRICT 表与 CHECK 必须拒绝类型漂移和非法枚举。 / STRICT tables and CHECKs must reject drift and bad enums."""

        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                """
                INSERT INTO services(
                    service_name, display_name, owner, criticality, enabled,
                    created_at, updated_at
                ) VALUES ('bad', 'Bad', 'ops', 'urgent', 1, ?, ?)
                """,
                (NOW, NOW),
            )
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                """
                INSERT INTO services(
                    service_name, display_name, owner, criticality, enabled,
                    created_at, updated_at
                ) VALUES ('bad-bool', 'Bad', 'ops', 'high', 'yes', ?, ?)
                """,
                (NOW, NOW),
            )

    def test_catalog_triggers_create_typed_status_targets(self) -> None:
        """服务和组件插入必须创建受外键保护的多态目标。 / Service and component inserts must create FK-backed targets."""

        self.add_service("identity")
        self.db.execute(
            """
            INSERT INTO components(
                component_id, service_name, display_name, created_at, updated_at
            ) VALUES ('login', 'identity', 'Login', ?, ?)
            """,
            (NOW, NOW),
        )
        targets = self.db.execute(
            "SELECT target_type, target_id FROM status_targets ORDER BY target_type"
        ).fetchall()
        self.assertEqual(
            [(row["target_type"], row["target_id"]) for row in targets],
            [("component", "login"), ("service", "identity")],
        )
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                """
                INSERT INTO current_statuses(
                    target_type, target_id, direct_status, effective_impact,
                    evaluated_at, fresh_until
                ) VALUES ('service', 'missing', 'unknown', 'unknown', ?, ?)
                """,
                (NOW, LATER),
            )


class ProvenanceAndPolicyTests(SchemaTestCase):
    """验证策略不可变性与 deployment/service 来源一致性。 / Validate policy immutability and deployment/service provenance."""

    def setUp(self) -> None:
        """创建两个服务、策略和一个部署。 / Create two services, a policy, and one deployment."""

        super().setUp()
        self.add_service("identity")
        self.add_service("gateway")
        self.add_policy()
        self.deployment_id = self.add_deployment("identity", 1)

    def test_policy_revision_is_immutable_and_selection_is_explicit(self) -> None:
        """策略修订不可改写，服务选择必须引用精确修订。 / Policy revisions are immutable and service selection pins a revision."""

        self.db.execute(
            """
            INSERT INTO service_diagnostic_policies(
                service_name, policy_id, policy_revision, assigned_by, assigned_at
            ) VALUES ('identity', 'default', 1, 'ops', ?)
            """,
            (NOW,),
        )
        with self.assertRaisesRegex(sqlite3.IntegrityError, "immutable"):
            self.db.execute(
                "UPDATE evaluation_policies SET minimum_samples=4 WHERE policy_id='default'"
            )
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                """
                INSERT INTO service_diagnostic_policies(
                    service_name, policy_id, policy_revision, assigned_by, assigned_at
                ) VALUES ('gateway', 'default', 99, 'ops', ?)
                """,
                (NOW,),
            )

    def test_diagnostic_deployment_must_belong_to_service(self) -> None:
        """DiagnosticEvent 不得伪造另一个服务的部署。 / A DiagnosticEvent cannot claim another service's deployment."""

        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                """
                INSERT INTO diagnostic_event_dedup(
                    event_id, event_schema_version, envelope_schema_version,
                    service_name, deployment_id, kind, severity, occurred_at,
                    received_at, processed_at, fingerprint_hash, payload_digest,
                    processing_token, producer_subject
                ) VALUES (?, '1.0', '1.0', 'gateway', ?, 'dependency.unavailable',
                          'error', ?, ?, ?, ?, ?, 'delivery-1', 'gateway-producer')
                """,
                (
                    uuid7(2),
                    self.deployment_id,
                    NOW,
                    NOW,
                    NOW,
                    "d" * 64,
                    "sha256:" + "e" * 64,
                ),
            )

    def test_current_deployment_pointer_requires_matching_ready_deployment(self) -> None:
        """当前部署指针必须匹配服务、环境和 ready/active 状态。 / Current deployment pointers require matching service, environment, and ready/active state."""

        with self.assertRaisesRegex(sqlite3.IntegrityError, "ready or active"):
            self.db.execute(
                """
                INSERT INTO service_environment_deployments(
                    service_name, environment, deployment_id, activated_at
                ) VALUES ('identity', 'production', ?, ?)
                """,
                (self.deployment_id, NOW),
            )
        self.db.execute(
            """
            INSERT INTO deployment_status_history(
                deployment_id, sequence, state, actor_subject, occurred_at
            ) VALUES (?, 2, 'ready', 'ci', ?)
            """,
            (self.deployment_id, NOW),
        )
        self.db.execute(
            """
            INSERT INTO service_environment_deployments(
                service_name, environment, deployment_id, activated_at
            ) VALUES ('identity', 'production', ?, ?)
            """,
            (self.deployment_id, NOW),
        )
        row = self.db.execute(
            "SELECT deployment_id FROM service_environment_deployments WHERE service_name='identity'"
        ).fetchone()
        self.assertEqual(row["deployment_id"], self.deployment_id)


class IdempotencyAndTransactionTests(SchemaTestCase):
    """验证重复投递所有权门控和批事务回滚。 / Validate duplicate-delivery ownership gates and batch rollback."""

    def setUp(self) -> None:
        """创建เอียด一个可接受 Diagnostic 的领域基础。 / Create the domain prerequisites for an accepted Diagnostic."""

        super().setUp()
        self.add_service("identity")
        self.add_policy()
        self.deployment_id = self.add_deployment("identity", 10)

    def insert_claim(self, event_id: str, token: str) -> int:
        """以 INSERT OR IGNORE 获取一次处理所有权。 / Acquire processing ownership with INSERT OR IGNORE."""

        result = self.db.execute(
            """
            INSERT OR IGNORE INTO diagnostic_event_dedup(
                event_id, event_schema_version, envelope_schema_version,
                service_name, deployment_id, kind, severity, occurred_at,
                received_at, processed_at, fingerprint_hash, payload_digest,
                processing_token, producer_subject
            ) VALUES (?, '1.0', '1.0', 'identity', ?, 'dependency.unavailable',
                      'error', ?, ?, ?, ?, ?, ?, 'identity-producer')
            """,
            (
                event_id,
                self.deployment_id,
                NOW,
                NOW,
                NOW,
                "d" * 64,
                "sha256:" + "e" * 64,
                token,
            ),
        )
        return result.rowcount

    def test_duplicate_delivery_cannot_mutate_domain_rows(self) -> None:
        """只有首次 processing_token 可驱动领域写入。 / Only the first processing token can drive domain writes."""

        event_id = uuid7(11)
        self.assertEqual(self.insert_claim(event_id, "owner-token"), 1)
        self.assertEqual(self.insert_claim(event_id, "duplicate-token"), 0)
        inserted = self.db.execute(
            """
            INSERT INTO issues(
                issue_id, fingerprint_hash, service_name, kind, severity, state,
                first_seen_at, last_seen_at, policy_id, policy_revision
            )
            SELECT ?, ?, 'identity', 'dependency.unavailable', 'error', 'observed',
                   ?, ?, 'default', 1
            WHERE EXISTS (
                SELECT 1 FROM diagnostic_event_dedup
                WHERE event_id=? AND processing_token=?
            )
            """,
            (uuid7(12), "f" * 64, NOW, NOW, event_id, "duplicate-token"),
        )
        self.assertEqual(inserted.rowcount, 0)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM issues").fetchone()[0], 0)

    def test_failed_transaction_assertion_rolls_back_claim_and_mutation(self) -> None:
        """过期预读触发断言时，claim 与全部领域写入一起回滚。 / A stale pre-read assertion rolls back the claim and every domain mutation."""

        event_id = uuid7(13)
        self.db.commit()
        self.db.execute("BEGIN")
        try:
            self.insert_claim(event_id, "owner-token")
            self.db.execute(
                """
                INSERT INTO issues(
                    issue_id, fingerprint_hash, service_name, kind, severity, state,
                    first_seen_at, last_seen_at, policy_id, policy_revision
                ) VALUES (?, ?, 'identity', 'dependency.unavailable', 'error',
                          'observed', ?, ?, 'default', 1)
                """,
                (uuid7(14), "a" * 64, NOW, NOW),
            )
            with self.assertRaisesRegex(sqlite3.IntegrityError, "transaction assertion failed"):
                self.db.execute(
                    """
                    INSERT INTO transaction_assertions(assertion_id, passed)
                    SELECT 'issue-revision', 0
                    WHERE EXISTS (
                        SELECT 1 FROM diagnostic_event_dedup
                        WHERE event_id=? AND processing_token='owner-token'
                    )
                    """,
                    (event_id,),
                )
            self.db.rollback()
        except Exception:
            self.db.rollback()
            raise
        self.assertEqual(
            self.db.execute(
                "SELECT COUNT(*) FROM diagnostic_event_dedup WHERE event_id=?", (event_id,)
            ).fetchone()[0],
            0,
        )
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM issues").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM transaction_assertions").fetchone()[0], 0)


class HistoryAndRetentionTests(SchemaTestCase):
    """验证 Issue recurrence、Incident 时间线和 occurrence 固定。 / Validate Issue recurrence, Incident timelines, and occurrence pins."""

    def setUp(self) -> None:
        """创建历史测试的服务、策略、部署与保留策略。 / Create prerequisites for history tests."""

        super().setUp()
        self.add_service("identity")
        self.add_policy()
        self.add_retention_policy()
        self.deployment_id = self.add_deployment("identity", 20)

    def test_partial_uniqueness_and_resolved_issue_recurrence(self) -> None:
        """未解决指纹唯一；resolved 后只能创建关联 recurrence。 / Unresolved fingerprints are unique; resolution permits only a linked recurrence."""

        first = uuid7(21)
        second = uuid7(22)
        self.add_issue(first, "identity")
        with self.assertRaises(sqlite3.IntegrityError):
            self.add_issue(second, "identity")
        self.db.execute(
            """
            UPDATE issues
            SET state='resolved', resolved_at=?, revision=2
            WHERE issue_id=? AND revision=1
            """,
            (LATER, first),
        )
        self.add_issue(second, "identity", recurrence_of=first)
        with self.assertRaisesRegex(sqlite3.IntegrityError, "resolved issue is immutable"):
            self.db.execute(
                """
                UPDATE issues SET state='active', resolved_at=NULL, revision=3
                WHERE issue_id=?
                """,
                (first,),
            )

    def test_incident_current_view_and_timeline_are_immutable(self) -> None:
        """Incident 当前态来自最新 update，旧 update 不可改写。 / Incident current state derives from the latest immutable update."""

        incident_id = uuid7(23)
        update_one = uuid7(24)
        update_two = uuid7(25)
        self.db.execute(
            """
            INSERT INTO incidents(
                incident_id, started_at, detected_at, created_at, created_by
            ) VALUES (?, ?, ?, ?, 'ops')
            """,
            (incident_id, NOW, NOW, NOW),
        )
        self.db.execute(
            """
            INSERT INTO incident_updates(
                update_id, incident_id, sequence, title, state, impact,
                public_message, actor_subject, occurred_at
            ) VALUES (?, ?, 1, 'Login errors', 'investigating', 'degraded',
                      'Investigating', 'ops', ?)
            """,
            (update_one, incident_id, NOW),
        )
        self.db.execute(
            """
            INSERT INTO incident_updates(
                update_id, incident_id, sequence, title, state, impact,
                public_message, actor_subject, occurred_at
            ) VALUES (?, ?, 2, 'Login errors', 'monitoring', 'degraded',
                      'Fix deployed', 'ops', ?)
            """,
            (update_two, incident_id, LATER),
        )
        current = self.db.execute(
            "SELECT revision, state, public_message FROM incident_current WHERE incident_id=?",
            (incident_id,),
        ).fetchone()
        self.assertEqual((current["revision"], current["state"]), (2, "monitoring"))
        with self.assertRaisesRegex(sqlite3.IntegrityError, "immutable"):
            self.db.execute(
                "UPDATE incident_updates SET public_message='rewritten' WHERE update_id=?",
                (update_one,),
            )

    def test_incident_pin_blocks_occurrence_retention_delete(self) -> None:
        """Incident 引用的 occurrence 摘要不得被清理。 / Incident-referenced occurrence summaries cannot be cleaned up."""

        issue_id = uuid7(26)
        occurrence_id = uuid7(27)
        incident_id = uuid7(28)
        update_id = uuid7(29)
        self.add_issue(issue_id, "identity", fingerprint="1" * 64)
        self.db.execute(
            """
            INSERT INTO issue_occurrences(
                occurrence_id, issue_id, service_name, deployment_id, occurred_at,
                observed_at, summary, retention_policy_id,
                retention_policy_revision, purge_after
            ) VALUES (?, ?, 'identity', ?, ?, ?, 'timeout', 'standard', 1, ?)
            """,
            (occurrence_id, issue_id, self.deployment_id, NOW, NOW, LATER),
        )
        self.db.execute(
            """
            INSERT INTO incidents(
                incident_id, started_at, detected_at, created_at, created_by
            ) VALUES (?, ?, ?, ?, 'ops')
            """,
            (incident_id, NOW, NOW, NOW),
        )
        self.db.execute(
            """
            INSERT INTO incident_updates(
                update_id, incident_id, sequence, title, state, impact,
                public_message, actor_subject, occurred_at
            ) VALUES (?, ?, 1, 'Timeouts', 'investigating', 'degraded',
                      'Investigating', 'ops', ?)
            """,
            (update_id, incident_id, NOW),
        )
        self.db.execute(
            """
            INSERT INTO incident_occurrences(incident_id, occurrence_id, update_sequence)
            VALUES (?, ?, 1)
            """,
            (incident_id, occurrence_id),
        )
        with self.assertRaisesRegex(sqlite3.IntegrityError, "cannot be deleted"):
            self.db.execute(
                "DELETE FROM issue_occurrences WHERE occurrence_id=?", (occurrence_id,)
            )


class AuditAndOutboxTests(SchemaTestCase):
    """验证审计不可变性与 outbox 的有限状态机。 / Validate audit immutability and the bounded outbox state machine."""

    def test_audit_is_append_only(self) -> None:
        """审计行不得修改或删除。 / Audit rows cannot be updated or deleted."""

        audit_id = uuid7(30)
        self.db.execute(
            """
            INSERT INTO audit_log(
                audit_id, actor_type, actor_subject, action, target_type,
                target_id, correlation_id, occurred_at
            ) VALUES (?, 'human', 'ops@example.com', 'incident.created',
                      'incident', 'x', 'correlation', ?)
            """,
            (audit_id, NOW),
        )
        with self.assertRaisesRegex(sqlite3.IntegrityError, "immutable"):
            self.db.execute("UPDATE audit_log SET action='changed' WHERE audit_id=?", (audit_id,))
        with self.assertRaisesRegex(sqlite3.IntegrityError, "immutable"):
            self.db.execute("DELETE FROM audit_log WHERE audit_id=?", (audit_id,))

    def test_outbox_payload_is_immutable_and_delivery_is_terminal(self) -> None:
        """outbox 可推进投递状态，但不能重写事件，delivered 为终态。 / Outbox delivery advances without rewriting events, and delivered is terminal."""

        outbox_id = uuid7(31)
        self.db.execute(
            """
            INSERT INTO outbox(
                outbox_id, aggregate_type, aggregate_id, event_type,
                schema_version, payload_json, available_at, next_attempt_at, created_at
            ) VALUES (?, 'issue', 'i', 'issue.created', '1.0', '{}', ?, ?, ?)
            """,
            (outbox_id, NOW, NOW, NOW),
        )
        self.db.execute(
            """
            UPDATE outbox SET state='processing', lease_owner='worker-1',
                lease_expires_at=?, attempt_count=1 WHERE outbox_id=?
            """,
            (LATER, outbox_id),
        )
        self.db.execute(
            """
            UPDATE outbox SET state='delivered', delivered_at=?, lease_owner=NULL,
                lease_expires_at=NULL WHERE outbox_id=?
            """,
            (LATER, outbox_id),
        )
        with self.assertRaisesRegex(sqlite3.IntegrityError, "payload are immutable"):
            self.db.execute("UPDATE outbox SET payload_json='{""x"":1}' WHERE outbox_id=?", (outbox_id,))
        with self.assertRaisesRegex(sqlite3.IntegrityError, "invalid outbox state transition"):
            self.db.execute(
                "UPDATE outbox SET state='pending', delivered_at=NULL WHERE outbox_id=?",
                (outbox_id,),
            )


if __name__ == "__main__":
    unittest.main()

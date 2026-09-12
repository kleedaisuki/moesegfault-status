"""验证 D1 初始模式的结构、约束和事务语义。 / Validate the initial D1 schema, constraints, and transactions."""

from __future__ import annotations

import sqlite3
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = tuple(sorted((ROOT / "migrations").glob("*.sql")))
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
        for migration in MIGRATIONS:
            self.db.executescript(migration.read_text(encoding="utf-8"))

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

    def add_upload_session(
        self,
        upload_id: str,
        deployment_id: str,
        idempotency_key: str,
        object_key: str,
    ) -> None:
        """插入不可变 artifact 上传会话。 / Insert an immutable artifact upload session."""

        values = (
            upload_id,
            deployment_id,
            idempotency_key,
            "sha256:" + "3" * 64,
            object_key,
            "sha256:" + "4" * 64,
            LATER,
            NOW,
        )
        columns = {
            row["name"] for row in self.db.execute("PRAGMA table_info(artifact_upload_sessions)")
        }
        if "content_md5" in columns:
            self.db.execute(
                """
                INSERT INTO artifact_upload_sessions(
                    upload_id, deployment_id, idempotency_key, request_digest,
                    object_key, kind, file_name, media_type, size_bytes,
                    artifact_digest, expires_at, created_at, created_by, content_md5
                ) VALUES (?, ?, ?, ?, ?, 'source_map', 'app.js.map',
                          'application/json', 128, ?, ?, ?, 'ci', ?)
                """,
                (*values, "QUFBQUFBQUFBQUFBQUFBQQ=="),
            )
            return
        self.db.execute(
            """
            INSERT INTO artifact_upload_sessions(
                upload_id, deployment_id, idempotency_key, request_digest,
                object_key, kind, file_name, media_type, size_bytes,
                artifact_digest, expires_at, created_at, created_by
            ) VALUES (?, ?, ?, ?, ?, 'source_map', 'app.js.map',
                      'application/json', 128, ?, ?, ?, 'ci')
            """,
            values,
        )

    def add_artifact(
        self,
        artifact_id: str,
        deployment_id: str,
        upload_id: str,
        object_key: str,
    ) -> None:
        """按上传会话提交 artifact。 / Commit an artifact against its upload session."""

        self.db.execute(
            """
            INSERT INTO deployment_artifacts(
                artifact_id, deployment_id, upload_id, kind, file_name,
                object_key, media_type, size_bytes, artifact_digest, created_at
            ) VALUES (?, ?, ?, 'source_map', 'app.js.map', ?,
                      'application/json', 128, ?, ?)
            """,
            (
                artifact_id,
                deployment_id,
                upload_id,
                object_key,
                "sha256:" + "4" * 64,
                NOW,
            ),
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
                assignment_id, selector_kind, service_name, policy_id,
                policy_revision, assigned_by, assigned_at
            ) VALUES (?, 'service_default', 'identity', 'default', 1, 'ops', ?)
            """,
            (uuid7(40), NOW),
        )
        with self.assertRaisesRegex(sqlite3.IntegrityError, "immutable"):
            self.db.execute(
                "UPDATE evaluation_policies SET minimum_samples=4 WHERE policy_id='default'"
            )
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                """
                INSERT INTO service_diagnostic_policies(
                    assignment_id, selector_kind, service_name, policy_id,
                    policy_revision, assigned_by, assigned_at
                ) VALUES (?, 'service_default', 'gateway', 'default', 99, 'ops', ?)
                """,
                (uuid7(41), NOW),
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


class MigrationEvolutionTests(SchemaTestCase):
    """验证增量迁移保留数据并解除错误的全局唯一性。 / Validate incremental migrations preserve data and remove incorrect global uniqueness."""

    def reset_to_initial_schema(self) -> None:
        """重建仅应用 0001 的数据库。 / Rebuild a database with only migration 0001 applied."""

        self.db.close()
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.executescript(MIGRATIONS[0].read_text(encoding="utf-8"))

    def test_0002_preserves_rows_and_allows_cross_deployment_object_reuse(self) -> None:
        """0002 必须保留旧行，并允许续签及跨部署复用对象键。 / 0002 must preserve rows and allow renewal and cross-deployment key reuse."""

        self.reset_to_initial_schema()
        self.add_service("identity")
        first_deployment = self.add_deployment("identity", 50, artifact_hex="5")
        second_deployment = self.add_deployment("identity", 51, artifact_hex="5")
        shared_key = "observability/artifacts/sha256/shared/app.js.map"
        first_upload = uuid7(52)
        first_artifact = uuid7(53)
        self.add_upload_session(first_upload, first_deployment, "first", shared_key)
        self.add_artifact(first_artifact, first_deployment, first_upload, shared_key)
        self.db.commit()

        self.db.executescript(MIGRATIONS[1].read_text(encoding="utf-8"))

        renewed_upload = uuid7(54)
        second_upload = uuid7(55)
        second_artifact = uuid7(56)
        self.add_upload_session(renewed_upload, first_deployment, "renewed", shared_key)
        self.add_upload_session(second_upload, second_deployment, "second", shared_key)
        self.add_artifact(second_artifact, second_deployment, second_upload, shared_key)

        self.assertEqual(
            self.db.execute(
                "SELECT COUNT(*) FROM artifact_upload_sessions WHERE object_key=?",
                (shared_key,),
            ).fetchone()[0],
            3,
        )
        artifacts = self.db.execute(
            """
            SELECT deployment_id, artifact_id
            FROM deployment_artifacts WHERE object_key=? ORDER BY deployment_id
            """,
            (shared_key,),
        ).fetchall()
        self.assertEqual(len(artifacts), 2)
        self.assertIn(first_artifact, {row["artifact_id"] for row in artifacts})
        with self.assertRaises(sqlite3.IntegrityError):
            self.add_artifact(uuid7(57), first_deployment, renewed_upload, shared_key)
        self.assertEqual(self.db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_0003_migrates_legacy_assignment_to_service_default(self) -> None:
        """0003 必须为旧服务级 assignment 建立稳定 ID 和默认 selector。 / 0003 must give legacy service assignments stable IDs and default selectors."""

        self.reset_to_initial_schema()
        self.add_service("identity")
        self.add_policy()
        self.db.execute(
            """
            INSERT INTO service_diagnostic_policies(
                service_name, policy_id, policy_revision, assigned_by, assigned_at
            ) VALUES ('identity', 'default', 1, 'ops', ?)
            """,
            (NOW,),
        )
        self.db.commit()

        for migration in MIGRATIONS[1:3]:
            self.db.executescript(migration.read_text(encoding="utf-8"))

        row = self.db.execute(
            """
            SELECT assignment_id, selector_kind, service_name, diagnostic_kind
            FROM service_diagnostic_policies
            """
        ).fetchone()
        self.assertEqual(row["selector_kind"], "service_default")
        self.assertEqual(row["service_name"], "identity")
        self.assertIsNone(row["diagnostic_kind"])
        self.assertEqual(len(row["assignment_id"]), 36)
        self.assertEqual(row["assignment_id"][14], "7")
        self.assertEqual(self.db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_policy_selector_precedence_and_uniqueness_are_deterministic(self) -> None:
        """monitor、service kind、service default 必须按固定优先级唯一选择。 / Monitor, service-kind, and service-default selectors must resolve uniquely in fixed priority."""

        self.add_service("identity")
        self.add_policy("default")
        self.add_policy("kind")
        self.add_policy("monitor")
        monitor_id = uuid7(60)
        self.db.execute(
            """
            INSERT INTO monitors(
                monitor_id, target_type, target_id, probe_kind, schedule_kind,
                interval_seconds, timeout_ms, probe_config_json, policy_id,
                policy_revision, next_run_at, created_at, updated_at
            ) VALUES (?, 'service', 'identity', 'http', 'interval', 60, 1000,
                      '{}', 'default', 1, ?, ?, ?)
            """,
            (monitor_id, NOW, NOW, NOW),
        )
        assignments = (
            (uuid7(61), "service_default", None, "identity", None, "default"),
            (uuid7(62), "service_kind", None, "identity", "health.probe_failed", "kind"),
            (uuid7(63), "monitor", monitor_id, None, None, "monitor"),
        )
        self.db.executemany(
            """
            INSERT INTO service_diagnostic_policies(
                assignment_id, selector_kind, monitor_id, service_name,
                diagnostic_kind, policy_id, policy_revision, assigned_by, assigned_at
            ) VALUES (?, ?, ?, ?, ?, ?, 1, 'ops', ?)
            """,
            [(*assignment, NOW) for assignment in assignments],
        )

        def select_policy(origin_monitor: str | None, diagnostic_kind: str) -> str:
            """执行 consumer 使用的固定 selector 查询。 / Run the consumer's deterministic selector query."""

            row = self.db.execute(
                """
                SELECT policy_id
                FROM service_diagnostic_policies
                WHERE (selector_kind='monitor' AND monitor_id=:monitor_id)
                   OR (selector_kind='service_kind' AND service_name=:service_name
                       AND diagnostic_kind=:diagnostic_kind)
                   OR (selector_kind='service_default' AND service_name=:service_name)
                ORDER BY CASE selector_kind
                    WHEN 'monitor' THEN 0
                    WHEN 'service_kind' THEN 1
                    ELSE 2
                END
                LIMIT 1
                """,
                {
                    "monitor_id": origin_monitor,
                    "service_name": "identity",
                    "diagnostic_kind": diagnostic_kind,
                },
            ).fetchone()
            assert row is not None
            return str(row["policy_id"])

        self.assertEqual(select_policy(monitor_id, "health.probe_failed"), "monitor")
        self.assertEqual(select_policy(None, "health.probe_failed"), "kind")
        self.assertEqual(select_policy(None, "dependency.unavailable"), "default")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                """
                INSERT INTO service_diagnostic_policies(
                    assignment_id, selector_kind, monitor_id, policy_id,
                    policy_revision, assigned_by, assigned_at
                ) VALUES (?, 'monitor', ?, 'default', 1, 'ops', ?)
                """,
                (uuid7(64), monitor_id, NOW),
            )

    def test_0004_preserves_legacy_sessions_but_requires_md5_for_new_uploads(self) -> None:
        """0004 保留旧会话/已提交记录，但新会话必须携带有效 MD5。 / 0004 preserves legacy sessions and commits but requires valid MD5 for new uploads."""

        self.reset_to_initial_schema()
        self.add_service("identity")
        committed_deployment = self.add_deployment("identity", 70, artifact_hex="7")
        pending_deployment = self.add_deployment("identity", 71, artifact_hex="8")
        object_key = "observability/artifacts/sha256/md5-migration"
        pending_key = "observability/artifacts/sha256/md5-pending"
        committed_upload = uuid7(72)
        pending_upload = uuid7(73)
        self.add_upload_session(committed_upload, committed_deployment, "committed", object_key)
        self.add_artifact(uuid7(74), committed_deployment, committed_upload, object_key)
        self.add_upload_session(pending_upload, pending_deployment, "pending", pending_key)
        self.db.commit()
        for migration in MIGRATIONS[1:4]:
            self.db.executescript(migration.read_text(encoding="utf-8"))

        legacy = self.db.execute(
            "SELECT content_md5 FROM artifact_upload_sessions WHERE upload_id=?",
            (pending_upload,),
        ).fetchone()
        self.assertIsNone(legacy["content_md5"])
        self.assertEqual(
            self.db.execute(
                "SELECT COUNT(*) FROM deployment_artifacts WHERE upload_id=?",
                (committed_upload,),
            ).fetchone()[0],
            1,
        )
        with self.assertRaisesRegex(sqlite3.IntegrityError, "checksummed upload session"):
            self.add_artifact(uuid7(75), pending_deployment, pending_upload, pending_key)
        with self.assertRaisesRegex(sqlite3.IntegrityError, "requires content_md5"):
            self.db.execute(
                """
                INSERT INTO artifact_upload_sessions(
                    upload_id, deployment_id, idempotency_key, request_digest,
                    object_key, kind, file_name, media_type, size_bytes,
                    artifact_digest, expires_at, created_at, created_by, content_md5
                ) VALUES (?, ?, 'missing-md5', ?, ?, 'source_map', 'app.js.map',
                          'application/json', 128, ?, ?, ?, 'ci', NULL)
                """,
                (
                    uuid7(76),
                    pending_deployment,
                    "sha256:" + "3" * 64,
                    pending_key,
                    "sha256:" + "4" * 64,
                    LATER,
                    NOW,
                ),
            )
        renewed_upload = uuid7(77)
        self.add_upload_session(renewed_upload, pending_deployment, "renewed", pending_key)
        self.add_artifact(uuid7(78), pending_deployment, renewed_upload, pending_key)

    def test_unpinned_occurrence_cleanup_detaches_but_preserves_evidence(self) -> None:
        """未固定 occurrence 清理后，永久 evidence 关系必须保留并解绑摘要。 / Cleaning an unpinned occurrence must preserve permanent evidence while detaching the summary."""

        self.add_service("identity")
        self.add_policy()
        self.add_retention_policy()
        deployment_id = self.add_deployment("identity", 80, artifact_hex="9")
        issue_id = uuid7(81)
        occurrence_id = uuid7(82)
        reference_id = uuid7(83)
        self.add_issue(issue_id, "identity", fingerprint="8" * 64)
        self.db.execute(
            """
            INSERT INTO issue_occurrences(
                occurrence_id, issue_id, service_name, deployment_id, occurred_at,
                observed_at, summary, retention_policy_id,
                retention_policy_revision, purge_after
            ) VALUES (?, ?, 'identity', ?, ?, ?, 'timeout', 'standard', 1, ?)
            """,
            (occurrence_id, issue_id, deployment_id, NOW, NOW, LATER),
        )
        self.db.execute(
            """
            INSERT INTO telemetry_backends(
                backend_name, capabilities_json, query_adapter, ui_url_template,
                retention_class, auth_reference, created_at, updated_at
            ) VALUES ('grafana', '["trace"]', 'grafana', 'https://example.invalid/{id}',
                      '30d', 'GRAFANA_TOKEN', ?, ?)
            """,
            (NOW, NOW),
        )
        self.db.execute(
            """
            INSERT INTO telemetry_references(
                telemetry_reference_id, kind, backend_name, locator_json,
                service_name, deployment_id, created_at
            ) VALUES (?, 'trace', 'grafana', '{"trace_id":"abc"}',
                      'identity', ?, ?)
            """,
            (reference_id, deployment_id, NOW),
        )
        self.db.execute(
            """
            INSERT INTO issue_telemetry_references(
                issue_id, telemetry_reference_id, occurrence_id, linked_at
            ) VALUES (?, ?, ?, ?)
            """,
            (issue_id, reference_id, occurrence_id, NOW),
        )

        self.db.execute("DELETE FROM issue_occurrences WHERE occurrence_id=?", (occurrence_id,))

        link = self.db.execute(
            """
            SELECT issue_id, telemetry_reference_id, occurrence_id
            FROM issue_telemetry_references
            WHERE issue_id=? AND telemetry_reference_id=?
            """,
            (issue_id, reference_id),
        ).fetchone()
        self.assertIsNotNone(link)
        self.assertIsNone(link["occurrence_id"])
        self.assertEqual(
            self.db.execute(
                "SELECT COUNT(*) FROM telemetry_references WHERE telemetry_reference_id=?",
                (reference_id,),
            ).fetchone()[0],
            1,
        )


class IdempotencyAndTransactionTests(SchemaTestCase):
    """验证重复投递所有权门控和批事务回滚。 / Validate duplicate-delivery ownership gates and batch rollback."""

    def setUp(self) -> None:
        """创建可接受 Diagnostic 的领域基础。 / Create the domain prerequisites for an accepted Diagnostic."""

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

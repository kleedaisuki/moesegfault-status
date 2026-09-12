"""验证完整评估快照的数据库失效契约。 / Verify database invalidation of full evaluation snapshots."""

import sqlite3

from test_schema import SchemaTestCase, uuid7


class EvaluationGenerationTests(SchemaTestCase):
    """真实 SQL 验证纪元、因果头与无证明来源默认值。 / SQL checks for epochs, causal heads, and unproven provenance defaults."""

    def generation(self) -> int:
        """读取唯一的全局评估纪元。 / Read the singleton evaluation generation."""
        return self.db.execute(
            "SELECT generation FROM evaluation_generation WHERE singleton_id=1"
        ).fetchone()[0]

    def test_catalog_inputs_invalidate_but_descriptions_do_not(self) -> None:
        """领域输入改变作废快照，展示文本不会产生无谓冲突。 / Domain inputs invalidate snapshots, display text does not."""
        before = self.generation()
        self.add_service("identity")
        self.assertGreater(self.generation(), before)
        before = self.generation()
        self.db.execute("UPDATE services SET description='new text',revision=revision+1 WHERE service_name='identity'")
        self.assertEqual(self.generation(), before)
        self.db.execute("UPDATE services SET enabled=0,revision=revision+1 WHERE service_name='identity'")
        self.assertGreater(self.generation(), before)

    def test_rolled_back_input_does_not_advance_epoch(self) -> None:
        """失败事务不留下虚假的纪元推进。 / A rolled-back transaction leaves no epoch advancement."""
        before = self.generation()
        self.db.execute("SAVEPOINT attempt")
        self.add_service("identity")
        self.assertGreater(self.generation(), before)
        self.db.execute("ROLLBACK TO attempt")
        self.db.execute("RELEASE attempt")
        self.assertEqual(self.generation(), before)

    def test_generation_singleton_cannot_be_removed(self) -> None:
        """删除纪元不能绕过评估比较。 / Deleting the epoch cannot bypass evaluation comparison."""
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("DELETE FROM evaluation_generation")
        self.assertIsInstance(self.generation(), int)

    def test_missing_fault_head_is_not_fabricated(self) -> None:
        """既有 Issue 没有可证明的故障头时保持空值。 / An Issue without proven fault identity retains a null head."""
        self.add_service("identity")
        self.add_policy()
        self.add_issue(uuid7(701), "identity")
        row = self.db.execute(
            "SELECT last_fault_event_id,recovery_count,last_recovery_at FROM issues WHERE issue_id=?",
            (uuid7(701),),
        ).fetchone()
        self.assertEqual(tuple(row), (None, 0, None))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE issues SET recovery_count=-1 WHERE issue_id=?", (uuid7(701),))

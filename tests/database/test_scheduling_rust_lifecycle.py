"""Rust 生命周期 SQL 在真实迁移上的可复现验证。 / Reproducible Rust lifecycle SQL tests on real migrations.

运行 / Run: python -m unittest discover -s tests/database -p test_scheduling_rust_lifecycle.py -v
验证 SQL 绑定、事务和约束，不代替 Wasm 或纯领域状态机测试。
Checks SQL bindings, transactions and constraints, not Wasm or pure-domain evaluation.
"""
import json
import re
import sqlite3
from test_schema import SchemaTestCase, ROOT, NOW, LATER, uuid7

# 提取实际生产 SQL，避免复制后漂移。 / Extract production SQL to avoid copied-query drift.
SOURCE = (ROOT / 'crates/status-backend/src/scheduling/probe_lifecycle.rs').read_text(encoding='utf-8')
QUERIES = re.findall(r'Query::new\("(UPDATE issues[^"\n]*|INSERT INTO [^"\n]*)"', SOURCE)
RECOVERY = QUERIES[:4]
SUPPRESSION = QUERIES[-4:]


class SchedulingLifecycleTest(SchemaTestCase):
    """真实外键和事务断言回归。 / Regressions with real foreign keys and transaction assertions."""

    def setUp(self):
        """固定服务、策略与故障事实。 / Seed a service, policy and fault fact."""
        super().setUp()
        self.add_service('api')
        self.add_policy()
        self.issue = uuid7(301)
        self.add_issue(self.issue, 'api')
        self.db.execute("UPDATE issues SET state='active',revision=2 WHERE issue_id=?", (self.issue,))
        self.db.commit()

    def writes(self, suppression=False, previous=2, revision=3):
        """执行 Rust 的四条连续语句。 / Execute Rust's four consecutive statements."""
        queries = SUPPRESSION if suppression else RECOVERY
        self.assertEqual(len(queries), 4)
        update = (revision, self.issue, previous) if suppression else ('recovering', None, revision, LATER, self.issue, previous, LATER)
        values = [update, ('assertion',), (uuid7(302), self.issue, previous, revision, 'test-correlation', LATER),
                  (uuid7(303), self.issue, json.dumps({'issue_id': self.issue, 'state': 'active' if suppression else 'recovering', 'revision': revision}), LATER, LATER, LATER)]
        for query, parameters in zip(queries, values):
            self.db.execute(query, parameters)

    def test_recovery_writes_audit_and_outbox(self):
        """成功恢复保留最后故障时间并追加关联事实。 / Recovery preserves fault time and appends associated facts."""
        with self.db:
            self.writes()
        row = self.db.execute('SELECT state,revision,last_seen_at FROM issues').fetchone()
        self.assertEqual(tuple(row), ('recovering', 3, NOW))
        self.assertEqual(self.db.execute('SELECT action FROM audit_log').fetchone()[0], 'issue.recovery_evaluated')
        self.assertEqual(self.db.execute('SELECT event_type FROM outbox').fetchone()[0], 'issue.state_changed')

    def test_expiry_clears_suppression_durably(self):
        """抑制到期恢复 active，清理抑制字段并正确命名审计。 / Expiry restores active, clears suppression and names the audit accurately."""
        self.db.execute("UPDATE issues SET state='suppressed',revision=3,suppression_until=?,suppression_reason='operator'", (NOW,))
        self.db.commit()
        with self.db:
            self.writes(suppression=True, previous=3, revision=4)
        row = self.db.execute('SELECT state,revision,suppression_until,suppression_reason FROM issues').fetchone()
        self.assertEqual(tuple(row), ('active', 4, None, None))
        self.assertEqual(self.db.execute('SELECT action FROM audit_log').fetchone()[0], 'issue.suppression_expired')
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM transaction_assertions').fetchone()[0], 0)

    def test_stale_revision_rolls_back_every_side_effect(self):
        """并发冲突不留下审计或待投递消息。 / Concurrency conflicts leave neither audits nor pending messages."""
        with self.assertRaises(sqlite3.IntegrityError):
            with self.db:
                self.writes(previous=9)
        self.assertEqual(self.db.execute('SELECT revision FROM issues').fetchone()[0], 2)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM audit_log').fetchone()[0], 0)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM outbox').fetchone()[0], 0)

    def test_later_status_failure_rolls_back_issue_and_events(self):
        """同 batch 后续状态计划失败也必须撤销恢复。 / Later status-plan failure in the same batch also rolls back recovery."""
        with self.assertRaises(sqlite3.IntegrityError):
            with self.db:
                self.writes()
                self.db.execute("INSERT INTO transaction_assertions(assertion_id,passed) VALUES ('status-plan',0)")
        self.assertEqual(tuple(self.db.execute('SELECT state,revision FROM issues').fetchone()), ('active', 2))
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM audit_log').fetchone()[0], 0)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM outbox').fetchone()[0], 0)

    def test_five_recovery_counts_are_atomic_and_retries_do_not_count(self):
        """五次独立观察计数与修订同行提交，重复时刻拒绝。 / Five distinct observations commit counts and revisions together; duplicate instants fail."""
        for count in range(1, 6):
            stamp = f'2026-09-12T08:00:0{count}.000Z'
            state = 'resolved' if count == 5 else 'recovering'
            with self.db:
                self.db.execute(RECOVERY[0], (state, stamp if count == 5 else None, count + 2, stamp, self.issue, count + 1, stamp))
                self.db.execute(RECOVERY[1], ('count',))
            row = self.db.execute('SELECT recovery_count,last_recovery_at,revision FROM issues').fetchone()
            self.assertEqual(tuple(row), (count, stamp, count + 2))
            with self.assertRaises(sqlite3.IntegrityError):
                with self.db:
                    self.db.execute(RECOVERY[0], (state, stamp if count == 5 else None, count + 3, stamp, self.issue, count + 2, stamp))
                    self.db.execute(RECOVERY[1], ('duplicate',))
            self.assertEqual(self.db.execute('SELECT recovery_count FROM issues').fetchone()[0], count)
        self.assertEqual(self.db.execute('SELECT state FROM issues').fetchone()[0], 'resolved')

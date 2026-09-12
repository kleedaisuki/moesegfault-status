"""真实迁移上的 Rust 调度 SQL 事务回归。 / Rust scheduler SQL transaction regressions against real migrations.

运行 / Run: python -m unittest discover -s tests/database -p test_scheduling_rust_store.py -v
这些测试执行 Rust 文件中的 SQL，不模拟 SQL 语义；不覆盖 Wasm binding。
These tests execute SQL extracted from Rust, not mocked SQL semantics; Wasm binding is excluded.
"""
import json
import re
import sqlite3
from test_schema import SchemaTestCase, ROOT, NOW, LATER, uuid7

SOURCE = (ROOT / 'crates/status-backend/src/scheduling/store.rs').read_text(encoding='utf-8')
SQL = dict(re.findall(r'const (\w+): &str =\s*r#"(.*?)"#;', SOURCE, re.S))
CLAIM = re.search(r'Query::new\("(UPDATE monitors SET lease_owner=.*?RETURNING revision)"', SOURCE).group(1)


class SchedulingStoreTest(SchemaTestCase):
    """SQLite 验证所有者隔离及原子提交。 / Verify owner isolation and atomic commits in SQLite."""

    def setUp(self):
        """建立真实服务、策略和监视器。 / Seed real service, policy and monitor rows."""
        super().setUp()
        self.add_service('api')
        self.add_policy()
        self.mid = uuid7(1)
        self.db.execute("""INSERT INTO monitors(monitor_id,target_type,target_id,probe_kind,schedule_kind,
            interval_seconds,timeout_ms,probe_config_json,policy_id,policy_revision,next_run_at,created_at,updated_at)
            VALUES(?,'service','api','http','interval',60,1000,'{}','default',1,?,?,?)""", (self.mid,NOW,NOW,NOW))
        self.db.execute("INSERT INTO monitor_locations(monitor_id,location) VALUES(?,'sin')",(self.mid,))
        self.db.commit()

    def claim(self, owner='a', revision=1):
        """执行 Rust 原始 CAS SQL。 / Execute the original Rust CAS SQL."""
        return self.db.execute(CLAIM,(owner,LATER,NOW,self.mid,revision,NOW,NOW)).fetchall()

    def checkpoint(self):
        """写一个有效有界聚合。 / Write one valid bounded aggregate."""
        self.db.execute(SQL['UPSERT_CHECKPOINT_SQL'],(self.mid,'sin',NOW,1,0,1,0,NOW,10,'operational',NOW,LATER,'default',1,None,None))

    def guard(self, revision=2, locations='["sin"]', owner='a', now=NOW):
        """用生产断言保护 lease 与配置。 / Guard lease and configuration with production assertion."""
        self.db.execute(SQL['ASSERT_MONITOR_LEASE_SQL'],('repeat',self.mid,owner,NOW,now,'default',1,revision,self.mid,locations))

    def enqueue(self, oid=None, event='status.reevaluation_requested', payload=None):
        """插入可重试工作项。 / Insert a retryable work item."""
        self.db.execute(SQL['INSERT_EXPIRY_OUTBOX_SQL'],(oid or uuid7(2),'api',event,json.dumps(payload or {'target_type':'service','target_id':'api'}),NOW,NOW,NOW))

    def test_claim_cas_and_owner_release(self):
        """重叠 tick 不可盗租，陈旧配置不可领取。 / Overlapping ticks cannot steal leases or claim stale configuration."""
        self.assertEqual(len(self.db.execute(SQL['DUE_MONITORS_SQL'],(NOW,NOW,5)).fetchall()),1)
        self.assertEqual(self.claim()[0][0],2)
        self.assertEqual(self.claim('b'),[])
        self.db.execute(SQL['RELEASE_MONITOR_SQL'],(NOW,self.mid,'b'))
        self.assertEqual(self.db.execute('SELECT lease_owner FROM monitors').fetchone()[0],'a')
        self.db.execute(SQL['RELEASE_MONITOR_SQL'],(NOW,self.mid,'a'))
        self.assertEqual(self.claim(revision=2),[])
        self.assertEqual(self.claim(revision=3)[0][0],4)

    def test_monitor_diagnostic_guard_rejects_administrative_change(self):
        """探针返回后禁用监控，不得提交独立诊断事务。 / Disabling a monitor after probing forbids the independent diagnostic transaction."""
        self.claim()
        self.db.execute("UPDATE monitors SET enabled=0,revision=revision+1 WHERE monitor_id=?", (self.mid,))
        self.db.commit()
        with self.assertRaises(sqlite3.IntegrityError), self.db:
            self.guard()
            self.enqueue()
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0], 0)
        runtime = (ROOT / 'crates/status-backend/src/scheduling/runtime.rs').read_text(encoding='utf-8')
        consumer = (ROOT / 'crates/status-backend/src/diagnostics/platform.rs').read_text(encoding='utf-8')
        self.assertIn('process_monitor_envelope', runtime)
        self.assertRegex(consumer, r'queries\.insert\(0,\s*guard\)')

    def test_checkpoint_schedule_and_retry_are_atomic(self):
        """提交窗口同时持久化重算；重复 assertion ID 不碰撞。 / Commit window and retry together; repeated assertion IDs do not collide."""
        self.claim();self.db.commit()
        with self.db:
            self.guard();self.guard();self.checkpoint();self.enqueue()
            self.db.execute(SQL['COMPLETE_MONITOR_SQL'],(NOW,LATER,NOW,self.mid,'a'))
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM transaction_assertions').fetchone()[0],0)
        self.assertEqual(self.db.execute('SELECT next_run_at FROM monitors').fetchone()[0],LATER)
        self.assertEqual(len(self.db.execute(SQL['READ_CHECKPOINTS_SQL'],(self.mid,)).fetchall()),1)
        self.assertEqual(self.db.execute('SELECT event_type FROM outbox').fetchone()[0],'status.reevaluation_requested')

    def test_invalid_owner_revision_location_or_expiry_rolls_back(self):
        """任意 guard 失败不能留下部分检查点或 outbox。 / Any guard failure leaves no partial checkpoint or outbox."""
        self.claim();self.db.commit()
        for options in ({'owner':'b'},{'revision':1},{'locations':'[]'},{'now':LATER}):
            with self.assertRaises(sqlite3.IntegrityError):
                with self.db:
                    self.checkpoint();self.enqueue();self.guard(**options)
            self.assertEqual(self.db.execute('SELECT COUNT(*) FROM monitor_checkpoints').fetchone()[0],0)
            self.assertEqual(self.db.execute('SELECT COUNT(*) FROM outbox').fetchone()[0],0)

    def test_outbox_owner_retry_and_expired_lease(self):
        """只允许当前 owner 确认；过期 lease 可重领。 / Only current owners acknowledge; expired leases may be reclaimed."""
        self.enqueue()
        claimed=self.db.execute(SQL['CLAIM_OUTBOX_SQL'],('a',LATER,NOW,NOW,1,5)).fetchall()
        self.assertEqual(claimed[0]['attempt_count'],1)
        self.db.execute(SQL['MARK_OUTBOX_DELIVERED_SQL'],(NOW,uuid7(2),'b'))
        self.assertEqual(self.db.execute('SELECT state FROM outbox').fetchone()[0],'processing')
        self.db.execute(SQL['MARK_OUTBOX_FAILED_SQL'],('pending',NOW,'timeout',uuid7(2),'a'))
        self.assertEqual(self.db.execute(SQL['CLAIM_OUTBOX_SQL'],('b',LATER,NOW,NOW,1,5)).fetchone()['attempt_count'],2)
        self.assertEqual(self.db.execute(SQL['CLAIM_OUTBOX_SQL'],('c',LATER,LATER,LATER,1,5)).fetchone()['attempt_count'],3)
        self.db.execute(SQL['MARK_OUTBOX_DELIVERED_SQL'],(LATER,uuid7(2),'b'))
        self.db.execute(SQL['MARK_OUTBOX_FAILED_SQL'],('dead',LATER,'timeout',uuid7(2),'c'))
        self.assertEqual(self.db.execute('SELECT state FROM outbox').fetchone()[0],'dead')
        self.assertEqual(self.db.execute(SQL['CLAIM_OUTBOX_SQL'],('d',LATER,LATER,LATER,1,5)).fetchall(),[])

    def test_disabled_notifications_preserve_external_events_without_blocking_internal_work(self):
        """禁用通知不消耗外部事件重试或批次；重新启用可领取。 / Disabled notifications preserve external retries and batch capacity; re-enabling permits claims."""
        external = uuid7(50)
        self.enqueue(external, 'catalog.changed')
        internal_events = ('maintenance.started', 'maintenance.expired', 'override.expired',
                           'suppression.expired', 'status.reevaluation_requested')
        for serial, event in enumerate(internal_events, 51):
            self.enqueue(uuid7(serial), event)
        claimed = self.db.execute(SQL['CLAIM_OUTBOX_SQL'], ('a',LATER,NOW,NOW,0,5)).fetchall()
        self.assertEqual({row['event_type'] for row in claimed}, set(internal_events))
        row = self.db.execute('SELECT state,attempt_count,lease_owner FROM outbox WHERE outbox_id=?', (external,)).fetchone()
        self.assertEqual(tuple(row), ('pending', 0, None))
        claimed = self.db.execute(SQL['CLAIM_OUTBOX_SQL'], ('b',LATER,NOW,NOW,1,5)).fetchall()
        self.assertEqual([(row['outbox_id'], row['attempt_count']) for row in claimed], [(external, 1)])
        self.db.execute(SQL['CLAIM_OUTBOX_SQL'], ('c',LATER,LATER,LATER,0,5)).fetchall()
        row = self.db.execute('SELECT state,attempt_count,lease_owner FROM outbox WHERE outbox_id=?', (external,)).fetchone()
        self.assertEqual(tuple(row), ('processing', 1, 'b'))

    def test_generation_changes_and_assertion_rollback(self):
        """配置和 checkpoint 修改使旧快照失效。 / Configuration and checkpoint changes invalidate old snapshots."""
        before=self.db.execute('SELECT generation FROM evaluation_generation').fetchone()[0]
        self.checkpoint();self.db.commit()
        self.assertGreater(self.db.execute('SELECT generation FROM evaluation_generation').fetchone()[0],before)
        with self.assertRaises(sqlite3.IntegrityError):
            with self.db:
                self.enqueue()
                self.db.execute('INSERT INTO transaction_assertions(assertion_id,passed) SELECT ?,CASE WHEN generation=? THEN 1 ELSE 0 END FROM evaluation_generation WHERE singleton_id=1',('expiry',before))
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM outbox').fetchone()[0],0)

    def test_maintenance_start_expire_and_scan_deduplication(self):
        """维护开始/完成严格依时间，扫描已投递源版本不会重复。 / Maintenance respects time; scanned source revisions are deduplicated."""
        mid=uuid7(4)
        self.db.execute("INSERT INTO maintenance_windows(maintenance_id,title,description,expected_impact,starts_at,ends_at,created_by,created_at,updated_at) VALUES(?,'x','x','degraded',?,?,'system',?,?)",(mid,NOW,LATER,NOW,NOW))
        self.db.execute("INSERT INTO maintenance_targets VALUES(?,'service','api')",(mid,))
        row=self.db.execute(SQL['EXPIRED_TARGETS_SQL'],(NOW,NOW,NOW,NOW,NOW,NOW,1)).fetchone()
        self.assertEqual(row['event_type'],'maintenance.started')
        self.db.execute(SQL['ACTIVATE_MAINTENANCE_SQL'],(NOW,mid,NOW,NOW))
        self.assertEqual(self.db.execute('SELECT state FROM maintenance_windows').fetchone()[0],'active')
        row=self.db.execute(SQL['EXPIRED_TARGETS_SQL'],(LATER,LATER,LATER,LATER,LATER,LATER,1)).fetchone()
        self.assertEqual(row['event_type'],'maintenance.expired')
        self.enqueue(event=row['event_type'],payload=dict(row))
        self.assertEqual(self.db.execute(SQL['EXPIRED_TARGETS_SQL'],(LATER,LATER,LATER,LATER,LATER,LATER,1)).fetchall(),[])
        self.db.execute(SQL['COMPLETE_MAINTENANCE_SQL'],(LATER,mid,LATER))
        self.assertEqual(self.db.execute('SELECT state FROM maintenance_windows').fetchone()[0],'completed')

    def test_retention_rechecks_revision_cutoff_and_late_pin(self):
        """候选选出后新增 pin 仍阻止删除，其他候选可清理。 / A pin added after selection still blocks deletion; other candidates purge."""
        self.add_retention_policy()
        deployment=self.add_deployment('api',10)
        issue=uuid7(11); self.add_issue(issue,'api')
        for serial in (12,13):
            self.db.execute("INSERT INTO issue_occurrences(occurrence_id,issue_id,service_name,deployment_id,occurred_at,observed_at,summary,retention_policy_id,retention_policy_revision,purge_after) VALUES(?,?,'api',?,?,?,'timeout','standard',1,?)",(uuid7(serial),issue,deployment,NOW,NOW,LATER))
        self.assertEqual(len(self.db.execute(SQL['RETENTION_CANDIDATES_SQL'],(LATER,5)).fetchall()),2)
        self.db.execute("INSERT INTO incidents(incident_id,started_at,detected_at,created_at,created_by) VALUES(?,?,?,?,'ops')",(uuid7(14),NOW,NOW,NOW))
        self.db.execute("INSERT INTO incident_updates(update_id,incident_id,sequence,title,state,impact,public_message,actor_subject,occurred_at) VALUES(?,?,1,'x','investigating','degraded','x','ops',?)",(uuid7(15),uuid7(14),NOW))
        self.db.execute('INSERT INTO incident_occurrences VALUES(?,?,1)',(uuid7(14),uuid7(12)))
        for serial,revision,cutoff,expected in ((12,1,LATER,0),(13,2,LATER,0),(13,1,NOW,0),(13,1,LATER,1)):
            cursor=self.db.execute(SQL['PURGE_OCCURRENCE_SQL'],(uuid7(serial),'standard',revision,LATER,cutoff))
            self.assertEqual(cursor.rowcount,expected)
        self.assertEqual(self.db.execute(SQL['RETENTION_CANDIDATES_SQL'],(LATER,5)).fetchall(),[])

    def test_override_and_suppression_expiry_sources(self):
        """覆盖与抑制到期事件按源版本去重。 / Override and suppression expiry events deduplicate by source revision."""
        self.db.execute("INSERT INTO status_overrides(override_id,target_type,target_id,status,reason,starts_at,expires_at,actor_subject,correlation_id,created_at) VALUES(?,'service','api','degraded','x',?,?,'ops','test',?)",(uuid7(20),NOW,LATER,NOW))
        issue=uuid7(21);self.add_issue(issue,'api')
        self.db.execute("UPDATE issues SET state='active',revision=revision+1 WHERE issue_id=?",(issue,))
        self.db.execute("UPDATE issues SET state='suppressed',suppression_reason='test',suppression_until=?,revision=revision+1 WHERE issue_id=?",(LATER,issue))
        rows=self.db.execute(SQL['EXPIRED_TARGETS_SQL'],(LATER,LATER,LATER,LATER,LATER,LATER,5)).fetchall()
        self.assertEqual({r['event_type'] for r in rows},{'override.expired','suppression.expired'})
        for index,row in enumerate(rows): self.enqueue(uuid7(22+index),row['event_type'],dict(row))
        self.assertEqual(self.db.execute(SQL['EXPIRED_TARGETS_SQL'],(LATER,LATER,LATER,LATER,LATER,LATER,5)).fetchall(),[])




    def test_suppression_source_limit_keeps_all_component_targets(self):
        """源级 limit 不可截断组件工作项。 / Source-level limits never truncate component work items."""
        for component in ('api', 'other'):
            self.db.execute("INSERT INTO components(component_id,service_name,display_name,created_at,updated_at) VALUES(?,'api','x',?,?)", (component,NOW,NOW))
        issue=uuid7(40);self.add_issue(issue,'api')
        self.db.execute("UPDATE issues SET state='active',revision=revision+1 WHERE issue_id=?",(issue,))
        self.db.execute("UPDATE issues SET state='suppressed',suppression_reason='test',suppression_until=?,revision=revision+1 WHERE issue_id=?",(LATER,issue))
        args=(LATER,LATER,LATER,LATER,LATER,LATER,1)
        rows=self.db.execute(SQL['EXPIRED_TARGETS_SQL'],args).fetchall()
        self.assertEqual({(r['target_type'],r['target_id']) for r in rows},{('service','api'),('component','api'),('component','other')})
        row=next(r for r in rows if r['target_type']=='service')
        self.enqueue(uuid7(41),row['event_type'],dict(row))
        self.assertEqual(len(self.db.execute(SQL['EXPIRED_TARGETS_SQL'],args).fetchall()),2)

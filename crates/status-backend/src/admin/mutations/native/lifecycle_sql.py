"""生命周期 SQL 复验：真实迁移、追加历史与 OCC 全回滚。
Lifecycle SQL verification: real migrations, append-only history, full OCC rollback.
Run: python crates/status-backend/src/admin/mutations/native/lifecycle_sql.py
"""
import pathlib
import re
import sqlite3


def main():
    """验证实际 Rust SQL 的语法以及持久化关键约束。
    Verify actual Rust SQL syntax and critical persistence constraints.
    """
    root = next(p for p in pathlib.Path(__file__).resolve().parents if (p / 'migrations').is_dir())
    db = sqlite3.connect(':memory:')
    db.execute('PRAGMA foreign_keys=ON')
    for path in sorted((root / 'migrations').glob('*.sql')):
        db.executescript(path.read_text(encoding='utf-8-sig'))
    source = (pathlib.Path(__file__).parent.parent / 'lifecycle.rs').read_text(encoding='utf-8-sig')
    statements = re.findall(r'(?:query|row)\(\s*(?:db,\s*)?"([^"]+)"', source)
    for sql in statements:
        db.execute('EXPLAIN ' + sql, [None] * sql.count('?')).fetchall()
    at = '2026-09-12T00:00:00.000Z'
    iid = '01994000-0000-7000-8000-000000000001'
    uid = '01994000-0000-7000-8000-000000000002'
    cid = '01994000-0000-7000-8000-000000000003'
    db.execute('INSERT INTO services(service_name,display_name,description,owner,criticality,enabled,created_at,updated_at,revision) VALUES (?,?,?,?,?,?,?,?,?)', ('api','API','','team','high',1,at,at,1))
    db.execute('INSERT INTO incidents(incident_id,started_at,detected_at,created_at,created_by) VALUES (?,?,?,?,?)',(iid,at,at,at,'operator'))
    insert = 'INSERT INTO incident_updates(update_id,incident_id,sequence,title,state,impact,cause,public_message,resolved_at,actor_subject,correlation_id,occurred_at)'
    db.execute(insert+' VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',(uid,iid,1,'Incident','investigating','degraded',None,'Investigating',None,'operator',cid,at))
    db.commit()
    guard = "SELECT CASE WHEN changes()=1 THEN 1 ELSE json('occ-conflict') END"
    update = insert+' SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT revision FROM incident_current WHERE incident_id=?)=?'
    args = ('01994000-0000-7000-8000-000000000004',iid,2,'Incident','identified','degraded',None,'Identified',None,'operator',cid,at,iid,1)
    with db:
        db.execute(update,args)
        db.execute(guard)
    assert db.execute('SELECT revision,state FROM incident_current').fetchone()==(2,'identified')
    try:
        with db:
            db.execute('UPDATE services SET display_name=?,revision=revision+1 WHERE service_name=?',('sentinel','api'))
            db.execute(update,args)
            db.execute(guard)
    except sqlite3.OperationalError:
        pass
    else:
        raise AssertionError('Stale incident revision did not abort')
    assert db.execute('SELECT display_name FROM services').fetchone()[0]=='API'
    assert db.execute('SELECT COUNT(*) FROM incident_updates').fetchone()[0]==2
    try:
        with db:
            db.execute('UPDATE incident_updates SET public_message=? WHERE update_id=?',('rewritten',uid))
    except sqlite3.IntegrityError:
        pass
    else:
        raise AssertionError('Timeline history was mutable')
    print(f'PASS: {len(statements)} actual literal SQL statements, incident append, stale OCC full rollback, immutable history')


if __name__ == '__main__':
    main()

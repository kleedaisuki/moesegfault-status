"""复验 catalog SQL 与原子 OCC；不替代真实 workerd 集成。
Reproduce catalog SQL and atomic OCC checks; not a substitute for workerd integration.

Run / 运行: python crates/status-backend/src/admin/mutations/native/catalog_sql.py
"""

import pathlib
import re
import sqlite3


def main():
    """加载真实迁移，验证参数化语法、关系及失败回滚。
    Load real migrations and verify parameterized syntax, relations and rollback.
    """
    root = next(p for p in pathlib.Path(__file__).resolve().parents if (p / "migrations").is_dir())
    db = sqlite3.connect(":memory:")
    db.execute("PRAGMA foreign_keys=ON")
    migrations = sorted((root / "migrations").glob("*.sql"))
    for migration in migrations:
        db.executescript(migration.read_text(encoding="utf-8-sig"))
    source = (pathlib.Path(__file__).parent.parent / "catalog.rs").read_text(encoding="utf-8-sig")
    statements = re.findall(r'(?:query|row)\(\s*(?:db,\s*)?"([^"]+)"', source)
    for sql in statements:
        db.execute("EXPLAIN " + sql, [None] * sql.count("?")).fetchall()
    at = "2026-09-12T00:00:00.000Z"
    for service in ["api", "db"]:
        db.execute("INSERT INTO services(service_name,display_name,description,owner,criticality,enabled,created_at,updated_at,revision) VALUES (?,?,?,?,?,?,?,?,?)", (service, service, "desc", "team", "high", 1, at, at, 1))
    db.execute("INSERT INTO components(component_id,service_name,display_name,description,public,sort_order,enabled,created_at,updated_at,revision) VALUES (?,?,?,?,?,?,?,?,?,?)", ("api-web", "api", "Web", "", 1, 0, 1, at, at, 1))
    for service, role in [("api", "owner"), ("db", "supporting")]:
        db.execute("INSERT INTO component_services(component_id,service_name,role,created_at) VALUES (?,?,?,?) ON CONFLICT(component_id,service_name) DO NOTHING", ("api-web", service, role, at))
    existence = "SELECT COUNT(*) FROM services WHERE service_name IN (SELECT value FROM json_each(?))"
    assert db.execute(existence, ('["api","db"]',)).fetchone()[0] == 2
    assert db.execute(existence, ('["unknown"]',)).fetchone()[0] == 0
    upsert = "INSERT INTO service_dependencies(source_service,target_service,capability,kind,criticality,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(source_service,target_service,capability) DO UPDATE SET kind=excluded.kind,criticality=excluded.criticality"
    db.execute(upsert, ("api", "db", "sql", "required", "high", at))
    db.execute(upsert, ("api", "db", "sql", "optional", "low", "2026-09-13T00:00:00.000Z"))
    assert db.execute("SELECT created_at,kind FROM service_dependencies").fetchone() == (at, "optional")
    db.commit()
    update = "UPDATE services SET display_name=?,description=?,owner=?,criticality=?,enabled=?,updated_at=?,revision=revision+1 WHERE service_name=? AND revision=?"
    guard = "SELECT CASE WHEN changes()=1 THEN 1 ELSE json('occ-conflict') END AS ok"
    with db:
        db.execute(update, ("New", "desc", "team", "high", 0, at, "api", 1))
        db.execute(guard)
    assert db.execute("SELECT revision,enabled FROM services WHERE service_name='api'").fetchone() == (2, 0)
    try:
        with db:
            # 在 OCC 前插入哨兵写，证明不是仅跳过后续语句，而是整体回滚。
            # A sentinel write before OCC proves full rollback rather than skipped later writes.
            db.execute("DELETE FROM component_services WHERE role='supporting'")
            db.execute(update, ("Stale", "desc", "team", "high", 1, at, "api", 1))
            db.execute(guard)
    except sqlite3.OperationalError:
        pass
    else:
        raise AssertionError("stale OCC did not fail")
    assert db.execute("SELECT COUNT(*) FROM component_services WHERE role='supporting'").fetchone()[0] == 1
    assert db.execute("SELECT revision,display_name FROM services WHERE service_name='api'").fetchone() == (2, "New")
    print(f"PASS: {len(migrations)} migrations, {len(statements)} literal SQL statements, service/component writes, JSON set checks, dependency timestamp preservation, OCC success and full stale-OCC rollback")


if __name__ == "__main__":
    main()

"""Split migrations using SQLite's own parser. / 使用 SQLite 原生完整性检查拆分迁移。"""
import json
import sqlite3
import sys

pending = ""
statements = []
for line in sys.stdin:
    if line.lstrip().startswith("--"):
        continue
    pending += line
    if sqlite3.complete_statement(pending):
        statements.append(pending)
        pending = ""
if pending.strip():
    raise ValueError("Unterminated SQL migration")
print(json.dumps(statements))

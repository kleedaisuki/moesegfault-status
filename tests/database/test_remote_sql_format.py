"""保护远端 D1 触发器解析兼容性。 / Guard remote D1 trigger parsing compatibility."""

from pathlib import Path
import re
import unittest


class RemoteSqlFormatTest(unittest.TestCase):
    """防止 CASE END 被误认作触发器结束。 / Prevent CASE END from terminating triggers."""

    def test_case_expressions_are_parenthesized(self):
        """保持 D1 query API 所需括号。 / Preserve parentheses needed by the D1 query API.

        SQLite accepts both forms, but the remote splitter can truncate an unwrapped
        CASE expression (cloudflare/workers-sdk#4326). 本地 SQLite 通过不足以覆盖此错误。
        """
        root = Path(__file__).resolve().parents[2]
        for migration in sorted((root / "migrations").glob("*.sql")):
            with self.subTest(migration=migration.name):
                sql = migration.read_text(encoding="utf-8")
                self.assertIsNone(re.search(r"\bSELECT\s+CASE\b", sql, re.I))

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** 验证远端实际约束及完整迁移集合，不把 CLI 退出码当作数据正确。 / Verify actual remote constraints and the complete migration set, not just CLI exit status. */
export function verifyMigrationResults(input, expected) {
  if (
    !Array.isArray(input) ||
    input.length !== 3 ||
    input.some((item) => item.success !== true || !Array.isArray(item.results))
  )
    throw new Error("Unexpected D1 verification response");
  if (input[0].results.length !== 0)
    throw new Error("D1 foreign-key violations found");
  if (input[1].results.length !== 1 || input[1].results[0].quick_check !== "ok")
    throw new Error("D1 integrity check failed");
  const actual = input[2].results.map((row) => row.name).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort()))
    throw new Error("Remote migration ledger differs from this commit");
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const expected = readdirSync(
    new URL("../../migrations/", import.meta.url),
  ).filter((name) => name.endsWith(".sql"));
  verifyMigrationResults(
    JSON.parse(readFileSync(process.argv[2], "utf8")),
    expected,
  );
  console.log(
    `Verified D1 integrity, foreign keys, and ${expected.length} migrations.`,
  );
}

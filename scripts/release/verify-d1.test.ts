import { describe, expect, it } from "vitest";
import { verifyMigrationResults } from "./verify-d1.mjs";

/** 构造真实 Wrangler JSON 形状的结果。 / Build the actual Wrangler JSON result shape. */
function results() {
  return [
    { success: true, results: [] },
    { success: true, results: [{ quick_check: "ok" }] },
    { success: true, results: [{ name: "0001.sql" }] },
  ];
}

describe("remote migration gate", () => {
  it("accepts only exact migrated schema with clean constraints", () => {
    expect(() => verifyMigrationResults(results(), ["0001.sql"])).not.toThrow();
    expect(() =>
      verifyMigrationResults(results(), ["0001.sql", "0002.sql"]),
    ).toThrow("ledger");
  });
  it("rejects nonempty foreign keys, corrupt integrity and malformed output", () => {
    const foreign = results();
    foreign[0]!.results = [{ name: "violating-row" }];
    expect(() => verifyMigrationResults(foreign, ["0001.sql"])).toThrow(
      "foreign-key",
    );
    const corrupt = results();
    corrupt[1]!.results = [{ quick_check: "corrupt" }];
    expect(() => verifyMigrationResults(corrupt, ["0001.sql"])).toThrow(
      "integrity",
    );
    expect(() => verifyMigrationResults([], ["0001.sql"])).toThrow(
      "Unexpected",
    );
  });
});

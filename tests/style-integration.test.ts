import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

/** 固定上游发行字节，不把应用风格适配混进供应商代码。 / Pin upstream bytes; keep application adapters outside vendor code. */
it("preserves the official style release hashes and license", () => {
  const root = "apps/ops/vendor/moesegfault-style/v0.1.2";
  const provenance = JSON.parse(
    readFileSync(join(root, "provenance.json"), "utf8"),
  );
  expect(provenance.version).toBe("0.1.2");
  expect(provenance.commit).toMatch(/^[a-f0-9]{40}$/);
  expect(provenance.license).toBe("GPL-3.0-or-later");
  expect(readFileSync(join(root, "LICENSE"), "utf8")).toContain(
    "GNU GENERAL PUBLIC LICENSE",
  );
  for (const file of provenance.files) {
    const bytes = readFileSync(join(root, file.path));
    expect(bytes.length, file.path).toBe(file.bytes);
    expect(createHash("sha256").update(bytes).digest("hex"), file.path).toBe(
      file.sha256,
    );
  }
});

/** 应用只能消费已存在的官方语义令牌。 / Application CSS may only consume existing official tokens. */
it("uses declared upstream tokens rather than an independent palette", () => {
  const root = "apps/ops/vendor/moesegfault-style/v0.1.2/css";
  const upstream = ["tokens", "foundation", "components", "icons", "motion"]
    .map((file) => readFileSync(join(root, `${file}.css`), "utf8"))
    .join("\n");
  const declared = new Set(
    [...upstream.matchAll(/(--moe-[\w-]+)\s*:/g)].map((match) => match[1]),
  );
  const app = readFileSync("apps/ops/src/styles.css", "utf8");
  for (const match of app.matchAll(/var\((--moe-[\w-]+)/g))
    expect(declared.has(match[1]), match[1]).toBe(true);
  expect(app).not.toMatch(/#[a-fA-F0-9]{3,8}\b|rgba?\(/);
});

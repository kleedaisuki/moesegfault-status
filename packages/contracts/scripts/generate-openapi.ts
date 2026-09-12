import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { format } from "prettier";
import { buildOpenApiDocument } from "../src/openapi.js";

/** 将共享 Zod schema 确定性写为 OpenAPI / Deterministically write shared Zod schemas as OpenAPI. */
async function main(): Promise<void> {
  const output = fileURLToPath(new URL("../openapi.json", import.meta.url));
  const document = await format(JSON.stringify(buildOpenApiDocument()), {
    parser: "json",
  });
  await writeFile(output, document, "utf8");
}

await main();

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { gate } from "./openapi-gate.js";

/** 写入测试 OpenAPI 文档。 / Write a test OpenAPI document. */
async function writeDocument(
  directory: string,
  name: string,
  paths: object,
): Promise<string> {
  const file = path.join(directory, name);
  await writeFile(
    file,
    JSON.stringify({
      openapi: "3.1.1",
      info: { title: "test", version: "1" },
      paths,
    }),
  );
  return file;
}

describe("OpenAPI compatibility gate", () => {
  it("accepts additive operations", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "moe-oas-"));
    const get = {
      operationId: "getStatus",
      security: [],
      responses: { "200": {}, "400": {} },
    };
    const baseline = await writeDocument(directory, "baseline.json", {
      "/v1/status": { get },
    });
    const current = await writeDocument(directory, "current.json", {
      "/v1/status": { get },
      "/v1/incidents": {
        get: {
          operationId: "listIncidents",
          security: [],
          responses: { "200": {}, "400": {} },
        },
      },
    });
    await expect(gate(current, baseline)).resolves.toBeUndefined();
  });

  it("rejects removed operations", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "moe-oas-"));
    const baseline = await writeDocument(directory, "baseline.json", {
      "/v1/status": {
        get: {
          operationId: "getStatus",
          security: [],
          responses: { "200": {}, "404": {} },
        },
      },
    });
    const current = await writeDocument(directory, "current.json", {});
    await expect(gate(current, baseline)).rejects.toThrow(
      "removed GET /v1/status",
    );
  });

  it("fails conservatively when an existing response shape changes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "moe-oas-"));
    const response = (schema: object) => ({
      operationId: "getStatus",
      security: [],
      responses: {
        "200": { content: { "application/json": { schema } } },
        "404": {},
      },
    });
    const baseline = await writeDocument(directory, "baseline.json", {
      "/v1/status": { get: response({ type: "object" }) },
    });
    const current = await writeDocument(directory, "current.json", {
      "/v1/status": {
        get: response({ type: "object", required: ["status"] }),
      },
    });
    await expect(gate(current, baseline)).rejects.toThrow(
      "response 200 changed",
    );
  });
});

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

interface Operation {
  readonly operationId?: unknown;
  readonly responses?: unknown;
  readonly security?: unknown;
  readonly parameters?: unknown;
  readonly requestBody?: unknown;
}
interface OpenApiDocument {
  readonly openapi?: unknown;
  readonly paths?: unknown;
  readonly components?: unknown;
}

/** 校验 OpenAPI 安全不变量，并可拒绝明显破坏性删除。 / Validate OpenAPI safety invariants and reject evident breaking removals. */
export async function gate(
  currentPath: string,
  baselinePath?: string,
): Promise<void> {
  const current = await document(currentPath);
  validate(current);
  if (baselinePath === undefined) return;
  const baseline = await document(baselinePath);
  for (const [route, method, operation] of operations(baseline)) {
    const candidate = operationAt(current, route, method);
    if (candidate === undefined)
      throw new Error(
        `breaking OpenAPI change: removed ${method.toUpperCase()} ${route}`,
      );
    if (candidate.operationId !== operation.operationId)
      throw new Error(
        `breaking OpenAPI change: operationId changed for ${method.toUpperCase()} ${route}`,
      );
    const oldResponses = responseCodes(operation);
    const newResponses = responseCodes(candidate);
    for (const code of oldResponses) {
      if (!newResponses.has(code))
        throw new Error(
          `breaking OpenAPI change: removed response ${code} from ${method.toUpperCase()} ${route}`,
        );
      if (
        stableShape((operation.responses as Record<string, unknown>)[code]) !==
        stableShape((candidate.responses as Record<string, unknown>)[code])
      ) {
        throw new Error(
          `potentially breaking OpenAPI change: response ${code} changed for ${method.toUpperCase()} ${route}`,
        );
      }
    }
    for (const field of ["security", "parameters", "requestBody"] as const) {
      if (stableShape(operation[field]) !== stableShape(candidate[field])) {
        throw new Error(
          `potentially breaking OpenAPI change: ${field} changed for ${method.toUpperCase()} ${route}`,
        );
      }
    }
  }
  compareExistingComponents(baseline, current);
}

function validate(value: OpenApiDocument): void {
  if (value.openapi !== "3.1.1")
    throw new Error("OpenAPI version must be exactly 3.1.1");
  const ids = new Set<string>();
  for (const [route, method, operation] of operations(value)) {
    if (
      typeof operation.operationId !== "string" ||
      operation.operationId.length === 0
    )
      throw new Error(`${method} ${route} lacks operationId`);
    if (ids.has(operation.operationId))
      throw new Error(`duplicate operationId: ${operation.operationId}`);
    ids.add(operation.operationId);
    if (!Array.isArray(operation.security))
      throw new Error(`${method} ${route} must declare security explicitly`);
    const codes = responseCodes(operation);
    if (![...codes].some((code) => /^2\d\d$/u.test(code)))
      throw new Error(`${method} ${route} lacks a success response`);
    if (![...codes].some((code) => /^4\d\d$/u.test(code)))
      throw new Error(`${method} ${route} lacks an error response`);
  }
}

function* operations(
  value: OpenApiDocument,
): Generator<readonly [string, string, Operation]> {
  if (!isRecord(value.paths))
    throw new Error("OpenAPI paths must be an object");
  for (const [route, item] of Object.entries(value.paths)) {
    if (!isRecord(item))
      throw new Error(`path item must be an object: ${route}`);
    for (const method of ["get", "post", "put", "patch", "delete"]) {
      const operation = item[method];
      if (operation !== undefined) {
        if (!isRecord(operation))
          throw new Error(`operation must be an object: ${method} ${route}`);
        yield [route, method, operation as Operation] as const;
      }
    }
  }
}

function operationAt(
  value: OpenApiDocument,
  route: string,
  method: string,
): Operation | undefined {
  if (
    !isRecord(value.paths) ||
    !isRecord(value.paths[route]) ||
    !isRecord(value.paths[route][method])
  )
    return undefined;
  return value.paths[route][method] as Operation;
}

function responseCodes(operation: Operation): ReadonlySet<string> {
  if (!isRecord(operation.responses))
    throw new Error(
      `operation ${String(operation.operationId)} lacks responses`,
    );
  return new Set(Object.keys(operation.responses));
}

function compareExistingComponents(
  baseline: OpenApiDocument,
  current: OpenApiDocument,
): void {
  if (!isRecord(baseline.components)) return;
  if (!isRecord(current.components))
    throw new Error("breaking OpenAPI change: removed components");
  for (const [category, oldEntries] of Object.entries(baseline.components)) {
    if (!isRecord(oldEntries)) continue;
    const newEntries = current.components[category];
    if (!isRecord(newEntries))
      throw new Error(
        `breaking OpenAPI change: removed component category ${category}`,
      );
    for (const [name, oldValue] of Object.entries(oldEntries)) {
      if (!(name in newEntries))
        throw new Error(
          `breaking OpenAPI change: removed component ${category}.${name}`,
        );
      if (stableShape(oldValue) !== stableShape(newEntries[name])) {
        throw new Error(
          `potentially breaking OpenAPI change: component ${category}.${name} changed`,
        );
      }
    }
  }
}

function stableShape(value: unknown): string {
  return JSON.stringify(stripAnnotations(value));
}

function stripAnnotations(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripAnnotations);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (
      [
        "description",
        "summary",
        "title",
        "example",
        "examples",
        "externalDocs",
      ].includes(key)
    )
      continue;
    result[key] = stripAnnotations(value[key]);
  }
  return result;
}

async function document(file: string): Promise<OpenApiDocument> {
  return JSON.parse(await readFile(file, "utf8")) as OpenApiDocument;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const [current, baseline] = process.argv.slice(2);
  if (current === undefined)
    throw new Error(
      "usage: tsx scripts/release/openapi-gate.ts <current.json> [baseline.json]",
    );
  gate(current, baseline).catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "OpenAPI gate failed"}\n`,
    );
    process.exitCode = 1;
  });
}

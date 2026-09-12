import type { EvidenceRecord } from "../../../../packages/contracts/src/backend-query.js";
import { sanitizeAttributes, sanitizeText } from "@moesegfault/telemetry";

import { requireAllowedHttpsUrl } from "./config.js";
import {
  compileLogQuery,
  compileMetricQuery,
  compileProfileQuery,
} from "./query.js";
import type { AdapterContext, AdapterResult } from "./types.js";

const MAX_RECORDS = 100;

/** 对已校验的有限适配器执行只读查询 / Execute a read-only query through a validated finite adapter. */
export async function executeAdapter(
  context: AdapterContext,
): Promise<AdapterResult> {
  switch (context.adapter) {
    case "tempo":
      return queryTempo(context);
    case "loki":
      return queryLoki(context);
    case "prometheus":
      return queryPrometheus(context);
    case "pyroscope":
      return queryPyroscope(context);
    case "source-commit":
      return sourceCommit(context);
    case "artifact-registry":
      return artifactReference(context);
  }
}

async function queryTempo(context: AdapterContext): Promise<AdapterResult> {
  const reference = context.resolved.reference;
  if (reference.kind !== "trace")
    return unsupported(context, "Tempo requires a trace reference");
  const url = apiUrl(
    context,
    "api",
    "v2",
    "traces",
    reference.locator.trace_id,
  );
  const loaded = await fetchJson(context, url);
  if (!("data" in loaded)) return loaded;
  const spans = collectObjects(loaded.data, "spans");
  const records = spans.slice(0, MAX_RECORDS).map((span, index) => {
    const attributes = flatAttributes(span.attributes);
    put(attributes, "span_id", scalar(span.spanId));
    put(attributes, "parent_span_id", scalar(span.parentSpanId));
    put(attributes, "status", scalar(object(span.status)?.code));
    return record(
      scalar(span.name) ?? `span ${index + 1}`,
      nanoTimestamp(scalar(span.startTimeUnixNano)),
      attributes,
    );
  });
  return ok(context, records, spans.length > records.length, {
    trace_id: reference.locator.trace_id,
  });
}

async function queryLoki(context: AdapterContext): Promise<AdapterResult> {
  const reference = context.resolved.reference;
  if (reference.kind !== "log_query")
    return unsupported(context, "Loki requires a log_query reference");
  const expression = compileLogQuery(
    reference.locator.query,
    queryIdentity(reference),
  );
  if (expression === undefined)
    return unsupported(
      context,
      "Loki locator requires finite structured keys with matching service and deployment identity",
    );
  const url = apiUrl(context, "loki", "api", "v1", "query_range");
  url.searchParams.set("query", expression);
  url.searchParams.set("start", epochNanoseconds(reference.time_range.start));
  url.searchParams.set("end", epochNanoseconds(reference.time_range.end));
  url.searchParams.set("limit", String(MAX_RECORDS));
  url.searchParams.set("direction", "backward");
  const loaded = await fetchJson(context, url);
  if (!("data" in loaded)) return loaded;
  const root = object(loaded.data);
  const data = object(root?.data);
  const streams = array(data?.result);
  const records: EvidenceRecord[] = [];
  for (const streamValue of streams) {
    const stream = object(streamValue);
    const labels = primitiveRecord(stream?.stream ?? stream?.metric);
    for (const value of array(stream?.values)) {
      const pair = array(value);
      const line = scalar(pair[1]);
      if (line === undefined) continue;
      records.push(record(line, nanoTimestamp(scalar(pair[0])), labels));
      if (records.length === MAX_RECORDS) break;
    }
    if (records.length === MAX_RECORDS) break;
  }
  return ok(context, records, records.length === MAX_RECORDS, {
    query: expression,
    start: reference.time_range.start,
    end: reference.time_range.end,
  });
}

async function queryPrometheus(
  context: AdapterContext,
): Promise<AdapterResult> {
  const reference = context.resolved.reference;
  if (reference.kind !== "metric_query")
    return unsupported(context, "Prometheus requires a metric_query reference");
  const expression = compileMetricQuery(
    reference.locator.metric_name,
    reference.locator.query,
    queryIdentity(reference),
  );
  if (expression === undefined)
    return unsupported(
      context,
      "Prometheus locator requires finite structured keys with matching service and deployment identity",
    );
  const url = apiUrl(context, "api", "v1", "query_range");
  url.searchParams.set("query", expression);
  url.searchParams.set("start", reference.time_range.start);
  url.searchParams.set("end", reference.time_range.end);
  url.searchParams.set(
    "step",
    String(rangeStep(reference.time_range.start, reference.time_range.end)),
  );
  const loaded = await fetchJson(context, url);
  if (!("data" in loaded)) return loaded;
  const root = object(loaded.data);
  const data = object(root?.data);
  const series = array(data?.result);
  const records: EvidenceRecord[] = [];
  for (const seriesValue of series) {
    const item = object(seriesValue);
    const labels = primitiveRecord(item?.metric);
    const samples =
      array(item?.values).length > 0 ? array(item?.values) : [item?.value];
    for (const sampleValue of samples) {
      const sample = array(sampleValue);
      if (sample.length < 2) continue;
      const value = scalar(sample[1]);
      records.push(
        record(
          `${reference.locator.metric_name} = ${value ?? "unknown"}`,
          secondTimestamp(sample[0]),
          labels,
        ),
      );
      if (records.length === MAX_RECORDS) break;
    }
    if (records.length === MAX_RECORDS) break;
  }
  return ok(context, records, records.length === MAX_RECORDS, {
    query: expression,
    start: reference.time_range.start,
    end: reference.time_range.end,
  });
}

async function queryPyroscope(context: AdapterContext): Promise<AdapterResult> {
  const reference = context.resolved.reference;
  if (reference.kind !== "profile")
    return unsupported(context, "Pyroscope requires a profile reference");
  const expression = compileProfileQuery(
    reference.locator.profile_type,
    reference.locator.profile_id,
    reference.locator.query,
    queryIdentity(reference),
  );
  if (expression === undefined)
    return unsupported(
      context,
      "Pyroscope locator requires finite structured keys with matching service and deployment identity; profile_id is not a query expression",
    );
  const url = apiUrl(context, "pyroscope", "render");
  url.searchParams.set("query", expression);
  url.searchParams.set("from", epochSeconds(reference.time_range.start));
  url.searchParams.set("until", epochSeconds(reference.time_range.end));
  url.searchParams.set("format", "json");
  url.searchParams.set("maxNodes", String(MAX_RECORDS));
  const loaded = await fetchJson(context, url);
  if (!("data" in loaded)) return loaded;
  const root = object(loaded.data);
  const flamebearer = object(root?.flamebearer);
  const names = array(flamebearer?.names).filter(
    (value): value is string => typeof value === "string",
  );
  const records = names
    .slice(0, MAX_RECORDS)
    .map((name) =>
      record(name, undefined, { profile_type: reference.locator.profile_type }),
    );
  return ok(context, records, names.length > records.length, {
    query: expression,
    from: reference.time_range.start,
    until: reference.time_range.end,
  });
}

function sourceCommit(context: AdapterContext): AdapterResult {
  const reference = context.resolved.reference;
  if (reference.kind !== "source")
    return unsupported(context, "source-commit requires a source reference");
  const locator = reference.locator;
  if (
    canonicalRepository(locator.repository_url) !==
      canonicalRepository(context.resolved.repositoryUrl) ||
    locator.git_commit !== context.resolved.gitCommit
  )
    return unavailable(
      context,
      "Source locator does not match immutable deployment provenance",
    );
  const repository = requireAllowedHttpsUrl(
    locator.repository_url,
    context.config.allowed_hosts,
  );
  repository.pathname = `${repository.pathname.replace(/\/$/u, "").replace(/\.git$/u, "")}${repository.hostname === "gitlab.com" ? "/-/blob/" : "/blob/"}${locator.git_commit}/${locator.path.split("/").map(encodeURIComponent).join("/")}`;
  repository.search = "";
  repository.hash = locator.line === undefined ? "" : `L${locator.line}`;
  if (repository.href.length > 2048)
    return unavailable(context, "Source URL exceeds the safe length limit");
  return {
    status: "ok",
    ui_url: repository.href,
    records: [
      record(locator.path, undefined, {
        git_commit: locator.git_commit,
        ...(locator.line === undefined ? {} : { line: locator.line }),
        ...(locator.column === undefined ? {} : { column: locator.column }),
      }),
    ],
    truncated: false,
  };
}

function artifactReference(context: AdapterContext): AdapterResult {
  const reference = context.resolved.reference;
  if (reference.kind !== "artifact")
    return unsupported(
      context,
      "artifact-registry requires an artifact reference",
    );
  const locator = reference.locator;
  return ok(
    context,
    [
      record(locator.artifact_kind, undefined, {
        artifact_digest: locator.artifact_digest,
        ...(locator.build_id === undefined
          ? {}
          : { build_id: locator.build_id }),
      }),
    ],
    false,
    {
      artifact_digest: locator.artifact_digest,
      artifact_kind: locator.artifact_kind,
      ...(locator.build_id === undefined ? {} : { build_id: locator.build_id }),
    },
  );
}

function ok(
  context: AdapterContext,
  records: readonly EvidenceRecord[],
  truncated: boolean,
  uiValues: Readonly<Record<string, string>>,
): AdapterResult {
  return {
    status: "ok",
    ui_url: uiUrl(context, uiValues),
    records: [...records],
    truncated,
  };
}

function unsupported(context: AdapterContext, detail: string): AdapterResult {
  return {
    status: "unsupported",
    ui_url: uiUrl(context, {}),
    records: [],
    truncated: false,
    detail,
  };
}

function unavailable(context: AdapterContext, detail: string): AdapterResult {
  return {
    status: "unavailable",
    ui_url: null,
    records: [],
    truncated: false,
    detail,
  };
}

function apiUrl(context: AdapterContext, ...segments: readonly string[]): URL {
  const url = requireAllowedHttpsUrl(
    context.config.endpoint,
    context.config.allowed_hosts,
  );
  url.pathname = `${url.pathname.replace(/\/$/u, "")}/${segments.map(encodeURIComponent).join("/")}`;
  url.search = "";
  url.hash = "";
  return url;
}

async function fetchJson(
  context: AdapterContext,
  url: URL,
): Promise<{ readonly data: unknown } | AdapterResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), context.config.timeout_ms);
  try {
    const headers = new Headers({ accept: "application/json" });
    if (context.config.auth_scheme !== "none") {
      if (context.credential === undefined)
        return unavailable(
          context,
          "Configured auth_reference has no secret value",
        );
      headers.set(
        "authorization",
        `${context.config.auth_scheme === "basic" ? "Basic" : "Bearer"} ${context.credential}`,
      );
    }
    if (context.config.tenant_id !== undefined)
      headers.set("x-scope-orgid", context.config.tenant_id);
    const response = await context.fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
      redirect: "error",
    });
    if (response.status === 404) {
      await cancelBody(response);
      return {
        status: "not_found",
        ui_url: uiUrl(context, {}),
        records: [],
        truncated: false,
      };
    }
    if (!response.ok) {
      await cancelBody(response);
      return unavailable(
        context,
        `Telemetry backend returned HTTP ${response.status}`,
      );
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(contentLength) &&
      contentLength > context.config.max_response_bytes
    ) {
      await cancelBody(response);
      return unavailable(
        context,
        "Telemetry response exceeds the configured byte limit",
      );
    }
    const body = await readBounded(response, context.config.max_response_bytes);
    try {
      return { data: JSON.parse(new TextDecoder().decode(body)) as unknown };
    } catch {
      return unavailable(context, "Telemetry backend returned invalid JSON");
    }
  } catch {
    return unavailable(
      context,
      "Telemetry backend request failed or timed out",
    );
  } finally {
    clearTimeout(timer);
  }
}

async function readBounded(
  response: Response,
  maximum: number,
): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel().catch(() => undefined);
        throw new Error("response too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/** 取消无需读取的供应商响应；释放失败不能覆盖既定状态。/ Cancels an unread vendor response without letting cleanup failure replace the established status. */
async function cancelBody(response: Response): Promise<void> {
  if (response.body === null) return;
  await response.body.cancel().catch(() => undefined);
}

function uiUrl(
  context: AdapterContext,
  values: Readonly<Record<string, string>>,
): string | null {
  try {
    let rendered = context.resolved.uiUrlTemplate;
    const used = new Set<string>();
    for (const [key, value] of Object.entries(values)) {
      const placeholder = `{${key}}`;
      if (!rendered.includes(placeholder)) continue;
      rendered = rendered.replaceAll(placeholder, encodeURIComponent(value));
      used.add(key);
    }
    if (/[{}]/u.test(rendered)) return null;
    const url = requireAllowedHttpsUrl(rendered, context.config.allowed_hosts);
    for (const [key, value] of Object.entries(values)) {
      if (!used.has(key)) url.searchParams.set(key, value);
    }
    return url.href.length <= 2048 ? url.href : null;
  } catch {
    return null;
  }
}

function rangeStep(start: string, end: string): number {
  const seconds = Math.max(1, (Date.parse(end) - Date.parse(start)) / 1000);
  return Math.max(1, Math.ceil(seconds / MAX_RECORDS));
}

function epochSeconds(value: string): string {
  return String(Math.floor(Date.parse(value) / 1000));
}

function epochNanoseconds(value: string): string {
  return `${Date.parse(value)}000000`;
}

function nanoTimestamp(value: string | undefined): string | undefined {
  if (value === undefined || !/^\d{1,30}$/u.test(value)) return undefined;
  try {
    return new Date(Number(BigInt(value) / 1_000_000n)).toISOString();
  } catch {
    return undefined;
  }
}

function secondTimestamp(value: unknown): string | undefined {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(numeric)) return undefined;
  try {
    return new Date(numeric * 1000).toISOString();
  } catch {
    return undefined;
  }
}

function record(
  title: string,
  timestamp: string | undefined,
  attributes: Readonly<Record<string, string | number | boolean | null>>,
): EvidenceRecord {
  const candidates: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  const allowed = new Set<string>();
  for (const [rawKey, value] of Object.entries(attributes).slice(0, 32)) {
    const key = sanitizeText(rawKey, 64);
    if (key.length === 0) continue;
    allowed.add(key);
    candidates[key] = value;
  }
  const sanitized = sanitizeAttributes(candidates, {
    allowed,
    maxStringLength: 512,
  });
  const safeAttributes: Record<string, string | number | boolean | null> =
    Object.create(null) as Record<string, string | number | boolean | null>;
  for (const [key, value] of Object.entries(sanitized)) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    )
      safeAttributes[key] = value;
  }
  for (const [key, value] of Object.entries(candidates)) {
    if (
      value === null &&
      /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/u.test(key) &&
      !(key in safeAttributes)
    )
      safeAttributes[key] = null;
  }
  const safeTitle = sanitizeText(title, 512).trim();
  return {
    title: safeTitle || "evidence",
    attributes: safeAttributes,
    ...(timestamp === undefined ? {} : { timestamp }),
  };
}

/** 从权威 TelemetryReference 提取不可变 query scope。/ Extracts immutable query scope from the authoritative TelemetryReference. */
function queryIdentity(reference: {
  readonly service_name: string;
  readonly deployment_id: string;
}): Readonly<{ serviceName: string; deploymentId: string }> {
  return {
    serviceName: reference.service_name,
    deploymentId: reference.deployment_id,
  };
}

function collectObjects(
  value: unknown,
  key: string,
  found: Record<string, unknown>[] = [],
): Record<string, unknown>[] {
  if (found.length > MAX_RECORDS) return found;
  if (Array.isArray(value)) {
    for (const item of value) collectObjects(item, key, found);
  } else {
    const item = object(value);
    if (item !== undefined) {
      const matches = array(item[key]);
      for (const match of matches) {
        const candidate = object(match);
        if (candidate !== undefined) found.push(candidate);
      }
      for (const [nestedKey, nested] of Object.entries(item))
        if (nestedKey !== key) collectObjects(nested, key, found);
    }
  }
  return found;
}

function flatAttributes(
  value: unknown,
): Record<string, string | number | boolean | null> {
  const output: Record<string, string | number | boolean | null> = {};
  for (const entryValue of array(value).slice(0, 32)) {
    const entry = object(entryValue);
    const key = scalar(entry?.key);
    const nested = object(entry?.value);
    const item =
      nested === undefined
        ? undefined
        : Object.values(nested).find(
            (candidate) =>
              typeof candidate === "string" ||
              typeof candidate === "number" ||
              typeof candidate === "boolean",
          );
    if (key !== undefined && item !== undefined) output[key] = item;
  }
  return output;
}

function primitiveRecord(
  value: unknown,
): Record<string, string | number | boolean | null> {
  const candidate = object(value);
  if (candidate === undefined) return {};
  return Object.fromEntries(
    Object.entries(candidate)
      .filter(
        (entry): entry is [string, string | number | boolean | null] =>
          entry[1] === null ||
          ["string", "number", "boolean"].includes(typeof entry[1]),
      )
      .slice(0, 32),
  );
}

function put(
  target: Record<string, string | number | boolean | null>,
  key: string,
  value: string | undefined,
): void {
  if (value !== undefined && Object.keys(target).length < 32)
    target[key] = value;
}

function canonicalRepository(raw: string): string {
  const url = new URL(raw);
  return `${url.origin}${url.pathname.replace(/\/$/u, "").replace(/\.git$/u, "")}`;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function scalar(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : undefined;
}

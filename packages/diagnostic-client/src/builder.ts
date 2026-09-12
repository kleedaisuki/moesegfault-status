import {
  DIAGNOSTIC_EVENT_MAX_BODY_BYTES,
  DiagnosticAttributesSchema,
  DiagnosticEventSchema,
  DiagnosticFingerprintSchema,
  type DiagnosticAttributes,
  type DiagnosticEvent,
  type DiagnosticFingerprint,
} from "@moesegfault/contracts";
import {
  createCorrelationId,
  defineResource,
  sanitizeAttributes,
  sanitizeText,
  type ResourceIdentity,
} from "@moesegfault/telemetry";

import { validateSafeEvidence } from "./evidence.js";
import {
  createDiagnosticPropagation,
  validatePropagation,
} from "./propagation.js";
import { ownPrepared } from "./prepared.js";
import type {
  DiagnosticEventInput,
  DiagnosticManifestIdentity,
  DiagnosticRecoveryInput,
  PreparedDiagnosticEvent,
} from "./types.js";

const ATTRIBUTE_KEYS = new Set<keyof DiagnosticAttributes>([
  "dependency.name",
  "operation.name",
  "error.type",
  "component.id",
  "cloud.region",
  "http.request.method",
  "http.response.status_code",
  "rpc.system",
  "db.system.name",
  "deployment.environment.name",
]);
const ATTRIBUTE_STRING_LIMITS: Readonly<
  Partial<Record<keyof DiagnosticAttributes, number>>
> = Object.freeze({
  "dependency.name": 128,
  "operation.name": 128,
  "error.type": 128,
  "component.id": 128,
  "cloud.region": 64,
  "http.request.method": 16,
  "rpc.system": 64,
  "db.system.name": 64,
  "deployment.environment.name": 16,
});
const FINGERPRINT_LIMITS = Object.freeze({
  dependency: 128,
  operation: 128,
  error_type: 128,
  component: 128,
  capability: 128,
  region: 64,
  protocol: 16,
} satisfies Readonly<Record<keyof DiagnosticFingerprint, number>>);

/**
 * 从不可变部署 manifest 生成共享 ResourceIdentity。
 * Creates shared ResourceIdentity from an immutable deployment manifest.
 */
export function resourceFromManifest(
  manifest: DiagnosticManifestIdentity,
): Readonly<ResourceIdentity> {
  return defineResource({
    "service.namespace": "moeSegFault",
    "service.name": manifest.service_name,
    "service.version": manifest.service_version,
    "deployment.environment.name": manifest.environment,
    "moesegfault.deployment.id": manifest.deployment_id,
    "moesegfault.build.revision": manifest.git_commit,
    "moesegfault.artifact.digest":
      manifest.artifact_digest as `sha256:${string}`,
  });
}

/**
 * 绑定单一 manifest/resource 身份的 Diagnostic 事件构建器。
 * Diagnostic event builder bound to one manifest/resource identity.
 *
 * 每次调用只生成一次 event UUIDv7 与规范 JSON；队列重试不会重建事件。
 * Each call generates its event UUIDv7 and canonical JSON exactly once; queue retries never rebuild it.
 */
export class DiagnosticEventBuilder {
  readonly #resource: Readonly<ResourceIdentity>;
  readonly #now: () => number;

  /** 校验并固定资源来源。/ Validates and pins resource provenance. */
  constructor(
    resource: Readonly<ResourceIdentity>,
    options: Readonly<{
      manifest?: DiagnosticManifestIdentity;
      now?: () => number;
    }> = {},
  ) {
    this.#resource = defineResource(resource);
    if (options.manifest !== undefined) {
      assertManifestBinding(this.#resource, options.manifest);
    }
    this.#now = options.now ?? Date.now;
  }

  /** 构建新的不可变故障信号。/ Builds a new immutable fault signal. */
  fault(input: DiagnosticEventInput): PreparedDiagnosticEvent {
    return this.#build(input, "fault");
  }

  /** 构建显式、因果绑定的恢复信号。/ Builds an explicit, causally bound recovery signal. */
  recovery(input: DiagnosticRecoveryInput): PreparedDiagnosticEvent {
    return this.#build(input, "recovery", input.recoveryOfEventId);
  }

  /** 构建并预序列化一个事件。/ Builds and pre-serializes one event. */
  #build(
    input: DiagnosticEventInput,
    signal: "fault" | "recovery",
    recoveryOfEventId?: string,
  ): PreparedDiagnosticEvent {
    const nowMs = this.#now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new RangeError(
        "now must return a non-negative safe epoch millisecond",
      );
    }
    const propagation =
      input.propagation === undefined
        ? createDiagnosticPropagation(nowMs)
        : validatePropagation(input.propagation);
    const summary = sanitizeText(input.summary, 512).trim();
    if (summary.length === 0) {
      throw new TypeError("summary must contain displayable text");
    }

    const event = DiagnosticEventSchema.parse({
      event_id: createCorrelationId(nowMs),
      schema_version: "1.0",
      kind: input.kind,
      signal,
      ...(recoveryOfEventId === undefined
        ? {}
        : { recovery_of_event_id: recoveryOfEventId }),
      severity: input.severity,
      service_name: this.#resource["service.name"],
      environment: this.#resource["deployment.environment.name"],
      deployment_id: this.#resource["moesegfault.deployment.id"],
      ...(input.instanceId === undefined
        ? {}
        : { instance_id: input.instanceId }),
      occurred_at: occurredAt(input.occurredAt, nowMs),
      correlation_id: propagation.correlationId,
      trace_id: propagation.traceId,
      span_id: propagation.spanId,
      summary,
      fingerprint: sanitizeFingerprint(input.fingerprint),
      evidence: (input.evidence ?? []).map(validateSafeEvidence),
      attributes: sanitizeDiagnosticAttributes(input.attributes ?? {}),
    });
    const immutableEvent = deepFreeze(event);
    const wireBody = JSON.stringify(immutableEvent);
    const bodyBytes = new TextEncoder().encode(wireBody).byteLength;
    if (bodyBytes > DIAGNOSTIC_EVENT_MAX_BODY_BYTES) {
      throw new RangeError(
        `diagnostic event exceeds ${DIAGNOSTIC_EVENT_MAX_BODY_BYTES} UTF-8 bytes`,
      );
    }
    return ownPrepared(
      Object.freeze({
        event: immutableEvent,
        bodyBytes,
        wireBody,
        propagation,
      }),
    );
  }
}

/** 交叉校验 runtime resource 与 manifest 声明。/ Cross-checks runtime resource against its manifest declaration. */
function assertManifestBinding(
  resource: Readonly<ResourceIdentity>,
  manifest: DiagnosticManifestIdentity,
): void {
  const expected = resourceFromManifest(manifest);
  for (const key of Object.keys(expected) as (keyof ResourceIdentity)[]) {
    if (resource[key] !== expected[key]) {
      throw new TypeError(`resource does not match manifest field: ${key}`);
    }
  }
}

/** 清理并限制 fingerprint 到稳定的显式字段。/ Scrubs and limits a fingerprint to explicit stable fields. */
function sanitizeFingerprint(
  input: Readonly<DiagnosticFingerprint>,
): DiagnosticFingerprint {
  const output: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const key of Object.keys(
    FINGERPRINT_LIMITS,
  ) as (keyof DiagnosticFingerprint)[]) {
    const value = input[key];
    if (value === undefined) continue;
    output[key] = sanitizeText(value, FINGERPRINT_LIMITS[key]);
  }
  return DiagnosticFingerprintSchema.parse(output);
}

/** 以共享 sanitizer 复制 Diagnostic 属性允许列表。/ Copies the Diagnostic attribute allowlist through the shared sanitizer. */
function sanitizeDiagnosticAttributes(
  input: Readonly<Record<string, unknown>>,
): DiagnosticAttributes {
  const sanitized = sanitizeAttributes(input, {
    allowed: ATTRIBUTE_KEYS,
    maxStringLength: 128,
  });
  const bounded: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const [key, value] of Object.entries(sanitized)) {
    const limit = ATTRIBUTE_STRING_LIMITS[key as keyof DiagnosticAttributes];
    bounded[key] =
      typeof value === "string" && limit !== undefined
        ? sanitizeText(value, limit)
        : value;
  }
  return DiagnosticAttributesSchema.parse(bounded);
}

/** 规范化发生时间为 UTC RFC 3339。/ Normalizes occurrence time to UTC RFC 3339. */
function occurredAt(value: Date | string | undefined, nowMs: number): string {
  if (value === undefined) return new Date(nowMs).toISOString();
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime()))
      throw new TypeError("occurredAt is invalid");
    return value.toISOString();
  }
  return value;
}

/** 深冻结 schema 克隆，避免 enqueue 后 payload 漂移。/ Deep-freezes the schema clone so payload cannot drift after enqueue. */
function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value))
    return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

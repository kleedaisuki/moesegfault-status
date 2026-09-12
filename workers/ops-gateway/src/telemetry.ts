import {
  acceptCorrelationId,
  acceptTraceContext,
  createTelemetry,
  injectTraceContext,
  type BoundaryContext,
  type DeploymentEnvironment,
  type Telemetry,
} from "@moesegfault/telemetry";

/** Gateway 遥测所需的部署来源配置 / Deployment provenance required by gateway telemetry. */
export interface GatewayTelemetryEnv {
  /** Deployment Registry UUIDv7 / Deployment Registry UUIDv7. */
  readonly DEPLOYMENT_ID: string;
  /** 完整 Git OID / Full Git OID. */
  readonly GIT_COMMIT: string;
  /** 已部署 bundle 的 SHA-256 / SHA-256 of the deployed bundle. */
  readonly ARTIFACT_DIGEST: string;
  /** Gateway 发布版本 / Gateway release version. */
  readonly STATUS_VERSION: string;
  /** 标准部署环境 / Standard deployment environment. */
  readonly ENVIRONMENT: string;
}

const ALLOWED_ATTRIBUTES = new Set([
  "error.type",
  "http.request.method",
  "http.response.status_code",
]);

/**
 * 为单次 invocation 创建共享遥测门面；只有完全未配置的本地开发可禁用。
 * Creates the shared telemetry facade for one invocation; only wholly unconfigured local development may disable it.
 */
export function createGatewayTelemetry(
  env: GatewayTelemetryEnv,
): Telemetry | undefined {
  const provenance = [
    env.DEPLOYMENT_ID,
    env.GIT_COMMIT,
    env.ARTIFACT_DIGEST,
    env.STATUS_VERSION,
  ];
  const allEmpty = provenance.every((value) => value === "");
  if (env.ENVIRONMENT === "development" && allEmpty) return undefined;
  if (provenance.some((value) => value === "")) {
    throw new Error("Deployment provenance must be complete");
  }
  if (!isDeploymentEnvironment(env.ENVIRONMENT)) {
    throw new Error("ENVIRONMENT is invalid");
  }
  if (!isArtifactDigest(env.ARTIFACT_DIGEST)) {
    throw new Error("ARTIFACT_DIGEST is invalid");
  }

  return createTelemetry({
    resource: {
      "service.namespace": "moeSegFault",
      "service.name": "ops-gateway",
      "service.version": env.STATUS_VERSION,
      "deployment.environment.name": env.ENVIRONMENT,
      "moesegfault.deployment.id": env.DEPLOYMENT_ID,
      "moesegfault.build.revision": env.GIT_COMMIT,
      "moesegfault.artifact.digest": env.ARTIFACT_DIGEST,
    },
    instrumentation: {
      name: "moesegfault.ops-gateway",
      version: env.STATUS_VERSION,
    },
    attributePolicy: { allowed: ALLOWED_ATTRIBUTES, maxStringLength: 256 },
    logSampleRate: 1,
    samplingPolicyRevision: "ops-gateway-v1",
  });
}

/**
 * 建立公网执行上下文；即使本地禁用资源遥测，也使用共享 W3C/UUIDv7 实现。
 * Establishes public execution context; even locally disabled resource telemetry uses shared W3C/UUIDv7 primitives.
 */
export function beginGatewayBoundary(
  request: Request,
  telemetry: Telemetry | undefined,
): BoundaryContext {
  if (telemetry !== undefined) {
    return telemetry.beginBoundary(request, {
      kind: "public",
      trustIncomingTrace: true,
      sampleRate: 1,
    });
  }

  const trace = acceptTraceContext(request.headers, { trustIncoming: true });
  const correlationId = acceptCorrelationId(request.headers, "public");
  return Object.freeze({
    trace,
    correlationId,
    inject(headers: Headers): Headers {
      injectTraceContext(headers, trace);
      headers.set("x-moesegfault-correlation-id", correlationId);
      return headers;
    },
  });
}

/** 只允许共享 ResourceIdentity 支持的环境 / Admits only environments supported by shared ResourceIdentity. */
function isDeploymentEnvironment(
  value: string,
): value is DeploymentEnvironment {
  return (
    value === "development" ||
    value === "test" ||
    value === "staging" ||
    value === "production"
  );
}

/** 为模板字面量类型执行真实 digest 校验 / Performs real digest validation for the template-literal type. */
function isArtifactDigest(value: string): value is `sha256:${string}` {
  return /^sha256:[0-9a-f]{64}$/.test(value);
}

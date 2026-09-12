import {
  createTelemetry,
  defineResource,
  type Telemetry,
  type TraceContext,
} from "@moesegfault/telemetry";
import { EnvironmentSchema } from "@moesegfault/contracts";
import { HttpError } from "./http.js";

/** 发布来源配置，禁止伪造 isolate/部署标识。 / Release provenance configuration; isolate and deployment IDs must not be fabricated. */
export interface TelemetryConfiguration {
  /** 已注册部署身份。 / Registered deployment identity. */
  DEPLOYMENT_ID: string;
  /** 实际源码 commit。 / Actual source commit. */
  GIT_COMMIT: string;
  /** 实际运行产物摘要。 / Actual runtime artifact digest. */
  ARTIFACT_DIGEST: string;
  /** 版本与环境。 / Version and environment. */
  STATUS_VERSION: string;
  ENVIRONMENT: string;
  /** 原生指标存储。 / Native metrics storage. */
  ANALYTICS: AnalyticsEngineDataset;
}

/** 创建 invocation 局部遥测；production 缺失 provenance 失败关闭。 / Create invocation-local telemetry; production fails closed without provenance. */
export function telemetryForInvocation(
  env: TelemetryConfiguration,
): Telemetry | undefined {
  try {
    const environment = EnvironmentSchema.parse(env.ENVIRONMENT);
    const resource = defineResource({
      "service.namespace": "moeSegFault",
      "service.name": "status",
      "service.version": env.STATUS_VERSION,
      "deployment.environment.name": environment,
      "moesegfault.deployment.id": env.DEPLOYMENT_ID,
      "moesegfault.build.revision": env.GIT_COMMIT,
      "moesegfault.artifact.digest": checkedDigest(env.ARTIFACT_DIGEST),
    });
    return createTelemetry({
      resource,
      instrumentation: {
        name: "moesegfault-status",
        version: env.STATUS_VERSION,
      },
      attributePolicy: {
        allowed: new Set([
          "operation.name",
          "http.response.status_code",
          "error.type",
          "queue.batch.size",
          "analytics.sample.dropped",
        ]),
      },
      metrics: {
        dimensionPolicy: {
          allowed: new Set([
            "operation.name",
            "outcome",
            "http.response.status_code",
          ]),
        },
      },
      metricsDataset: {
        writeDataPoint: (point = {}) =>
          env.ANALYTICS.writeDataPoint({
            ...(point.blobs ? { blobs: [...point.blobs] } : {}),
            ...(point.doubles ? { doubles: [...point.doubles] } : {}),
            ...(point.indexes ? { indexes: [...point.indexes] } : {}),
          }),
      },
    });
  } catch {
    if (
      env.ENVIRONMENT !== "development" ||
      env.DEPLOYMENT_ID ||
      env.GIT_COMMIT ||
      env.ARTIFACT_DIGEST
    )
      throw new HttpError(
        503,
        "provenance-unavailable",
        "Runtime deployment provenance is not configured",
      );
    // 本地未注册运行允许调试，但不制造貌似有效的 production 证据。 / Unregistered local runs remain debuggable without fabricating production evidence.
    return undefined;
  }
}

/** 指标预算耗尽后用日志报告丢弃总数，不递归写指标。 / Report dropped samples through logs, never recursively through the exhausted metric exporter. */
export function recordTelemetryDrops(telemetry: Telemetry | undefined): void {
  if (!telemetry?.metrics.dropped) return;
  telemetry.logger.emit({
    eventName: "status.analytics.samples-dropped",
    severity: "WARN",
    body: "Analytics samples were dropped",
    attributes: { "analytics.sample.dropped": telemetry.metrics.dropped },
  });
}

/** 摘要的类型缩窄同时验证输入。 / Narrow digest type while validating the input. */
function checkedDigest(value: string): `sha256:${string}` {
  if (!/^sha256:[0-9a-f]{64}$/.test(value))
    throw new Error("Invalid artifact digest");
  return value as `sha256:${string}`;
}

/** 记录 HTTP 操作，外部遥测失败不得改变请求结果。 / Record HTTP operations without letting telemetry failures change results. */
export function recordHttp(
  telemetry: Telemetry | undefined,
  response: Response,
  started: number,
  correlationId: string,
  trace?: TraceContext,
): void {
  if (!telemetry) return;
  telemetry.metrics.write({
    name: "http.server.request.count",
    kind: "counter",
    unit: "1",
    value: 1,
    attributes: { "http.response.status_code": response.status },
  });
  if (response.status >= 500)
    telemetry.metrics.write({
      name: "http.server.request.failure",
      kind: "counter",
      unit: "1",
      value: 1,
    });
  telemetry.metrics.write({
    name: "http.server.request.duration",
    kind: "histogram",
    unit: "ms",
    value: Math.max(0, Date.now() - started),
    attributes: { "http.response.status_code": response.status },
  });
  telemetry.logger.emit(
    {
      eventName: "status.request.completed",
      severity: response.status >= 500 ? "ERROR" : "INFO",
      body: "Status request completed",
      attributes: {
        "http.response.status_code": response.status,
        ...(response.status >= 500
          ? { "error.type": "ServiceUnavailable" }
          : {}),
      },
    },
    { correlationId, ...(trace ? { trace } : {}) },
  );
}

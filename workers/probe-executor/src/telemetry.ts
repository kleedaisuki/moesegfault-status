import {
  createTelemetry,
  defineResource,
  type Telemetry,
  type WorkersTracing,
} from "@moesegfault/telemetry";
import { EnvironmentSchema } from "@moesegfault/contracts";

/** 发布过程提供真实来源；执行器身份不是部署身份。 / Release-supplied provenance; executor identity is not deployment identity. */
export interface ExecutorProvenance {
  /** 已注册领域部署。 / Registered domain deployment. */
  readonly DEPLOYMENT_ID: string;
  /** 不可变源码提交。 / Immutable source revision. */
  readonly GIT_COMMIT: string;
  /** 实际运行文件的 SHA-256。 / SHA-256 of the actual runtime file. */
  readonly ARTIFACT_DIGEST: string;
  /** 服务版本。 / Service version. */
  readonly STATUS_VERSION: string;
  /** 明确环境。 / Explicit environment. */
  readonly ENVIRONMENT: string;
}
/** 无来源的 development 不生成伪造资源，其余环境失败关闭。 / Unregistered development produces no invented resource; all other environments fail closed. */
export function executorTelemetry(
  env: ExecutorProvenance,
): Telemetry | undefined {
  if (
    env.ENVIRONMENT === "development" &&
    !env.DEPLOYMENT_ID &&
    !env.GIT_COMMIT &&
    !env.ARTIFACT_DIGEST
  )
    return undefined;
  if (!/^sha256:[0-9a-f]{64}$/.test(env.ARTIFACT_DIGEST))
    throw new Error("executor_provenance_unavailable");
  const resource = defineResource({
    "service.namespace": "moeSegFault",
    "service.name": "probe-executor",
    "service.version": env.STATUS_VERSION,
    "deployment.environment.name": EnvironmentSchema.parse(env.ENVIRONMENT),
    "moesegfault.deployment.id": env.DEPLOYMENT_ID,
    "moesegfault.build.revision": env.GIT_COMMIT,
    "moesegfault.artifact.digest": env.ARTIFACT_DIGEST as `sha256:${string}`,
  });
  return createTelemetry({
    resource,
    instrumentation: {
      name: "moesegfault-probe-executor",
      version: env.STATUS_VERSION,
    },
    attributePolicy: {
      allowed: new Set([
        ...Object.keys(resource),
        "operation.name",
        "http.response.status_code",
        "error.type",
      ]),
    },
  });
}
/** 先验证来源再执行目标请求；不记录 URL、正文或秘密。 / Validate provenance before target execution; never log URLs, bodies, or secrets. */
export async function withExecutorInvocation(
  env: ExecutorProvenance,
  tracing: WorkersTracing | undefined,
  operation: (telemetry: Telemetry | undefined) => Promise<Response>,
): Promise<Response> {
  let telemetry: Telemetry | undefined;
  try {
    telemetry = executorTelemetry(env);
  } catch {
    return new Response(null, { status: 503 });
  }
  const run = async () => {
    try {
      return await operation(telemetry);
    } catch {
      telemetry?.logger.emit({
        eventName: "probe.executor.failed",
        severity: "ERROR",
        body: "Probe executor invocation failed",
        attributes: { "error.type": "ExecutorUnavailable" },
      });
      return new Response(null, { status: 503 });
    }
  };
  return telemetry
    ? telemetry.withSpan(
        tracing,
        "probe.executor.invocation",
        { ...telemetry.resource, "operation.name": "probe.execute" },
        run,
      )
    : run();
}

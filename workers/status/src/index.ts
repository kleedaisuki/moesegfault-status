/// <reference path="../worker-configuration.d.ts" />
import { WorkerEntrypoint } from "cloudflare:workers";
import { domainCore } from "@moesegfault/domain-wasm";
import {
  acceptCorrelationId,
  acceptTraceContext,
} from "@moesegfault/telemetry";
import { handlePublic } from "./public/index.js";
import { publicSelfLink } from "./public/http.js";
import { ingest } from "./diagnostics/ingest.js";
import { consume } from "./diagnostics/consumer.js";
import {
  putDeployment,
  createArtifactUpload,
  commitArtifact,
  createR2ArtifactSigner,
  DeploymentProblem,
} from "./deployments/index.js";
import { runScheduled } from "./scheduling/production.js";
import {
  authenticateMachine,
  requireScope,
  type MachineIdentity,
} from "./platform/auth.js";
import {
  HttpError,
  problemResponse,
  uuidv7,
  withResponseHeaders,
} from "./platform/http.js";
import {
  recordHttp,
  recordTelemetryDrops,
  telemetryForInvocation,
} from "./platform/telemetry.js";
import {
  instrumentDatabase,
  measurement,
  observed,
  observeQueue,
  recordSchedule,
} from "./platform/instrumentation.js";
import { consumeNotifications } from "./platform/notifications.js";
import { createAnalyticsBudget } from "./platform/analytics-budget.js";

export { AdminRpc } from "./admin-rpc.js";

/** status 公网入口仅公开文档声明的资源；管理方法在独立 AdminRpc。 / Public status entrypoint exposes only documented resources; administration lives in AdminRpc. */
export default class StatusWorker extends WorkerEntrypoint<StatusEnv> {
  /** 请求边界统一认证、错误映射与执行关联。 / Request boundary centralizes authentication, error mapping, and correlation. */
  async fetch(request: Request): Promise<Response> {
    let correlationId = uuidv7();
    const started = Date.now();
    const analytics = createAnalyticsBudget(this.env.ANALYTICS);
    let telemetry: ReturnType<typeof telemetryForInvocation>;
    const trace = acceptTraceContext(request.headers);
    try {
      telemetry = telemetryForInvocation({
        ...this.env,
        ANALYTICS: analytics.dataset,
      });
      const read = await handlePublic(request, {
        DB: instrumentDatabase(this.env.DB, telemetry, this.ctx.tracing),
        cursorSecret: this.env.CURSOR_SIGNING_KEY,
        ...(telemetry ? { telemetry } : {}),
        correlationId,
        dependencyCore: domainCore,
      });
      if (read) {
        recordHttp(telemetry, read, started, correlationId, trace);
        return withResponseHeaders(read, correlationId);
      }

      const route = machineRoute(request);
      if (!route)
        throw new HttpError(404, "route-not-found", "Resource not found");
      const identity = await authenticateMachine(request, this.env);
      correlationId = acceptCorrelationId(request.headers, "internal");
      requireScope(identity, route.scope);
      const response = await this.machineWrite(
        request,
        route,
        identity,
        correlationId,
        telemetry,
      );
      recordHttp(telemetry, response, started, correlationId, trace);
      return withResponseHeaders(response, correlationId);
    } catch (error) {
      const mapped =
        error instanceof DeploymentProblem
          ? new HttpError(
              error.status,
              error.type.split("/").at(-1) ?? "deployment-failed",
              error.title,
            )
          : error;
      const response = problemResponse(mapped, request, correlationId);
      if (
        new URL(request.url).pathname === "/v1/diagnostic-events" &&
        [401, 403].includes(response.status)
      )
        measurement(telemetry, "diagnostic.auth.rejection", 1, "ingest");
      recordHttp(telemetry, response, started, correlationId, trace);
      return response;
    } finally {
      analytics.report(telemetry);
      recordTelemetryDrops(telemetry);
    }
  }

  /** Queue 重试由 consumer 控制，所有副作用在 D1 内去重。 / Consumer controls Queue retries; all effects are deduplicated in D1. */
  async queue(batch: MessageBatch<unknown>): Promise<void> {
    const analytics = createAnalyticsBudget(this.env.ANALYTICS);
    const telemetry = telemetryForInvocation({
      ...this.env,
      ANALYTICS: analytics.dataset,
    });
    const kind =
      batch.queue === this.env.NOTIFICATION_QUEUE_NAME
        ? "notification"
        : "diagnostic";
    try {
      await observeQueue(telemetry, batch, kind, async (measured) => {
        if (kind === "notification")
          return consumeNotifications(measured, this.env);
        await consume(measured, {
          DB: instrumentDatabase(this.env.DB, telemetry, this.ctx.tracing),
          DIAGNOSTIC_CORE: domainCore,
          ...(telemetry ? { TELEMETRY: telemetry } : {}),
          DIAGNOSTIC_DLQ: {
            send: async (event) => {
              await observed(telemetry, "queue.dlq.publish", () =>
                this.env.DIAGNOSTIC_DLQ.send(event),
              );
              measurement(telemetry, "queue.dlq.count", 1, "diagnostic");
            },
          },
          DIAGNOSTIC_MAX_ATTEMPTS: 5,
        });
      });
    } finally {
      analytics.report(telemetry);
      recordTelemetryDrops(telemetry);
    }
  }

  /** Cron 工作受全局/目标并发和 deadline 限制。 / Cron work obeys global/per-target concurrency and deadlines. */
  async scheduled(_event: ScheduledController): Promise<void> {
    const analytics = createAnalyticsBudget(this.env.ANALYTICS);
    const scopedEnv = { ...this.env, ANALYTICS: analytics.dataset };
    const telemetry = telemetryForInvocation(scopedEnv);
    try {
      const summary = await observed(telemetry, "scheduler.invocation", () =>
        runScheduled(
          {
            ...scopedEnv,
            DB: instrumentDatabase(this.env.DB, telemetry, this.ctx.tracing),
          },
          domainCore,
          telemetry,
        ),
      );
      recordSchedule(telemetry, summary);
    } finally {
      analytics.report(telemetry);
      recordTelemetryDrops(telemetry);
    }
  }

  /** 仅由认证后的路由调用，无额外公网能力。 / Called only by authenticated routing; adds no public capabilities. */
  private async machineWrite(
    request: Request,
    route: MachineRoute,
    identity: MachineIdentity,
    correlationId: string,
    telemetry: ReturnType<typeof telemetryForInvocation>,
  ): Promise<Response> {
    if (route.kind === "diagnostic") {
      const trace = acceptTraceContext(request.headers, {
        trustIncoming: true,
      });
      const response = await ingest(
        request,
        {
          DIAGNOSTIC_QUEUE: {
            send: async (event) => {
              await observed(telemetry, "queue.diagnostic.publish", () =>
                this.env.DIAGNOSTIC_QUEUE.send(event),
              );
            },
          },
        },
        identity,
        {
          correlationId,
          traceparent: trace.traceparent,
          ...(trace.tracestate ? { tracestate: trace.tracestate } : {}),
        },
      );
      if ([400, 413, 415, 422].includes(response.status))
        measurement(telemetry, "diagnostic.schema.rejection", 1, "ingest");
      if ([401, 403].includes(response.status))
        measurement(telemetry, "diagnostic.auth.rejection", 1, "ingest");
      return response;
    }
    const context = {
      db: instrumentDatabase(this.env.DB, telemetry, this.ctx.tracing),
      artifacts: this.env.ARTIFACTS,
      principal: identity,
      correlationId,
      now: () => new Date(),
      signArtifactPut: createR2ArtifactSigner({
        accountId: this.env.R2_ACCOUNT_ID,
        bucketName: this.env.R2_BUCKET_NAME,
        accessKeyId: this.env.R2_ACCESS_KEY_ID,
        secretAccessKey: this.env.R2_SECRET_ACCESS_KEY,
      }),
    };
    const operation =
      route.kind === "deployment"
        ? putDeployment
        : route.kind === "upload"
          ? createArtifactUpload
          : commitArtifact;
    const result = await operation(request, route.deploymentId, context);
    return Response.json(
      { data: result.body, links: { self: publicSelfLink(request) } },
      { status: result.status, headers: { "cache-control": "no-store" } },
    );
  }
}

/** 编译期限定机器资源路由。 / Compile-time-bounded machine resource route. */
type MachineRoute =
  | { kind: "diagnostic"; scope: "diagnostics:write" }
  | {
      kind: "deployment" | "upload" | "artifact";
      scope: "deployments:write" | "artifacts:write";
      deploymentId: string;
    };

/** 路径与方法白名单；不提供通用 RPC-over-HTTP。 / Exact path/method allowlist, never generic RPC-over-HTTP. */
function machineRoute(request: Request): MachineRoute | undefined {
  const { pathname, search } = new URL(request.url);
  if (search) return undefined;
  if (pathname === "/v1/diagnostic-events" && request.method === "POST")
    return { kind: "diagnostic", scope: "diagnostics:write" };
  const match =
    /^\/v1\/deployments\/([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:\/(artifact-uploads|artifacts))?$/.exec(
      pathname,
    );
  if (!match?.[1]) return undefined;
  if (!match[2] && request.method === "PUT")
    return {
      kind: "deployment",
      deploymentId: match[1],
      scope: "deployments:write",
    };
  if (match[2] && request.method === "POST")
    return {
      kind: match[2] === "artifact-uploads" ? "upload" : "artifact",
      deploymentId: match[1],
      scope: "artifacts:write",
    };
  return undefined;
}

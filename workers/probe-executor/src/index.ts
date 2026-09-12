/// <reference path="../worker-configuration.d.ts" />
import { createCloudflareDohResolver } from "../../status/src/scheduling/doh.js";
import { createWorkersTcpConnector } from "../../status/src/scheduling/workers-tcp.js";
import { createProbeBindings } from "../../status/src/scheduling/probe-bindings.js";
import { deterministicUuidV7 } from "../../status/src/scheduling/identity.js";
import { withExecutorInvocation } from "./telemetry.js";
import { handleRegionalProbe } from "./handler.js";

/** 仅私有默认 fetch 入口参与区域 placement；无公开路由。 / Only the private default fetch entrypoint participates in regional placement; no public routes. */
export default {
  async fetch(
    request: Request,
    env: ProbeExecutorEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    return withExecutorInvocation(env, ctx.tracing, async (telemetry) => {
      const bindings = createProbeBindings(env, env.PROBE_BINDING_CONFIG);
      return handleRegionalProbe(
        request,
        {
          executorId: env.EXECUTOR_ID,
          location: env.EXECUTOR_LOCATION,
          allowedKinds: JSON.parse(env.EXECUTOR_ALLOWED_KINDS),
        },
        {
          fetcher: fetch,
          resolver: createCloudflareDohResolver(fetch),
          tcp: createWorkersTcpConnector(),
          targetPolicy: {
            allowedHostnames: new Set<string>(
              JSON.parse(env.PROBE_ALLOWED_HOSTS),
            ),
            allowedTcpPorts: new Set<number>(
              JSON.parse(env.PROBE_ALLOWED_TCP_PORTS),
            ),
          },
          rpcBindings: bindings.rpc,
          syntheticBindings: bindings.synthetic,
          userAgent: "moesegfault-status-probe/1.0",
          provenance: { runtime: "cloudflare-worker" },
          now: Date.now,
          id: deterministicUuidV7,
        },
        telemetry,
      );
    });
  },
} satisfies ExportedHandler<ProbeExecutorEnv>;

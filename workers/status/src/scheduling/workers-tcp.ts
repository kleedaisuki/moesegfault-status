import { connect } from "cloudflare:sockets";
import type { TcpConnector } from "./probes.js";

/** 创建 Cloudflare Workers Socket TCP 适配器。 / Create the Cloudflare Workers Socket TCP adapter. */
export function createWorkersTcpConnector(): TcpConnector {
  return {
    async connect(hostname, port, signal): Promise<void> {
      if (signal.aborted) throw signal.reason;
      const socket = connect({ hostname, port }, { allowHalfOpen: false });
      const abort = (): void => void socket.close();
      signal.addEventListener("abort", abort, { once: true });
      try {
        await socket.opened;
      } finally {
        signal.removeEventListener("abort", abort);
        await socket.close().catch(() => undefined);
      }
    },
  };
}

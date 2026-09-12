import type { AddressResolver } from "./security.js";
/** 创建固定端点、64 KiB 上限的 DNS-over-HTTPS 解析器。 / Create a fixed-endpoint DNS-over-HTTPS resolver with a 64 KiB response limit. */
export function createCloudflareDohResolver(
  fetcher: typeof fetch,
): AddressResolver {
  return {
    async resolve(hostname, signal, recordType): Promise<readonly string[]> {
      const types: readonly ("A" | "AAAA")[] = recordType
        ? [recordType]
        : ["A", "AAAA"];
      const results = await Promise.all(
        types.map(async (type) => {
          const endpoint = new URL("https://cloudflare-dns.com/dns-query");
          endpoint.searchParams.set("name", hostname);
          endpoint.searchParams.set("type", type);
          const response = await fetcher(endpoint, {
            headers: { accept: "application/dns-json" },
            redirect: "error",
            signal,
          });
          if (!response.ok) throw new Error("doh_unavailable");
          const payload = await readBoundedJson(response, 65_536);
          if (!isObject(payload) || !Array.isArray(payload.Answer)) return [];
          const expectedType = type === "A" ? 1 : 28;
          return payload.Answer.flatMap((answer) =>
            isObject(answer) &&
            answer.type === expectedType &&
            typeof answer.data === "string"
              ? [answer.data]
              : [],
          );
        }),
      );
      return [...new Set(results.flat())];
    },
  };
}

async function readBoundedJson(
  response: Response,
  maximumBytes: number,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) throw new Error("doh_response_too_large");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

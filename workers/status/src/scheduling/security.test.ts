import { describe, expect, it, vi } from "vitest";
import { executeProbe, type ProbeDependencies } from "./probes.js";
import { assertSafeHostname, isPublicAddress } from "./security.js";

const signal = new AbortController().signal;

describe("probe target policy", () => {
  it("rejects private and reserved address ranges", () => {
    expect(isPublicAddress("10.0.0.1")).toBe(false);
    expect(isPublicAddress("127.0.0.1")).toBe(false);
    expect(isPublicAddress("169.254.1.1")).toBe(false);
    expect(isPublicAddress("192.0.2.1")).toBe(false);
    expect(isPublicAddress("::1")).toBe(false);
    expect(isPublicAddress("fc00::1")).toBe(false);
    expect(isPublicAddress("::ffff:127.0.0.1")).toBe(false);
    expect(isPublicAddress("64:ff9b::7f00:1")).toBe(false);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
    expect(isPublicAddress("1.1.1.1")).toBe(true);
  });

  it("requires both exact allowlist membership and public DNS answers", async () => {
    const policy = {
      allowedHostnames: new Set(["health.example.com"]),
      allowedTcpPorts: new Set<number>(),
    };
    const resolver = { resolve: vi.fn(async () => ["10.0.0.2"]) };
    await expect(
      assertSafeHostname("health.example.com", policy, resolver, signal),
    ).rejects.toMatchObject({ code: "private_or_reserved_address" });
    await expect(
      assertSafeHostname("other.example.com", policy, resolver, signal),
    ).rejects.toMatchObject({ code: "hostname_not_allowed" });
  });

  it("validates every redirect before the next fetch", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/admin" },
        }),
    );
    const dependencies: ProbeDependencies = {
      fetcher,
      resolver: { resolve: async () => ["93.184.216.34"] },
      targetPolicy: {
        allowedHostnames: new Set(["health.example.com"]),
        allowedTcpPorts: new Set(),
      },
      tcp: { connect: async () => undefined },
      rpcBindings: {},
      syntheticBindings: {},
      userAgent: "test-probe/1",
      provenance: { runtime: "cloudflare-worker" },
      now: (() => {
        let value = 0;
        return () => ++value;
      })(),
      id: async () => "0199d0a8-2e12-7a59-a51e-44aa9b6d1001",
    };
    const observation = await executeProbe(
      "monitor",
      { kind: "http", url: "https://health.example.com", maxRedirects: 1 },
      "correlation",
      dependencies,
      signal,
    );
    expect(observation.outcome).toBe("invalid");
    expect(observation.errorType).toBe("hostname_not_allowed");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

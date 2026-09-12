import { describe, expect, it } from "vitest";
import { createCorrelationId } from "@moesegfault/telemetry";
import {
  hasRequiredRole,
  normalizeAccessClaims,
  parseAccessConfig,
  parseRoleMapping,
  type AccessConfig,
} from "../src/access.js";
import {
  HttpProblem,
  enforceMutationGuards,
  parseConfiguredOrigin,
  problem,
  problemResponse,
  readBoundedJson,
  requireExpectedRevision,
} from "../src/http.js";
import {
  beginGatewayBoundary,
  createGatewayTelemetry,
} from "../src/telemetry.js";

const AUDIENCE = "a".repeat(64);

/** 构造测试用的最小 Access 配置 / Builds minimal Access configuration for tests. */
function accessConfig(
  roles: readonly ("viewer" | "operator" | "admin")[] = ["operator"],
): AccessConfig {
  return {
    issuer: "https://team.cloudflareaccess.com",
    audience: AUDIENCE,
    maxTokenAgeSeconds: 3_600,
    rolesBySubject: new Map([["stable-subject", roles]]),
  };
}

describe("Access claims", () => {
  it("derives roles only from the configured stable subject", () => {
    const principal = normalizeAccessClaims(
      {
        sub: "stable-subject",
        email: "klee@example.com",
        iat: 1_000,
        nbf: 1_000,
        exp: 2_000,
        type: "app",
        identity_nonce: "session-key",
        roles: ["admin"],
      },
      accessConfig(["viewer"]),
      1_100,
    );

    expect(principal.roles).toEqual(["viewer"]);
    expect(principal.authenticated_at).toBe("1970-01-01T00:16:40.000Z");
  });

  it("rejects service tokens and unmapped human subjects", () => {
    expect(() =>
      normalizeAccessClaims(
        { sub: "", iat: 1_000, nbf: 1_000, exp: 2_000, type: "app" },
        accessConfig(),
        1_100,
      ),
    ).toThrow(/human identity/);
    expect(() =>
      normalizeAccessClaims(
        {
          sub: "unknown-subject",
          email: "unknown@example.com",
          iat: 1_000,
          nbf: 1_000,
          exp: 2_000,
          type: "app",
          identity_nonce: "session-key",
        },
        accessConfig(),
        1_100,
      ),
    ).toThrow(/role mapping/);
  });

  it("rejects stale sessions even when their expiry is in the future", () => {
    expect(() =>
      normalizeAccessClaims(
        {
          sub: "stable-subject",
          email: "klee@example.com",
          iat: 1_000,
          nbf: 1_000,
          exp: 20_000,
          type: "app",
          identity_nonce: "session-key",
        },
        accessConfig(),
        10_000,
      ),
    ).toThrow(/allowed age|lifetime/);
  });

  it("strictly validates config and role maps", () => {
    expect(
      parseAccessConfig({
        issuer: "https://team.cloudflareaccess.com",
        audience: AUDIENCE,
        maxTokenAgeSeconds: "3600",
        roleMapping: '{"stable-subject":["admin"]}',
      }).rolesBySubject.get("stable-subject"),
    ).toEqual(["admin"]);
    expect(() => parseRoleMapping('{"*":["admin"]}')).toThrow();
    expect(() => parseRoleMapping('{"stable-subject":["root"]}')).toThrow();
  });

  it("applies the documented role hierarchy", () => {
    expect(hasRequiredRole(["admin"], "operator")).toBe(true);
    expect(hasRequiredRole(["operator"], "viewer")).toBe(true);
    expect(hasRequiredRole(["viewer"], "operator")).toBe(false);
  });
});

describe("HTTP mutation boundary", () => {
  it("requires exact origin, fetch metadata, custom CSRF header, and JSON", () => {
    const accepted = new Request("https://ops.moesegfault.dev/api/incidents", {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        origin: "https://ops.moesegfault.dev",
        "sec-fetch-site": "same-origin",
        "x-moesegfault-csrf": "1",
      },
      body: "{}",
    });
    expect(() =>
      enforceMutationGuards(accepted, "https://ops.moesegfault.dev"),
    ).not.toThrow();

    const rejected = new Request("https://ops.moesegfault.dev/api/incidents", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
        "x-moesegfault-csrf": "1",
      },
      body: "{}",
    });
    expect(() =>
      enforceMutationGuards(rejected, "https://ops.moesegfault.dev"),
    ).toThrow(HttpProblem);
  });

  it("applies the byte limit to the consumed stream", async () => {
    const request = new Request("https://ops.moesegfault.dev/api/incidents", {
      method: "POST",
      body: JSON.stringify({ text: "x".repeat(100) }),
    });
    await expect(readBoundedJson(request, 32)).rejects.toMatchObject({
      problem: { status: 413 },
    });
  });

  it("accepts only a strong numeric If-Match", () => {
    const accepted = new Request(
      "https://ops.moesegfault.dev/api/incidents/id",
      {
        headers: { "if-match": '"42"' },
      },
    );
    expect(requireExpectedRevision(accepted)).toBe(42);

    for (const value of ["*", 'W/"42"', "42", '"01"']) {
      const rejected = new Request(
        "https://ops.moesegfault.dev/api/incidents/id",
        {
          headers: { "if-match": value },
        },
      );
      expect(() => requireExpectedRevision(rejected)).toThrow(HttpProblem);
    }
  });

  it("accepts an exact HTTPS origin and local HTTP only", () => {
    expect(parseConfiguredOrigin("https://ops.moesegfault.dev")).toBe(
      "https://ops.moesegfault.dev",
    );
    expect(parseConfiguredOrigin("http://localhost:8787")).toBe(
      "http://localhost:8787",
    );
    expect(() => parseConfiguredOrigin("http://ops.moesegfault.dev")).toThrow();
    expect(() =>
      parseConfiguredOrigin("https://ops.moesegfault.dev/path"),
    ).toThrow();
  });

  it("renders RFC 9457 with the same correlation identity in body and header", async () => {
    const correlationId = createCorrelationId();
    const response = problemResponse(
      problem("invalid-command", "Invalid command", 400),
      "/api/incidents",
      correlationId,
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
    expect(response.headers.get("x-moesegfault-correlation-id")).toBe(
      correlationId,
    );
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    await expect(response.json()).resolves.toMatchObject({
      instance: "/api/incidents",
      correlation_id: correlationId,
    });
  });
});

describe("correlation ID", () => {
  it("creates a lowercase RFC 9562 UUIDv7", () => {
    const value = createCorrelationId(1_700_000_000_000);
    expect(value).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(value.startsWith("018bcfe5-6800-")).toBe(true);
  });

  it("rotates a public correlation ID while continuing valid W3C context", () => {
    const inboundCorrelation = createCorrelationId();
    const request = new Request("https://ops.moesegfault.dev/api/session", {
      headers: {
        traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
        "x-moesegfault-correlation-id": inboundCorrelation,
      },
    });
    const boundary = beginGatewayBoundary(request, undefined);
    expect(boundary.correlationId).not.toBe(inboundCorrelation);
    expect(boundary.trace.traceId).toBe("0123456789abcdef0123456789abcdef");
    expect(boundary.trace.spanId).not.toBe("0123456789abcdef");
  });
});

describe("telemetry provenance", () => {
  it("allows empty provenance only for local development", () => {
    const empty = {
      DEPLOYMENT_ID: "",
      GIT_COMMIT: "",
      ARTIFACT_DIGEST: "",
      STATUS_VERSION: "",
      ENVIRONMENT: "development",
    };
    expect(createGatewayTelemetry(empty)).toBeUndefined();
    expect(() =>
      createGatewayTelemetry({ ...empty, ENVIRONMENT: "production" }),
    ).toThrow(/provenance/);
  });

  it("uses the stable ops-gateway resource identity", () => {
    const telemetry = createGatewayTelemetry({
      DEPLOYMENT_ID: "0199d09a-b692-7ce0-a1c0-5138a43d7402",
      GIT_COMMIT: "0123456789abcdef0123456789abcdef01234567",
      ARTIFACT_DIGEST: `sha256:${"a".repeat(64)}`,
      STATUS_VERSION: "0.1.0",
      ENVIRONMENT: "production",
    });
    expect(telemetry?.resource["service.name"]).toBe("ops-gateway");
  });
});

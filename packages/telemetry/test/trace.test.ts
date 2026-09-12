import { describe, expect, it } from "vitest";
import {
  acceptCorrelationId,
  acceptTraceContext,
  createCorrelationId,
  parseTraceParent,
  parseTraceState,
} from "../src/index.js";

describe("W3C trace context", () => {
  it("strictly parses version 00 and rejects malformed or zero IDs", () => {
    const valid = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    expect(parseTraceParent(valid)).toMatchObject({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: 1,
    });
    expect(parseTraceParent(valid.toUpperCase())).toBeNull();
    expect(
      parseTraceParent(
        "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
      ),
    ).toBeNull();
    expect(
      parseTraceParent(
        "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
      ),
    ).toBeNull();
    expect(parseTraceParent(`${valid}-extra`)).toBeNull();
    expect(parseTraceParent(`${valid}-abcd`)).toBeNull();
  });

  it("validates tracestate size, uniqueness, and grammar as one field", () => {
    expect(parseTraceState("vendor=opaque, tenant@system=value")).toBe(
      "vendor=opaque,tenant@system=value",
    );
    expect(parseTraceState("vendor=one,vendor=two")).toBeUndefined();
    expect(parseTraceState("Vendor=one")).toBeUndefined();
    expect(parseTraceState("vendor=has=equals")).toBeUndefined();
    expect(parseTraceState(`vendor=${"x".repeat(513)}`)).toBeUndefined();
  });

  it("creates a new cryptographic child span and drops invalid tracestate", () => {
    const parent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const headers = new Headers({
      traceparent: parent,
      tracestate: "duplicate=x,duplicate=y",
    });
    const child = acceptTraceContext(headers);
    expect(child.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(child.spanId).not.toBe("00f067aa0ba902b7");
    expect(child.traceFlags).toBe(1);
    expect(child.tracestate).toBeUndefined();
  });
});

describe("correlation IDs", () => {
  it("generates RFC 9562 UUIDv7 and rotates public input", () => {
    const now = 1_757_649_600_000;
    const id = createCorrelationId(now);
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const headers = new Headers({ "x-moesegfault-correlation-id": id });
    expect(acceptCorrelationId(headers, "internal", now)).toBe(id);
    expect(acceptCorrelationId(headers, "public", now)).not.toBe(id);
  });
});

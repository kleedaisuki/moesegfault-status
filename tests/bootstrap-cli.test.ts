import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  prepareConfig,
  assertRemoteState,
  uploadedVersion,
  childEnvironment,
} from "../scripts/operations/prepare-bootstrap.mjs";

/** 引导操作只能降低暴露面，不能制造生产证明。 / Bootstrap narrows exposure and cannot manufacture provenance. */
describe("restricted Actions bootstrap", () => {
  const root = resolve(".");
  const source = {
    name: "moesegfault-status",
    main: "dist/rust/status/status.js",
    no_bundle: true,
    vars: { DEPLOYMENT_ID: "old", GIT_COMMIT: "old", ARTIFACT_DIGEST: "old" },
    rules: [{ type: "CompiledWasm", globs: ["**/*.wasm"] }],
    routes: [{ pattern: "example.com" }],
    triggers: { crons: ["* * * * *"] },
    workers_dev: true,
    preview_urls: true,
    queues: {
      producers: [{ binding: "QUEUE", queue: "queue" }],
      consumers: [{ queue: "queue" }],
    },
  };
  it("strips all status routes, triggers, consumers and fabricated provenance", () => {
    const config = prepareConfig(source, "status", root);
    for (const key of [
      "routes",
      "route",
      "domains",
      "triggers",
      "workers_dev",
      "preview_urls",
    ])
      expect(config).not.toHaveProperty(key);
    expect(config.queues).not.toHaveProperty("consumers");
    expect(config.vars).toMatchObject({
      ENVIRONMENT: "production",
      BOOTSTRAP_MODE: "true",
      DEPLOYMENT_ID: "",
      GIT_COMMIT: "",
      ARTIFACT_DIGEST: "",
    });
    expect(config.rules).toEqual(source.rules);
    expect(config.secrets.required).toContain("ADMIN_PASSWORD_RECORD");
  });
  it("rejects another worker, entrypoint, build hook or secret variable", () => {
    for (const patch of [
      { name: "another" },
      { main: "other.js" },
      { build: { command: "evil" } },
      { vars: { ADMIN_EMAIL: "private" } },
      { no_bundle: false },
      { assets: {} },
    ])
      expect(() =>
        prepareConfig({ ...source, ...patch }, "status", root),
      ).toThrow();
    expect(() => prepareConfig(source, "ops", root)).toThrow();
  });
  it("keeps first probe private and unconfigured", () => {
    const config = prepareConfig(
      {
        ...source,
        name: "moesegfault-probe-asia",
        main: "../../dist/rust/probe/probe.js",
      },
      "probe",
      root,
    );
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    expect(config).not.toHaveProperty("queues");
    expect(config.vars.PROBE_ALLOWED_HOSTS).toBe("[]");
  });
  it("refuses every status state except an exact bootstrap plaintext binding", () => {
    const response = {
      status: 200,
      body: {
        success: true,
        result: {
          bindings: [
            { name: "BOOTSTRAP_MODE", type: "plain_text", text: "true" },
          ],
        },
      },
    };
    expect(() => assertRemoteState("status", response)).not.toThrow();
    for (const value of ["false", true, "TRUE", " true "])
      expect(() =>
        assertRemoteState("status", {
          ...response,
          body: {
            ...response.body,
            result: {
              bindings: [
                { name: "BOOTSTRAP_MODE", type: "plain_text", text: value },
              ],
            },
          },
        }),
      ).toThrow();
    expect(() =>
      assertRemoteState("status", { status: 403, body: {} }),
    ).toThrow();
    expect(() =>
      assertRemoteState("status", {
        status: 200,
        body: { success: true, result: { bindings: [] } },
      }),
    ).toThrow();
  });
  it("probe requires provider-confirmed missing script, not permission failure", () => {
    expect(() =>
      assertRemoteState("probe", {
        status: 404,
        body: { success: false, errors: [{ code: 10007 }] },
      }),
    ).not.toThrow();
    for (const status of [200, 401, 403, 500])
      expect(() => assertRemoteState("probe", { status, body: {} })).toThrow();
    expect(() =>
      assertRemoteState("probe", { status: 404, body: {} }),
    ).toThrow();
  });
  it("deploys only the exact unique uploaded UUID", () => {
    const line = JSON.stringify({
      type: "version-upload",
      version_id: "01234567-89ab-cdef-0123-456789abcdef",
    });
    expect(uploadedVersion(line)).toBe("01234567-89ab-cdef-0123-456789abcdef");
    for (const invalid of [
      "",
      line + "\n" + line,
      '{"type":"version-upload","version_id":"--name=evil"}',
    ])
      expect(() => uploadedVersion(invalid)).toThrow();
  });
  it("does not forward runtime credentials to Wrangler", () => {
    const env = childEnvironment({
      PATH: "path",
      CLOUDFLARE_API_TOKEN: "cf",
      CURSOR_SIGNING_KEY: "cursor",
      ADMIN_PASSWORD_RECORD: "password",
      MACHINE_JWT_PRIVATE_KEY: "private",
      RANDOM_SECRET: "other",
    });
    expect(env.CLOUDFLARE_API_TOKEN).toBe("cf");
    for (const key of [
      "CURSOR_SIGNING_KEY",
      "ADMIN_PASSWORD_RECORD",
      "MACHINE_JWT_PRIVATE_KEY",
      "RANDOM_SECRET",
    ])
      expect(env).not.toHaveProperty(key);
  });
  it("workflow credentials exist only after compilation with fixed main and shared concurrency", () => {
    const workflow = readFileSync(".github/workflows/bootstrap.yml", "utf8");
    expect(workflow).toContain("github.ref == 'refs/heads/main'");
    expect(workflow).toContain("environment: production-release");
    expect(workflow).toContain(
      "group: production-release-${{ inputs.service }}",
    );
    expect(workflow.indexOf("secrets.CLOUDFLARE_API_TOKEN")).toBeGreaterThan(
      workflow.indexOf("cargo run --locked"),
    );
    expect(workflow).not.toMatch(
      /ADMIN_PASSWORD_RECORD|triggers deploy|dns_records|custom_domain/,
    );
  });
});

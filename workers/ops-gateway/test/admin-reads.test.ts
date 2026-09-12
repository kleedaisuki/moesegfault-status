import { describe, expect, it, vi } from "vitest";

import type { AdminPrincipal } from "@moesegfault/contracts";
import type { TraceContext } from "@moesegfault/telemetry";
import { routeApiRequest, type AdminRpcClient } from "../src/router.js";

const CORRELATION = "018f0000-0000-7000-8000-000000000021";
const DEPLOYMENT = "018f0000-0000-7000-8000-000000000022";
const NOW = "2026-09-12T00:00:00.000Z";
const principal: AdminPrincipal = {
  subject: "viewer-subject",
  email: "viewer@example.com",
  roles: ["viewer"],
  authenticated_at: NOW,
  access_application: "ops",
};
const trace: TraceContext = {
  traceId: "0123456789abcdef0123456789abcdef",
  spanId: "0123456789abcdef",
  traceFlags: 1,
  traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
};

function context() {
  return {
    principal,
    correlationId: CORRELATION,
    allowedOrigin: "https://ops.moesegfault.dev",
    trace,
  };
}

const service = {
  service_name: "api",
  display_name: "API",
  description: "Public API",
  owner: "platform",
  criticality: "critical",
  enabled: true,
  dependencies: [],
  created_at: NOW,
  updated_at: NOW,
  revision: 1,
};

const component = {
  component_id: "public-api",
  owner_service: "api",
  display_name: "Public API",
  description: "Public edge",
  public: true,
  sort_order: 1,
  enabled: true,
  supporting_services: [],
  created_at: NOW,
  updated_at: NOW,
  revision: 1,
};

describe("administrative snapshot routes", () => {
  it.each([
    {
      path: "/api/catalog/services/api",
      method: "getServiceCatalog",
      idField: "service_name",
      id: "api",
      data: service,
    },
    {
      path: "/api/catalog/components/public-api",
      method: "getComponentCatalog",
      idField: "component_id",
      id: "public-api",
      data: component,
    },
    {
      path: "/api/retention-policy-assignments/api",
      method: "getServiceRetentionPolicyAssignment",
      idField: "service_name",
      id: "api",
      data: {
        service_name: "api",
        policy: {
          policy_id: "default",
          revision: 1,
          occurrence_retention_days: 30,
          cleanup_batch_size: 500,
        },
        assignment_revision: 1,
        assigned_at: NOW,
        assigned_by: "admin-subject",
        policy_registered_at: NOW,
        policy_registered_by: "admin-subject",
      },
    },
    {
      path: `/api/deployments/${DEPLOYMENT}/activation-context`,
      method: "getDeploymentActivationContext",
      idField: "deployment_id",
      id: DEPLOYMENT,
      data: {
        deployment_id: DEPLOYMENT,
        service_name: "api",
        environment: "production",
        state: "ready",
        deployment_revision: 2,
        current_pointer: null,
      },
    },
  ])(
    "routes $path to the viewer RPC",
    async ({ path, method, idField, id, data }) => {
      const operation = vi.fn(async () => ({ data }));
      const status = { [method]: operation } as unknown as AdminRpcClient;
      const response = await routeApiRequest(
        new Request(`https://ops.moesegfault.dev${path}`),
        status,
        context(),
      );
      expect(response.status).toBe(200);
      expect(operation).toHaveBeenCalledWith(
        expect.objectContaining({
          [idField]: id,
          principal,
          correlation_id: CORRELATION,
        }),
      );
      await expect(response.json()).resolves.toEqual({ data });
    },
  );

  it("projects a missing retention assignment as a correlated 404", async () => {
    const status = {
      getServiceRetentionPolicyAssignment: async () => ({
        problem: {
          type: "https://status.moesegfault.dev/problems/not-found",
          title: "Administrative snapshot not found",
          status: 404,
          correlation_id: CORRELATION,
        },
      }),
    } as unknown as AdminRpcClient;
    const response = await routeApiRequest(
      new Request(
        "https://ops.moesegfault.dev/api/retention-policy-assignments/api",
      ),
      status,
      context(),
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      status: 404,
      correlation_id: CORRELATION,
    });
  });
});

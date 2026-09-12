import { afterEach, describe, expect, it } from "vitest";

import {
  getComponentCatalog,
  getDeploymentActivationContext,
  getServiceCatalog,
  getServiceRetentionPolicyAssignment,
} from "../../workers/status/src/admin/reads.js";
import { createMigratedD1, type TestD1Database } from "./d1.js";

const NOW = "2026-09-12T00:00:00.000Z";
const DEPLOYMENT = "018f0000-0000-7000-8000-000000000011";
const CORRELATION = "018f0000-0000-7000-8000-000000000012";
const DIGEST = `sha256:${"b".repeat(64)}`;

const principal = {
  subject: "viewer-subject",
  email: "viewer@example.com",
  roles: ["viewer"] as const,
  authenticated_at: NOW,
  access_application: "ops",
};

async function seed(database: TestD1Database): Promise<void> {
  const statement = (sql: string, ...values: unknown[]) =>
    database.prepare(sql).bind(...values);
  const service = (name: string, display: string, criticality: string) =>
    statement(
      "INSERT INTO services(service_name,display_name,description,owner,criticality,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
      name,
      display,
      `${display} description`,
      "platform",
      criticality,
      1,
      NOW,
      NOW,
    );
  await database.batch([
    service("api", "API", "critical"),
    service("database", "Database", "high"),
    statement(
      "INSERT INTO service_dependencies(source_service,target_service,capability,kind,criticality,created_at) VALUES(?,?,?,?,?,?)",
      "api",
      "database",
      "sql",
      "required",
      "critical",
      NOW,
    ),
    statement(
      "INSERT INTO components(component_id,service_name,display_name,description,public,sort_order,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
      "public-api",
      "api",
      "Public API",
      "Public edge",
      1,
      10,
      1,
      NOW,
      NOW,
    ),
    statement(
      "INSERT INTO component_services(component_id,service_name,role,created_at) VALUES(?,?,?,?)",
      "public-api",
      "api",
      "owner",
      NOW,
    ),
    statement(
      "INSERT INTO component_services(component_id,service_name,role,created_at) VALUES(?,?,?,?)",
      "public-api",
      "database",
      "supporting",
      NOW,
    ),
    statement(
      "INSERT INTO data_retention_policies(policy_id,revision,occurrence_retention_days,cleanup_batch_size,created_by,created_at) VALUES(?,?,?,?,?,?)",
      "default",
      2,
      30,
      500,
      "admin-subject",
      NOW,
    ),
    statement(
      "INSERT INTO service_retention_policies(service_name,policy_id,policy_revision,assigned_by,assigned_at,revision) VALUES(?,?,?,?,?,?)",
      "api",
      "default",
      2,
      "admin-subject",
      NOW,
      3,
    ),
    statement(
      `INSERT INTO deployments(deployment_id,service_name,environment,service_version,repository_url,
       git_commit,git_ref,artifact_digest,ci_provider,ci_run_id,deployed_at,manifest_object_key,
       manifest_digest,manifest_schema_version,registered_at,registered_by)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      DEPLOYMENT,
      "api",
      "production",
      "1.0.0",
      "https://github.com/moesegfault/status.git",
      "b".repeat(40),
      "refs/heads/main",
      DIGEST,
      "github-actions",
      "1",
      NOW,
      "manifests/api.json",
      DIGEST,
      "1",
      NOW,
      "ci",
    ),
    statement(
      "INSERT INTO deployment_status_history(deployment_id,sequence,state,reason,actor_subject,occurred_at) VALUES(?,?,?,?,?,?)",
      DEPLOYMENT,
      1,
      "registered",
      "registered",
      "ci",
      NOW,
    ),
    statement(
      "INSERT INTO deployment_status_history(deployment_id,sequence,state,reason,actor_subject,occurred_at) VALUES(?,?,?,?,?,?)",
      DEPLOYMENT,
      2,
      "ready",
      "verified",
      "ci",
      NOW,
    ),
    statement(
      "INSERT INTO service_environment_deployments(service_name,environment,deployment_id,activated_at,revision) VALUES(?,?,?,?,?)",
      "api",
      "production",
      DEPLOYMENT,
      NOW,
      4,
    ),
  ]);
}

describe("bounded administrative reads", () => {
  const opened: TestD1Database[] = [];
  afterEach(() => {
    for (const database of opened.splice(0)) database.close();
  });

  async function ready(): Promise<TestD1Database> {
    const database = await createMigratedD1();
    opened.push(database);
    await seed(database);
    return database;
  }

  it("returns strict service and component snapshots from authoritative relations", async () => {
    const database = await ready();
    await expect(
      getServiceCatalog(
        { DB: database as unknown as D1Database },
        { principal, correlation_id: CORRELATION, service_name: "api" },
      ),
    ).resolves.toMatchObject({
      data: {
        service_name: "api",
        revision: 1,
        dependencies: [{ target_service: "database", capability: "sql" }],
      },
    });
    await expect(
      getComponentCatalog(
        { DB: database as unknown as D1Database },
        { principal, correlation_id: CORRELATION, component_id: "public-api" },
      ),
    ).resolves.toMatchObject({
      data: {
        component_id: "public-api",
        owner_service: "api",
        supporting_services: ["database"],
      },
    });
  });

  it("returns retention and deployment activation concurrency context", async () => {
    const database = await ready();
    await expect(
      getServiceRetentionPolicyAssignment(
        { DB: database as unknown as D1Database },
        { principal, correlation_id: CORRELATION, service_name: "api" },
      ),
    ).resolves.toMatchObject({
      data: {
        policy: { policy_id: "default", revision: 2 },
        assignment_revision: 3,
      },
    });
    await expect(
      getDeploymentActivationContext(
        { DB: database as unknown as D1Database },
        { principal, correlation_id: CORRELATION, deployment_id: DEPLOYMENT },
      ),
    ).resolves.toEqual({
      data: {
        deployment_id: DEPLOYMENT,
        service_name: "api",
        environment: "production",
        state: "ready",
        deployment_revision: 2,
        current_pointer: { deployment_id: DEPLOYMENT, revision: 4 },
      },
    });
  });

  it("returns 404 for an absent assignment", async () => {
    const database = await ready();
    const result = await getServiceRetentionPolicyAssignment(
      { DB: database as unknown as D1Database },
      { principal, correlation_id: CORRELATION, service_name: "database" },
    );
    expect("problem" in result && result.problem.status).toBe(404);
  });
});

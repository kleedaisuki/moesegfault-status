import { afterEach, describe, expect, it } from "vitest";

import {
  activateDeployment,
  registerAndAssignRetentionPolicy,
} from "../../workers/status/src/admin/bootstrap.js";
import type { AdminEnvironment } from "../../workers/status/src/admin/index.js";
import { createMigratedD1, type TestD1Database } from "./d1.js";

const CORRELATION = "018f0000-0000-7000-8000-000000000401";
const RETENTION_COMMAND = "018f0000-0000-7000-8000-000000000402";
const RETENTION_UPDATE = "018f0000-0000-7000-8000-000000000403";
const RETENTION_CONFLICT = "018f0000-0000-7000-8000-000000000404";
const ACTIVATE_FIRST = "018f0000-0000-7000-8000-000000000405";
const ACTIVATE_SECOND = "018f0000-0000-7000-8000-000000000406";
const STALE_ACTIVATION = "018f0000-0000-7000-8000-000000000407";
const DEPLOYMENT_ONE = "018f0000-0000-7000-8000-000000000408";
const DEPLOYMENT_TWO = "018f0000-0000-7000-8000-000000000409";
const STARTED = "2026-09-12T00:00:00.000Z";
const DIGEST = `sha256:${"a".repeat(64)}`;

const principal = {
  subject: "admin-1",
  email: "admin@example.com",
  roles: ["admin"] as const,
  authenticated_at: STARTED,
  access_application: "status-ops",
};

/** 构造真实 D1 管理环境 / Builds an administrative environment backed by real D1. */
function environment(database: TestD1Database): AdminEnvironment {
  return {
    DB: database as unknown as D1Database,
    CURSOR_SIGNING_KEY: "bootstrap-test-cursor-key-with-enough-entropy",
    STATUS_VERSION: "integration-test",
  };
}

/** 写入最小服务目录 / Seeds the minimal service catalog. */
async function seedService(database: TestD1Database): Promise<void> {
  await database
    .prepare(
      `INSERT INTO services
       (service_name,display_name,description,owner,criticality,enabled,created_at,updated_at)
       VALUES ('api','API','','platform','critical',1,?,?)`,
    )
    .bind(STARTED, STARTED)
    .run();
}

/** 写入一个已验证为 ready、但尚未激活的 deployment / Seeds a verified-ready deployment that is not yet active. */
async function seedReadyDeployment(
  database: TestD1Database,
  deploymentId: string,
  version: string,
): Promise<void> {
  const sql = (text: string, ...values: unknown[]) =>
    database.prepare(text).bind(...values);
  await database.batch([
    sql(
      `INSERT INTO deployments
       (deployment_id,service_name,environment,service_version,repository_url,git_commit,git_ref,artifact_digest,
        ci_provider,ci_run_id,deployed_at,manifest_object_key,manifest_digest,manifest_schema_version,registered_at,registered_by)
       VALUES (?,'api','production',?,'https://example.com/repo',?,'refs/heads/main',?,'github','1',?,?,?,?,?,'ci')`,
      deploymentId,
      version,
      "a".repeat(40),
      DIGEST,
      STARTED,
      `manifests/${deploymentId}.json`,
      DIGEST,
      "1.0",
      STARTED,
    ),
    sql(
      `INSERT INTO deployment_status_history
       (deployment_id,sequence,state,reason,actor_subject,correlation_id,occurred_at)
       VALUES (?,1,'registered','','ci',?,?)`,
      deploymentId,
      CORRELATION,
      STARTED,
    ),
    sql(
      `INSERT INTO deployment_status_history
       (deployment_id,sequence,state,reason,actor_subject,correlation_id,occurred_at)
       VALUES (?,2,'artifacts_pending','','ci',?,?)`,
      deploymentId,
      CORRELATION,
      STARTED,
    ),
    sql(
      `INSERT INTO deployment_status_history
       (deployment_id,sequence,state,reason,actor_subject,correlation_id,occurred_at)
       VALUES (?,3,'ready','all artifacts verified','ci',?,?)`,
      deploymentId,
      CORRELATION,
      STARTED,
    ),
  ]);
}

describe("retention and deployment bootstrap controls", () => {
  const opened: TestD1Database[] = [];
  afterEach(() => {
    for (const database of opened.splice(0)) database.close();
  });

  async function ready(): Promise<{
    database: TestD1Database;
    env: AdminEnvironment;
  }> {
    const database = await createMigratedD1();
    opened.push(database);
    await seedService(database);
    return { database, env: environment(database) };
  }

  it("atomically registers immutable retention revisions and CAS-assigns the service", async () => {
    const { database, env } = await ready();
    const request = {
      principal: { ...principal, roles: [...principal.roles] },
      correlation_id: CORRELATION,
      command: {
        command_id: RETENTION_COMMAND,
        service_name: "api",
        policy: {
          policy_id: "occurrences",
          revision: 1,
          occurrence_retention_days: 30,
          cleanup_batch_size: 100,
        },
        expected_assignment_revision: null,
      },
    };

    const first = await registerAndAssignRetentionPolicy(env, request);
    const replay = await registerAndAssignRetentionPolicy(env, request);

    expect(first).toMatchObject({
      data: {
        service_name: "api",
        policy: { policy_id: "occurrences", revision: 1 },
        assignment_revision: 1,
        assigned_by: "admin-1",
      },
    });
    expect(replay).toEqual(first);
    await expect(
      database
        .prepare(
          "SELECT COUNT(*) FROM audit_log WHERE action='retention_policy.assigned'",
        )
        .first<number>("COUNT(*)"),
    ).resolves.toBe(1);
    await expect(
      database
        .prepare(
          "SELECT COUNT(*) FROM outbox WHERE event_type='retention_policy.assigned'",
        )
        .first<number>("COUNT(*)"),
    ).resolves.toBe(1);

    const updated = await registerAndAssignRetentionPolicy(env, {
      ...request,
      command: {
        ...request.command,
        command_id: RETENTION_UPDATE,
        policy: {
          ...request.command.policy,
          revision: 2,
          occurrence_retention_days: 60,
        },
        expected_assignment_revision: 1,
      },
    });
    expect(updated).toMatchObject({
      data: {
        policy: { revision: 2, occurrence_retention_days: 60 },
        assignment_revision: 2,
      },
    });
    await expect(
      database
        .prepare(
          "SELECT COUNT(*) FROM data_retention_policies WHERE policy_id='occurrences'",
        )
        .first<number>("COUNT(*)"),
    ).resolves.toBe(2);
  });

  it("rolls back the whole retention command when an immutable revision differs", async () => {
    const { database, env } = await ready();
    const base = {
      principal: { ...principal, roles: [...principal.roles] },
      correlation_id: CORRELATION,
      command: {
        command_id: RETENTION_COMMAND,
        service_name: "api",
        policy: {
          policy_id: "occurrences",
          revision: 1,
          occurrence_retention_days: 30,
          cleanup_batch_size: 100,
        },
        expected_assignment_revision: null,
      },
    };
    await registerAndAssignRetentionPolicy(env, base);

    const conflict = await registerAndAssignRetentionPolicy(env, {
      ...base,
      command: {
        ...base.command,
        command_id: RETENTION_CONFLICT,
        policy: { ...base.command.policy, occurrence_retention_days: 31 },
        expected_assignment_revision: 1,
      },
    });

    expect(conflict).toMatchObject({ problem: { status: 409 } });
    await expect(
      database
        .prepare(
          "SELECT occurrence_retention_days FROM data_retention_policies WHERE policy_id='occurrences' AND revision=1",
        )
        .first<number>("occurrence_retention_days"),
    ).resolves.toBe(30);
    await expect(
      database
        .prepare(
          "SELECT revision FROM service_retention_policies WHERE service_name='api'",
        )
        .first<number>("revision"),
    ).resolves.toBe(1);
  });

  it("activates only the expected ready revision and atomically retires a cut-over predecessor", async () => {
    const { database, env } = await ready();
    await seedReadyDeployment(database, DEPLOYMENT_ONE, "1.0.0");

    const firstRequest = {
      principal: { ...principal, roles: [...principal.roles] },
      correlation_id: CORRELATION,
      deployment_id: DEPLOYMENT_ONE,
      command: {
        command_id: ACTIVATE_FIRST,
        expected_deployment_revision: 3,
        expected_pointer_revision: null,
        reason: "Production deploy smoke checks passed",
      },
    };
    const first = await activateDeployment(env, firstRequest);
    const replay = await activateDeployment(env, firstRequest);
    expect(first).toMatchObject({
      data: {
        deployment_id: DEPLOYMENT_ONE,
        deployment_state: "active",
        deployment_revision: 4,
        pointer_revision: 1,
      },
    });
    expect(replay).toEqual(first);

    await seedReadyDeployment(database, DEPLOYMENT_TWO, "2.0.0");
    const second = await activateDeployment(env, {
      ...firstRequest,
      deployment_id: DEPLOYMENT_TWO,
      command: {
        command_id: ACTIVATE_SECOND,
        expected_deployment_revision: 3,
        expected_pointer_revision: 1,
        reason: "Canary and production smoke checks passed",
      },
    });
    expect(second).toMatchObject({
      data: {
        deployment_id: DEPLOYMENT_TWO,
        deployment_state: "active",
        deployment_revision: 4,
        pointer_revision: 2,
      },
    });
    await expect(
      database
        .prepare(
          "SELECT state FROM deployment_current_status WHERE deployment_id=?",
        )
        .bind(DEPLOYMENT_ONE)
        .first<string>("state"),
    ).resolves.toBe("retired");
    await expect(
      database
        .prepare(
          "SELECT deployment_id FROM service_environment_deployments WHERE service_name='api' AND environment='production'",
        )
        .first<string>("deployment_id"),
    ).resolves.toBe(DEPLOYMENT_TWO);
    await expect(
      database
        .prepare(
          "SELECT COUNT(*) FROM audit_log WHERE action='deployment.activated'",
        )
        .first<number>("COUNT(*)"),
    ).resolves.toBe(2);
    await expect(
      database
        .prepare(
          "SELECT COUNT(*) FROM outbox WHERE event_type='deployment.activated'",
        )
        .first<number>("COUNT(*)"),
    ).resolves.toBe(2);
  });

  it("rejects stale activation without appending status or moving the pointer", async () => {
    const { database, env } = await ready();
    await seedReadyDeployment(database, DEPLOYMENT_ONE, "1.0.0");

    const rejected = await activateDeployment(env, {
      principal: { ...principal, roles: [...principal.roles] },
      correlation_id: CORRELATION,
      deployment_id: DEPLOYMENT_ONE,
      command: {
        command_id: STALE_ACTIVATION,
        expected_deployment_revision: 2,
        expected_pointer_revision: null,
        reason: "This assertion is stale",
      },
    });

    expect(rejected).toMatchObject({ problem: { status: 409 } });
    await expect(
      database
        .prepare(
          "SELECT COUNT(*) FROM deployment_status_history WHERE deployment_id=?",
        )
        .bind(DEPLOYMENT_ONE)
        .first<number>("COUNT(*)"),
    ).resolves.toBe(3);
    await expect(
      database
        .prepare("SELECT COUNT(*) FROM service_environment_deployments")
        .first<number>("COUNT(*)"),
    ).resolves.toBe(0);
  });
});

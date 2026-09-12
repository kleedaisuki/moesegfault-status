import { afterEach, describe, expect, it } from "vitest";
import {
  createMigratedD1,
  TestD1PreparedStatement,
  type TestD1Database,
} from "../../../../tests/integration/d1.js";
import { D1ProbeIssueLifecycle, D1TargetReevaluator } from "./reevaluate.js";
import { deterministicUuidV7 } from "./identity.js";
import { createRustMonitorEvaluator } from "./rust.js";
import {
  D1SchedulerStore,
  type D1DatabaseLike,
  type D1StatementLike,
} from "./store.js";
import type {
  ClaimedMonitor,
  MonitorCheckpoint,
  MonitorEvaluationResult,
  Observation,
} from "./types.js";

let database: TestD1Database | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

describe("D1 scheduler store", () => {
  it("leases once and atomically commits only aggregate checkpoint data", async () => {
    database = await createMigratedD1();
    await seedMonitor(database);
    const store = new D1SchedulerStore(adaptTestD1(database));
    const now = new Date("2026-09-12T00:00:00.000Z");
    const first = await store.claimDue(now, "owner-a", 60_000, 10);
    const overlapping = await store.claimDue(now, "owner-b", 60_000, 10);
    expect(first).toHaveLength(1);
    expect(overlapping).toHaveLength(0);
    const checkpoint: MonitorCheckpoint = {
      monitorId: first[0]!.monitorId,
      location: "cloudflare-worker",
      windowStartedAt: now.toISOString(),
      lastObservedAt: now.toISOString(),
      consecutiveSuccesses: 1,
      consecutiveFailures: 0,
      windowSamples: 1,
      windowUnhealthySamples: 0,
      windowLatencyP95Ms: null,
      evaluationStatus: "operational",
      evaluatedAt: now.toISOString(),
      freshUntil: "2026-09-12T00:02:00.000Z",
      policyId: "probe-policy",
      policyRevision: 1,
      revision: 1,
    };
    await store.commitEvaluation(first[0]!, checkpoint, "owner-a", now);
    const persisted = await database
      .prepare(
        "SELECT window_samples,window_unhealthy_samples FROM monitor_checkpoints",
      )
      .first<{ window_samples: number; window_unhealthy_samples: number }>();
    const monitor = await database
      .prepare("SELECT lease_owner,next_run_at FROM monitors")
      .first<{ lease_owner: string | null; next_run_at: string }>();
    expect(persisted).toEqual({
      window_samples: 1,
      window_unhealthy_samples: 0,
    });
    expect(monitor?.lease_owner).toBeNull();
    expect(monitor?.next_run_at).toBe("2026-09-12T00:01:00.000Z");
  });

  it("rejects a stale owner after lease takeover without checkpoint side effects", async () => {
    database = await createMigratedD1();
    await seedMonitor(database);
    const store = new D1SchedulerStore(adaptTestD1(database));
    const due = new Date("2026-09-12T00:00:00.000Z");
    const stale = (await store.claimDue(due, "owner-a", 1_000, 1))[0]!;
    const current = (
      await store.claimDue(
        new Date("2026-09-12T00:00:02.000Z"),
        "owner-b",
        1_000,
        1,
      )
    )[0]!;
    expect(
      await store.ownsLease(
        stale,
        "owner-a",
        new Date("2026-09-12T00:00:02.000Z"),
      ),
    ).toBe(false);
    const observation = successfulObservation(stale);
    await expect(
      store.commitEvaluation(
        stale,
        checkpointForLifecycle(stale, observation),
        "owner-a",
        due,
      ),
    ).rejects.toThrow("transaction assertion failed");
    expect(await store.readCheckpoints(stale.monitorId)).toHaveLength(0);
    expect(
      await store.ownsLease(
        current,
        "owner-b",
        new Date("2026-09-12T00:00:02.000Z"),
      ),
    ).toBe(true);
  });

  it("loads two actual location aggregates into one Rust quorum evaluation", async () => {
    database = await createMigratedD1();
    await seedMonitor(database);
    const store = new D1SchedulerStore(adaptTestD1(database));
    const monitor = (
      await store.claimDue(
        new Date("2026-09-12T00:00:00.000Z"),
        "owner",
        60_000,
        1,
      )
    )[0]!;
    const firstObservation: Observation = {
      ...successfulObservation(monitor),
      execution: { runtime: "cloudflare-worker", location: "colo-a" },
    };
    await store.writeCheckpoint({
      ...checkpointForLifecycle(monitor, firstObservation),
      location: "colo-a",
      evaluationStatus: "operational",
    });
    const persisted = await store.readCheckpoints(monitor.monitorId);
    const secondObservation: Observation = {
      ...firstObservation,
      observationId: "0199d0a8-2e12-7a59-a51e-44aa9b6d1070",
      execution: { runtime: "cloudflare-worker", location: "colo-b" },
    };
    const evaluator = createRustMonitorEvaluator({
      dispatchJson(request): string {
        const input = JSON.parse(request) as {
          payload: {
            policy: { revision: string };
            locations: { location: string }[];
          };
        };
        expect(
          input.payload.locations.map((location) => location.location),
        ).toEqual(["colo-b", "colo-a"]);
        return JSON.stringify({
          policy_revision: input.payload.policy.revision,
          state: "healthy",
          status: "operational",
          reason: "recovery_quorum_met",
          eligible_locations: 2,
          failing_locations: 0,
          recovering_locations: 2,
          fresh_until: "2026-09-12T00:02:00.000Z",
        });
      },
    });
    const result = await evaluator.evaluate({
      monitor: {
        ...monitor,
        policy: { ...monitor.policy, locationQuorum: 2 },
      },
      previous: null,
      peerCheckpoints: persisted,
      observation: secondObservation,
    });
    expect(result.checkpoint.location).toBe("colo-b");
  });

  it("reevaluates a service through Rust aggregate_status and appends one transition", async () => {
    database = await createMigratedD1();
    await seedMonitor(database);
    const reevaluator = new D1TargetReevaluator(
      adaptTestD1(database),
      {
        dispatchJson(request): string {
          const parsed = JSON.parse(request) as { operation: string };
          expect(parsed.operation).toBe("aggregate_status");
          return JSON.stringify("unknown");
        },
      },
      () => Date.parse("2026-09-12T00:00:00.000Z"),
    );
    await reevaluator.reevaluate(
      { type: "service", id: "identity" },
      { type: "observation", id: "observation-1" },
      new AbortController().signal,
    );
    const status = await database
      .prepare(
        "SELECT direct_status FROM current_statuses WHERE target_id='identity'",
      )
      .first<{ direct_status: string }>();
    const transitions = await database
      .prepare(
        "SELECT COUNT(*) count FROM status_transitions WHERE target_id='identity'",
      )
      .first<{ count: number }>();
    expect(status?.direct_status).toBe("unknown");
    expect(transitions?.count).toBe(1);
  });

  it("retries outbox leases without changing the stable event identity", async () => {
    database = await createMigratedD1();
    await database.exec(`INSERT INTO outbox(outbox_id,aggregate_type,aggregate_id,event_type,schema_version,payload_json,
      available_at,next_attempt_at,created_at) VALUES('0199d0a8-2e12-7a59-a51e-44aa9b6d1002','service','identity',
      'status.changed','1.0','{}','2026-09-12T00:00:00.000Z','2026-09-12T00:00:00.000Z','2026-09-12T00:00:00.000Z')`);
    const store = new D1SchedulerStore(adaptTestD1(database));
    const first = await store.claimOutbox(
      new Date("2026-09-12T00:00:00.000Z"),
      "owner-a",
      1_000,
      10,
    );
    expect(first).toMatchObject([
      { outboxId: "0199d0a8-2e12-7a59-a51e-44aa9b6d1002", attempt: 1 },
    ]);
    expect(
      await store.claimOutbox(
        new Date("2026-09-12T00:00:00.500Z"),
        "owner-b",
        1_000,
        10,
      ),
    ).toHaveLength(0);
    await store.markOutboxFailed(
      first[0]!.outboxId,
      "owner-a",
      new Date("2026-09-12T00:00:02.000Z"),
      "receiver_failed",
      false,
    );
    const retry = await store.claimOutbox(
      new Date("2026-09-12T00:00:02.000Z"),
      "owner-b",
      1_000,
      10,
    );
    expect(retry).toMatchObject([{ outboxId: first[0]!.outboxId, attempt: 2 }]);
  });

  it("limit=1 completes whole maintenance source and enqueues every inherited component", async () => {
    database = await createMigratedD1();
    await database.exec(`
      INSERT INTO services(service_name,display_name,description,owner,criticality,created_at,updated_at)
      VALUES('identity','Identity','','platform','critical','2026-09-11T00:00:00.000Z','2026-09-11T00:00:00.000Z');
      INSERT INTO components(component_id,service_name,display_name,description,created_at,updated_at)
      VALUES('login','identity','Login','','2026-09-11T00:00:00.000Z','2026-09-11T00:00:00.000Z');
      INSERT INTO maintenance_windows(maintenance_id,title,description,expected_impact,starts_at,ends_at,state,created_by,created_at,updated_at)
      VALUES('0199d0a8-2e12-7a59-a51e-44aa9b6d1010','Deploy','Deploy','degraded','2026-09-11T23:00:00.000Z','2026-09-11T23:30:00.000Z','active','test','2026-09-11T00:00:00.000Z','2026-09-11T00:00:00.000Z');
      INSERT INTO maintenance_targets(maintenance_id,target_type,target_id)
      VALUES('0199d0a8-2e12-7a59-a51e-44aa9b6d1010','service','identity');
    `);
    const store = new D1SchedulerStore(adaptTestD1(database));
    const id = deterministicUuidV7;
    expect(
      await store.enqueueExpiredReevaluations(
        new Date("2026-09-12T00:00:00.000Z"),
        1,
        id,
      ),
    ).toBe(2);
    expect(
      await store.enqueueExpiredReevaluations(
        new Date("2026-09-12T00:00:01.000Z"),
        1,
        id,
      ),
    ).toBe(0);
    const state = await database
      .prepare("SELECT state FROM maintenance_windows")
      .first<{ state: string }>();
    const outbox = await database
      .prepare(
        "SELECT event_type,aggregate_id FROM outbox ORDER BY aggregate_id",
      )
      .all<{ event_type: string; aggregate_id: string }>();
    expect(state?.state).toBe("completed");
    expect(outbox.results).toEqual([
      { event_type: "maintenance.expired", aggregate_id: "identity" },
      { event_type: "maintenance.expired", aggregate_id: "login" },
    ]);
  });

  it("activates service maintenance and makes its owned component non-green", async () => {
    database = await createMigratedD1();
    await database.exec(`
      INSERT INTO services(service_name,display_name,description,owner,criticality,created_at,updated_at)
      VALUES('identity','Identity','','platform','critical','2026-09-11T00:00:00.000Z','2026-09-11T00:00:00.000Z');
      INSERT INTO components(component_id,service_name,display_name,description,created_at,updated_at)
      VALUES('login','identity','Login','','2026-09-11T00:00:00.000Z','2026-09-11T00:00:00.000Z');
      INSERT INTO maintenance_windows(maintenance_id,title,description,expected_impact,starts_at,ends_at,state,created_by,created_at,updated_at)
      VALUES('0199d0a8-2e12-7a59-a51e-44aa9b6d1060','Deploy','Deploy','degraded','2026-09-11T23:00:00.000Z','2026-09-12T01:00:00.000Z','scheduled','test','2026-09-11T00:00:00.000Z','2026-09-11T00:00:00.000Z');
      INSERT INTO maintenance_targets(maintenance_id,target_type,target_id)
      VALUES('0199d0a8-2e12-7a59-a51e-44aa9b6d1060','service','identity');
    `);
    const store = new D1SchedulerStore(adaptTestD1(database));
    expect(
      await store.enqueueExpiredReevaluations(
        new Date("2026-09-12T00:00:00.000Z"),
        1,
        deterministicUuidV7,
      ),
    ).toBe(2);
    const reevaluator = new D1TargetReevaluator(
      adaptTestD1(database),
      {
        dispatchJson(request): string {
          const input = JSON.parse(request) as {
            operation: string;
            payload: { maintenance: unknown[] };
          };
          expect(input.operation).toBe("aggregate_status");
          expect(input.payload.maintenance).toEqual([{ active: true }]);
          return JSON.stringify("maintenance");
        },
      },
      () => Date.parse("2026-09-12T00:00:00.000Z"),
    );
    await reevaluator.reevaluate(
      { type: "component", id: "login" },
      { type: "maintenance", id: "0199d0a8-2e12-7a59-a51e-44aa9b6d1060" },
      new AbortController().signal,
    );
    const status = await database
      .prepare(
        "SELECT direct_status FROM current_statuses WHERE target_type='component' AND target_id='login'",
      )
      .first<{ direct_status: string }>();
    expect(status?.direct_status).toBe("maintenance");
  });

  it("purges revisioned candidates but preserves permanent Incident pins", async () => {
    database = await createMigratedD1();
    await seedRetention(database);
    const store = new D1SchedulerStore(adaptTestD1(database));
    const candidates = await store.selectRetentionCandidates(
      new Date("2026-09-12T00:00:00.000Z"),
      10,
    );
    expect(candidates.map((candidate) => candidate.occurrenceId)).toEqual([
      "0199d0a8-2e12-7a59-a51e-44aa9b6d1023",
    ]);
    expect(
      await store.purgeRetentionCandidates(
        candidates,
        new Date("2026-09-12T00:00:00.000Z"),
      ),
    ).toBe(1);
    const remaining = await database
      .prepare("SELECT occurrence_id FROM issue_occurrences")
      .all<{ occurrence_id: string }>();
    const detachedEvidence = await database
      .prepare(
        "SELECT occurrence_id FROM issue_telemetry_references WHERE telemetry_reference_id='0199d0a8-2e12-7a59-a51e-44aa9b6d1028'",
      )
      .first<{ occurrence_id: string | null }>();
    expect(remaining.results).toEqual([
      { occurrence_id: "0199d0a8-2e12-7a59-a51e-44aa9b6d1024" },
    ]);
    expect(detachedEvidence?.occurrence_id).toBeNull();
  });

  it("uses Rust issue_transition when a suppression expires", async () => {
    database = await createMigratedD1();
    await seedMonitor(database);
    await database.exec(`
      INSERT INTO issues(issue_id,fingerprint_hash,service_name,kind,severity,state,first_seen_at,last_seen_at,occurrence_count,
        affected_instance_count,policy_id,policy_revision,revision)
      VALUES('0199d0a8-2e12-7a59-a51e-44aa9b6d1030','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        'identity','dependency.unavailable','error','observed','2026-09-11T00:00:00.000Z','2026-09-11T00:00:00.000Z',1,0,'probe-policy',1,1);
      UPDATE issues SET state='active',revision=2 WHERE issue_id='0199d0a8-2e12-7a59-a51e-44aa9b6d1030';
      UPDATE issues SET state='suppressed',suppression_until='2026-09-11T23:00:00.000Z',suppression_reason='deploy',revision=3
        WHERE issue_id='0199d0a8-2e12-7a59-a51e-44aa9b6d1030';
    `);
    const core = {
      dispatchJson(request: string): string {
        const input = JSON.parse(request) as {
          operation: string;
          payload: { issue?: Record<string, unknown> };
        };
        if (input.operation === "aggregate_status")
          return JSON.stringify("partial_outage");
        expect(input.operation).toBe("issue_transition");
        expect(input.payload).toMatchObject({
          expected_revision: 3,
          command: "suppression_expired",
        });
        return JSON.stringify({
          issue: {
            ...input.payload.issue,
            state: "active",
            suppressed_until: null,
            revision: 4,
          },
        });
      },
    };
    const reevaluator = new D1TargetReevaluator(
      adaptTestD1(database),
      core,
      () => Date.parse("2026-09-12T00:00:00.000Z"),
    );
    await reevaluator.reevaluate(
      { type: "service", id: "identity" },
      { type: "suppression", id: "0199d0a8-2e12-7a59-a51e-44aa9b6d1030" },
      new AbortController().signal,
    );
    const issue = await database
      .prepare(
        "SELECT state,suppression_until,revision FROM issues WHERE issue_id='0199d0a8-2e12-7a59-a51e-44aa9b6d1030'",
      )
      .first<{
        state: string;
        suppression_until: string | null;
        revision: number;
      }>();
    expect(issue).toEqual({
      state: "active",
      suppression_until: null,
      revision: 4,
    });
  });

  it("maps only the exact component monitor Issue and ignores expired maintenance coverage", async () => {
    database = await createMigratedD1();
    await seedComponentIssue(database);
    const core = {
      dispatchJson(request: string): string {
        const input = JSON.parse(request) as {
          operation: string;
          payload: { issues?: { covered_by_maintenance: boolean }[] };
        };
        if (input.operation === "canonical_fingerprint") {
          return JSON.stringify({
            canonical: "component",
            hash: "c".repeat(64),
          });
        }
        expect(input.operation).toBe("aggregate_status");
        expect(input.payload.issues).toEqual([
          {
            state: "active",
            impact: "partial_outage",
            covered_by_maintenance: false,
          },
        ]);
        return JSON.stringify("partial_outage");
      },
    };
    const reevaluator = new D1TargetReevaluator(
      adaptTestD1(database),
      core,
      () => Date.parse("2026-09-12T00:00:00.000Z"),
    );
    await reevaluator.reevaluate(
      { type: "component", id: "login" },
      { type: "observation", id: "observation-1" },
      new AbortController().signal,
    );
    const status = await database
      .prepare(
        "SELECT direct_status FROM current_statuses WHERE target_type='component' AND target_id='login'",
      )
      .first<{ direct_status: string }>();
    expect(status?.direct_status).toBe("partial_outage");
  });

  it("preserves a critical failing component monitor as unknown before Issue confirmation", async () => {
    database = await createMigratedD1();
    await seedComponentIssue(database);
    await database.exec(`
      DELETE FROM issues;
      DELETE FROM maintenance_targets;
      DELETE FROM maintenance_windows;
      INSERT INTO monitor_locations(monitor_id,location) VALUES('0199d0a8-2e12-7a59-a51e-44aa9b6d1040','cloudflare-worker');
      INSERT INTO monitor_checkpoints(monitor_id,location,last_observed_at,consecutive_successes,consecutive_failures,
        window_samples,window_unhealthy_samples,window_started_at,evaluation_status,evaluated_at,fresh_until,policy_id,policy_revision)
      VALUES('0199d0a8-2e12-7a59-a51e-44aa9b6d1040','cloudflare-worker','2026-09-12T00:00:00.000Z',0,3,3,3,
        '2026-09-11T23:58:00.000Z','partial_outage','2026-09-12T00:00:00.000Z','2026-09-12T00:02:00.000Z','probe-policy',1);
      UPDATE monitor_checkpoints SET executor_id='trusted-test',actual_colo='SIN',revision=revision+1;
    `);
    const reevaluator = new D1TargetReevaluator(
      adaptTestD1(database),
      {
        dispatchJson(request): string {
          const input = JSON.parse(request) as {
            operation: string;
            payload: { monitors: unknown[] };
          };
          if (input.operation === "canonical_fingerprint") {
            return JSON.stringify({
              canonical: "component",
              hash: "c".repeat(64),
            });
          }
          expect(input.payload.monitors).toEqual([
            { critical: true, state: "failing" },
          ]);
          return JSON.stringify("unknown");
        },
      },
      () => Date.parse("2026-09-12T00:00:01.000Z"),
    );
    await reevaluator.reevaluate(
      { type: "component", id: "login" },
      { type: "observation", id: "observation-2" },
      new AbortController().signal,
    );
    const status = await database
      .prepare(
        "SELECT direct_status FROM current_statuses WHERE target_type='component' AND target_id='login'",
      )
      .first<{ direct_status: string }>();
    expect(status?.direct_status).toBe("unknown");
  });

  it("rolls back stale recovery side effects when two workers race", async () => {
    database = await createMigratedD1();
    await seedRecoveringIssue(database);
    const lifecycle = new D1ProbeIssueLifecycle(adaptTestD1(database), {
      dispatchJson(request): string {
        const input = JSON.parse(request) as {
          operation: string;
          payload: { issue?: Record<string, unknown> };
        };
        if (input.operation === "canonical_fingerprint") {
          return JSON.stringify({ canonical: "probe", hash: "d".repeat(64) });
        }
        if (input.operation === "aggregate_status") {
          return JSON.stringify("unknown");
        }
        return JSON.stringify({
          issue: {
            ...input.payload.issue,
            state: "recovering",
            suppressed_until: null,
            revision: 3,
          },
        });
      },
    });
    const monitor = monitorForLifecycle();
    const observation = successfulObservation(monitor);
    const evaluation: MonitorEvaluationResult = {
      checkpoint: checkpointForLifecycle(monitor, observation),
    };
    const outcomes = await Promise.allSettled([
      lifecycle.apply(monitor, observation, evaluation),
      lifecycle.apply(monitor, observation, evaluation),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.status === "rejected"),
    ).toHaveLength(1);
    const audit = await database
      .prepare(
        "SELECT COUNT(*) count FROM audit_log WHERE action='issue.recovery_evaluated'",
      )
      .first<{ count: number }>();
    const outbox = await database
      .prepare(
        "SELECT COUNT(*) count FROM outbox WHERE event_type='issue.state_changed'",
      )
      .first<{ count: number }>();
    expect(audit?.count).toBe(1);
    expect(outbox?.count).toBe(1);
  });

  it("rejects a probe recovery when a newer causal fault commits after planning", async () => {
    database = await createMigratedD1();
    await seedRecoveringIssue(database);
    const lifecycle = new D1ProbeIssueLifecycle(
      adaptTestD1(database, async (batchNumber) => {
        if (batchNumber !== 1) return;
        await database!.batch([
          database!
            .prepare(
              `INSERT INTO diagnostic_event_dedup(event_id,event_schema_version,service_name,deployment_id,kind,severity,
            occurred_at,received_at,processed_at,fingerprint_hash,payload_digest,envelope_schema_version,processing_token,producer_subject)
            VALUES('0199d0a8-2e12-7a59-a51e-44aa9b6d1062','1.0','identity','0199d0a8-2e12-7a59-a51e-44aa9b6d1060',
            'health.probe_failed','warning','2026-09-12T00:00:01.000Z','2026-09-12T00:00:01.000Z','2026-09-12T00:00:01.000Z',
            ?,?,'1.0','newer-probe-fault','status-scheduler')`,
            )
            .bind("d".repeat(64), `sha256:${"e".repeat(64)}`),
          database!.prepare(
            `UPDATE issues SET last_seen_at='2026-09-12T00:00:01.000Z',last_fault_event_id=
              '0199d0a8-2e12-7a59-a51e-44aa9b6d1062',occurrence_count=occurrence_count+1,revision=revision+1
              WHERE issue_id='0199d0a8-2e12-7a59-a51e-44aa9b6d1050'`,
          ),
        ]);
      }),
      {
        dispatchJson(request): string {
          const input = JSON.parse(request) as {
            operation: string;
            payload: { issue?: Record<string, unknown> };
          };
          if (input.operation === "canonical_fingerprint")
            return JSON.stringify({ canonical: "probe", hash: "d".repeat(64) });
          if (input.operation === "aggregate_status")
            return JSON.stringify("unknown");
          return JSON.stringify({
            issue: {
              ...input.payload.issue,
              state: "recovering",
              suppressed_until: null,
              revision: 3,
            },
          });
        },
      },
    );
    const monitor = monitorForLifecycle();
    const observation = successfulObservation(monitor);

    await expect(
      lifecycle.apply(monitor, observation, {
        checkpoint: checkpointForLifecycle(monitor, observation),
      }),
    ).rejects.toThrow("transaction assertion failed");
    await expect(
      database
        .prepare(
          "SELECT state,last_seen_at,last_fault_event_id,revision FROM issues WHERE issue_id='0199d0a8-2e12-7a59-a51e-44aa9b6d1050'",
        )
        .first(),
    ).resolves.toEqual({
      state: "active",
      last_seen_at: "2026-09-12T00:00:01.000Z",
      last_fault_event_id: "0199d0a8-2e12-7a59-a51e-44aa9b6d1062",
      revision: 3,
    });
    await expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM audit_log WHERE action='issue.recovery_evaluated'",
        )
        .first<number>("count"),
    ).resolves.toBe(0);
    await expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM outbox WHERE event_type IN ('issue.state_changed','status.changed')",
        )
        .first<number>("count"),
    ).resolves.toBe(0);
  });
});

async function seedMonitor(db: TestD1Database): Promise<void> {
  await db.exec(`
    INSERT INTO services(service_name,display_name,description,owner,criticality,created_at,updated_at)
    VALUES('identity','Identity','','platform','critical','2026-09-11T00:00:00.000Z','2026-09-11T00:00:00.000Z');
    INSERT INTO evaluation_policies(policy_id,revision,schema_version,name,observation_window_seconds,minimum_samples,
      failure_threshold,recovery_threshold,latency_threshold_ms,stale_after_seconds,location_quorum,
      fingerprint_template_json,status_mapping_json,diagnostic_rules_json,created_by,created_at)
    VALUES('probe-policy',1,'1.0','Probe',300,1,0.5,0.1,NULL,120,1,'{}','{"failure_status":"degraded"}',
      '{"minimum_occurrences":1,"status_by_severity":{"info":"degraded","warning":"degraded","error":"partial_outage","critical":"major_outage"}}',
      'test','2026-09-11T00:00:00.000Z');
    INSERT INTO monitors(monitor_id,target_type,target_id,probe_kind,environment,schedule_kind,interval_seconds,timeout_ms,
      probe_config_json,policy_id,policy_revision,next_run_at,created_at,updated_at)
    VALUES('0199d0a8-2e12-7a59-a51e-44aa9b6d1001','service','identity','http','production','interval',60,5000,
      '{"url":"https://health.example.com"}','probe-policy',1,'2026-09-12T00:00:00.000Z','2026-09-11T00:00:00.000Z','2026-09-11T00:00:00.000Z');
    INSERT INTO monitor_locations(monitor_id,location) VALUES('0199d0a8-2e12-7a59-a51e-44aa9b6d1001','cloudflare-worker'),('0199d0a8-2e12-7a59-a51e-44aa9b6d1001','colo-a'),('0199d0a8-2e12-7a59-a51e-44aa9b6d1001','colo-b');
  `);
}

async function seedRetention(db: TestD1Database): Promise<void> {
  await db.exec(`
    INSERT INTO services(service_name,display_name,description,owner,criticality,created_at,updated_at)
    VALUES('identity','Identity','','platform','critical','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');
    INSERT INTO evaluation_policies(policy_id,revision,schema_version,name,observation_window_seconds,minimum_samples,
      failure_threshold,recovery_threshold,latency_threshold_ms,stale_after_seconds,location_quorum,
      fingerprint_template_json,status_mapping_json,diagnostic_rules_json,created_by,created_at)
    VALUES('probe-policy',1,'1.0','Probe',300,1,0.5,0.1,NULL,120,1,'{}','{"failure_status":"degraded"}',
      '{"minimum_occurrences":1,"status_by_severity":{"info":"degraded","warning":"degraded","error":"partial_outage","critical":"major_outage"}}','test','2026-09-01T00:00:00.000Z');
    INSERT INTO data_retention_policies(policy_id,revision,occurrence_retention_days,cleanup_batch_size,created_by,created_at)
    VALUES('retention',3,1,100,'test','2026-09-01T00:00:00.000Z');
    INSERT INTO deployments(deployment_id,service_name,environment,service_version,repository_url,git_commit,git_ref,artifact_digest,
      ci_provider,ci_run_id,deployed_at,manifest_object_key,manifest_digest,manifest_schema_version,registered_at,registered_by)
    VALUES('0199d0a8-2e12-7a59-a51e-44aa9b6d1020','identity','production','1','https://example.com/repo',
      '0123456789012345678901234567890123456789','main','sha256:0123456789012345678901234567890123456789012345678901234567890123',
      'test','1','2026-09-01T00:00:00.000Z','manifest/1','sha256:1123456789012345678901234567890123456789012345678901234567890123','1.0','2026-09-01T00:00:00.000Z','test');
    INSERT INTO issues(issue_id,fingerprint_hash,service_name,kind,severity,state,first_seen_at,last_seen_at,occurrence_count,
      affected_instance_count,policy_id,policy_revision,revision)
    VALUES('0199d0a8-2e12-7a59-a51e-44aa9b6d1021','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'identity','health.probe_failed','warning','observed','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z',2,0,'probe-policy',1,1);
    INSERT INTO issue_occurrences(occurrence_id,issue_id,service_name,deployment_id,occurred_at,observed_at,summary,evidence_count,
      retention_policy_id,retention_policy_revision,purge_after)
    VALUES
      ('0199d0a8-2e12-7a59-a51e-44aa9b6d1023','0199d0a8-2e12-7a59-a51e-44aa9b6d1021','identity','0199d0a8-2e12-7a59-a51e-44aa9b6d1020',
       '2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z','old',0,'retention',3,'2026-09-10T00:00:00.000Z'),
      ('0199d0a8-2e12-7a59-a51e-44aa9b6d1024','0199d0a8-2e12-7a59-a51e-44aa9b6d1021','identity','0199d0a8-2e12-7a59-a51e-44aa9b6d1020',
       '2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z','pinned',0,'retention',3,'2026-09-10T00:00:00.000Z');
    INSERT INTO telemetry_backends(backend_name,capabilities_json,query_adapter,ui_url_template,retention_class,auth_reference,created_at,updated_at)
    VALUES('test','["trace"]','test','https://example.com','short','secret:test','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');
    INSERT INTO telemetry_references(telemetry_reference_id,kind,backend_name,locator_json,service_name,deployment_id,trace_id,created_at)
    VALUES('0199d0a8-2e12-7a59-a51e-44aa9b6d1028','trace','test','{"trace_id":"0123456789abcdef0123456789abcdef"}',
      'identity','0199d0a8-2e12-7a59-a51e-44aa9b6d1020','0123456789abcdef0123456789abcdef','2026-09-01T00:00:00.000Z');
    INSERT INTO issue_telemetry_references(issue_id,telemetry_reference_id,occurrence_id,linked_at)
    VALUES('0199d0a8-2e12-7a59-a51e-44aa9b6d1021','0199d0a8-2e12-7a59-a51e-44aa9b6d1028',
      '0199d0a8-2e12-7a59-a51e-44aa9b6d1023','2026-09-01T00:00:00.000Z');
    INSERT INTO incidents(incident_id,started_at,detected_at,created_at,created_by)
    VALUES('0199d0a8-2e12-7a59-a51e-44aa9b6d1025','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z','test');
    INSERT INTO incident_updates(update_id,incident_id,sequence,title,state,impact,public_message,actor_subject,occurred_at)
    VALUES('0199d0a8-2e12-7a59-a51e-44aa9b6d1026','0199d0a8-2e12-7a59-a51e-44aa9b6d1025',1,'Incident','investigating','degraded','Investigating','test','2026-09-01T00:00:00.000Z');
    INSERT INTO incident_occurrences(incident_id,occurrence_id,update_sequence)
    VALUES('0199d0a8-2e12-7a59-a51e-44aa9b6d1025','0199d0a8-2e12-7a59-a51e-44aa9b6d1024',1);
  `);
}

async function seedComponentIssue(db: TestD1Database): Promise<void> {
  await db.exec(`
    INSERT INTO services(service_name,display_name,description,owner,criticality,created_at,updated_at)
    VALUES('identity','Identity','','platform','critical','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');
    INSERT INTO components(component_id,service_name,display_name,description,created_at,updated_at)
    VALUES('login','identity','Login','','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');
    INSERT INTO evaluation_policies(policy_id,revision,schema_version,name,observation_window_seconds,minimum_samples,
      failure_threshold,recovery_threshold,latency_threshold_ms,stale_after_seconds,location_quorum,
      fingerprint_template_json,status_mapping_json,diagnostic_rules_json,created_by,created_at)
    VALUES('probe-policy',1,'1.0','Probe',300,1,0.5,0.1,NULL,120,1,'{}','{"failure_status":"partial_outage"}',
      '{"minimum_occurrences":1,"status_by_severity":{"info":"degraded","warning":"degraded","error":"partial_outage","critical":"major_outage"}}','test','2026-09-01T00:00:00.000Z');
    INSERT INTO monitors(monitor_id,target_type,target_id,probe_kind,environment,schedule_kind,interval_seconds,timeout_ms,
      probe_config_json,policy_id,policy_revision,next_run_at,created_at,updated_at)
    VALUES('0199d0a8-2e12-7a59-a51e-44aa9b6d1040','component','login','http','production','interval',60,5000,
      '{"url":"https://health.example.com"}','probe-policy',1,'2026-09-12T00:00:00.000Z','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');
    INSERT INTO issues(issue_id,fingerprint_hash,service_name,kind,severity,state,first_seen_at,last_seen_at,occurrence_count,
      affected_instance_count,policy_id,policy_revision,revision)
    VALUES('0199d0a8-2e12-7a59-a51e-44aa9b6d1041','${"c".repeat(64)}','identity','health.probe_failed','error','observed',
      '2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z',1,0,'probe-policy',1,1);
    UPDATE issues SET state='active',revision=2 WHERE issue_id='0199d0a8-2e12-7a59-a51e-44aa9b6d1041';
    INSERT INTO maintenance_windows(maintenance_id,title,description,expected_impact,starts_at,ends_at,state,created_by,created_at,updated_at)
    VALUES('0199d0a8-2e12-7a59-a51e-44aa9b6d1042','Old','Old','degraded','2026-09-10T00:00:00.000Z','2026-09-11T00:00:00.000Z','active',
      'test','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');
    INSERT INTO maintenance_targets(maintenance_id,target_type,target_id)
    VALUES('0199d0a8-2e12-7a59-a51e-44aa9b6d1042','component','login');
  `);
}

async function seedRecoveringIssue(db: TestD1Database): Promise<void> {
  await seedMonitor(db);
  await db.exec(`
    INSERT INTO deployments(deployment_id,service_name,environment,service_version,repository_url,git_commit,git_ref,artifact_digest,
      ci_provider,ci_run_id,deployed_at,manifest_object_key,manifest_digest,manifest_schema_version,registered_at,registered_by)
    VALUES('0199d0a8-2e12-7a59-a51e-44aa9b6d1060','identity','production','1','https://example.com/repo',
      '${"a".repeat(40)}','main','sha256:${"a".repeat(64)}','test','1','2026-09-01T00:00:00.000Z','manifest/probe',
      'sha256:${"b".repeat(64)}','1.0','2026-09-01T00:00:00.000Z','test');
    INSERT INTO diagnostic_event_dedup(event_id,event_schema_version,service_name,deployment_id,kind,severity,occurred_at,received_at,
      processed_at,fingerprint_hash,payload_digest,envelope_schema_version,processing_token,producer_subject)
    VALUES('0199d0a8-2e12-7a59-a51e-44aa9b6d1061','1.0','identity','0199d0a8-2e12-7a59-a51e-44aa9b6d1060',
      'health.probe_failed','warning','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z',
      '${"d".repeat(64)}','sha256:${"c".repeat(64)}','1.0','probe-fault-token','status-scheduler');
    INSERT INTO issues(issue_id,fingerprint_hash,service_name,kind,severity,state,first_seen_at,last_seen_at,occurrence_count,
      affected_instance_count,policy_id,policy_revision,revision,last_fault_event_id)
    VALUES('0199d0a8-2e12-7a59-a51e-44aa9b6d1050','${"d".repeat(64)}','identity','health.probe_failed','warning','observed',
      '2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z',1,0,'probe-policy',1,1,
      '0199d0a8-2e12-7a59-a51e-44aa9b6d1061');
    UPDATE issues SET state='active',revision=2 WHERE issue_id='0199d0a8-2e12-7a59-a51e-44aa9b6d1050';
  `);
}

function monitorForLifecycle(): ClaimedMonitor {
  return {
    locations: ["cloudflare-worker"],
    monitorId: "0199d0a8-2e12-7a59-a51e-44aa9b6d1001",
    target: { type: "service", id: "identity", serviceName: "identity" },
    probe: { kind: "http", url: "https://health.example.com" },
    timeoutMs: 5_000,
    intervalMs: 60_000,
    scheduledFor: "2026-09-12T00:00:00.000Z",
    nextRunAt: "2026-09-12T00:01:00.000Z",
    critical: true,
    policy: {
      policyId: "probe-policy",
      revision: 1,
      observationWindowMs: 300_000,
      minimumSamples: 1,
      failureThreshold: 0.5,
      recoveryThreshold: 0.1,
      latencyThresholdMs: null,
      staleAfterMs: 120_000,
      locationQuorum: 1,
      fingerprintTemplate: {},
      statusMapping: { failure_status: "degraded" },
    },
  };
}

function successfulObservation(monitor: ClaimedMonitor): Observation {
  return {
    observationId: "0199d0a8-2e12-7a59-a51e-44aa9b6d1051",
    monitorId: monitor.monitorId,
    observedAt: "2026-09-12T00:00:00.000Z",
    execution: { runtime: "cloudflare-worker" },
    outcome: "success",
    latencyMs: 10,
    protocolStatus: "http_200",
    errorType: null,
    correlationId: "0199d0a8-2e12-7a59-a51e-44aa9b6d1052",
  };
}

function checkpointForLifecycle(
  monitor: ClaimedMonitor,
  observation: Observation,
): MonitorCheckpoint {
  return {
    monitorId: monitor.monitorId,
    location: "cloudflare-worker",
    windowStartedAt: observation.observedAt,
    lastObservedAt: observation.observedAt,
    consecutiveSuccesses: 1,
    consecutiveFailures: 0,
    windowSamples: 1,
    windowUnhealthySamples: 0,
    windowLatencyP95Ms: null,
    evaluationStatus: "degraded",
    evaluatedAt: observation.observedAt,
    freshUntil: "2026-09-12T00:02:00.000Z",
    policyId: monitor.policy.policyId,
    policyRevision: monitor.policy.revision,
    revision: 1,
  };
}

type WrappedStatement = ReturnType<D1DatabaseLike["prepare"]> & {
  readonly rawStatement: () => TestD1PreparedStatement;
};

/** 测试专用结构适配器，不以双重断言隐藏平台类型错误。 / Test-only structural adapter that avoids hiding platform type errors behind a double assertion. */
function adaptTestD1(
  db: TestD1Database,
  afterBatch?: (batchNumber: number) => Promise<void>,
): D1DatabaseLike {
  let batchNumber = 0;
  const wrap = (raw: TestD1PreparedStatement): WrappedStatement => ({
    bind(...values): WrappedStatement {
      return wrap(raw.bind(...values));
    },
    all: <T>() => raw.all<T>(),
    first: <T>() => raw.first<T>(),
    run: <T>() => raw.run<T>(),
    rawStatement: () => raw,
  });
  return {
    prepare: (sql) => wrap(db.prepare(sql)),
    async batch<T>(
      statements: D1StatementLike[],
    ): Promise<import("./store.js").D1ResultLike<T>[]> {
      const raw: TestD1PreparedStatement[] = [];
      for (const statement of statements) {
        if (
          !("rawStatement" in statement) ||
          typeof statement.rawStatement !== "function"
        ) {
          throw new Error("foreign test statement");
        }
        const candidate: unknown = statement.rawStatement();
        if (!(candidate instanceof TestD1PreparedStatement))
          throw new Error("foreign test statement");
        raw.push(candidate);
      }
      const result = await db.batch<T>(raw);
      batchNumber += 1;
      await afterBatch?.(batchNumber);
      return result;
    },
  };
}

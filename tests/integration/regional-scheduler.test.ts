import {
  runSchedulerTick,
  type SchedulerDependencies,
} from "../../workers/status/src/scheduling/scheduler.js";
import { afterEach, describe, it, expect } from "vitest";
import {
  createMigratedD1,
  TestD1PreparedStatement,
  type TestD1Database,
} from "./d1.js";
import { realDomainCore } from "./wasm.js";
import {
  D1SchedulerStore,
  type D1DatabaseLike,
  type D1StatementLike,
} from "../../workers/status/src/scheduling/store.js";
import { createRustMonitorEvaluator } from "../../workers/status/src/scheduling/rust.js";
import type {
  ClaimedMonitor,
  Observation,
} from "../../workers/status/src/scheduling/types.js";
let db: TestD1Database;
afterEach(() => db?.close());
const now = new Date("2026-09-12T00:00:00.000Z");
/** 真实领域核心与 D1 schema 测试。 / Tests using the real domain core and D1 schema. */
async function setup() {
  db = await createMigratedD1();
  await seedMonitor(db);
  await db
    .prepare(
      "UPDATE monitor_locations SET enabled=0 WHERE location='cloudflare-worker'",
    )
    .run();
  const store = new D1SchedulerStore(adaptTestD1(db));
  const monitor = (await store.claimDue(now, "owner", 60000, 1))[0]!;
  return {
    store,
    monitor: {
      ...monitor,
      locations: ["colo-a", "colo-b"],
      policy: { ...monitor.policy, locationQuorum: 2 },
    },
    evaluator: createRustMonitorEvaluator(realDomainCore()),
  };
}
/** 构造平台认证的样本。 / Construct a platform-attested observation. */
function observation(
  monitor: ClaimedMonitor,
  location: string,
  colo: string,
): Observation {
  return {
    monitorId: monitor.monitorId,
    observationId: "0199d0a8-2e12-7a59-a51e-44aa9b6d1050",
    observedAt: now.toISOString(),
    execution: {
      runtime: "cloudflare-worker",
      location,
      executorId: `exec-${location}`,
      actualColo: colo,
    },
    outcome: "failure",
    latencyMs: 5,
    protocolStatus: "503",
    errorType: null,
    correlationId: "0199d0a8-2e12-7a59-a51e-44aa9b6d1051",
  };
}
describe("regional scheduling authoritative windows", () => {
  it("runs one claimed lease across all configured regions and treats unreachable executors as absent samples", async () => {
    const { store, evaluator } = await setup();
    await db
      .prepare(
        "UPDATE monitors SET lease_owner=NULL,lease_expires_at=NULL,revision=revision+1",
      )
      .run();
    await db
      .prepare(
        "UPDATE monitor_locations SET enabled=0 WHERE location='cloudflare-worker'",
      )
      .run();
    const calls: { location: string; runId: string }[] = [];
    const dependencies: SchedulerDependencies = {
      monitors: store,
      expiry: store,
      outbox: store,
      retention: store,
      evaluator,
      diagnostics: { process: async () => "processed" },
      observations: { write: () => undefined },
      issueLifecycle: { apply: async () => undefined },
      reevaluator: { reevaluate: async () => undefined },
      regionalDispatcher: {
        dispatch: async (monitor, location, runId, correlationId) => {
          calls.push({ location, runId });
          return location === "colo-b"
            ? null
            : { ...observation(monitor, location, "SIN"), correlationId };
        },
      },
      outboxDeliverers: {},
      outboxPolicy: {
        maxAttempts: 3,
        baseBackoffMs: 1,
        maxBackoffMs: 5,
        deliveryDeadlineMs: 5,
        concurrency: 1,
      },
      now: () => now.getTime(),
    };
    const result = await runSchedulerTick(dependencies, {
      globalConcurrency: 2,
      perTargetConcurrency: 1,
      monitorBatchSize: 5,
      outboxBatchSize: 5,
      invocationDeadlineMs: 1000,
      leaseMs: 6000,
    });
    expect(calls.map((value) => value.location)).toEqual(["colo-a", "colo-b"]);
    expect(new Set(calls.map((value) => value.runId)).size).toBe(1);
    expect(result.probed).toBe(1);
    expect(result.timedOut).toBe(0);
    expect(
      await store.readCheckpoints("0199d0a8-2e12-7a59-a51e-44aa9b6d1001"),
    ).toHaveLength(1);
    expect(
      await db.prepare("SELECT next_run_at,lease_owner FROM monitors").first(),
    ).toEqual({ next_run_at: "2026-09-12T00:01:00.000Z", lease_owner: null });
  });
  it("loads only enabled configured locations and commits two colos with one schedule advance", async () => {
    const { store, monitor, evaluator } = await setup();
    expect(await store.readCheckpoints(monitor.monitorId)).toEqual([]);
    const result = await evaluator.evaluateBatch!(
      monitor,
      [],
      [
        observation(monitor, "colo-a", "SIN"),
        observation(monitor, "colo-b", "NRT"),
      ],
    );
    expect(result.map((x) => x.checkpoint.evaluationStatus)).toEqual([
      "degraded",
      "degraded",
    ]);
    await store.commitEvaluation(
      monitor,
      result.map((x) => x.checkpoint),
      "owner",
      now,
    );
    expect(await store.readCheckpoints(monitor.monitorId)).toHaveLength(2);
    expect(
      await db
        .prepare("SELECT next_run_at,last_run_at,lease_owner FROM monitors")
        .first(),
    ).toEqual({
      next_run_at: "2026-09-12T00:01:00.000Z",
      last_run_at: now.toISOString(),
      lease_owner: null,
    });
  });
  it("configuration change between planning and commit rolls back all checkpoints", async () => {
    const { store, monitor, evaluator } = await setup();
    const result = await evaluator.evaluateBatch!(
      monitor,
      [],
      [
        observation(monitor, "colo-a", "SIN"),
        observation(monitor, "colo-b", "NRT"),
      ],
    );
    await db
      .prepare("UPDATE monitor_locations SET enabled=0 WHERE location='colo-b'")
      .run();
    await expect(
      store.commitEvaluation(
        monitor,
        result.map((value) => value.checkpoint),
        "owner",
        now,
      ),
    ).rejects.toThrow();
    expect(await store.readCheckpoints(monitor.monitorId)).toEqual([]);
    expect(
      (await db
        .prepare("SELECT next_run_at FROM monitors")
        .first<{ next_run_at: string }>())!.next_run_at,
    ).toBe(monitor.scheduledFor);
  });
  it("same colo aliases do not satisfy two-location quorum", async () => {
    const { monitor, evaluator } = await setup();
    const result = await evaluator.evaluateBatch!(
      monitor,
      [],
      [
        observation(monitor, "colo-a", "SIN"),
        observation(monitor, "colo-b", "SIN"),
      ],
    );
    expect(
      result.every((x) => x.checkpoint.evaluationStatus === "unknown"),
    ).toBe(true);
  });
  it("missing provenance cannot vote", async () => {
    const { monitor, evaluator } = await setup();
    const bad = {
      ...observation(monitor, "colo-b", "NRT"),
      execution: { runtime: "cloudflare-worker" as const, location: "colo-b" },
    };
    const result = await evaluator.evaluateBatch!(
      monitor,
      [],
      [observation(monitor, "colo-a", "SIN"), bad],
    );
    expect(
      result.every((x) => x.checkpoint.evaluationStatus === "unknown"),
    ).toBe(true);
  });
  it("colo shift resets counters and expired lease rolls back every checkpoint", async () => {
    const { store, monitor, evaluator } = await setup();
    const initial = await evaluator.evaluateBatch!(
      monitor,
      [],
      [observation(monitor, "colo-a", "SIN")],
    );
    const next = await evaluator.evaluateBatch!(
      monitor,
      initial.map((x) => x.checkpoint),
      [observation(monitor, "colo-a", "NRT")],
    );
    expect(next[0]!.checkpoint.windowSamples).toBe(1);
    await expect(
      store.commitEvaluation(
        monitor,
        next.map((x) => x.checkpoint),
        "owner",
        new Date(now.getTime() + 60001),
      ),
    ).rejects.toThrow();
    expect(await store.readCheckpoints(monitor.monitorId)).toEqual([]);
    expect(
      (await db
        .prepare("SELECT next_run_at FROM monitors")
        .first<{ next_run_at: string }>())!.next_run_at,
    ).toBe(monitor.scheduledFor);
  });
  it("an observation cannot invent a configured location", async () => {
    const { store, monitor, evaluator } = await setup();
    const result = await evaluator.evaluateBatch!(
      monitor,
      [],
      [observation(monitor, "colo-a", "SIN")],
    );
    await expect(
      store.commitEvaluation(
        monitor,
        result.map((x) => ({ ...x.checkpoint, location: "unconfigured" })),
        "owner",
        now,
      ),
    ).rejects.toThrow();
    expect(
      await db
        .prepare(
          "SELECT location FROM monitor_locations WHERE location='unconfigured'",
        )
        .first(),
    ).toBeNull();
    expect(await store.readCheckpoints(monitor.monitorId)).toEqual([]);
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

type WrappedStatement = ReturnType<D1DatabaseLike["prepare"]> & {
  readonly rawStatement: () => TestD1PreparedStatement;
};

/** 测试专用结构适配器，不以双重断言隐藏平台类型错误。 / Test-only structural adapter that avoids hiding platform type errors behind a double assertion. */
function adaptTestD1(db: TestD1Database): D1DatabaseLike {
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
    ): Promise<
      import("../../workers/status/src/scheduling/store.js").D1ResultLike<T>[]
    > {
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
      return db.batch<T>(raw);
    },
  };
}

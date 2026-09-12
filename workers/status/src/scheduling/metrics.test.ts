import { afterEach, describe, expect, it } from "vitest";
import {
  createMigratedD1,
  type TestD1Database,
} from "../../../../tests/integration/d1.js";
import { readSchedulingMetrics } from "./metrics.js";
let database: TestD1Database | undefined;
afterEach(() => {
  database?.close();
  database = undefined;
});
describe("scheduler telemetry SQL", () => {
  it("counts due and missing monitors once, honors leases and counts pending outbox", async () => {
    database = await createMigratedD1();
    await seedMonitor(database);
    const now = new Date("2026-09-12T00:00:00.000Z");
    expect(await readSchedulingMetrics(database, now)).toEqual({
      due: 1,
      missing: 1,
      stale: 0,
      backlog: 0,
    });
    await database.exec(`UPDATE monitors SET lease_owner='owner',lease_expires_at='2026-09-12T00:01:00.000Z',revision=revision+1;
      INSERT INTO outbox(outbox_id,aggregate_type,aggregate_id,event_type,schema_version,payload_json,available_at,next_attempt_at,created_at)
      VALUES('0199d0a8-2e12-7a59-a51e-44aa9b6d1111','service','identity','status.changed','1.0','{}','2026-09-12T00:00:00.000Z','2026-09-12T00:00:00.000Z','2026-09-12T00:00:00.000Z');`);
    expect(await readSchedulingMetrics(database, now)).toEqual({
      due: 0,
      missing: 1,
      stale: 0,
      backlog: 1,
    });
    expect(
      (
        await readSchedulingMetrics(
          database,
          new Date("2026-09-12T00:01:00.000Z"),
        )
      ).due,
    ).toBe(1);
  });
  it("counts stale enabled-location checkpoints separately from missing ones", async () => {
    database = await createMigratedD1();
    await seedMonitor(database);
    await database.exec(`INSERT INTO monitor_checkpoints(monitor_id,location,last_observed_at,window_started_at,evaluation_status,evaluated_at,fresh_until,policy_id,policy_revision)
      VALUES('0199d0a8-2e12-7a59-a51e-44aa9b6d1001','colo-a','2026-09-11T00:00:00.000Z','2026-09-11T00:00:00.000Z','unknown','2026-09-11T00:00:00.000Z','2026-09-11T00:02:00.000Z','probe-policy',1);`);
    expect(
      await readSchedulingMetrics(
        database,
        new Date("2026-09-12T00:00:00.000Z"),
      ),
    ).toEqual({ due: 1, stale: 1, missing: 1, backlog: 0 });
    await database.exec(
      "UPDATE monitor_locations SET enabled=0 WHERE location='colo-a'",
    );
    expect(
      (
        await readSchedulingMetrics(
          database,
          new Date("2026-09-12T00:00:00.000Z"),
        )
      ).stale,
    ).toBe(0);
  });
});
/** 填充真实迁移后的监控记录。 / Seed monitor records under the real migrations. */
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

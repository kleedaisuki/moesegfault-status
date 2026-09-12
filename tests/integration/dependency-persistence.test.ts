import { afterEach, describe, expect, it } from "vitest";

import { D1TargetReevaluator } from "../../workers/status/src/scheduling/reevaluate.js";
import type { D1DatabaseLike } from "../../workers/status/src/scheduling/store.js";
import type { RustDispatcher } from "../../workers/status/src/scheduling/types.js";
import { createMigratedD1, type TestD1Database } from "./d1.js";
import { realDomainCore } from "./wasm.js";

const NOW = new Date("2026-09-12T12:00:00.000Z");
const POLICY = "018f2000-0000-7000-8000-000000000001";
const ISSUE = "018f2000-0000-7000-8000-000000000002";

/** 建立 B 故障、A→B→A 循环和由 A 支撑的 component。 / Seed a B fault, an A→B→A cycle, and a component supported by A. */
async function seed(database: TestD1Database): Promise<void> {
  await database.exec(`
    INSERT INTO services(service_name,display_name,description,owner,criticality,created_at,updated_at)
    VALUES
      ('a','A','','platform','critical','2026-09-12T11:00:00.000Z','2026-09-12T11:00:00.000Z'),
      ('b','B','','platform','critical','2026-09-12T11:00:00.000Z','2026-09-12T11:00:00.000Z');
    INSERT INTO components(component_id,service_name,display_name,description,public,sort_order,enabled,created_at,updated_at)
    VALUES('public','b','Public','',1,0,1,'2026-09-12T11:00:00.000Z','2026-09-12T11:00:00.000Z');
    INSERT INTO component_services(component_id,service_name,role,created_at)
    VALUES('public','a','supporting','2026-09-12T11:00:00.000Z');
    INSERT INTO service_dependencies(source_service,target_service,capability,kind,criticality,created_at)
    VALUES
      ('a','b','storage','required','critical','2026-09-12T11:00:00.000Z'),
      ('b','a','callback','required','critical','2026-09-12T11:00:00.000Z');
    INSERT INTO evaluation_policies(policy_id,revision,schema_version,name,observation_window_seconds,minimum_samples,
      failure_threshold,recovery_threshold,latency_threshold_ms,stale_after_seconds,location_quorum,
      fingerprint_template_json,status_mapping_json,diagnostic_rules_json,created_by,created_at)
    VALUES('${POLICY}',1,'1.0','dependency',300,1,0.5,0.2,NULL,300,1,'{}','{}',
      '{"minimum_occurrences":1,"recovery_min_occurrences":2,"status_by_severity":{"info":"degraded","warning":"degraded","error":"degraded","critical":"major_outage"}}',
      'test','2026-09-12T11:00:00.000Z');
    INSERT INTO current_statuses(target_type,target_id,direct_status,dependency_risk,effective_impact,evaluated_at,fresh_until)
    VALUES
      ('service','a','operational','none','operational','2026-09-12T11:59:00.000Z','2026-09-12T12:10:00.000Z'),
      ('service','b','operational','none','operational','2026-09-12T11:59:00.000Z','2026-09-12T12:10:00.000Z'),
      ('component','public','operational','none','operational','2026-09-12T11:59:00.000Z','2026-09-12T12:10:00.000Z');
    INSERT INTO status_transitions(transition_id,target_type,target_id,sequence,from_status,to_status,source_type,source_id,occurred_at)
    VALUES
      ('018f2000-0000-7000-8000-000000000011','service','a',1,NULL,'operational','freshness','seed-a','2026-09-12T11:59:00.000Z'),
      ('018f2000-0000-7000-8000-000000000012','service','b',1,NULL,'operational','freshness','seed-b','2026-09-12T11:59:00.000Z'),
      ('018f2000-0000-7000-8000-000000000013','component','public',1,NULL,'operational','freshness','seed-public','2026-09-12T11:59:00.000Z');
    INSERT INTO issues(issue_id,fingerprint_hash,service_name,kind,severity,state,first_seen_at,last_seen_at,
      occurrence_count,affected_instance_count,policy_id,policy_revision,revision)
    VALUES('${ISSUE}','${"f".repeat(64)}','b','dependency.unavailable','critical','observed',
      '2026-09-12T11:59:30.000Z','2026-09-12T11:59:30.000Z',1,0,'${POLICY}',1,1);
    UPDATE issues SET state='active',revision=2 WHERE issue_id='${ISSUE}';
  `);
}

/** 读取指定目标的持久 fanout 并调用同一个重评估器。 / Read a target's durable fanout and invoke the same reevaluator. */
async function deliver(
  database: TestD1Database,
  reevaluator: D1TargetReevaluator,
  type: "service" | "component",
  id: string,
): Promise<void> {
  const row = await database
    .prepare(
      `SELECT outbox_id,payload_json FROM outbox WHERE event_type='status.reevaluation_requested'
       AND json_extract(payload_json,'$.target_type')=? AND json_extract(payload_json,'$.target_id')=?
       ORDER BY created_at,outbox_id LIMIT 1`,
    )
    .bind(type, id)
    .first<{ outbox_id: string; payload_json: string }>();
  if (row === null) throw new Error(`missing fanout for ${type}:${id}`);
  const payload = JSON.parse(row.payload_json) as {
    source_type: string;
    source_id: string;
  };
  await reevaluator.reevaluate(
    { type, id },
    { type: payload.source_type, id: payload.source_id },
    new AbortController().signal,
  );
}

describe("persisted dependency-risk fanout", () => {
  let database: TestD1Database | undefined;
  afterEach(() => database?.close());

  it("persists B→A risk, reaches A-supported component, and converges across a cycle", async () => {
    database = await createMigratedD1();
    await seed(database);
    const reevaluator = new D1TargetReevaluator(
      database as unknown as D1DatabaseLike,
      realDomainCore() as unknown as RustDispatcher,
      () => NOW.getTime(),
    );

    await reevaluator.reevaluate(
      { type: "service", id: "b" },
      { type: "issue", id: ISSUE },
      new AbortController().signal,
    );
    await deliver(database, reevaluator, "service", "a");
    await expect(
      database
        .prepare(
          "SELECT direct_status,dependency_risk,effective_impact FROM current_statuses WHERE target_type='service' AND target_id='a'",
        )
        .first(),
    ).resolves.toEqual({
      direct_status: "operational",
      dependency_risk: "major_outage",
      effective_impact: "major_outage",
    });

    await deliver(database, reevaluator, "component", "public");
    await expect(
      database
        .prepare(
          "SELECT direct_status,dependency_risk,effective_impact FROM current_statuses WHERE target_type='component' AND target_id='public'",
        )
        .first(),
    ).resolves.toEqual({
      direct_status: "operational",
      dependency_risk: "major_outage",
      effective_impact: "major_outage",
    });

    await deliver(database, reevaluator, "service", "b");
    await deliver(database, reevaluator, "service", "b");
    await expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM outbox WHERE event_type='status.reevaluation_requested'",
        )
        .first<number>("count"),
    ).resolves.toBe(3);
    await expect(
      database
        .prepare(
          "SELECT from_status,to_status FROM status_transitions WHERE target_type='service' AND target_id='a' ORDER BY sequence DESC LIMIT 1",
        )
        .first(),
    ).resolves.toEqual({
      from_status: "operational",
      to_status: "major_outage",
    });
  });
});

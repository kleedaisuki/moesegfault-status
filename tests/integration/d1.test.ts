import { afterEach, describe, expect, it } from "vitest";

import { createMigratedD1, type TestD1Database } from "./d1.js";

const AT = "2026-09-12T00:00:00.000Z";

/** 生成最小有效服务插入。 / Build the smallest valid service insert. */
function insertService(db: TestD1Database, name: string) {
  return db
    .prepare(
      `INSERT INTO services
    (service_name,display_name,description,owner,criticality,enabled,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`,
    )
    .bind(name, name.toUpperCase(), "", "platform", "high", 1, AT, AT);
}

describe("real SQL D1 adapter", () => {
  const opened: TestD1Database[] = [];

  afterEach(() => {
    for (const database of opened.splice(0)) database.close();
  });

  async function database(): Promise<TestD1Database> {
    const value = await createMigratedD1();
    opened.push(value);
    return value;
  }

  it("executes every migration and exposes prepare/bind/run/first/all", async () => {
    const db = await database();

    const inserted = await insertService(db, "api").run();
    const row = await db
      .prepare("SELECT service_name,enabled FROM services WHERE service_name=?")
      .bind("api")
      .first<{ service_name: string; enabled: number }>();
    const targets = await db
      .prepare(
        "SELECT target_type,target_id FROM status_targets ORDER BY target_id",
      )
      .all();

    expect(inserted.success).toBe(true);
    expect(inserted.meta.changes).toBe(1);
    expect(row).toEqual({ service_name: "api", enabled: 1 });
    expect(targets.results).toEqual([
      { target_type: "service", target_id: "api" },
    ]);
    await expect(
      db
        .prepare("SELECT service_name FROM services")
        .first<string>("service_name"),
    ).resolves.toBe("api");
  });

  it("rolls back the entire D1 batch after a later constraint failure", async () => {
    const db = await database();
    const statements = [insertService(db, "api"), insertService(db, "api")];

    await expect(db.batch(statements)).rejects.toThrow();
    await expect(
      db.prepare("SELECT COUNT(*) FROM services").first<number>("COUNT(*)"),
    ).resolves.toBe(0);
  });

  it("supports first-primary sessions without pretending to model replicas", async () => {
    const db = await database();
    const session = db.withSession("first-primary");

    expect(session.getBookmark()).toBeNull();
    await session.batch([
      session
        .prepare(
          "INSERT INTO services (service_name,display_name,description,owner,criticality,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
        )
        .bind("api", "API", "", "platform", "high", 1, AT, AT),
    ]);
    expect(session.getBookmark()).toBe("test-primary:1");
    await expect(
      session
        .prepare("SELECT service_name FROM services")
        .first<string>("service_name"),
    ).resolves.toBe("api");
    expect(session.getBookmark()).toBe("test-primary:2");
    expect(() => db.withSession("first-unconstrained")).toThrow(
      /first-primary/u,
    );
  });

  it("rejects undefined bindings instead of silently persisting NULL", async () => {
    const db = await database();
    expect(() => db.prepare("SELECT ?").bind(undefined)).toThrow(/undefined/u);
  });
});

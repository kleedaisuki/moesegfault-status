import { describe, expect, it } from "vitest";
import {
  activationCommand,
  componentCreateCommand,
  componentUpdateCommand,
  dependencyRows,
  retentionCommand,
  serviceUpdateCommand,
} from "./catalog-commands";

const id = "0199d0a8-2e12-7000-8000-000000000001";
/** 完整 Component 表单夹具。 / Complete Component form fixture. */
const component = {
  display_name: "API",
  description: "",
  sort_order: "0",
  public: "on",
  enabled: "on",
  supporting_services: "cache, storage",
};

describe("catalog command contracts", () => {
  it("distinguishes first assignment from a known assignment revision", () => {
    const raw = {
      service_name: "api",
      policy_id: "default",
      policy_revision: "1",
      occurrence_retention_days: "30",
      cleanup_batch_size: "100",
    };
    expect(retentionCommand(raw, id).expected_assignment_revision).toBeNull();
    expect(
      retentionCommand({ ...raw, expected_assignment_revision: "4" }, id)
        .expected_assignment_revision,
    ).toBe(4);
    expect(() =>
      retentionCommand({ ...raw, expected_assignment_revision: "0" }, id),
    ).toThrow();
  });
  it("requires exact deployment revision and an explicit activation reason", () => {
    expect(
      activationCommand(
        { expected_deployment_revision: "3", reason: "Verified real deploy" },
        id,
      ),
    ).toMatchObject({
      expected_pointer_revision: null,
      expected_deployment_revision: 3,
    });
    expect(() =>
      activationCommand({ expected_deployment_revision: "", reason: "" }, id),
    ).toThrow();
  });
  it("supports multiple capabilities but rejects malformed and duplicate edges", () => {
    const base = {
      display_name: "API",
      description: "",
      owner: "team",
      criticality: "high",
      enabled: "on",
    };
    const row = "storage, read, required, high";
    expect(
      serviceUpdateCommand(
        { ...base, dependencies: `${row}\nstorage, write, optional, low` },
        id,
      ).dependencies,
    ).toHaveLength(2);
    expect(() =>
      serviceUpdateCommand({ ...base, dependencies: `${row}\n${row}` }, id),
    ).toThrow();
    expect(() => dependencyRows("storage, read")).toThrow();
    expect(
      serviceUpdateCommand({ ...base, dependencies: "" }, id).dependencies,
    ).toEqual([]);
  });
  it("preserves immutable component identity and zero sort order", () => {
    expect(
      componentCreateCommand(
        { ...component, component_id: "api", owner_service: "gateway" },
        id,
      ),
    ).toMatchObject({
      component_id: "api",
      owner_service: "gateway",
      sort_order: 0,
    });
    const update = componentUpdateCommand(
      { ...component, owner_service: "evil", component_id: "renamed" },
      id,
    );
    expect(update).not.toHaveProperty("owner_service");
    expect(update).not.toHaveProperty("component_id");
    expect(() =>
      componentCreateCommand(
        { ...component, component_id: "api", owner_service: "cache" },
        id,
      ),
    ).toThrow();
    expect(() =>
      componentUpdateCommand(
        { ...component, supporting_services: "cache,cache" },
        id,
      ),
    ).toThrow();
  });
});

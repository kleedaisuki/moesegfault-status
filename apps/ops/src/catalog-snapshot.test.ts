// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { populateSnapshot, snapshotFields } from "./catalog-snapshot";

const id = "0199d0a8-2e12-7000-8000-000000000001";
const timestamp = "2026-09-12T00:00:00Z";

describe("authoritative catalog snapshots", () => {
  it("preserves exact revisions, disabled state, all dependency capabilities and false checkboxes", () => {
    const fields = snapshotFields("service", {
      service_name: "api",
      display_name: "API",
      description: "",
      owner: "team",
      criticality: "high",
      enabled: false,
      dependencies: [
        {
          target_service: "storage",
          capability: "read",
          kind: "required",
          criticality: "critical",
        },
        {
          target_service: "storage",
          capability: "write",
          kind: "optional",
          criticality: "low",
        },
      ],
      created_at: timestamp,
      updated_at: timestamp,
      revision: 7,
    });
    expect(fields.revision).toBe("7");
    expect(fields.dependencies).toBe(
      "storage, read, required, critical\nstorage, write, optional, low",
    );
    const form = document.createElement("form");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.name = "enabled";
    checkbox.checked = true;
    form.append(checkbox);
    populateSnapshot(form, fields);
    expect(checkbox.checked).toBe(false);
  });
  it("loads both deployment and pointer versions and explicitly represents no current pointer", () => {
    const snapshot = {
      deployment_id: id,
      service_name: "api",
      environment: "production",
      state: "ready",
      deployment_revision: 4,
      current_pointer: { deployment_id: id, revision: 12 },
    };
    expect(snapshotFields("activation", snapshot)).toMatchObject({
      expected_deployment_revision: "4",
      expected_pointer_revision: "12",
    });
    expect(
      snapshotFields("activation", { ...snapshot, current_pointer: null })
        .expected_pointer_revision,
    ).toBe("");
  });
  it("rejects public projections that omit authoritative revision", () => {
    expect(() =>
      snapshotFields("service", { service_name: "api", status: "operational" }),
    ).toThrow();
  });
});

import { describe, expect, it } from "vitest";

import {
  CreateComponentCommandSchema,
  UpdateServiceCatalogCommandSchema,
} from "../src/catalog.js";

const COMMAND = "018f0000-0000-7000-8000-000000000701";

describe("catalog mutation contracts", () => {
  it("rejects duplicate authored dependency identities", () => {
    const parsed = UpdateServiceCatalogCommandSchema.safeParse({
      command_id: COMMAND,
      dependencies: [
        {
          target_service: "database",
          capability: "storage",
          kind: "required",
          criticality: "critical",
        },
        {
          target_service: "database",
          capability: "storage",
          kind: "optional",
          criticality: "low",
        },
      ],
    });

    expect(parsed.success).toBe(false);
  });

  it("treats owner and supporting service roles as disjoint", () => {
    const parsed = CreateComponentCommandSchema.safeParse({
      command_id: COMMAND,
      component_id: "public-api",
      owner_service: "api",
      display_name: "Public API",
      description: "Public request path",
      public: true,
      sort_order: 10,
      enabled: true,
      supporting_services: ["api"],
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts an empty exact dependency set for unlinking all edges", () => {
    const parsed = UpdateServiceCatalogCommandSchema.parse({
      command_id: COMMAND,
      dependencies: [],
    });

    expect(parsed.dependencies).toEqual([]);
  });
});

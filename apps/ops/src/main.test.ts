// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ write: vi.fn(), catalogSnapshot: vi.fn() }));
vi.mock("./api", () => ({
  ApiError: class extends Error {},
  api: {
    session: async () => ({
      data: {
        subject: "operator",
        email: "ops@example.com",
        roles: ["admin"],
        authenticated_at: "2026-09-12T00:00:00Z",
        access_application: "ops",
      },
    }),
    health: async () => ({ data: { status: "ok", dependencies: [] } }),
    platform: async () => {
      throw new Error("offline");
    },
    services: async () => ({ data: [] }),
    incidents: async () => ({ data: [] }),
    write: mocked.write,
    catalogSnapshot: mocked.catalogSnapshot,
  },
}));

/** 根据标题找到真实 UI 表单，而非复制实现。 / Find the real UI form by heading rather than duplicating implementation. */
function formFor(title: string): HTMLFormElement {
  const heading = [...document.querySelectorAll("h2")].find(
    (node) => node.textContent === title,
  );
  if (!heading) throw new Error(`Missing panel ${title}`);
  return heading.closest(".panel")!.querySelector("form")!;
}

/** 填充真实 DOM 控件。 / Populate actual DOM controls. */
function fill(form: HTMLFormElement, values: Record<string, string>): void {
  for (const [name, value] of Object.entries(values)) {
    const input = form.elements.namedItem(name) as HTMLInputElement;
    input.value = value;
  }
}

beforeEach(async () => {
  vi.resetModules();
  vi.spyOn(window, "setInterval").mockReturnValue(setTimeout(() => {}, 0));
  mocked.write.mockReset().mockResolvedValue({ data: { revision: 5 } });
  document.body.replaceChildren(
    Object.assign(document.createElement("div"), { id: "app" }),
  );
  await import("./main");
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("退出登录"),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("real bootstrap and catalog UI", () => {
  it("loads actual activation form revisions from an authoritative snapshot", async () => {
    const id = "0199d0a8-2e12-7000-8000-000000000001";
    mocked.catalogSnapshot.mockResolvedValue({
      data: {
        deployment_id: id,
        service_name: "api",
        environment: "production",
        state: "ready",
        deployment_revision: 7,
        current_pointer: { deployment_id: id, revision: 11 },
      },
    });
    const form = formFor("激活已部署版本");
    fill(form, { id });
    form.querySelector<HTMLButtonElement>('button[type="button"]')!.click();
    await vi.waitFor(() =>
      expect(
        (
          form.elements.namedItem(
            "expected_deployment_revision",
          ) as HTMLInputElement
        ).value,
      ).toBe("7"),
    );
    expect(
      (form.elements.namedItem("expected_pointer_revision") as HTMLInputElement)
        .value,
    ).toBe("11");
    expect(mocked.catalogSnapshot).toHaveBeenCalledWith("activation", id);
  });
  it("submits retention with an explicit first-assignment guard and displays returned revision", async () => {
    const form = formFor("绑定数据保留策略");
    fill(form, {
      service_name: "api",
      policy_id: "default",
      policy_revision: "1",
      occurrence_retention_days: "30",
      cleanup_batch_size: "50",
    });
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(mocked.write).toHaveBeenCalledOnce());
    expect(mocked.write.mock.calls[0]?.[1]).toMatchObject({
      expected_assignment_revision: null,
      policy: { occurrence_retention_days: 30 },
    });
    expect(form.closest(".panel")?.textContent).toContain('"revision": 5');
  });
  it("sends catalog OCC revision and does not retry a conflict", async () => {
    mocked.write.mockRejectedValue(new Error("409 revision conflict"));
    const form = formFor("编辑服务与依赖");
    fill(form, {
      id: "api",
      revision: "4",
      display_name: "API",
      description: "",
      owner: "team",
      criticality: "high",
      dependencies: "storage, read, required, high",
    });
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("409 revision conflict"),
    );
    expect(mocked.write).toHaveBeenCalledOnce();
    expect(mocked.write.mock.calls[0]?.[3]).toBe(4);
    expect(
      (form.elements.namedItem("revision") as HTMLInputElement).value,
    ).toBe("4");
    const commandId = mocked.write.mock.calls[0]?.[1].command_id;
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(mocked.write).toHaveBeenCalledTimes(2));
    expect(mocked.write.mock.calls[1]?.[1].command_id).toBe(commandId);
  });
  it("blocks malformed revisions before network writes even when submit is dispatched programmatically", async () => {
    const form = formFor("编辑 Component 与支撑服务");
    fill(form, {
      id: "api",
      revision: "0",
      display_name: "API",
      sort_order: "0",
    });
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        "必须填写刚读取的正整数 revision",
      ),
    );
    expect(mocked.write).not.toHaveBeenCalled();
  });
});

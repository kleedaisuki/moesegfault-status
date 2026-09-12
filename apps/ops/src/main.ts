import {
  TelemetryBackendQueryAdapterSchema,
  AssignDiagnosticPolicyCommandSchema,
  CreateMonitorCommandSchema,
  RegisterEvaluationPolicyCommandSchema,
  RegisterServiceCommandSchema,
  RegisterTelemetryBackendCommandSchema,
  SetStatusOverrideCommandSchema,
  UpdateMonitorCommandSchema,
  type AdminPrincipal,
  type PlatformStatus,
  type PublicIncidentSummary,
  type PublicServiceSummary,
} from "@moesegfault/contracts";
import { api, ApiError } from "./api";
import { renderEvidenceResult } from "./evidence-view";
import {
  renderDiagnosticContext,
  refreshDiagnosticFreshness,
} from "./context-view";
import {
  populateSnapshot,
  snapshotFields,
  type SnapshotKind,
} from "./catalog-snapshot";
import {
  activationCommand,
  retentionCommand,
  serviceUpdateCommand,
  componentCreateCommand,
  componentUpdateCommand,
} from "./catalog-commands";
import { evaluateFreshness } from "./freshness";
import {
  canOperateRoles,
  gateControl,
  highestRole,
  renderHealthBanner,
  type ControlPlaneChecks,
} from "./health-view";
import { authForm } from "./auth-view";
import "../vendor/moesegfault-style/v0.1.2/css/tokens.css";
import "../vendor/moesegfault-style/v0.1.2/css/foundation.css";
import "../vendor/moesegfault-style/v0.1.2/css/components.css";
import "../vendor/moesegfault-style/v0.1.2/css/icons.css";
import "../vendor/moesegfault-style/v0.1.2/css/motion.css";
import { brandMark } from "./brand-view";
import "./styles.css";

type NodeChild = Node | string | null | undefined;

/** 安全创建 DOM 节点；字符串始终作为 textContent，不解释 HTML。Create DOM safely; strings are always text, never HTML. */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  ...children: NodeChild[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  // 沿用官方组件类与变体契约，不复刻组件配色。 / Reuse official classes and variants, not copied palettes.
  if (
    tag === "button" &&
    !node.classList.contains("tab") &&
    !node.classList.contains("issue")
  ) {
    node.classList.add("moe-button");
    if (node.classList.contains("secondary"))
      node.dataset.variant = "secondary";
    if (node.classList.contains("danger")) node.dataset.variant = "danger";
  }
  if (node.classList.contains("panel")) node.classList.add("moe-card");
  if (node.classList.contains("status")) node.classList.add("moe-badge");
  for (const child of children)
    if (child != null)
      node.append(
        child instanceof Node ? child : document.createTextNode(child),
      );
  return node;
}

/** 从已解码对象读取可选字符串 / Read an optional string from a decoded object. */
function stringOf(value: unknown, key: string, fallback = "—"): string {
  return typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>)[key] === "string"
    ? String((value as Record<string, unknown>)[key])
    : fallback;
}

/** 从已解码对象读取可选数值 / Read an optional number from a decoded object. */
function numberOf(value: unknown, key: string): number | undefined {
  const candidate =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)[key]
      : undefined;
  return typeof candidate === "number" ? candidate : undefined;
}

/** 本地化 RFC 3339 时间 / Format an RFC 3339 timestamp for the local operator. */
function time(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "无效时间"
    : new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "medium",
        timeStyle: "medium",
      }).format(date);
}

/** 状态药丸，保留协议枚举方便排障 / Status pill retaining the protocol enum for diagnosis. */
function statusPill(status: string): HTMLElement {
  const labels: Record<string, string> = {
    operational: "正常",
    degraded: "性能下降",
    partial_outage: "部分中断",
    major_outage: "重大中断",
    maintenance: "维护中",
    unknown: "未知",
  };
  return el("span", `status ${status}`, labels[status] ?? status);
}

/** 应用内存状态；刷新即丢弃，不形成浏览器会话 / In-memory app state; discarded on refresh, never persisted. */
interface AppState {
  principal?: AdminPrincipal;
  platform?: PlatformStatus;
  services: PublicServiceSummary[];
  incidents: PublicIncidentSummary[];
  /** 区分成功空列表与未知结果。 / Distinguish a successfully empty list from an unknown result. */
  incidentsLoaded: boolean;
  checks: ControlPlaneChecks;
}

const state: AppState = {
  services: [],
  incidents: [],
  incidentsLoaded: false,
  checks: {
    access: { state: "checking", detail: "正在验证管理员会话" },
    rpc: { state: "checking", detail: "正在检查管理 RPC" },
    freshness: { state: "checking", detail: "正在读取公开状态证据" },
  },
};

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("Missing #app mount point");
const shell = el("div", "shell");
const main = el("main");
main.id = "main";
main.tabIndex = -1;
const toastRegion = el("div", "toast-region");
toastRegion.setAttribute("role", "status");
toastRegion.setAttribute("aria-live", "polite");
root.append(shell, toastRegion);

/** 显示短时、可被辅助技术播报的反馈 / Show brief feedback announced by assistive technology. */
function toast(message: string, bad = false): void {
  const item = el("div", `toast${bad ? " bad" : ""}`, message);
  toastRegion.append(item);
  window.setTimeout(() => item.remove(), 7000);
}

/** 将未知异常转换为不泄密的运维提示 / Convert an unknown exception into an operator-safe message. */
function errorMessage(error: unknown): string {
  if (error instanceof ApiError)
    return `${error.message}${error.correlationId ? ` · 关联 ID ${error.correlationId}` : ""}`;
  return error instanceof Error ? error.message : "未知错误";
}

/** 当前主体角色；未知字段保持 viewer 的最小权限 / Current role; unknown fields fail closed to viewer. */
function role(): "viewer" | "operator" | "admin" {
  return highestRole(state.principal?.roles ?? []);
}

/** 操作员写权限门禁；服务端仍执行权威授权 / Operator write gate; the server remains authoritative. */
function canOperate(): boolean {
  return canOperateRoles(state.principal?.roles ?? []);
}

/** Catalog 变更仅向 admin 开放 / Catalog mutations are exposed only to admins. */
function canAdmin(): boolean {
  return role() === "admin";
}

/** 重绘整体 shell；数据只来自当前内存快照 / Render the shell from the current in-memory snapshot. */
function render(): void {
  shell.replaceChildren();
  const identityName = state.principal ? "管理员" : "身份未确认";
  const top = el(
    "header",
    "topbar",
    brandMark(),
    el(
      "div",
      "identity",
      el("span", "", identityName),
      el("span", "role moe-badge", "已认证"),
    ),
  );
  const logout = el("button", "", "退出登录");
  logout.type = "button";
  logout.addEventListener("click", async () => {
    logout.disabled = true;
    try {
      await api.logout();
      window.location.reload();
    } catch {
      toast("退出失败，请重试", true);
      logout.disabled = false;
    }
  });
  top.querySelector(".identity")!.append(logout);
  const banner = renderHealthBanner(state.checks);
  const tabs = el("nav", "tabs");
  tabs.setAttribute("aria-label", "运维视图");
  tabs.setAttribute("role", "tablist");
  const views = el("div");
  const definitions = [
    ["overview", "状态总览", renderOverview],
    ["issues", "Issue 检索", renderIssues],
    ["incident", "Incident 证据", renderIncidentWorkbench],
    ["actions", "运维操作", renderActions],
    ["catalog", "Catalog 管理", renderCatalog],
  ] as const;
  definitions.forEach(([id, label, build], index) => {
    const button = el("button", "tab", label);
    button.type = "button";
    button.id = `tab-${id}`;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-controls", `view-${id}`);
    button.setAttribute("aria-selected", index === 0 ? "true" : "false");
    const view = el("section", `view${index === 0 ? " active" : ""}`, build());
    view.id = `view-${id}`;
    view.setAttribute("role", "tabpanel");
    view.setAttribute("aria-labelledby", button.id);
    button.addEventListener("click", () => {
      tabs
        .querySelectorAll(".tab")
        .forEach((item) =>
          item.setAttribute("aria-selected", String(item === button)),
        );
      views
        .querySelectorAll(".view")
        .forEach((item) => item.classList.toggle("active", item === view));
    });
    tabs.append(button);
    views.append(view);
  });
  main.replaceChildren(banner, tabs, views);
  shell.append(top, main);
}

/** 状态总览：公共证据与管理面健康严格分离 / Overview keeping public evidence separate from management-plane health. */
function renderOverview(): HTMLElement {
  const grid = el("div", "grid");
  const platform = state.platform;
  grid.append(
    panel(
      "平台影响",
      "由公开评估器给出的领域状态",
      el(
        "div",
        "metric",
        platform
          ? statusPill(
              evaluateFreshness(platform.fresh_until).kind === "fresh"
                ? platform.status
                : "unknown",
            )
          : "—",
      ),
      el("div", "muted", `评估：${time(platform?.evaluated_at)}`),
    ),
    panel(
      "活动事故",
      "公开且尚未解决",
      el("div", "metric", String(platform?.active_incident_count ?? "—")),
      el(
        "div",
        "muted",
        state.incidentsLoaded
          ? `${state.incidents.length} 条已加载记录`
          : "事故列表尚不可验证",
      ),
    ),
    panel(
      "证据期限",
      "到期后界面立即降级为未知",
      el("div", "metric", platform ? time(platform.fresh_until) : "—"),
      el("div", "muted", "不以缓存可读性替代新鲜度"),
    ),
  );
  const services = el("ul", "service-list");
  if (state.services.length === 0)
    services.append(el("li", "empty", "暂无可验证服务数据"));
  for (const service of state.services)
    services.append(
      el(
        "li",
        "service",
        el(
          "div",
          "",
          el("strong", "", service.display_name),
          el("small", "", service.service_name),
        ),
        statusPill(
          evaluateFreshness(service.fresh_until).kind === "fresh"
            ? service.status
            : "unknown",
        ),
      ),
    );
  const incidents = el("ul", "timeline");
  if (state.incidents.length === 0)
    incidents.append(
      el(
        "li",
        "empty",
        state.incidentsLoaded
          ? "没有公开 Incident"
          : "无法验证公开 Incident 列表",
      ),
    );
  for (const incident of state.incidents.slice(0, 6))
    incidents.append(
      el(
        "li",
        "",
        el(
          "div",
          "",
          el("strong", "", incident.title),
          el("small", "muted", time(incident.latest_update.published_at)),
        ),
        statusPill(incident.impact),
      ),
    );
  const servicePanel = panel(
    "服务目录",
    "状态数据不会因加载失败而假装全绿",
    services,
  );
  servicePanel.classList.remove("third");
  servicePanel.classList.add("half");
  const incidentPanel = panel(
    "最近 Incident",
    "面向用户的影响时间线",
    incidents,
  );
  incidentPanel.classList.remove("third");
  incidentPanel.classList.add("half");
  grid.append(servicePanel, incidentPanel);
  return grid;
}

/** 创建标准面板 / Create a standard dashboard panel. */
function panel(
  title: string,
  subtitle: string,
  ...children: NodeChild[]
): HTMLElement {
  const result = el(
    "article",
    "panel",
    el(
      "div",
      "panel-head",
      el("div", "", el("h2", "", title), el("p", "", subtitle)),
    ),
    ...children,
  );
  result.classList.add("third");
  return result;
}

/** Issue 搜索视图 / Issue search view. */
function renderIssues(): HTMLElement {
  const result = el("div", "grid");
  const box = panel(
    "内部 Issue 检索",
    "按服务、状态或文本条件查询机器聚合事实",
  );
  box.classList.remove("third");
  const output = el(
    "div",
    "issue-list",
    el("div", "empty", "输入条件后查询；不会在本地缓存结果"),
  );
  const form = el("form", "form-grid") as HTMLFormElement;
  form.append(
    field("服务名", "service_name", "text", false),
    selectField("状态", "states", [
      "",
      "observed",
      "active",
      "recovering",
      "suppressed",
      "resolved",
    ]),
    field("事件类别 kind", "kind", "search", false),
    selectField("严重度", "severities", [
      "",
      "info",
      "warning",
      "error",
      "critical",
    ]),
    field("每页数量", "limit", "number", false),
  );
  const actions = el("div", "actions field full");
  const submit = el("button", "button", "检索 Issues");
  submit.type = "submit";
  actions.append(submit);
  form.append(actions);
  if (!state.principal) {
    submit.disabled = true;
    actions.append(el("span", "muted", "需要有效管理员会话"));
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    output.replaceChildren(el("div", "empty", "正在查询…"));
    try {
      const raw = Object.fromEntries(new FormData(form).entries());
      const query: Record<string, unknown> = Object.fromEntries(
        Object.entries(raw).filter(([, value]) => value !== ""),
      );
      if (typeof query.limit === "string") query.limit = Number(query.limit);
      for (const key of ["states", "severities"])
        if (typeof query[key] === "string") query[key] = [query[key]];
      const response = await api.searchIssues(query);
      const resultData = "data" in response ? response.data : undefined;
      const items =
        resultData && Array.isArray(resultData.data) ? resultData.data : [];
      output.replaceChildren();
      if (items.length === 0)
        output.append(el("div", "empty", "没有匹配 Issue"));
      for (const item of items) {
        const button = el(
          "button",
          "issue",
          el(
            "span",
            "",
            el(
              "strong",
              "",
              `${stringOf(item, "kind")} · ${stringOf(item, "service_name")}`,
            ),
            el(
              "small",
              "",
              `${stringOf(item, "issue_id")} · ${numberOf(item, "occurrence_count") ?? 0} 次`,
            ),
          ),
          statusPill(stringOf(item, "state", "unknown")),
        );
        button.type = "button";
        button.addEventListener("click", () =>
          navigator.clipboard?.writeText(stringOf(item, "issue_id")).then(
            () => toast("Issue ID 已复制"),
            () => toast("无法复制 Issue ID", true),
          ),
        );
        output.append(button);
      }
    } catch (error) {
      output.replaceChildren(el("div", "notice error", errorMessage(error)));
    } finally {
      submit.disabled = false;
    }
  });
  box.append(form, output);
  result.append(box);
  return result;
}

/** Incident 详情与证据图工作台 / Incident detail and evidence graph workbench. */
function renderIncidentWorkbench(): HTMLElement {
  const wrap = el("div", "grid");
  const box = panel(
    "Incident 证据工作台",
    "后端无关 locator、Issue 与 Incident 的可审计关联",
  );
  box.classList.remove("third");
  const id = field("Incident ID", "incident_id", "text", true);
  const input = id.querySelector("input")!;
  const button = el("button", "button", "加载详情");
  button.type = "button";
  const controls = el("div", "actions", id, button);
  const target = el(
    "div",
    "empty",
    "加载 Incident 后显示证据图和严格结构化数据",
  );
  button.addEventListener("click", async () => {
    if (!input.reportValidity()) return;
    button.disabled = true;
    target.replaceChildren(document.createTextNode("正在加载…"));
    try {
      const [incident, context] = await Promise.all([
        api.incident(input.value),
        api.diagnosticContext(input.value),
      ]);
      renderEvidence(target, { incident, context });
    } catch (error) {
      target.replaceChildren(el("div", "notice error", errorMessage(error)));
    } finally {
      button.disabled = false;
    }
  });
  box.append(controls, target);
  wrap.append(box);
  return wrap;
}

/** 渲染证据关系，不将任意 URL 或 HTML 直接注入页面 / Render evidence relations without injecting arbitrary URLs or HTML. */
function renderEvidence(target: HTMLElement, response: unknown): void {
  const pair = response as { incident?: unknown; context?: unknown };
  const incident =
    pair.incident &&
    typeof pair.incident === "object" &&
    "data" in pair.incident
      ? (pair.incident as { data: unknown }).data
      : pair.incident;
  const context =
    pair.context && typeof pair.context === "object" && "data" in pair.context
      ? (pair.context as { data: unknown }).data
      : pair.context;
  const issues =
    typeof context === "object" &&
    context !== null &&
    Array.isArray((context as Record<string, unknown>).issues)
      ? ((context as Record<string, unknown>).issues as unknown[])
      : [];
  const evidence =
    typeof context === "object" &&
    context !== null &&
    Array.isArray((context as Record<string, unknown>).evidence)
      ? ((context as Record<string, unknown>).evidence as unknown[])
      : [];
  const graph = el("div", "graph");
  graph.setAttribute("role", "img");
  graph.setAttribute(
    "aria-label",
    `Incident 关联 ${issues.length} 个 Issue 和 ${evidence.length} 条证据`,
  );
  graph.append(
    el(
      "div",
      "node incident",
      el("strong", "", "Incident"),
      stringOf(incident, "title", stringOf(incident, "incident_id")),
    ),
  );
  issues.slice(0, 4).forEach((issue, index) => {
    const node = el(
      "div",
      "node issue",
      el("strong", "", stringOf(issue, "kind", "Issue")),
      stringOf(issue, "issue_id"),
    );
    node.style.top = `${12 + index * 19}%`;
    node.style.left = `${36 + (index % 2) * 4}%`;
    graph.append(node);
  });
  evidence.slice(0, 5).forEach((item, index) => {
    const node = el(
      "div",
      "node evidence",
      el("strong", "", stringOf(item, "kind", "Evidence")),
      stringOf(item, "backend", "structured locator"),
    );
    node.style.top = `${5 + index * 18}%`;
    graph.append(node);
  });
  const structured = renderDiagnosticContext(context);
  target.replaceChildren(
    el(
      "div",
      "evidence-layout",
      graph,
      el(
        "div",
        "",
        el(
          "div",
          "panel-head",
          el(
            "div",
            "",
            el("h2", "", "结构化证据"),
            el(
              "p",
              "",
              `响应已由共享契约约束；关系图预览 ${Math.min(4, issues.length)}/${issues.length} 个 Issue、${Math.min(5, evidence.length)}/${evidence.length} 条证据，完整返回集合见下方。`,
            ),
          ),
        ),
        structured,
      ),
    ),
  );
  const queries = el("div", "grid");
  for (const item of evidence) {
    const id = stringOf(item, "id", "");
    if (!id) continue;
    const box = el("div", "panel half");
    const button = el(
      "button",
      "button secondary",
      `查询 ${stringOf(item, "kind")}：${id}`,
    );
    button.type = "button";
    const output = el("div");
    output.setAttribute("aria-live", "polite");
    button.addEventListener("click", async () => {
      button.disabled = true;
      output.textContent = "正在查询受控后端…";
      try {
        const result = await api.evidence(id);
        if ("data" in result)
          output.replaceChildren(renderEvidenceResult(result.data));
        else throw new Error("证据查询失败，请查看关联请求。");
      } catch (error) {
        output.textContent = errorMessage(error);
      } finally {
        button.disabled = false;
      }
    });
    box.append(button, output);
    queries.append(box);
  }
  target.append(queries);
}

/** 角色门控的变更表单集合 / Role-gated mutation form collection. */
function renderActions(): HTMLElement {
  const grid = el("div", "grid");
  if (!canOperate())
    grid.append(
      el(
        "div",
        "panel notice",
        "管理员会话无效。界面已禁用变更操作；服务端仍会独立鉴权。",
      ),
    );
  grid.append(
    mutationPanel(
      "创建 Incident",
      "operator / admin",
      "/api/incidents",
      [
        field("标题", "title", "text", true),
        selectField("影响", "impact", [
          "degraded",
          "partial_outage",
          "major_outage",
        ]),
        field(
          "影响开始时间（本地，提交为 UTC）",
          "started_at",
          "datetime-local",
          true,
        ),
        field("受影响组件（逗号分隔）", "affected_components", "text", true),
        textareaField("首条更新", "initial_message", true),
        field("关联 Issue IDs（逗号分隔）", "issue_ids", "text", false),
      ],
      normalizeIncidentCreate,
    ),
    mutationPanel(
      "更新 Incident",
      "乐观并发 / optimistic concurrency",
      "/api/incidents/:id",
      [
        field("Incident ID", "id", "text", true),
        field("期望 revision", "revision", "number", true),
        selectField("状态", "state", [
          "investigating",
          "identified",
          "monitoring",
          "resolved",
        ]),
        textareaField("更新消息", "message", true),
        textareaField("已确认原因（可选）", "cause", false),
      ],
      identityBody,
      "PATCH",
    ),
    mutationPanel(
      "确认 Issue",
      "acknowledge 不等于解决",
      "/api/issues/:id/acknowledge",
      [
        field("Issue ID", "id", "text", true),
        field("期望 revision", "revision", "number", true),
      ],
      identityBody,
    ),
    mutationPanel(
      "抑制 Issue",
      "只改变公开展示，不伪造 probe 成功",
      "/api/issues/:id/suppress",
      [
        field("Issue ID", "id", "text", true),
        field("期望 revision", "revision", "number", true),
        field("截止时间（本地，提交为 UTC）", "until", "datetime-local", true),
        textareaField("原因", "reason", true),
      ],
      utcBody,
    ),
    mutationPanel(
      "创建维护窗口",
      "已批准的预期影响区间",
      "/api/maintenance-windows",
      [
        field("标题", "title", "text", true),
        textareaField("说明", "description", true),
        selectField("预期影响", "expected_impact", [
          "degraded",
          "partial_outage",
          "major_outage",
        ]),
        field(
          "开始时间（本地，提交为 UTC）",
          "starts_at",
          "datetime-local",
          true,
        ),
        field(
          "结束时间（本地，提交为 UTC）",
          "ends_at",
          "datetime-local",
          true,
        ),
        field("目标服务（逗号分隔）", "target_services", "text", false),
        field("目标组件（逗号分隔）", "target_components", "text", false),
      ],
      maintenanceBody,
    ),
    mutationPanel(
      "更新维护窗口",
      "revision 防止覆盖并发修改",
      "/api/maintenance-windows/:id",
      [
        field("Maintenance ID", "id", "text", true),
        field("期望 revision", "revision", "number", true),
        field("标题（可选）", "title", "text", false),
        textareaField("说明（可选）", "description", false),
        selectField("状态", "state", ["", "scheduled", "active", "cancelled"]),
        field("开始时间（本地，可选）", "starts_at", "datetime-local", false),
        field("结束时间（本地，可选）", "ends_at", "datetime-local", false),
      ],
      utcBody,
      "PATCH",
    ),
  );
  return grid;
}

/** 管理员 Catalog、probe 与策略控制面 / Administrator catalog, probe, and policy control plane. */
function renderCatalog(): HTMLElement {
  const grid = el("div", "grid");
  grid.append(...renderCatalogEvolution());
  if (!canAdmin())
    grid.append(
      el(
        "div",
        "panel notice",
        "Catalog、监控器与后端注册需要有效管理员会话；服务端仍会复核权限。",
      ),
    );

  const policyJson = textareaField("EvaluationPolicy JSON", "policy", true);
  const policyArea = policyJson.querySelector("textarea")!;
  policyArea.value = JSON.stringify(
    {
      policy_id: "0199d0a8-2e12-7000-8000-000000000001",
      revision: 1,
      window_seconds: 300,
      minimum_samples: 3,
      failure_threshold: { numerator: 2, denominator: 3 },
      recovery_threshold: { numerator: 3, denominator: 3 },
      latency_threshold_ms: 2000,
      stale_after_seconds: 180,
      quorum: {
        minimum_locations: 2,
        failure_locations: 2,
        recovery_locations: 2,
      },
      issue_fingerprint_template: ["operation", "error_type", "region"],
      failure_status: "degraded",
    },
    null,
    2,
  );

  grid.append(
    mutationPanel(
      "注册服务",
      "结构化常用路径；组件与依赖无需手写 JSON",
      "/api/services",
      [
        field("service.name", "service_name", "text", true),
        field("显示名", "display_name", "text", true),
        textareaField("说明", "description", true),
        field("Owner", "owner", "text", true),
        selectField("关键性", "criticality", [
          "low",
          "medium",
          "high",
          "critical",
        ]),
        checkboxField("启用服务", "enabled", true),
        field("首个 Component ID（可选）", "component_id", "text", false),
        field("Component 显示名", "component_display_name", "text", false),
        checkboxField("公开 Component", "component_public", true),
        field("依赖服务（可选）", "dependency_service", "text", false),
        field("依赖 capability", "dependency_capability", "text", false),
        selectField("依赖类型", "dependency_kind", [
          "required",
          "optional",
          "degraded_fallback",
        ]),
        selectField("依赖关键性", "dependency_criticality", [
          "low",
          "medium",
          "high",
          "critical",
        ]),
      ],
      serviceCommand,
      "POST",
      RegisterServiceCommandSchema,
      "admin",
    ),
    mutationPanel(
      "注册评估策略",
      "高级编辑器；提交前由共享 schema 精确校验",
      "/api/evaluation-policies",
      [policyJson],
      policyCommand,
      "POST",
      RegisterEvaluationPolicyCommandSchema,
      "admin",
    ),
    mutationPanel(
      "绑定 Diagnostic 策略",
      "将不可变 policy revision 绑定 monitor 或 Diagnostic 类",
      "/api/diagnostic-policy-assignments",
      [
        selectField("选择器", "selector_kind", ["diagnostic", "monitor"]),
        field("Monitor ID（monitor 时）", "monitor_id", "text", false),
        field("服务名（diagnostic 时）", "service_name", "text", false),
        field("Diagnostic kind", "diagnostic_kind", "text", false),
        field("Policy ID", "policy_id", "text", true),
        field("Policy revision", "policy_revision", "number", true),
      ],
      assignmentCommand,
      "POST",
      AssignDiagnosticPolicyCommandSchema,
      "admin",
    ),
    mutationPanel(
      "创建 HTTP Monitor",
      "可执行 probe 常用路径；secret 不进入页面",
      "/api/monitors",
      httpMonitorFields(true),
      createHttpMonitorCommand,
      "POST",
      CreateMonitorCommandSchema,
      "admin",
    ),
    mutationPanel(
      "更新 HTTP Monitor",
      "probe 与 probe_kind 成对更新，强 ETag 防并发覆盖",
      "/api/monitors/:id",
      httpMonitorFields(false),
      updateHttpMonitorCommand,
      "PATCH",
      UpdateMonitorCommandSchema,
      "admin",
    ),
    mutationPanel(
      "注册 Telemetry Backend",
      "auth_reference 是 TELEMETRY_AUTH_JSON 中的符号名，不是凭据",
      "/api/telemetry-backends",
      [
        field("名称", "name", "text", true),
        field("Capabilities（逗号分隔）", "capabilities", "text", true),
        selectField(
          "Query adapter",
          "query_adapter",
          TelemetryBackendQueryAdapterSchema.options,
        ),
        field("UI URL template", "ui_url_template", "url", true),
        field("Retention class", "retention_class", "text", true),
        field("Secret 引用名", "auth_reference", "text", true),
      ],
      backendCommand,
      "POST",
      RegisterTelemetryBackendCommandSchema,
      "admin",
    ),
    mutationPanel(
      "设置到期状态覆盖",
      "临时人工判断必须说明原因并自动到期",
      "/api/status-overrides",
      [
        selectField("目标类型", "target_type", ["service", "component"]),
        field("服务名", "service_name", "text", true),
        field("Component ID（组件目标时）", "component_id", "text", false),
        selectField("覆盖状态", "status", [
          "operational",
          "degraded",
          "partial_outage",
          "major_outage",
          "unknown",
        ]),
        field(
          "到期时间（本地，提交为 UTC）",
          "expires_at",
          "datetime-local",
          true,
        ),
        textareaField("原因", "reason", true),
      ],
      overrideCommand,
      "POST",
      SetStatusOverrideCommandSchema,
      "operator",
    ),
  );
  return grid;
}

/** 不可变身份和显式版本保护的初始化、目录演进表单。 / Bootstrap and catalog evolution forms with immutable identity and explicit version guards. */
function renderCatalogEvolution(): HTMLElement[] {
  const componentFields = (): HTMLElement[] => {
    const order = field("排序（允许 0）", "sort_order", "number", true);
    order.querySelector("input")!.min = "0";
    order.querySelector("input")!.value = "0";
    return [
      field("显示名", "display_name", "text", true),
      textareaField("说明", "description", false),
      checkboxField("公开", "public", true),
      checkboxField("启用", "enabled", true),
      order,
      field(
        "完整支撑服务集合（逗号分隔；空表示清空）",
        "supporting_services",
        "text",
        false,
      ),
    ];
  };
  return [
    mutationPanel(
      "绑定数据保留策略",
      "首次绑定 revision 留空；已有绑定必须填当前 revision。Incident 固定证据不受普通清理影响。",
      "/api/retention-policy-assignments",
      [
        field("服务名", "service_name", "text", true),
        field("保留策略 ID", "policy_id", "text", true),
        field("不可变策略 revision", "policy_revision", "number", true),
        field("保留天数", "occurrence_retention_days", "number", true),
        field("清理批大小", "cleanup_batch_size", "number", true),
        field(
          "当前绑定 revision（首次留空）",
          "expected_assignment_revision",
          "number",
          false,
        ),
      ],
      retentionCommand,
      "POST",
      undefined,
      "admin",
    ),
    mutationPanel(
      "激活已部署版本",
      "仅在真实部署成功后操作；ready 不等于 active。部署与当前指针均受版本保护。",
      "/api/deployments/:id/activate",
      [
        field("Deployment UUID", "id", "text", true),
        field(
          "当前部署 revision",
          "expected_deployment_revision",
          "number",
          true,
        ),
        field(
          "当前指针 revision（首次留空）",
          "expected_pointer_revision",
          "number",
          false,
        ),
        textareaField("部署完成依据与激活原因", "reason", true),
      ],
      activationCommand,
      "POST",
      undefined,
      "admin",
    ),
    mutationPanel(
      "编辑服务与依赖",
      "完整替换下列元数据及依赖集合；先读取最新 revision，409 后重新核对，绝不盲重试。",
      "/api/services/:id",
      [
        field("不可变服务名", "id", "text", true),
        field("当前 revision", "revision", "number", true),
        field("显示名", "display_name", "text", true),
        textareaField("说明", "description", false),
        field("Owner", "owner", "text", true),
        selectField("关键性", "criticality", [
          "low",
          "medium",
          "high",
          "critical",
        ]),
        checkboxField("启用", "enabled", true),
        textareaField(
          "完整依赖集合：每行 服务, capability, required|optional|degraded_fallback, low|medium|high|critical；空表示清空",
          "dependencies",
          false,
        ),
      ],
      serviceUpdateCommand,
      "PATCH",
      undefined,
      "admin",
    ),
    mutationPanel(
      "添加 Component",
      "全局 ID 和唯一 owner 不可改名；支撑服务只影响依赖风险，不伪造直接健康状态。",
      "/api/components",
      [
        field("全局 Component ID", "component_id", "text", true),
        field("唯一 owner 服务", "owner_service", "text", true),
        ...componentFields(),
      ],
      componentCreateCommand,
      "POST",
      undefined,
      "admin",
    ),
    mutationPanel(
      "编辑 Component 与支撑服务",
      "完整替换元数据和支撑集合；不允许更改 Component ID 或 owner。",
      "/api/components/:id",
      [
        field("Component ID", "id", "text", true),
        field("当前 revision", "revision", "number", true),
        ...componentFields(),
      ],
      componentUpdateCommand,
      "PATCH",
      undefined,
      "admin",
    ),
  ];
}

/** HTTP monitor 的结构化常用字段 / Structured common fields for an HTTP monitor. */
function httpMonitorFields(create: boolean): HTMLElement[] {
  const values: HTMLElement[] = [];
  if (create)
    values.push(
      field("Monitor ID", "monitor_id", "text", true),
      field("服务名", "service_name", "text", true),
      selectField("目标类型", "target_type", ["service", "component"]),
      field("目标 ID", "target_id", "text", true),
    );
  else
    values.push(
      field("Monitor ID", "id", "text", true),
      field("期望 revision", "revision", "number", true),
    );
  const redirects = field("最大重定向", "max_redirects", "number", create);
  redirects.querySelector("input")!.min = "0";
  values.push(
    field(
      `HTTPS URL${create ? "" : "（留空则不更新 probe）"}`,
      "url",
      "url",
      create,
    ),
    selectField("HTTP method", "method", ["HEAD", "GET"]),
    field("预期状态码（逗号分隔）", "expected_statuses", "text", create),
    redirects,
    field("Interval 秒", "interval_seconds", "number", create),
    field("Timeout 毫秒", "timeout_ms", "number", create),
    field("Locations（逗号分隔）", "locations", "text", create),
    field("Policy ID", "policy_id", "text", create),
    field("Policy revision", "policy_revision", "number", create),
    checkboxField("启用 Monitor", "enabled", true),
  );
  return values;
}

/** CSV 文本规范化为非空条目 / Normalize CSV text into non-empty entries. */
function csv(value: FormDataEntryValue | undefined): string[] {
  return typeof value === "string"
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

/** 构造结构化 Service Registry 命令 / Build a structured Service Registry command. */
function serviceCommand(
  input: Record<string, FormDataEntryValue>,
): Record<string, unknown> {
  const componentId = String(input.component_id ?? "").trim();
  const dependency = String(input.dependency_service ?? "").trim();
  return {
    service_name: input.service_name,
    display_name: input.display_name,
    description: input.description,
    owner: input.owner,
    criticality: input.criticality,
    enabled: input.enabled === "on",
    components: componentId
      ? [
          {
            component_id: componentId,
            display_name: input.component_display_name || componentId,
            public: input.component_public === "on",
            sort_order: 0,
          },
        ]
      : [],
    dependencies: dependency
      ? [
          {
            target_service: dependency,
            kind: input.dependency_kind,
            criticality: input.dependency_criticality,
            capability: input.dependency_capability,
          },
        ]
      : [],
  };
}

/** 解析并封装高级 policy JSON / Parse and wrap advanced policy JSON. */
function policyCommand(
  input: Record<string, FormDataEntryValue>,
): Record<string, unknown> {
  return { policy: JSON.parse(String(input.policy)) as unknown };
}

/** 构造策略绑定命令 / Build a policy-assignment command. */
function assignmentCommand(
  input: Record<string, FormDataEntryValue>,
): Record<string, unknown> {
  const selector =
    input.selector_kind === "monitor"
      ? { kind: "monitor", monitor_id: input.monitor_id }
      : {
          kind: "diagnostic",
          service_name: input.service_name,
          diagnostic_kind: input.diagnostic_kind,
        };
  return {
    selector,
    policy_id: input.policy_id,
    policy_revision: Number(input.policy_revision),
  };
}

/** 构造完整可执行 HTTP monitor / Build a complete executable HTTP monitor. */
function createHttpMonitorCommand(
  input: Record<string, FormDataEntryValue>,
): Record<string, unknown> {
  return {
    monitor_id: input.monitor_id,
    service_name: input.service_name,
    target_type: input.target_type,
    target_id: input.target_id,
    probe_kind: "http",
    probe_config: {
      kind: "http",
      url: input.url,
      method: input.method,
      expected_statuses: csv(input.expected_statuses).map(Number),
      max_redirects: Number(input.max_redirects),
    },
    schedule_kind: "interval",
    schedule_expression: null,
    interval_seconds: Number(input.interval_seconds),
    timeout_ms: Number(input.timeout_ms),
    locations: csv(input.locations),
    policy_id: input.policy_id,
    policy_revision: Number(input.policy_revision),
    enabled: input.enabled === "on",
  };
}

/** 构造 HTTP monitor 局部更新 / Build a partial HTTP monitor update. */
function updateHttpMonitorCommand(
  input: Record<string, FormDataEntryValue>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.url) {
    body.probe_kind = "http";
    body.probe_config = {
      kind: "http",
      url: input.url,
      method: input.method,
      expected_statuses: csv(input.expected_statuses).map(Number),
      max_redirects: Number(input.max_redirects),
    };
  }
  if (input.interval_seconds) {
    body.schedule_kind = "interval";
    body.schedule_expression = null;
    body.interval_seconds = Number(input.interval_seconds);
  }
  if (input.timeout_ms) body.timeout_ms = Number(input.timeout_ms);
  if (input.locations) body.locations = csv(input.locations);
  if (input.policy_id) body.policy_id = input.policy_id;
  if (input.policy_revision)
    body.policy_revision = Number(input.policy_revision);
  body.enabled = input.enabled === "on";
  return body;
}

/** 构造 Telemetry backend 注册命令 / Build a telemetry-backend registration command. */
function backendCommand(
  input: Record<string, FormDataEntryValue>,
): Record<string, unknown> {
  return {
    backend: {
      name: input.name,
      capabilities: csv(input.capabilities),
      query_adapter: input.query_adapter,
      ui_url_template: input.ui_url_template,
      retention_class: input.retention_class,
      auth_reference: input.auth_reference,
    },
  };
}

/** 构造有期限的状态覆盖命令 / Build an expiring status-override command. */
function overrideCommand(
  input: Record<string, FormDataEntryValue>,
): Record<string, unknown> {
  const target =
    input.target_type === "component"
      ? {
          target_type: "component",
          service_name: input.service_name,
          component_id: input.component_id,
        }
      : { target_type: "service", service_name: input.service_name };
  return {
    target,
    status: input.status,
    expires_at: new Date(String(input.expires_at)).toISOString(),
    reason: input.reason,
  };
}

type BodyMapper = (
  input: Record<string, FormDataEntryValue>,
  commandId: string,
) => Record<string, unknown>;
type CommandSchema = { parse(value: unknown): unknown };

/** 创建统一变更面板并强制 revision/路径约束 / Build a mutation panel with revision and path constraints. */
function mutationPanel(
  title: string,
  subtitle: string,
  pathTemplate: string,
  fields: HTMLElement[],
  mapper: BodyMapper,
  method: "POST" | "PATCH" = "POST",
  schema?: CommandSchema,
  permission: "operator" | "admin" = "operator",
): HTMLElement {
  const box = panel(title, subtitle);
  box.classList.remove("third");
  box.classList.add("half");
  const form = el("form", "form-grid") as HTMLFormElement;
  const allowed = (): boolean =>
    permission === "admin" ? canAdmin() : canOperate();
  const syncGate = (control: HTMLButtonElement): void => {
    if (permission === "operator")
      gateControl(control, state.principal?.roles ?? []);
    else {
      control.disabled = !canAdmin();
      control.setAttribute("aria-disabled", String(control.disabled));
    }
  };
  form.append(...fields);
  const action = el("div", "actions field full");
  const submit = el("button", "button", "提交变更");
  submit.type = "submit";
  syncGate(submit);
  action.append(submit);
  form.append(action);
  const snapshotKinds: Record<string, SnapshotKind> = {
    "/api/services/:id": "service",
    "/api/components/:id": "component",
    "/api/retention-policy-assignments": "retention",
    "/api/deployments/:id/activate": "activation",
  };
  const snapshotKind = snapshotKinds[pathTemplate];
  /** 不确定网络结果后的原样重试保留 command ID；编辑命令才分配新 ID。 / Preserve the command ID across identical retries after uncertain network results; edited commands receive a new ID. */
  let pendingAttempt: { fingerprint: string; commandId: string } | undefined;
  if (snapshotKind) {
    const load = el("button", "button secondary", "读取权威快照并填入当前版本");
    load.type = "button";
    load.addEventListener("click", async () => {
      load.disabled = true;
      submit.disabled = true;
      try {
        const idField = form.elements.namedItem(
          snapshotKind === "retention" ? "service_name" : "id",
        ) as HTMLInputElement;
        const id = idField.value.trim();
        if (!id) throw new Error("请先填写目标 ID 或服务名。");
        const result = await api.catalogSnapshot(snapshotKind, id);
        if (idField.value.trim() !== id)
          throw new Error("目标已改变，丢弃旧快照；请重新读取。");
        if (!result || typeof result !== "object" || !("data" in result))
          throw new Error("快照不可验证。");
        populateSnapshot(form, snapshotFields(snapshotKind, result.data));
        resultView.textContent = JSON.stringify(result.data, null, 2);
        toast("已读取权威快照；编辑后提交仍受版本保护。");
      } catch (error) {
        toast(errorMessage(error), true);
      } finally {
        load.disabled = false;
        syncGate(submit);
      }
    });
    action.prepend(load);
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!allowed()) return;
    submit.disabled = true;
    try {
      const raw = Object.fromEntries(new FormData(form).entries());
      const id = String(raw.id ?? "");
      const revision = raw.revision ? Number(raw.revision) : undefined;
      const path = pathTemplate.replace(":id", encodeURIComponent(id));
      const fingerprint = JSON.stringify([
        path,
        revision,
        Object.entries(raw).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ]);
      const commandId =
        pendingAttempt?.fingerprint === fingerprint
          ? pendingAttempt.commandId
          : uuidV7();
      const body = mapper(raw, commandId);
      delete body.id;
      delete body.revision;
      body.command_id = commandId;
      schema?.parse(body);
      if (
        method === "PATCH" &&
        (!Number.isInteger(revision) || !revision || revision < 1)
      )
        throw new Error(
          "必须填写刚读取的正整数 revision；冲突后请重新读取，不自动覆盖。",
        );
      pendingAttempt = { fingerprint, commandId };
      const result = await api.write(path, body, method, revision);
      pendingAttempt = undefined;
      resultView.textContent = JSON.stringify(result, null, 2);
      toast(`${title}已提交`);
      form.reset();
    } catch (error) {
      toast(errorMessage(error), true);
    } finally {
      syncGate(submit);
    }
  });
  const resultView = el("pre", "structured");
  resultView.setAttribute("aria-live", "polite");
  box.append(form, resultView);
  return box;
}

/** 原样清理空字段 / Preserve values while removing empty fields. */
function identityBody(
  input: Record<string, FormDataEntryValue>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== ""),
  );
}
/** 将 datetime-local 明确序列化为 UTC / Serialize datetime-local values explicitly as UTC. */
function utcBody(
  input: Record<string, FormDataEntryValue>,
): Record<string, unknown> {
  const body = identityBody(input);
  for (const key of ["until", "starts_at", "ends_at", "started_at"])
    if (typeof body[key] === "string")
      body[key] = new Date(body[key]).toISOString();
  return body;
}
/** 规范化 Incident 创建命令 / Normalize the incident creation command. */
function normalizeIncidentCreate(
  input: Record<string, FormDataEntryValue>,
): Record<string, unknown> {
  const body = utcBody(input);
  for (const key of ["affected_components", "issue_ids"])
    body[key] =
      typeof body[key] === "string"
        ? body[key]
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean)
        : [];
  return body;
}
/** 规范化 Maintenance 创建命令 / Normalize the maintenance creation command. */
function maintenanceBody(
  input: Record<string, FormDataEntryValue>,
): Record<string, unknown> {
  const body = utcBody(input);
  for (const key of ["target_services", "target_components"])
    body[key] =
      typeof body[key] === "string"
        ? body[key]
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean)
        : [];
  return body;
}

/**
 * 生成 RFC 9562 UUIDv7 幂等命令标识；不编码用户或业务信息。
 * Generate an RFC 9562 UUIDv7 idempotency key without embedding user or business data.
 */
function uuidV7(now = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let timestamp = BigInt(now);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 构建带可访问标签的 input / Build an accessible labeled input. */
function field(
  label: string,
  name: string,
  type: string,
  required: boolean,
): HTMLLabelElement {
  const input = el("input");
  input.name = name;
  input.type = type;
  input.required = required;
  if (type === "number") {
    input.min = "1";
    input.step = "1";
  }
  return el("label", "field", el("span", "", label), input);
}
/** 构建带可访问标签的 textarea / Build an accessible labeled textarea. */
function textareaField(
  label: string,
  name: string,
  required: boolean,
): HTMLLabelElement {
  const input = el("textarea");
  input.name = name;
  input.required = required;
  const field = el("label", "field full", el("span", "", label), input);
  return field;
}
/** 构建枚举选择框 / Build an enum select field. */
function selectField(
  label: string,
  name: string,
  options: string[],
): HTMLLabelElement {
  const select = el("select");
  select.name = name;
  for (const value of options) {
    const option = el("option", "", value || "全部 / 未指定");
    option.value = value;
    select.append(option);
  }
  return el("label", "field", el("span", "", label), select);
}

/** 构建布尔复选框 / Build a labeled boolean checkbox. */
function checkboxField(
  label: string,
  name: string,
  checked: boolean,
): HTMLLabelElement {
  const input = el("input");
  input.type = "checkbox";
  input.name = name;
  input.checked = checked;
  return el("label", "field checkbox", input, el("span", "", label));
}

/** 并行加载相互独立的三个健康信号和公共读模型 / Load three independent health signals and public read models. */
async function bootstrap(): Promise<void> {
  try {
    const { data } = await api.session();
    state.principal = data;
    state.checks.access = {
      state: "healthy",
      detail: "管理员会话已验证",
    };
  } catch {
    showAuthentication();
    return;
  }
  render();
  const health = api.health().then(
    ({ data }) => {
      const healthy =
        data.status === "ok" &&
        data.dependencies.every((dependency) => dependency.status === "ok");
      state.checks.rpc = {
        state: healthy ? "healthy" : "failed",
        detail: healthy
          ? "gateway → status typed RPC 可用"
          : "管理 RPC 报告不健康",
      };
    },
    (error) => {
      state.checks.rpc = { state: "failed", detail: errorMessage(error) };
    },
  );
  const platform = api.platform().then(
    ({ data }) => {
      state.platform = data;
      const freshness = evaluateFreshness(data.fresh_until);
      state.checks.freshness =
        freshness.kind === "fresh" && data.status !== "unknown"
          ? { state: "healthy", detail: `证据有效至 ${time(data.fresh_until)}` }
          : {
              state: "failed",
              detail:
                freshness.kind === "fresh"
                  ? "证据新鲜，但评估器无法判断平台状态"
                  : freshness.kind === "stale"
                    ? `证据已过期 ${Math.ceil(freshness.overdueMs / 1000)} 秒`
                    : freshness.reason,
            };
    },
    (error) => {
      state.checks.freshness = {
        state: "failed",
        detail: `公开状态不可验证：${errorMessage(error)}`,
      };
    },
  );
  const services = api.services().then(
    ({ data }) => {
      state.services = data;
    },
    (error) => toast(`服务目录：${errorMessage(error)}`, true),
  );
  const incidents = api.incidents().then(
    ({ data }) => {
      state.incidents = data;
      state.incidentsLoaded = true;
    },
    (error) => toast(`Incident 列表：${errorMessage(error)}`, true),
  );
  await Promise.allSettled([health, platform, services, incidents]);
  render();
  window.setInterval(() => {
    refreshDiagnosticFreshness(shell);
    if (!state.platform) return;
    const freshness = evaluateFreshness(state.platform.fresh_until);
    if (
      freshness.kind !== "fresh" &&
      state.checks.freshness.state !== "failed"
    ) {
      state.checks.freshness = {
        state: "failed",
        detail: "公开证据已在页面打开期间过期",
      };
      render();
    }
  }, 15_000);
}

/** 未认证时只渲染认证表单，不预取管理数据。 / Render only authentication and avoid management prefetch before login. */
function showAuthentication(): void {
  shell.replaceChildren(
    authForm(async (password) => {
      await api.login(password);
      await bootstrap();
    }),
  );
}

void bootstrap();

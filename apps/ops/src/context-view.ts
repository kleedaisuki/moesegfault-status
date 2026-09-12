import {
  DiagnosticContextSchema,
  type DiagnosticContext,
} from "@moesegfault/contracts";

/** 仅文本 DOM 节点，不解释外部 HTML。 / Text-only DOM nodes never interpret external HTML. */
function text<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  value: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.textContent = value;
  return element;
}

/** 有表头的有界诊断表；空集合不声称不存在故障。 / Bounded diagnostic table with headers; an empty set never asserts absence of faults. */
function table(
  title: string,
  headings: string[],
  rows: string[][],
): HTMLElement {
  const section = document.createElement("section");
  section.className = "panel";
  section.append(text("h3", title));
  if (rows.length === 0) {
    section.append(text("p", "本次上下文未返回相关记录。"));
    return section;
  }
  const scroll = document.createElement("div");
  scroll.className = "diagnostic-table-scroll";
  scroll.tabIndex = 0;
  scroll.setAttribute("role", "region");
  scroll.setAttribute("aria-label", `${title}，窄屏可横向滚动`);
  const node = document.createElement("table");
  const header = document.createElement("tr");
  for (const label of headings) {
    const cell = text("th", label);
    cell.scope = "col";
    header.append(cell);
  }
  const head = document.createElement("thead");
  head.append(header);
  const body = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    for (const value of row) tr.append(text("td", value));
    body.append(tr);
  }
  node.append(head, body);
  scroll.append(node);
  section.append(scroll);
  return section;
}

/** 用新鲜度约束服务状态展示，过期值只作为历史证据。 / Constrain service status display by freshness; expired values remain historical evidence only. */
function serviceRows(context: DiagnosticContext, now: number): string[][] {
  return context.affected_services.map((service) => {
    const status = service.current_status;
    const stale = status === null || Date.parse(status.fresh_until) <= now;
    return [
      service.service_name,
      service.relations.map((relation) => relation.kind).join(", "),
      stale ? "unknown（证据缺失或已过期）" : status.direct_status,
      stale ? "unknown" : status.dependency_risk,
      stale ? "unknown" : status.effective_impact,
      status
        ? `${status.evaluated_at} → ${status.fresh_until} · revision ${status.revision}${stale ? `；历史值 ${status.direct_status}` : ""}`
        : "无当前评估",
    ];
  });
}

/**
 * 渲染契约中的诊断关系和摘要；不透传原始 audit/details/telemetry JSON。
 * Render contracted diagnostic relationships and summaries without raw audit/details/telemetry JSON.
 */
export function renderDiagnosticContext(
  value: unknown,
  now = Date.now(),
): HTMLElement {
  const context = DiagnosticContextSchema.parse(value);
  const root = document.createElement("div");
  root.className = "diagnostic-context";
  const notice = text(
    "p",
    context.truncated
      ? "上下文已截断：列表和计数仅表示返回的有界子集，不是完整历史。"
      : "有界诊断快照；关系关联不等于因果证明，历史迁移不等于当前健康。",
  );
  notice.className = context.truncated ? "notice error" : "notice";
  root.append(
    notice,
    table(
      "受影响服务",
      ["服务", "关联来源", "直接状态", "依赖风险", "有效影响", "证据有效期"],
      serviceRows(context, now),
    ),
    table(
      "依赖路径",
      ["根服务", "叶服务", "有向依赖边"],
      context.dependency_paths.map((path) => [
        path.root_service,
        path.leaf_service,
        path.edges
          .map(
            (edge) =>
              `${edge.source_service} → ${edge.target_service} [${edge.capability}; ${edge.kind}; ${edge.criticality}]`,
          )
          .join(" / "),
      ]),
    ),
    table(
      "源码位置",
      ["证据 / 部署", "固定 commit", "位置", "来源验证"],
      context.source_locations.map((source) => [
        `${source.telemetry_reference_id} / ${source.deployment_id}`,
        source.git_commit,
        `${source.repository_url} / ${source.path}${source.line === undefined ? "" : `:${source.line}`}${source.column === undefined ? "" : `:${source.column}`}`,
        source.provenance_verified
          ? "已验证部署来源"
          : "未验证，禁止据此推断来源",
      ]),
    ),
    table(
      "状态迁移（历史）",
      ["时间 / 顺序", "目标", "迁移", "依据", "Policy / 关联 ID"],
      context.status_transitions.map((transition) => [
        `${transition.occurred_at} / ${transition.sequence}`,
        `${transition.target_type}:${transition.target_id}`,
        `${transition.from_status ?? "未评估"} → ${transition.to_status}`,
        `${transition.source_type}:${transition.source_id}`,
        `${transition.policy ? `${transition.policy.policy_id}@${transition.policy.revision}` : "无 policy"} / ${transition.correlation_id ?? "无关联 ID"}`,
      ]),
    ),
    table(
      "Issue",
      ["ID", "状态", "等级", "最近出现"],
      context.issues.map((issue) => [
        issue.issue_id,
        issue.state,
        issue.severity,
        issue.last_seen_at,
      ]),
    ),
    table(
      "Deployment",
      ["ID", "服务", "Commit", "运行产物摘要"],
      context.deployments.map((deployment) => [
        deployment.deployment_id,
        deployment.service_name,
        deployment.git_commit,
        deployment.artifact_digest,
      ]),
    ),
  );
  const audit = context.audit_summary;
  root.append(
    table(
      "Incident",
      ["ID / 标题", "状态 / 影响", "组件", "原因"],
      context.incidents.map((incident) => [
        `${incident.incident_id} / ${incident.title}`,
        `${incident.state} / ${incident.impact}`,
        incident.affected_components.join(", "),
        incident.cause ?? "未确认原因",
      ]),
    ),
  );
  for (const incident of context.incidents) {
    root.append(
      table(
        `Incident 时间线：${incident.incident_id}`,
        ["时间", "状态", "消息"],
        incident.updates.map((update) => [
          update.published_at,
          update.state,
          update.message,
        ]),
      ),
    );
  }
  root.append(
    text(
      "h3",
      `审计摘要：${audit.event_count} 条${context.truncated ? "（有界子集）" : ""}`,
    ),
    text(
      "p",
      `${audit.first_occurred_at ?? "无起始时间"} → ${audit.last_occurred_at ?? "无结束时间"}`,
    ),
    table(
      "审计动作",
      ["动作", "计数"],
      audit.actions.map((action) => [action.action, String(action.count)]),
    ),
    table(
      "审计主体",
      ["类型", "主体", "计数"],
      audit.actors.map((actor) => [
        actor.actor_type,
        actor.actor_subject,
        String(actor.event_count),
      ]),
    ),
  );
  const serviceTable = root.querySelector("tbody");
  context.affected_services.forEach((service, index) => {
    const row = serviceTable?.querySelectorAll("tr")[index];
    if (row && service.current_status)
      row.dataset.freshUntil = service.current_status.fresh_until;
  });
  return root;
}

/** 页面停留期间过期即降级；只改派生状态，不把历史评估变成新观测。 / Downgrade evidence that expires while the page stays open; never turn historical evaluation into new observations. */
export function refreshDiagnosticFreshness(
  root: ParentNode,
  now = Date.now(),
): void {
  for (const row of root.querySelectorAll<HTMLTableRowElement>(
    ".diagnostic-context tr[data-fresh-until]",
  )) {
    if (Date.parse(row.dataset.freshUntil!) > now) continue;
    const cells = row.querySelectorAll("td");
    cells[2]!.textContent = "unknown（证据已过期）";
    cells[3]!.textContent = "unknown";
    cells[4]!.textContent = "unknown";
  }
}

import { aggregateHealth, type HealthCheck } from "./freshness";

/** 带运维解释的独立检查 / Independent check with an operator-facing explanation. */
export type DetailedHealthCheck = HealthCheck & { readonly detail: string };

/** 健康横幅的三个独立输入 / Three independent inputs to the health banner. */
export interface ControlPlaneChecks {
  access: DetailedHealthCheck;
  rpc: DetailedHealthCheck;
  freshness: DetailedHealthCheck;
}

/** 安全创建只含文本的元素 / Safely create a text-only element. */
function textElement(
  tag: "div" | "p" | "span" | "section",
  className: string,
  text?: string,
): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 构建独立健康检查块 / Build an independent health-check cell. */
function checkCell(label: string, check: DetailedHealthCheck): HTMLElement {
  const dot = textElement("span", "dot");
  dot.setAttribute("aria-hidden", "true");
  const labelNode = textElement("div", "check-label");
  labelNode.append(dot, document.createTextNode(label));
  const cell = textElement("div", "check");
  cell.dataset.state = check.state;
  cell.append(labelNode, textElement("p", "check-detail", check.detail));
  return cell;
}

/**
 * 呈现 fail-closed 控制面健康横幅；任一失败、警告或检查中状态都不会变绿。
 * Render a fail-closed control-plane banner; failure, warning, or pending checks never become green.
 */
export function renderHealthBanner(checks: ControlPlaneChecks): HTMLElement {
  const overall = aggregateHealth(Object.values(checks));
  const banner = textElement("section", "health-banner");
  banner.dataset.state = overall;
  const title = textElement("div", "health-title");
  title.append(
    textElement("span", "pulse"),
    document.createTextNode(
      overall === "healthy"
        ? "控制面已验证"
        : overall === "failed"
          ? "控制面不可完全信任"
          : "控制面状态不确定",
    ),
  );
  const head = textElement("div", "health-head");
  head.append(title, textElement("span", "eyebrow", "fail closed"));
  const cells = textElement("div", "checks");
  cells.append(
    checkCell("Access 会话", checks.access),
    checkCell("Status Admin RPC", checks.rpc),
    checkCell("公开数据新鲜度", checks.freshness),
  );
  banner.append(head, cells);
  return banner;
}

/** 角色优先级归一化；未知角色只能得到 viewer / Normalize role precedence; unknown roles fail closed to viewer. */
export function highestRole(
  roles: readonly string[],
): "viewer" | "operator" | "admin" {
  return roles.includes("admin")
    ? "admin"
    : roles.includes("operator")
      ? "operator"
      : "viewer";
}

/** 判断是否可执行常规运维变更 / Determine whether ordinary operational mutations are allowed. */
export function canOperateRoles(roles: readonly string[]): boolean {
  const role = highestRole(roles);
  return role === "operator" || role === "admin";
}

/** 将角色门禁应用到真实表单控件 / Apply the role gate to an actual form control. */
export function gateControl(
  control: HTMLButtonElement,
  roles: readonly string[],
): void {
  control.disabled = !canOperateRoles(roles);
  control.setAttribute("aria-disabled", String(control.disabled));
}

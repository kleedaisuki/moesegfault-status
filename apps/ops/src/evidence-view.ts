import { EvidenceQueryResultSchema } from "@moesegfault/contracts";

/** 只接受规范化证据；后端故障、过期、截断均显式展示，不推导服务健康。 / Render only normalized evidence; explicitly expose failures, expiry and truncation without inferring service health. */
export function renderEvidenceResult(value: unknown): HTMLElement {
  const result = EvidenceQueryResultSchema.parse(value);
  const section = document.createElement("section");
  section.className = "panel";
  section.dataset.evidenceStatus = result.status;
  const heading = document.createElement("h3");
  heading.textContent = `证据查询：${result.status}`;
  const detail = document.createElement("p");
  detail.textContent = `${result.detail ?? "只读证据查询，不改变服务状态。"} 查询时间：${result.queried_at}${result.truncated ? "；结果已截断" : ""}`;
  section.append(heading, detail);
  if (result.ui_url) {
    const url = new URL(result.ui_url);
    if (url.protocol === "https:" && !url.username && !url.password) {
      const link = document.createElement("a");
      link.href = url.href;
      link.textContent = "在受控后端中打开";
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      section.append(link);
    }
  }
  const records = document.createElement("pre");
  records.className = "structured";
  records.textContent = JSON.stringify(result.records, null, 2);
  section.append(records);
  return section;
}

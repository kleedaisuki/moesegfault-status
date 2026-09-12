import { WorkerEntrypoint } from "cloudflare:workers";
import { domainCore } from "@moesegfault/domain-wasm";
import { instrumentDatabase, measurement } from "./platform/instrumentation.js";
import * as admin from "./admin/index.js";
import * as bootstrap from "./admin/bootstrap.js";
import * as catalog from "./admin/catalog.js";
import * as reads from "./admin/reads.js";
import * as evidence from "./evidence/index.js";
import { parseTraceParent } from "@moesegfault/telemetry";
import { telemetryForInvocation } from "./platform/telemetry.js";
import type { QueryTelemetryReferenceRpcRequest } from "@moesegfault/contracts";

/** 执行上下文与管理员身份分离。 / Execution context remains separate from administrative identity. */
interface RpcInvocation {
  /** 可信网关提供的执行关联。 / Execution correlation supplied by the trusted gateway. */
  correlation_id: string;
  /** 可选独立 W3C 上下文。 / Optional independent W3C context. */
  trace_context?:
    { traceparent: string; tracestate?: string | undefined } | undefined;
}

/** 私有管理能力；只通过 ops-gateway 的 Service Binding 调用。 / Private management capability, callable only through the gateway's Service Binding. */
export class AdminRpc extends WorkerEntrypoint<StatusEnv> {
  /** 按版本维护服务与依赖集合。 / Maintain service and dependency sets at an expected revision. */
  updateServiceCatalog(
    request: Parameters<typeof catalog.updateServiceCatalog>[1],
  ) {
    return this.invoke(
      "status.admin.updateServiceCatalog",
      request,
      catalog.updateServiceCatalog,
    );
  }
  /** 创建含多个支撑服务的能力组件。 / Create a capability component with multiple supporting services. */
  createComponent(request: Parameters<typeof catalog.createComponent>[1]) {
    return this.invoke(
      "status.admin.createComponent",
      request,
      catalog.createComponent,
    );
  }
  /** 按版本修改组件及支撑关系。 / Update component and support relations at an expected revision. */
  updateComponentCatalog(
    request: Parameters<typeof catalog.updateComponentCatalog>[1],
  ) {
    return this.invoke(
      "status.admin.updateComponentCatalog",
      request,
      catalog.updateComponentCatalog,
    );
  }
  /** 注册不可变保留策略并原子绑定服务。 / Register immutable retention policy and atomically bind a service. */
  registerAndAssignRetentionPolicy(
    request: Parameters<typeof bootstrap.registerAndAssignRetentionPolicy>[1],
  ) {
    return this.invoke(
      "status.admin.registerAndAssignRetentionPolicy",
      request,
      bootstrap.registerAndAssignRetentionPolicy,
    );
  }
  /** 在实际部署后显式激活已验证部署。 / Explicitly activate a verified deployment after rollout. */
  activateDeployment(
    request: Parameters<typeof bootstrap.activateDeployment>[1],
  ) {
    return this.invoke(
      "status.admin.activateDeployment",
      request,
      bootstrap.activateDeployment,
    );
  }
  /** 原生 Span 与领域日志共用稳定操作名，不记录正文或 SQL。 / Native spans and domain logs share stable operation names, never bodies or SQL. */
  private async invoke<Request extends RpcInvocation, Result>(
    name: string,
    request: Request,
    operation: (
      env: admin.AdminEnvironment,
      request: Request,
    ) => Promise<Result>,
  ): Promise<Result> {
    const telemetry = telemetryForInvocation(this.env);
    const trace = parseTraceParent(request.trace_context?.traceparent);
    const execute = () =>
      operation(
        {
          ...this.env,
          DOMAIN_CORE: domainCore,
          ...(telemetry ? { TELEMETRY: telemetry } : {}),
          DB: instrumentDatabase(this.env.DB, telemetry, this.ctx.tracing),
        },
        request,
      );
    const result = telemetry
      ? await telemetry.withSpan(
          this.ctx.tracing,
          name,
          { "operation.name": name },
          execute,
        )
      : await execute();
    const failed =
      typeof result === "object" && result !== null && "problem" in result;
    if (
      failed &&
      typeof result.problem === "object" &&
      result.problem !== null &&
      "status" in result.problem &&
      result.problem.status === 409
    )
      measurement(telemetry, "admin.conflict", 1, name);
    telemetry?.logger.emit(
      {
        eventName: "status.admin.completed",
        severity: failed ? "WARN" : "INFO",
        body: "Administrative operation completed",
        attributes: { "operation.name": name },
      },
      { correlationId: request.correlation_id, ...(trace ? { trace } : {}) },
    );
    return result;
  }
  /** 控制面就绪检查。 / Check control-plane readiness. */
  checkHealth(request: Parameters<typeof admin.checkHealth>[1]) {
    return this.invoke("status.admin.checkHealth", request, admin.checkHealth);
  }
  /** 查询内部事故。 / Read an internal incident. */
  getIncident(request: Parameters<typeof admin.getIncident>[1]) {
    return this.invoke("status.admin.getIncident", request, admin.getIncident);
  }
  /** 查询聚合问题。 / Search aggregated issues. */
  searchIssues(request: Parameters<typeof admin.searchIssues>[1]) {
    return this.invoke(
      "status.admin.searchIssues",
      request,
      admin.searchIssues,
    );
  }
  /** 原子创建事故与时间线。 / Atomically create an incident and its timeline. */
  createIncident(request: Parameters<typeof admin.createIncident>[1]) {
    return this.invoke(
      "status.admin.createIncident",
      request,
      admin.createIncident,
    );
  }
  /** 按预期版本修改事故。 / Mutate an incident at its expected revision. */
  updateIncident(request: Parameters<typeof admin.updateIncident>[1]) {
    return this.invoke(
      "status.admin.updateIncident",
      request,
      admin.updateIncident,
    );
  }
  /** 确认问题，不改变观测事实。 / Acknowledge an issue without changing observed facts. */
  acknowledgeIssue(request: Parameters<typeof admin.acknowledgeIssue>[1]) {
    return this.invoke(
      "status.admin.acknowledgeIssue",
      request,
      admin.acknowledgeIssue,
    );
  }
  /** 有期限地抑制问题。 / Suppress an issue until an explicit expiry. */
  suppressIssue(request: Parameters<typeof admin.suppressIssue>[1]) {
    return this.invoke(
      "status.admin.suppressIssue",
      request,
      admin.suppressIssue,
    );
  }
  /** 创建获批维护窗口。 / Create an approved maintenance window. */
  createMaintenanceWindow(
    request: Parameters<typeof admin.createMaintenanceWindow>[1],
  ) {
    return this.invoke(
      "status.admin.createMaintenanceWindow",
      request,
      admin.createMaintenanceWindow,
    );
  }
  /** 按预期版本修改维护窗口。 / Mutate a maintenance window at its expected revision. */
  updateMaintenanceWindow(
    request: Parameters<typeof admin.updateMaintenanceWindow>[1],
  ) {
    return this.invoke(
      "status.admin.updateMaintenanceWindow",
      request,
      admin.updateMaintenanceWindow,
    );
  }
  /** 查询结构化诊断证据图。 / Query a structured diagnostic evidence graph. */
  queryDiagnosticContext(
    request: Parameters<typeof admin.queryDiagnosticContext>[1],
  ) {
    return this.invoke(
      "status.admin.queryDiagnosticContext",
      request,
      admin.queryDiagnosticContext,
    );
  }
  /** 按已注册 ID 查询有界遥测证据。 / Query bounded telemetry evidence by registered ID. */
  queryTelemetryReference(request: QueryTelemetryReferenceRpcRequest) {
    return this.invoke(
      "status.admin.queryTelemetryReference",
      request,
      evidence.queryTelemetryReference,
    );
  }
  /** 读取服务目录权威快照。 / Read the authoritative service-catalog snapshot. */
  getServiceCatalog(request: Parameters<typeof reads.getServiceCatalog>[1]) {
    return this.invoke(
      "status.admin.getServiceCatalog",
      request,
      reads.getServiceCatalog,
    );
  }
  /** 读取 Component 目录权威快照。 / Read the authoritative component-catalog snapshot. */
  getComponentCatalog(
    request: Parameters<typeof reads.getComponentCatalog>[1],
  ) {
    return this.invoke(
      "status.admin.getComponentCatalog",
      request,
      reads.getComponentCatalog,
    );
  }
  /** 读取服务当前保留策略绑定。 / Read the current service retention-policy assignment. */
  getServiceRetentionPolicyAssignment(
    request: Parameters<typeof reads.getServiceRetentionPolicyAssignment>[1],
  ) {
    return this.invoke(
      "status.admin.getServiceRetentionPolicyAssignment",
      request,
      reads.getServiceRetentionPolicyAssignment,
    );
  }
  /** 读取 Deployment 状态与激活指针。 / Read deployment state and activation pointer. */
  getDeploymentActivationContext(
    request: Parameters<typeof reads.getDeploymentActivationContext>[1],
  ) {
    return this.invoke(
      "status.admin.getDeploymentActivationContext",
      request,
      reads.getDeploymentActivationContext,
    );
  }
  /** 注册目录项与依赖。 / Register a catalog entry and dependencies. */
  registerService(request: Parameters<typeof admin.registerService>[1]) {
    return this.invoke(
      "status.admin.registerService",
      request,
      admin.registerService,
    );
  }
  /** 注册不可变策略修订。 / Register an immutable policy revision. */
  registerEvaluationPolicy(
    request: Parameters<typeof admin.registerEvaluationPolicy>[1],
  ) {
    return this.invoke(
      "status.admin.registerEvaluationPolicy",
      request,
      admin.registerEvaluationPolicy,
    );
  }
  /** 创建可调度监控。 / Create a schedulable monitor. */
  createMonitor(request: Parameters<typeof admin.createMonitor>[1]) {
    return this.invoke(
      "status.admin.createMonitor",
      request,
      admin.createMonitor,
    );
  }
  /** 按预期版本修改监控。 / Mutate a monitor at its expected revision. */
  updateMonitor(request: Parameters<typeof admin.updateMonitor>[1]) {
    return this.invoke(
      "status.admin.updateMonitor",
      request,
      admin.updateMonitor,
    );
  }
  /** 指定服务的诊断确认策略。 / Assign a service diagnostic confirmation policy. */
  assignDiagnosticPolicy(
    request: Parameters<typeof admin.assignDiagnosticPolicy>[1],
  ) {
    return this.invoke(
      "status.admin.assignDiagnosticPolicy",
      request,
      admin.assignDiagnosticPolicy,
    );
  }
  /** 注册后端定位器与受控凭据引用。 / Register backend locators and controlled credential references. */
  registerBackend(request: Parameters<typeof admin.registerBackend>[1]) {
    return this.invoke(
      "status.admin.registerBackend",
      request,
      admin.registerBackend,
    );
  }
  /** 创建有期限且可审计的覆盖。 / Create an expiring audited override. */
  setStatusOverride(request: Parameters<typeof admin.setStatusOverride>[1]) {
    return this.invoke(
      "status.admin.setStatusOverride",
      request,
      admin.setStatusOverride,
    );
  }
}

//! 命名私有 AdminRpc；与公开默认 Worker 分别编译，避免泄漏管理方法。
//! Named private AdminRpc, compiled separately from the public default Worker to prevent capability leakage.
#![cfg(target_arch = "wasm32")]
#![deny(missing_docs)]

use serde::Serialize;
use serde_json::{json, Value};
use status_backend::{
    access::AdminRole,
    admin::{self, reads::ReadOperation, RpcContext, RpcProblem},
    database::{Database, Query},
};
use wasm_bindgen::prelude::*;
use worker::Env;

#[wasm_bindgen(module = "cloudflare:workers")]
extern "C" {
    /// 平台环境仅在 invocation 内读取；RPC 参数永不提供 bindings。 / Read platform environment only inside an invocation; RPC arguments never provide bindings.
    #[wasm_bindgen(thread_local_v2, js_name = env)]
    static ENV: Env;
}

/// 固定业务能力类型，不接受浏览器或调用者选取任意方法。 / Fixed capability type, never an arbitrary caller-selected method.
#[derive(Clone, Copy)]
enum Operation {
    /// 权威管理健康。 / Authoritative management health.
    Health,
    /// 固定单管理员认证能力。 / Fixed single-administrator authentication capability.
    Authentication(&'static str),
    /// 类型化目录读取。 / Typed catalog read.
    Read(ReadOperation),
    /// 诊断读取。 / Diagnostic read.
    Diagnostic(&'static str),
    /// 事务性命令。 / Transactional command.
    Mutation(&'static str),
    /// 私有遥测证据。 / Private telemetry evidence.
    Evidence,
}
impl Operation {
    /// 稳定可审计操作名。 / Stable auditable operation name.
    fn name(self) -> &'static str {
        match self {
            Self::Health => "checkHealth",
            Self::Read(op) => op.name(),
            Self::Diagnostic(op) | Self::Mutation(op) | Self::Authentication(op) => op,
            Self::Evidence => "queryTelemetryReference",
        }
    }
}

/// 固定安全错误 envelope，保留合法关联身份。 / Fixed safe error envelope preserving a valid correlation identity.
fn problem(status: u16, title: &str, raw: &Value, operation: &str) -> Value {
    json!({"problem":RpcProblem::new(status,title,raw,operation)})
}

/// 一次调用内获取环境，bootstrap 在任何正常业务和数据库访问之前拒绝。 / Obtain environment inside invocation; bootstrap rejects before normal business or database access.
async fn invoke(operation: Operation, raw: JsValue) -> Result<JsValue, JsValue> {
    let env = ENV.with(Clone::clone);
    let raw: Value = serde_wasm_bindgen::from_value(raw).unwrap_or(Value::Null);
    let name = operation.name();
    let result = if env
        .var("BOOTSTRAP_MODE")
        .is_ok_and(|v| v.to_string() == "true")
    {
        problem(
            503,
            "Administrative RPC is disabled during bootstrap",
            &raw,
            name,
        )
    } else {
        observed(env, operation, raw).await
    };
    // JSON-compatible 输出确保是普通对象，不是 JS Map。 / JSON-compatible output ensures plain objects, never JS Maps.
    result
        .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(|_| JsValue::from_str("Administrative response unavailable"))
}

/// 共享 invocation 遥测；只记录固定操作、结果及关联身份，不记录参数或异常正文。
/// Shared invocation telemetry records only fixed operations, outcomes and correlation, never arguments or exception bodies.
async fn observed(env: Env, operation: Operation, raw: Value) -> Value {
    use status_backend::telemetry::{for_invocation, with_span, TraceContext};
    let telemetry = match for_invocation(&env) {
        Ok(t) => t,
        Err(_) => {
            return problem(
                503,
                "Administrative telemetry unavailable",
                &raw,
                operation.name(),
            )
        }
    };
    let trace = TraceContext::child(
        raw["trace_context"]["traceparent"].as_str(),
        raw["trace_context"]["tracestate"].as_str(),
    )
    .ok();
    let correlation = raw["correlation_id"].as_str().map(str::to_owned);
    let attributes = telemetry
        .as_ref()
        .map(|t| t.span_attributes(operation.name(), correlation.as_deref(), trace.as_ref()))
        .unwrap_or_else(|| json!({"operation.name":operation.name()}));
    let result = with_span("status.admin_rpc", attributes, async move {
        let result = perform(&env, operation, raw).await;
        if result["problem"]["status"]
            .as_u64()
            .is_some_and(|s| s >= 500)
        {
            Err(result)
        } else {
            Ok(result)
        }
    })
    .await
    .unwrap_or_else(|problem| problem);
    if let Some(t) = telemetry {
        t.event("status.admin.completed", result["problem"]["status"].as_u64().is_some_and(|s|s>=500),
            json!({"operation.name":operation.name(),"http.response.status_code":result["problem"]["status"].as_u64().unwrap_or(200)}), correlation.as_deref(), trace.as_ref());
        t.report_drops();
    }
    result
}

/// 领域服务自己再次校验主体、命令和并发版本。 / Domain services independently revalidate principals, commands and revisions.
async fn perform(env: &Env, operation: Operation, raw: Value) -> Value {
    if matches!(operation, Operation::Health) {
        return health(env, &raw).await;
    }
    let binding = match env.d1("DB") {
        Ok(db) => db,
        Err(_) => {
            return problem(
                503,
                "Administrative database unavailable",
                &raw,
                operation.name(),
            )
        }
    };
    let db = Database::new(binding);
    match operation {
        Operation::Authentication(op) => {
            status_backend::admin_auth::dispatch(&db, op, raw, env).await
        }
        Operation::Read(op) => admin::reads::read(&db, op, raw).await,
        Operation::Diagnostic(op) => admin::diagnostics::dispatch(&db, op, raw, env).await,
        Operation::Mutation(op) => admin::mutations::dispatch(&db, op, raw, env).await,
        Operation::Evidence => {
            status_backend::evidence::query_telemetry_reference(env, raw.clone())
                .await
                .unwrap_or_else(|_| {
                    problem(503, "Evidence service unavailable", &raw, operation.name())
                })
        }
        Operation::Health => unreachable!("health handled before database construction"),
    }
}

/// 健康只检查管理 RPC/D1，不推断被监控服务状态。 / Health checks only management RPC/D1, never inferred monitored-service health.
async fn health(env: &Env, raw: &Value) -> Value {
    let context = match RpcContext::parse(raw, &[]) {
        Ok(c) => c,
        Err(p) => return json!({"problem":p}),
    };
    if !context.require(AdminRole::Viewer) {
        return problem(403, "Forbidden", raw, "checkHealth");
    }
    let version = match env.var("STATUS_VERSION").map(|v| v.to_string()) {
        Ok(v) if !v.is_empty() && v.len() <= 128 => v,
        _ => return problem(503, "Status version is unavailable", raw, "checkHealth"),
    };
    let checked_at = js_sys::Date::new_0()
        .to_iso_string()
        .as_string()
        .unwrap_or_default();
    let available = match env.d1("DB") {
        Ok(binding) => Database::new(binding)
            .first::<Value>(&Query::new("SELECT 1 AS ok", vec![]))
            .await
            .is_ok(),
        Err(_) => false,
    };
    json!({"data":{"status":if available {"ok"} else {"degraded"},"checked_at":checked_at,"service_name":"status","version":version,"dependencies":[{"name":"d1","status":if available {"ok"}else{"unavailable"},"last_success_at":if available {json!(checked_at)}else{Value::Null}}]}})
}

/// 私有 checkHealth 能力，仅命名入口可达。 / Private checkHealth capability, reachable only through the named entrypoint.
#[wasm_bindgen(js_name = checkHealth)]
pub async fn check_health(raw: JsValue) -> Result<JsValue, JsValue> {
    invoke(Operation::Health, raw).await
}

/// 私有 getIncident 能力，仅命名入口可达。 / Private getIncident capability, reachable only through the named entrypoint.
#[wasm_bindgen(js_name = getIncident)]
pub async fn get_incident(raw: JsValue) -> Result<JsValue, JsValue> {
    invoke(Operation::Diagnostic("getIncident"), raw).await
}

/// 私有 queryTelemetryReference 能力，仅命名入口可达。 / Private queryTelemetryReference capability, reachable only through the named entrypoint.
#[wasm_bindgen(js_name = queryTelemetryReference)]
pub async fn query_telemetry_reference(raw: JsValue) -> Result<JsValue, JsValue> {
    invoke(Operation::Evidence, raw).await
}

/// 私有 getServiceCatalog 能力，仅命名入口可达。 / Private getServiceCatalog capability, reachable only through the named entrypoint.
#[wasm_bindgen(js_name = getServiceCatalog)]
pub async fn get_service_catalog(raw: JsValue) -> Result<JsValue, JsValue> {
    invoke(Operation::Read(ReadOperation::Service), raw).await
}

/// 私有 getComponentCatalog 能力，仅命名入口可达。 / Private getComponentCatalog capability, reachable only through the named entrypoint.
#[wasm_bindgen(js_name = getComponentCatalog)]
pub async fn get_component_catalog(raw: JsValue) -> Result<JsValue, JsValue> {
    invoke(Operation::Read(ReadOperation::Component), raw).await
}

/// 私有 getServiceRetentionPolicyAssignment 能力，仅命名入口可达。 / Private getServiceRetentionPolicyAssignment capability, reachable only through the named entrypoint.
#[wasm_bindgen(js_name = getServiceRetentionPolicyAssignment)]
pub async fn get_service_retention_policy_assignment(raw: JsValue) -> Result<JsValue, JsValue> {
    invoke(Operation::Read(ReadOperation::Retention), raw).await
}

/// 私有 getDeploymentActivationContext 能力，仅命名入口可达。 / Private getDeploymentActivationContext capability, reachable only through the named entrypoint.
#[wasm_bindgen(js_name = getDeploymentActivationContext)]
pub async fn get_deployment_activation_context(raw: JsValue) -> Result<JsValue, JsValue> {
    invoke(Operation::Read(ReadOperation::Activation), raw).await
}

/// 私有 searchIssues 能力，仅命名入口可达。 / Private searchIssues capability, reachable only through the named entrypoint.
#[wasm_bindgen(js_name = searchIssues)]
pub async fn search_issues(raw: JsValue) -> Result<JsValue, JsValue> {
    invoke(Operation::Diagnostic("searchIssues"), raw).await
}

/// 私有 queryDiagnosticContext 能力，仅命名入口可达。 / Private queryDiagnosticContext capability, reachable only through the named entrypoint.
#[wasm_bindgen(js_name = queryDiagnosticContext)]
pub async fn query_diagnostic_context(raw: JsValue) -> Result<JsValue, JsValue> {
    invoke(Operation::Diagnostic("queryDiagnosticContext"), raw).await
}

/// 私有 createIncident 能力，仅命名入口可达。 / Private createIncident capability, reachable only through the named entrypoint.
#[wasm_bindgen(js_name = createIncident)]
pub async fn create_incident(raw: JsValue) -> Result<JsValue, JsValue> {
    invoke(Operation::Mutation("createIncident"), raw).await
}

/// 私有 updateIncident 能力，仅命名入口可达。 / Private updateIncident capability, reachable only through the named entrypoint.
#[wasm_bindgen(js_name = updateIncident)]
pub async fn update_incident(raw: JsValue) -> Result<JsValue, JsValue> {
    invoke(Operation::Mutation("updateIncident"), raw).await
}

/// 私有 acknowledgeIssue 能力，仅命名入口可达。 / Private acknowledgeIssue capability, reachable only through the named entrypoint.
#[wasm_bindgen(js_name = acknowledgeIssue)]
pub async fn acknowledge_issue(raw: JsValue) -> Result<JsValue, JsValue> {
    invoke(Operation::Mutation("acknowledgeIssue"), raw).await
}

/// 私有 suppressIssue 能力，仅命名入口可达。 / Private suppressIssue capability, reachable only through the named entrypoint.
#[wasm_bindgen(js_name = suppressIssue)]
pub async fn suppress_issue(raw: JsValue) -> Result<JsValue, JsValue> {
    invoke(Operation::Mutation("suppressIssue"), raw).await
}

/// 私有 createMaintenanceWindow 能力，仅命名入口可达。 / Private createMaintenanceWindow capability, reachable only through the named entrypoint.
#[wasm_bindgen(js_name = createMaintenanceWindow)]
pub async fn create_maintenance_window(raw: JsValue) -> Result<JsValue, JsValue> {
    invoke(Operation::Mutation("createMaintenanceWindow"), raw).await
}

/// 私有 updateMaintenanceWindow 能力，仅命名入口可达。 / Private updateMaintenanceWindow capability, reachable only through the named entrypoint.
#[wasm_bindgen(js_name = updateMaintenanceWindow)]
pub async fn update_maintenance_window(raw: JsValue) -> Result<JsValue, JsValue> {
    invoke(Operation::Mutation("updateMaintenanceWindow"), raw).await
}

/// 私有 registerService 能力，仅命名入口可达。 / Private registerService capability, reachable only through the named entrypoint.
#[wasm_bindgen(js_name = registerService)]
pub async fn register_service(raw: JsValue) -> Result<JsValue, JsValue> {
    invoke(Operation::Mutation("registerService"), raw).await
}

/// 私有 updateServiceCatalog 能力，仅命名入口可达。 / Private updateServiceCatalog capability, reachable only through the named entrypoint.
#[wasm_bindgen(js_name = updateServiceCatalog)]
pub async fn update_service_catalog(raw: JsValue) -> Result<JsValue, JsValue> {
    invoke(Operation::Mutation("updateServiceCatalog"), raw).await
}

/// 私有 createComponent 能力，仅命名入口可达。 / Private createComponent capability, reachable only through the named entrypoint.
#[wasm_bindgen(js_name = createComponent)]
pub async fn create_component(raw: JsValue) -> Result<JsValue, JsValue> {
    invoke(Operation::Mutation("createComponent"), raw).await
}

/// 私有 updateComponentCatalog 能力，仅命名入口可达。 / Private updateComponentCatalog capability, reachable only through the named entrypoint.
#[wasm_bindgen(js_name = updateComponentCatalog)]
pub async fn update_component_catalog(raw: JsValue) -> Result<JsValue, JsValue> {
    invoke(Operation::Mutation("updateComponentCatalog"), raw).await
}

/// 私有 registerAndAssignRetentionPolicy 能力，仅命名入口可达。 / Private registerAndAssignRetentionPolicy capability, reachable only through the named entrypoint.
#[wasm_bindgen(js_name = registerAndAssignRetentionPolicy)]
pub async fn register_and_assign_retention_policy(raw: JsValue) -> Result<JsValue, JsValue> {
    invoke(Operation::Mutation("registerAndAssignRetentionPolicy"), raw).await
}

/// 私有 activateDeployment 能力，仅命名入口可达。 / Private activateDeployment capability, reachable only through the named entrypoint.
#[wasm_bindgen(js_name = activateDeployment)]
pub async fn activate_deployment(raw: JsValue) -> Result<JsValue, JsValue> {
    invoke(Operation::Mutation("activateDeployment"), raw).await
}

/// 私有 createMonitor 能力，仅命名入口可达。 / Private createMonitor capability, reachable only through the named entrypoint.
#[wasm_bindgen(js_name = createMonitor)]
pub async fn create_monitor(raw: JsValue) -> Result<JsValue, JsValue> {
    invoke(Operation::Mutation("createMonitor"), raw).await
}

/// 私有 updateMonitor 能力，仅命名入口可达。 / Private updateMonitor capability, reachable only through the named entrypoint.
#[wasm_bindgen(js_name = updateMonitor)]
pub async fn update_monitor(raw: JsValue) -> Result<JsValue, JsValue> {
    invoke(Operation::Mutation("updateMonitor"), raw).await
}

/// 私有 registerEvaluationPolicy 能力，仅命名入口可达。 / Private registerEvaluationPolicy capability, reachable only through the named entrypoint.
#[wasm_bindgen(js_name = registerEvaluationPolicy)]
pub async fn register_evaluation_policy(raw: JsValue) -> Result<JsValue, JsValue> {
    invoke(Operation::Mutation("registerEvaluationPolicy"), raw).await
}

/// 私有 assignDiagnosticPolicy 能力，仅命名入口可达。 / Private assignDiagnosticPolicy capability, reachable only through the named entrypoint.
#[wasm_bindgen(js_name = assignDiagnosticPolicy)]
pub async fn assign_diagnostic_policy(raw: JsValue) -> Result<JsValue, JsValue> {
    invoke(Operation::Mutation("assignDiagnosticPolicy"), raw).await
}

/// 私有 registerBackend 能力，仅命名入口可达。 / Private registerBackend capability, reachable only through the named entrypoint.
#[wasm_bindgen(js_name = registerBackend)]
pub async fn register_backend(raw: JsValue) -> Result<JsValue, JsValue> {
    invoke(Operation::Mutation("registerBackend"), raw).await
}

/// 私有 setStatusOverride 能力，仅命名入口可达。 / Private setStatusOverride capability, reachable only through the named entrypoint.
#[wasm_bindgen(js_name = setStatusOverride)]
pub async fn set_status_override(raw: JsValue) -> Result<JsValue, JsValue> {
    invoke(Operation::Mutation("setStatusOverride"), raw).await
}

/// 单管理员私有认证，仅通过命名能力调用。 / Single-administrator authentication through the named private capability only.
#[wasm_bindgen(js_name = loginAdministrator)]
pub async fn login_administrator(raw: JsValue) -> Result<JsValue, JsValue> {
    invoke(Operation::Authentication("loginAdministrator"), raw).await
}

/// 单管理员私有认证，仅通过命名能力调用。 / Single-administrator authentication through the named private capability only.
#[wasm_bindgen(js_name = authenticateAdministrator)]
pub async fn authenticate_administrator(raw: JsValue) -> Result<JsValue, JsValue> {
    invoke(Operation::Authentication("authenticateAdministrator"), raw).await
}

/// 单管理员私有认证，仅通过命名能力调用。 / Single-administrator authentication through the named private capability only.
#[wasm_bindgen(js_name = logoutAdministrator)]
pub async fn logout_administrator(raw: JsValue) -> Result<JsValue, JsValue> {
    invoke(Operation::Authentication("logoutAdministrator"), raw).await
}

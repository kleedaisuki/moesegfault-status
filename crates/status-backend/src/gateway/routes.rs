//! 单一固定能力表。 / Single fixed capability table.
use crate::{access::AdminRole, http::HttpError};
/// 固定方法集合，禁止浏览器选择任意属性。 / Fixed method set; browsers cannot select arbitrary properties.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RpcMethod {
    /// 私有能力。 / Private Session capability.
    Session,
    /// 私有能力。 / Private checkHealth capability.
    CheckHealth,
    /// 私有能力。 / Private getIncident capability.
    GetIncident,
    /// 私有能力。 / Private queryTelemetryReference capability.
    QueryTelemetryReference,
    /// 私有能力。 / Private getServiceCatalog capability.
    GetServiceCatalog,
    /// 私有能力。 / Private getComponentCatalog capability.
    GetComponentCatalog,
    /// 私有能力。 / Private getServiceRetentionPolicyAssignment capability.
    GetServiceRetentionPolicyAssignment,
    /// 私有能力。 / Private getDeploymentActivationContext capability.
    GetDeploymentActivationContext,
    /// 私有能力。 / Private searchIssues capability.
    SearchIssues,
    /// 私有能力。 / Private queryDiagnosticContext capability.
    QueryDiagnosticContext,
    /// 私有能力。 / Private createIncident capability.
    CreateIncident,
    /// 私有能力。 / Private updateIncident capability.
    UpdateIncident,
    /// 私有能力。 / Private acknowledgeIssue capability.
    AcknowledgeIssue,
    /// 私有能力。 / Private suppressIssue capability.
    SuppressIssue,
    /// 私有能力。 / Private createMaintenanceWindow capability.
    CreateMaintenanceWindow,
    /// 私有能力。 / Private updateMaintenanceWindow capability.
    UpdateMaintenanceWindow,
    /// 私有能力。 / Private registerService capability.
    RegisterService,
    /// 私有能力。 / Private updateServiceCatalog capability.
    UpdateServiceCatalog,
    /// 私有能力。 / Private createComponent capability.
    CreateComponent,
    /// 私有能力。 / Private updateComponentCatalog capability.
    UpdateComponentCatalog,
    /// 私有能力。 / Private registerAndAssignRetentionPolicy capability.
    RegisterAndAssignRetentionPolicy,
    /// 私有能力。 / Private activateDeployment capability.
    ActivateDeployment,
    /// 私有能力。 / Private createMonitor capability.
    CreateMonitor,
    /// 私有能力。 / Private updateMonitor capability.
    UpdateMonitor,
    /// 私有能力。 / Private registerEvaluationPolicy capability.
    RegisterEvaluationPolicy,
    /// 私有能力。 / Private assignDiagnosticPolicy capability.
    AssignDiagnosticPolicy,
    /// 私有能力。 / Private registerBackend capability.
    RegisterBackend,
    /// 私有能力。 / Private setStatusOverride capability.
    SetStatusOverride,
}
impl RpcMethod {
    /// 固定平台方法名。 / Fixed platform method name.
    pub fn name(self) -> &'static str {
        match self {
            Self::Session => "Session",
            Self::CheckHealth => "checkHealth",
            Self::GetIncident => "getIncident",
            Self::QueryTelemetryReference => "queryTelemetryReference",
            Self::GetServiceCatalog => "getServiceCatalog",
            Self::GetComponentCatalog => "getComponentCatalog",
            Self::GetServiceRetentionPolicyAssignment => "getServiceRetentionPolicyAssignment",
            Self::GetDeploymentActivationContext => "getDeploymentActivationContext",
            Self::SearchIssues => "searchIssues",
            Self::QueryDiagnosticContext => "queryDiagnosticContext",
            Self::CreateIncident => "createIncident",
            Self::UpdateIncident => "updateIncident",
            Self::AcknowledgeIssue => "acknowledgeIssue",
            Self::SuppressIssue => "suppressIssue",
            Self::CreateMaintenanceWindow => "createMaintenanceWindow",
            Self::UpdateMaintenanceWindow => "updateMaintenanceWindow",
            Self::RegisterService => "registerService",
            Self::UpdateServiceCatalog => "updateServiceCatalog",
            Self::CreateComponent => "createComponent",
            Self::UpdateComponentCatalog => "updateComponentCatalog",
            Self::RegisterAndAssignRetentionPolicy => "registerAndAssignRetentionPolicy",
            Self::ActivateDeployment => "activateDeployment",
            Self::CreateMonitor => "createMonitor",
            Self::UpdateMonitor => "updateMonitor",
            Self::RegisterEvaluationPolicy => "registerEvaluationPolicy",
            Self::AssignDiagnosticPolicy => "assignDiagnosticPolicy",
            Self::RegisterBackend => "registerBackend",
            Self::SetStatusOverride => "setStatusOverride",
        }
    }
}
/// 路由元数据。 / Route metadata.
#[derive(Debug)]
pub struct Route {
    /// 固定能力。 / Fixed capability.
    pub method: RpcMethod,
    /// 最低角色。 / Minimum role.
    pub role: AdminRole,
    /// 正文容器；空表示平铺。 / Body container; empty means flat.
    pub body: &'static str,
    /// 必须提供版本。 / Requires revision.
    pub revision: bool,
    /// 成功状态。 / Success status.
    pub status: u16,
    /// 已解码路径身份。 / Decoded path identity.
    pub identity: Option<(&'static str, String)>,
}
/// 固定能力描述。 / Fixed capability descriptor.
struct Spec {
    /// HTTP 方法。 / HTTP method.
    verb: &'static str,
    /// 路径模板。 / Path template.
    path: &'static str,
    /// 能力、角色、正文、版本、状态。 / Capability, role, body, revision and status.
    route: (RpcMethod, AdminRole, &'static str, bool, u16),
}
/// 唯一能力 allowlist。 / Sole capability allowlist.
const ROUTES: &[Spec] = &[
    Spec {
        verb: "GET",
        path: "/api/session",
        route: (RpcMethod::Session, AdminRole::Viewer, "", false, 200),
    },
    Spec {
        verb: "GET",
        path: "/api/health",
        route: (RpcMethod::CheckHealth, AdminRole::Viewer, "", false, 200),
    },
    Spec {
        verb: "GET",
        path: "/api/incidents/:incident_id",
        route: (RpcMethod::GetIncident, AdminRole::Viewer, "", false, 200),
    },
    Spec {
        verb: "GET",
        path: "/api/evidence/:telemetry_reference_id",
        route: (
            RpcMethod::QueryTelemetryReference,
            AdminRole::Viewer,
            "",
            false,
            200,
        ),
    },
    Spec {
        verb: "GET",
        path: "/api/catalog/services/:service_name",
        route: (
            RpcMethod::GetServiceCatalog,
            AdminRole::Viewer,
            "",
            false,
            200,
        ),
    },
    Spec {
        verb: "GET",
        path: "/api/catalog/components/:component_id",
        route: (
            RpcMethod::GetComponentCatalog,
            AdminRole::Viewer,
            "",
            false,
            200,
        ),
    },
    Spec {
        verb: "GET",
        path: "/api/retention-policy-assignments/:service_name",
        route: (
            RpcMethod::GetServiceRetentionPolicyAssignment,
            AdminRole::Viewer,
            "",
            false,
            200,
        ),
    },
    Spec {
        verb: "GET",
        path: "/api/deployments/:deployment_id/activation-context",
        route: (
            RpcMethod::GetDeploymentActivationContext,
            AdminRole::Viewer,
            "",
            false,
            200,
        ),
    },
    Spec {
        verb: "POST",
        path: "/api/issues/search",
        route: (
            RpcMethod::SearchIssues,
            AdminRole::Viewer,
            "query",
            false,
            200,
        ),
    },
    Spec {
        verb: "POST",
        path: "/api/diagnostic-context/query",
        route: (
            RpcMethod::QueryDiagnosticContext,
            AdminRole::Viewer,
            "locator",
            false,
            200,
        ),
    },
    Spec {
        verb: "POST",
        path: "/api/incidents",
        route: (
            RpcMethod::CreateIncident,
            AdminRole::Operator,
            "command",
            false,
            201,
        ),
    },
    Spec {
        verb: "PATCH",
        path: "/api/incidents/:incident_id",
        route: (
            RpcMethod::UpdateIncident,
            AdminRole::Operator,
            "command",
            true,
            200,
        ),
    },
    Spec {
        verb: "POST",
        path: "/api/issues/:issue_id/acknowledge",
        route: (
            RpcMethod::AcknowledgeIssue,
            AdminRole::Operator,
            "",
            true,
            200,
        ),
    },
    Spec {
        verb: "POST",
        path: "/api/issues/:issue_id/suppress",
        route: (RpcMethod::SuppressIssue, AdminRole::Operator, "", true, 200),
    },
    Spec {
        verb: "POST",
        path: "/api/maintenance-windows",
        route: (
            RpcMethod::CreateMaintenanceWindow,
            AdminRole::Operator,
            "command",
            false,
            201,
        ),
    },
    Spec {
        verb: "PATCH",
        path: "/api/maintenance-windows/:id",
        route: (
            RpcMethod::UpdateMaintenanceWindow,
            AdminRole::Operator,
            "command",
            true,
            200,
        ),
    },
    Spec {
        verb: "POST",
        path: "/api/services",
        route: (
            RpcMethod::RegisterService,
            AdminRole::Admin,
            "command",
            false,
            201,
        ),
    },
    Spec {
        verb: "PATCH",
        path: "/api/services/:service_name",
        route: (
            RpcMethod::UpdateServiceCatalog,
            AdminRole::Admin,
            "command",
            true,
            200,
        ),
    },
    Spec {
        verb: "POST",
        path: "/api/components",
        route: (
            RpcMethod::CreateComponent,
            AdminRole::Admin,
            "command",
            false,
            201,
        ),
    },
    Spec {
        verb: "PATCH",
        path: "/api/components/:component_id",
        route: (
            RpcMethod::UpdateComponentCatalog,
            AdminRole::Admin,
            "command",
            true,
            200,
        ),
    },
    Spec {
        verb: "POST",
        path: "/api/retention-policy-assignments",
        route: (
            RpcMethod::RegisterAndAssignRetentionPolicy,
            AdminRole::Admin,
            "command",
            false,
            200,
        ),
    },
    Spec {
        verb: "POST",
        path: "/api/deployments/:deployment_id/activate",
        route: (
            RpcMethod::ActivateDeployment,
            AdminRole::Admin,
            "command",
            false,
            200,
        ),
    },
    Spec {
        verb: "POST",
        path: "/api/monitors",
        route: (
            RpcMethod::CreateMonitor,
            AdminRole::Admin,
            "command",
            false,
            201,
        ),
    },
    Spec {
        verb: "PATCH",
        path: "/api/monitors/:monitor_id",
        route: (
            RpcMethod::UpdateMonitor,
            AdminRole::Admin,
            "command",
            true,
            200,
        ),
    },
    Spec {
        verb: "POST",
        path: "/api/evaluation-policies",
        route: (
            RpcMethod::RegisterEvaluationPolicy,
            AdminRole::Admin,
            "command",
            false,
            201,
        ),
    },
    Spec {
        verb: "POST",
        path: "/api/diagnostic-policy-assignments",
        route: (
            RpcMethod::AssignDiagnosticPolicy,
            AdminRole::Admin,
            "command",
            false,
            201,
        ),
    },
    Spec {
        verb: "POST",
        path: "/api/telemetry-backends",
        route: (
            RpcMethod::RegisterBackend,
            AdminRole::Admin,
            "command",
            false,
            201,
        ),
    },
    Spec {
        verb: "POST",
        path: "/api/status-overrides",
        route: (
            RpcMethod::SetStatusOverride,
            AdminRole::Operator,
            "command",
            false,
            201,
        ),
    },
];
/// 精确匹配，在读取正文之前拒绝未知路径。 / Exact matching rejects unknown routes before body reads.
pub fn resolve(verb: &str, path: &str) -> Result<Route, HttpError> {
    for spec in ROUTES.iter().filter(|s| s.verb == verb) {
        let actual: Vec<_> = path.split('/').collect();
        let expected: Vec<_> = spec.path.split('/').collect();
        if actual.len() != expected.len() {
            continue;
        }
        if !actual.iter().zip(&expected).all(|(a, e)| {
            if e.starts_with(':') {
                !a.is_empty()
            } else {
                a == e
            }
        }) {
            continue;
        }
        let mut identity = None;
        for (a, e) in actual.iter().zip(&expected) {
            if let Some(key) = e.strip_prefix(':') {
                identity = Some((key, decode_segment(a)?));
            }
        }
        let (method, role, body, revision, status) = spec.route;
        return Ok(Route {
            method,
            role,
            body,
            revision,
            status,
            identity,
        });
    }
    if !matches!(verb, "GET" | "POST" | "PATCH") {
        return Err(HttpError::new(
            405,
            "method-not-allowed",
            "HTTP method is not allowed",
        ));
    }
    Err(HttpError::new(
        404,
        "route-not-found",
        "Administrative API route not found",
    ))
}
/// 验证转义并拒绝分隔符混淆。 / Validate escapes and reject separator confusion.
fn decode_segment(s: &str) -> Result<String, HttpError> {
    let invalid = HttpError::new(400, "invalid-path", "Path contains invalid encoding");
    let bytes = s.as_bytes();
    for (i, b) in bytes.iter().enumerate() {
        if *b == b'%'
            && (i + 2 >= bytes.len()
                || !bytes[i + 1].is_ascii_hexdigit()
                || !bytes[i + 2].is_ascii_hexdigit())
        {
            return Err(invalid);
        }
    }
    let decoded = percent_encoding::percent_decode_str(s)
        .decode_utf8()
        .map_err(|_| invalid.clone())?
        .into_owned();
    if decoded.contains('/') || decoded.contains('\\') || decoded.chars().any(char::is_control) {
        return Err(invalid);
    }
    Ok(decoded)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn all_capabilities_are_reachable_and_exact() {
        assert_eq!(ROUTES.len(), 28);
        for s in ROUTES {
            let path = s
                .path
                .split('/')
                .map(|p| if p.starts_with(':') { "test-id" } else { p })
                .collect::<Vec<_>>()
                .join("/");
            let r = resolve(s.verb, &path).unwrap();
            assert_eq!(r.method, s.route.0);
            assert!(resolve(s.verb, &format!("{path}/extra")).is_err());
        }
        assert!(resolve("POST", "/api/checkHealth").is_err());
        assert_eq!(
            resolve("OPTIONS", "/api/incidents").unwrap_err().status,
            405
        );
        for p in ["%", "%GG", "%FF", "%2f", "%00"] {
            assert!(resolve("GET", &format!("/api/incidents/{p}")).is_err());
        }
    }
}

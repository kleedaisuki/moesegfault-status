//! Manifest 绑定的不可变事件构建器。 / Manifest-bound immutable event builder.
use crate::{
    evidence::{invalid, required, SafeDiagnosticEvidence},
    propagation::{uuid_v7, DiagnosticPropagation},
};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use status_domain::{
    DeploymentManifest, DiagnosticEvent, DiagnosticSeverity, DiagnosticSignal, DomainResult,
    ResourceIdentity,
};
use std::collections::BTreeMap;

/// HTTP 正文字节硬上限。 / Hard HTTP body byte bound.
pub const MAX_EVENT_BYTES: usize = 64 * 1024;
/// 调用方分类的安全事实输入。 / Caller-classified safe fact input.
#[derive(Clone, Debug)]
pub struct DiagnosticEventInput {
    /// 稳定点分类别。 / Stable dotted kind.
    pub kind: String,
    /// 运维严重度。 / Operational severity.
    pub severity: DiagnosticSeverity,
    /// 展示文案，禁止原始请求及异常。 / Display text, never raw requests or exceptions.
    pub summary: String,
    /// 固定允许字段的低基数指纹。 / Low-cardinality fingerprint with fixed allowed keys.
    pub fingerprint: BTreeMap<String, String>,
    /// 未知键被删除。 / Unknown keys are dropped.
    pub attributes: BTreeMap<String, Value>,
    /// 有限构建器产生的证据。 / Evidence from finite builders.
    pub evidence: Vec<SafeDiagnosticEvidence>,
    /// 已验证执行上下文。 / Validated execution context.
    pub propagation: Option<DiagnosticPropagation>,
    /// 缺省采用构建时刻。 / Defaults to build time.
    pub occurred_at: Option<DateTime<Utc>>,
    /// 非用户来源的实例 UUID。 / Non-user-derived instance UUID.
    pub instance_id: Option<String>,
}
impl DiagnosticEventInput {
    /// 创建最小输入；仍需至少一个 fingerprint 字段。 / Creates minimal input; at least one fingerprint field is still required.
    pub fn new(
        kind: impl Into<String>,
        severity: DiagnosticSeverity,
        summary: impl Into<String>,
    ) -> Self {
        Self {
            kind: kind.into(),
            severity,
            summary: summary.into(),
            fingerprint: BTreeMap::new(),
            attributes: BTreeMap::new(),
            evidence: Vec::new(),
            propagation: None,
            occurred_at: None,
            instance_id: None,
        }
    }
}
/// 私有构造、只读且预序列化的事件；重试复用相同字节。 / Privately constructed read-only event; retries reuse identical bytes.
#[derive(Clone, Debug)]
pub struct PreparedDiagnostic {
    event: DiagnosticEvent,
    bytes: Vec<u8>,
    propagation: DiagnosticPropagation,
}
impl PreparedDiagnostic {
    /// 只读事件。 / Read-only event.
    pub fn event(&self) -> &DiagnosticEvent {
        &self.event
    }
    /// 已验证 JSON 字节。 / Validated JSON bytes.
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
    /// 关联 ID。 / Correlation ID.
    pub fn correlation_id(&self) -> &str {
        self.propagation.correlation_id()
    }
    /// 安全出站上下文。 / Safe outgoing context.
    pub fn propagation(&self) -> &DiagnosticPropagation {
        &self.propagation
    }
}
/// 绑定单一部署；调用方不能逐事件覆盖身份。 / Bound to one deployment; callers cannot override event identity.
#[derive(Clone, Debug)]
pub struct DiagnosticEventBuilder {
    resource: ResourceIdentity,
}
impl DiagnosticEventBuilder {
    /// 交叉校验并固定身份。 / Cross-checks and pins identity.
    pub fn new(resource: ResourceIdentity, manifest: &DeploymentManifest) -> DomainResult<Self> {
        resource.validate_against(manifest)?;
        if resource.service_name.len() > 63
            || !regex::Regex::new(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
                .expect("constant regex")
                .is_match(&resource.service_name)
        {
            return Err(invalid("invalid service name"));
        }
        Ok(Self { resource })
    }
    /// 从完整部署 manifest 固定身份。 / Pins identity from a complete deployment manifest.
    pub fn from_manifest(manifest: &DeploymentManifest) -> DomainResult<Self> {
        Self::new(resource_from_manifest(manifest)?, manifest)
    }
    /// 只读身份，供 publisher 校验。 / Read-only identity for publisher validation.
    pub fn resource(&self) -> &ResourceIdentity {
        &self.resource
    }
    /// 检查事件来源是否匹配固定部署。 / Checks event provenance against the pinned deployment.
    pub fn identity_matches(&self, event: &DiagnosticEvent) -> bool {
        event.service_name == self.resource.service_name
            && event.environment == self.resource.environment
            && event.deployment_id == self.resource.deployment_id
    }
    /// 创建故障。 / Creates a fault.
    pub fn fault(&self, input: DiagnosticEventInput) -> DomainResult<PreparedDiagnostic> {
        self.fault_at(input, now()?)
    }
    /// 使用可测试时钟创建故障。 / Creates a fault with a testable clock.
    pub fn fault_at(
        &self,
        input: DiagnosticEventInput,
        now: DateTime<Utc>,
    ) -> DomainResult<PreparedDiagnostic> {
        self.build(input, DiagnosticSignal::Fault, None, now)
    }
    /// 恢复必须因果引用一个已知故障。 / Recovery must causally reference a known fault.
    pub fn recovery(
        &self,
        input: DiagnosticEventInput,
        recovery_of_event_id: &str,
    ) -> DomainResult<PreparedDiagnostic> {
        self.recovery_at(input, recovery_of_event_id, now()?)
    }
    /// 使用可测试时钟创建因果恢复。 / Creates causal recovery with a testable clock.
    pub fn recovery_at(
        &self,
        input: DiagnosticEventInput,
        recovery_of_event_id: &str,
        now: DateTime<Utc>,
    ) -> DomainResult<PreparedDiagnostic> {
        self.build(
            input,
            DiagnosticSignal::Recovery,
            Some(recovery_of_event_id.into()),
            now,
        )
    }
    fn build(
        &self,
        input: DiagnosticEventInput,
        signal: DiagnosticSignal,
        recovery_of_event_id: Option<String>,
        now: DateTime<Utc>,
    ) -> DomainResult<PreparedDiagnostic> {
        let propagation = match input.propagation {
            Some(p) => p,
            None => DiagnosticPropagation::new(now.timestamp_millis())?,
        };
        let event = DiagnosticEvent {
            event_id: uuid_v7(now.timestamp_millis())?,
            schema_version: "1.0".into(),
            kind: input.kind,
            signal,
            recovery_of_event_id,
            severity: input.severity,
            service_name: self.resource.service_name.clone(),
            environment: self.resource.environment,
            deployment_id: self.resource.deployment_id.clone(),
            instance_id: input.instance_id,
            occurred_at: input.occurred_at.unwrap_or(now),
            correlation_id: propagation.correlation_id().into(),
            trace_id: Some(propagation.trace_id().into()),
            span_id: Some(propagation.span_id().into()),
            summary: required(&input.summary, 512)?.trim().into(),
            fingerprint: fingerprint(input.fingerprint)?,
            evidence: input
                .evidence
                .iter()
                .map(|e| e.evidence().clone())
                .collect(),
            attributes: attributes(input.attributes)?,
        };
        event.validate()?;
        // 公共 JSON 契约以缺省字段表达 None，而非 null。 / Public JSON expresses None by omission, not null.
        let mut wire = serde_json::to_value(&event)?;
        if let Some(object) = wire.as_object_mut() {
            object.retain(|_, v| !v.is_null());
        }
        if let Some(evidence) = wire.get_mut("evidence").and_then(Value::as_array_mut) {
            for e in evidence {
                if let Some(o) = e.as_object_mut() {
                    o.retain(|_, v| !v.is_null());
                }
            }
        }
        let bytes = serde_json::to_vec(&wire)?;
        if bytes.len() > MAX_EVENT_BYTES {
            return Err(invalid("diagnostic exceeds 64 KiB UTF-8 bytes"));
        }
        Ok(PreparedDiagnostic {
            event,
            bytes,
            propagation,
        })
    }
}
/// 显式复制并验证 manifest 身份。 / Explicitly copies and validates manifest identity.
pub fn resource_from_manifest(manifest: &DeploymentManifest) -> DomainResult<ResourceIdentity> {
    manifest.validate()?;
    Ok(ResourceIdentity {
        service_name: manifest.service_name.clone(),
        environment: manifest.environment,
        service_version: manifest.service_version.clone(),
        deployment_id: manifest.deployment_id.clone(),
        build_revision: manifest.git_commit.clone(),
        artifact_digest: manifest.artifact_digest.clone(),
    })
}
fn fingerprint(input: BTreeMap<String, String>) -> DomainResult<Value> {
    if input.is_empty() {
        return Err(invalid("fingerprint requires a stable field"));
    }
    let mut result = BTreeMap::new();
    for (k, v) in input {
        let limit = match k.as_str() {
            "dependency" | "operation" | "error_type" | "component" | "capability" => 128,
            "region" => 64,
            "protocol" => 16,
            _ => return Err(invalid("unknown fingerprint field")),
        };
        if k == "protocol"
            && !matches!(
                v.as_str(),
                "http" | "rpc" | "tcp" | "dns" | "queue" | "database"
            )
        {
            return Err(invalid("invalid fingerprint protocol"));
        }
        result.insert(k, required(&v, limit)?);
    }
    Ok(json!(result))
}
fn attributes(input: BTreeMap<String, Value>) -> DomainResult<BTreeMap<String, Value>> {
    let mut result = BTreeMap::new();
    for (k, v) in input {
        let limit = match k.as_str() {
            "dependency.name" | "operation.name" | "error.type" | "component.id" => 128,
            "cloud.region" | "rpc.system" | "db.system.name" => 64,
            "http.request.method" | "deployment.environment.name" => 16,
            "http.response.status_code" => 0,
            _ => continue,
        };
        if limit == 0 {
            if !v.as_u64().is_some_and(|n| (100..=599).contains(&n)) {
                return Err(invalid("invalid HTTP status"));
            }
            result.insert(k, v);
            continue;
        }
        let Some(s) = v.as_str() else {
            return Err(invalid("attribute requires string"));
        };
        if k == "http.request.method"
            && !matches!(
                s,
                "GET"
                    | "HEAD"
                    | "POST"
                    | "PUT"
                    | "DELETE"
                    | "CONNECT"
                    | "OPTIONS"
                    | "TRACE"
                    | "PATCH"
            )
        {
            return Err(invalid("invalid HTTP method"));
        }
        if k == "deployment.environment.name"
            && !matches!(s, "development" | "test" | "staging" | "production")
        {
            return Err(invalid("invalid environment"));
        }
        result.insert(k, json!(required(s, limit)?));
    }
    Ok(result)
}
fn now() -> DomainResult<DateTime<Utc>> {
    #[cfg(target_arch = "wasm32")]
    let ms = js_sys::Date::now() as i64;
    #[cfg(not(target_arch = "wasm32"))]
    let ms = i64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| invalid("clock before epoch"))?
            .as_millis(),
    )
    .map_err(|_| invalid("clock overflow"))?;
    DateTime::from_timestamp_millis(ms).ok_or_else(|| invalid("clock out of range"))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stable_bytes_and_causal_recovery() {
        let builder = DiagnosticEventBuilder {
            resource: ResourceIdentity {
                service_name: "api".into(),
                environment: status_domain::Environment::Production,
                service_version: "1".into(),
                deployment_id: "01900000-0000-7000-8000-000000000001".into(),
                build_revision: "a".repeat(40),
                artifact_digest: format!("sha256:{}", "b".repeat(64)),
            },
        };
        let mut input = DiagnosticEventInput::new(
            "dependency.failed",
            DiagnosticSeverity::Error,
            "token=secret 中文",
        );
        input.fingerprint.insert("dependency".into(), "db".into());
        let now = DateTime::from_timestamp_millis(1234).unwrap();
        let fault = builder.fault_at(input.clone(), now).unwrap();
        let copy = fault.clone();
        assert_eq!(fault.bytes(), copy.bytes());
        assert!(!String::from_utf8_lossy(fault.bytes()).contains("secret"));
        assert!(!String::from_utf8_lossy(fault.bytes()).contains(":null"));
        let recovery = builder
            .recovery_at(input, fault.event().event_id.as_str(), now)
            .unwrap();
        assert_eq!(
            recovery.event().recovery_of_event_id.as_deref(),
            Some(fault.event().event_id.as_str())
        );
        assert_ne!(fault.event().event_id, recovery.event().event_id);
    }
}

#[cfg(test)]
mod bounds_tests {
    use super::*;
    #[test]
    fn hard_byte_bound_and_unknown_fields() {
        assert!(fingerprint(BTreeMap::from([("secret".into(), "x".into())])).is_err());
        assert!(attributes(BTreeMap::from([(
            "http.response.status_code".into(),
            json!(600)
        )]))
        .is_err());
        assert!(
            attributes(BTreeMap::from([("password".into(), json!("x"))]))
                .unwrap()
                .is_empty()
        );
        let builder = DiagnosticEventBuilder {
            resource: ResourceIdentity {
                service_name: "中".repeat(MAX_EVENT_BYTES),
                environment: status_domain::Environment::Production,
                service_version: "1".into(),
                deployment_id: "01900000-0000-7000-8000-000000000001".into(),
                build_revision: "a".repeat(40),
                artifact_digest: format!("sha256:{}", "b".repeat(64)),
            },
        };
        let mut input =
            DiagnosticEventInput::new("dependency.failed", DiagnosticSeverity::Error, "bounded");
        input.fingerprint.insert("dependency".into(), "db".into());
        assert!(builder
            .fault_at(input, DateTime::from_timestamp_millis(1234).unwrap())
            .unwrap_err()
            .to_string()
            .contains("64 KiB"));
    }
}

#[cfg(test)]
mod manifest_tests {
    use super::*;
    #[test]
    fn binds_all_manifest_fields() {
        let manifest:DeploymentManifest=serde_json::from_value(json!({
            "deployment_id":"01900000-0000-7000-8000-000000000001","service_name":"api","environment":"production","service_version":"1",
            "repository_url":"https://example.com/repo","git_commit":"a".repeat(40),"git_ref":"main","artifact_digest":format!("sha256:{}","b".repeat(64)),
            "ci_provider":"test","ci_run_id":"1","deployed_at":"2026-09-12T00:00:00Z","region":["global"],
            "artifacts":[{"kind":"other","file_name":"main.wasm","artifact_digest":format!("sha256:{}","b".repeat(64)),"media_type":"application/wasm","size_bytes":1,"build_id":null}]
        })).unwrap();
        let resource = resource_from_manifest(&manifest).unwrap();
        DiagnosticEventBuilder::new(resource.clone(), &manifest).unwrap();
        let mut mismatch = resource;
        mismatch.service_version = "2".into();
        assert!(DiagnosticEventBuilder::new(mismatch, &manifest).is_err());
    }
}

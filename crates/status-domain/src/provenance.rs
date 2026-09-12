//! Deployment 与遥测来源校验。 / Deployment and telemetry provenance validation.

use std::collections::{BTreeMap, BTreeSet};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;
use uuid::{Uuid, Version};

use crate::{DomainError, DomainResult};

/// 可部署环境。 / Deployment environment.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Environment {
    /// 本地开发。 / Local development.
    Development,
    /// 自动测试环境。 / Automated test environment.
    Test,
    /// 预发布验证。 / Pre-production validation.
    Staging,
    /// 生产环境。 / Production.
    Production,
}

/// 不可变部署产物类别。 / Immutable deployment artifact kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactKind {
    /// 原生二进制或部署 bundle。 / Native binary or deployment bundle.
    Binary,
    /// 原生调试符号。 / Native debug symbols.
    DebugSymbols,
    /// JavaScript/TypeScript source map。 / JavaScript/TypeScript source map.
    SourceMap,
    /// 部署 manifest 副本。 / Deployment manifest copy.
    Manifest,
    /// 软件物料清单。 / Software bill of materials.
    Sbom,
    /// 其他已登记不可变产物。 / Other registered immutable artifact.
    Other,
}

/// 内容寻址的不可变产物元数据。 / Metadata for an immutable content-addressed artifact.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Artifact {
    /// 产物类别。 / Artifact kind.
    pub kind: ArtifactKind,
    /// Manifest 内安全的 ASCII 文件名。 / Safe ASCII file name within the manifest.
    pub file_name: String,
    /// `sha256:<64 lowercase hex>` 内容摘要。 / `sha256:<64 lowercase hex>` content digest.
    pub digest: String,
    /// 平台媒体类型。 / Media type.
    pub media_type: String,
    /// 字节大小。 / Size in bytes.
    pub size_bytes: u64,
    /// 原生符号化所需稳定 Build ID。 / Stable Build ID required for native symbolization.
    pub build_id: Option<String>,
}

impl Artifact {
    /// 校验摘要、文件名和符号 Build ID。 / Validates digest, file name, and symbol Build ID.
    pub fn validate(&self) -> DomainResult<()> {
        validate_sha256(&self.digest, "artifact digest")?;
        if self.media_type.trim().is_empty()
            || !valid_file_name(&self.file_name)
            || self.size_bytes == 0
        {
            return Err(DomainError::Validation(
                "artifact requires positive size, media_type, and safe ASCII file_name".into(),
            ));
        }
        if matches!(self.kind, ArtifactKind::DebugSymbols | ArtifactKind::Binary)
            && self
                .build_id
                .as_ref()
                .map_or(true, |id| id.trim().is_empty())
        {
            return Err(DomainError::Validation(
                "native binary and debug symbols require a stable build_id".into(),
            ));
        }
        Ok(())
    }
}

/// 在接流量前注册的不可变 Deployment Manifest。 / Immutable Deployment Manifest registered before receiving traffic.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeploymentManifest {
    /// UUIDv7 部署身份。 / UUIDv7 deployment identity.
    pub deployment_id: String,
    /// 已注册的 OpenTelemetry `service.name`。 / Registered OpenTelemetry `service.name`.
    pub service_name: String,
    /// 部署环境。 / Deployment environment.
    pub environment: Environment,
    /// 与运行时 Resource 一致的版本。 / Version matching the runtime Resource.
    pub service_version: String,
    /// 无凭据的规范 HTTPS 仓库 URL。 / Canonical credential-free HTTPS repository URL.
    pub repository_url: String,
    /// 完整 Git SHA-1 或 SHA-256 OID。 / Full Git SHA-1 or SHA-256 OID.
    pub git_commit: String,
    /// 构建时 ref，仅供展示。 / Build-time ref, for display only.
    pub git_ref: String,
    /// 实际运行主产物摘要。 / Digest of the running primary artifact.
    pub artifact_digest: String,
    /// CI provider 稳定名。 / Stable CI provider name.
    pub ci_provider: String,
    /// 可构造永久链接的 CI run 身份。 / CI run identity from which a permanent link can be built.
    pub ci_run_id: String,
    /// UTC 部署时间。 / UTC deployment time.
    pub deployed_at: DateTime<Utc>,
    /// 实际区域；全局边缘使用平台约定名。 / Actual regions; global edge uses a platform-defined name.
    pub region: Vec<String>,
    /// 属于该 deployment 的不可变产物。 / Immutable artifacts belonging to this deployment.
    #[serde(default)]
    pub artifacts: Vec<Artifact>,
}

impl DeploymentManifest {
    /// 执行严格来源校验。 / Performs strict provenance validation.
    pub fn validate(&self) -> DomainResult<()> {
        validate_uuid_v7(&self.deployment_id, "deployment_id")?;
        validate_non_empty(&self.service_name, "service_name")?;
        validate_non_empty(&self.service_version, "service_version")?;
        validate_non_empty(&self.git_ref, "git_ref")?;
        validate_non_empty(&self.ci_provider, "ci_provider")?;
        validate_non_empty(&self.ci_run_id, "ci_run_id")?;
        validate_git_oid(&self.git_commit)?;
        validate_sha256(&self.artifact_digest, "artifact_digest")?;
        let repository = Url::parse(&self.repository_url)
            .map_err(|_| DomainError::Validation("repository_url must be a valid URL".into()))?;
        if repository.scheme() != "https"
            || !repository.username().is_empty()
            || repository.password().is_some()
            || repository.query().is_some()
            || repository.fragment().is_some()
        {
            return Err(DomainError::Validation(
                "repository_url must be credential-free HTTPS without query or fragment".into(),
            ));
        }
        if self.region.is_empty() || self.region.iter().any(|region| region.trim().is_empty()) {
            return Err(DomainError::Validation(
                "region must contain only non-empty entries".into(),
            ));
        }
        let mut identities = BTreeSet::new();
        for artifact in &self.artifacts {
            artifact.validate()?;
            if !identities.insert((artifact.kind, artifact.file_name.as_str())) {
                return Err(DomainError::Validation(
                    "artifact kind and file_name must be unique per manifest".into(),
                ));
            }
        }
        Ok(())
    }

    /// 比较幂等 PUT：相等为重放，不等为冲突。 / Compares an idempotent PUT: equality is replay, inequality is conflict.
    pub fn ensure_same_registration(&self, submitted: &Self) -> DomainResult<()> {
        if self.deployment_id != submitted.deployment_id {
            return Err(DomainError::Validation(
                "cannot compare different deployment IDs".into(),
            ));
        }
        if self == submitted {
            Ok(())
        } else {
            Err(DomainError::Validation(
                "deployment_id is already bound to different immutable content".into(),
            ))
        }
    }
}

/// 运行时必须与 Manifest 匹配的 Resource Identity。 / Runtime Resource Identity that must match a Manifest.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResourceIdentity {
    /// `service.name`。 / `service.name`.
    pub service_name: String,
    /// `deployment.environment.name`。 / `deployment.environment.name`.
    pub environment: Environment,
    /// `service.version`。 / `service.version`.
    pub service_version: String,
    /// `moesegfault.deployment.id`。 / `moesegfault.deployment.id`.
    pub deployment_id: String,
    /// `moesegfault.build.revision`。 / `moesegfault.build.revision`.
    pub build_revision: String,
    /// `moesegfault.artifact.digest`。 / `moesegfault.artifact.digest`.
    pub artifact_digest: String,
}

impl ResourceIdentity {
    /// 校验运行时身份与注册 Deployment 完全一致。 / Validates exact correspondence between runtime identity and registered Deployment.
    pub fn validate_against(&self, manifest: &DeploymentManifest) -> DomainResult<()> {
        manifest.validate()?;
        if self.service_name != manifest.service_name
            || self.environment != manifest.environment
            || self.service_version != manifest.service_version
            || self.deployment_id != manifest.deployment_id
            || self.build_revision != manifest.git_commit
            || self.artifact_digest != manifest.artifact_digest
        {
            return Err(DomainError::Validation(
                "runtime Resource Identity does not match Deployment Manifest".into(),
            ));
        }
        Ok(())
    }
}

/// 后端无关遥测引用类别。 / Backend-neutral telemetry reference kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TelemetryKind {
    /// 单条 trace。 / A single trace.
    Trace,
    /// 结构化日志查询。 / Structured log query.
    LogQuery,
    /// Profile 查询或对象。 / Profile query or object.
    Profile,
    /// Metric 查询。 / Metric query.
    MetricQuery,
    /// 固定 commit 的源码位置。 / Source location fixed to a commit.
    Source,
    /// 不可变产物。 / Immutable artifact.
    Artifact,
}

/// 查询型引用的 UTC 时间范围。 / UTC time range for query references.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TimeRange {
    /// 包含起点。 / Inclusive start.
    pub start: DateTime<Utc>,
    /// 包含终点。 / Inclusive end.
    pub end: DateTime<Utc>,
}

/// 后端无关、结构化的证据引用。 / Backend-neutral, structured evidence reference.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TelemetryReference {
    /// UUIDv7 引用身份。 / UUIDv7 reference identity.
    pub id: String,
    /// 引用类别。 / Reference kind.
    pub kind: TelemetryKind,
    /// 后端 registry 名，不是 UI URL。 / Backend registry name, not a UI URL.
    pub backend: String,
    /// kind-specific 结构化定位器。 / Kind-specific structured locator.
    pub locator: BTreeMap<String, Value>,
    /// 查询型引用的时间范围。 / Time range for query references.
    pub time_range: Option<TimeRange>,
    /// 来源服务。 / Source service.
    pub service_name: String,
    /// 来源 deployment UUIDv7。 / Source deployment UUIDv7.
    pub deployment_id: String,
    /// 可选逻辑执行 UUIDv7。 / Optional logical-execution UUIDv7.
    pub correlation_id: Option<String>,
    /// 可选 W3C trace ID。 / Optional W3C trace ID.
    pub trace_id: Option<String>,
    /// 可选 W3C span ID。 / Optional W3C span ID.
    pub span_id: Option<String>,
    /// 后端证据可能过期的时刻。 / Instant at which backend evidence may expire.
    pub expires_at: Option<DateTime<Utc>>,
}

impl TelemetryReference {
    /// 校验结构化 locator、身份和条件必需字段。 / Validates structured locator, identities, and conditionally required fields.
    pub fn validate(&self) -> DomainResult<()> {
        validate_uuid_v7(&self.id, "telemetry_reference_id")?;
        validate_uuid_v7(&self.deployment_id, "deployment_id")?;
        validate_non_empty(&self.backend, "backend")?;
        validate_non_empty(&self.service_name, "service_name")?;
        if self.locator.is_empty()
            || self.locator.contains_key("url")
            || self.locator.contains_key("ui_url")
        {
            return Err(DomainError::Validation(
                "locator must be structured and must not be only a vendor UI URL".into(),
            ));
        }
        if matches!(
            self.kind,
            TelemetryKind::LogQuery | TelemetryKind::Profile | TelemetryKind::MetricQuery
        ) && self.time_range.is_none()
        {
            return Err(DomainError::Validation(
                "query telemetry references require time_range".into(),
            ));
        }
        if let Some(range) = &self.time_range {
            if range.end < range.start {
                return Err(DomainError::Validation(
                    "telemetry time_range end cannot precede start".into(),
                ));
            }
        }
        if let Some(id) = &self.correlation_id {
            validate_uuid_v7(id, "correlation_id")?;
        }
        if let Some(id) = &self.trace_id {
            validate_w3c_hex(id, 32, "trace_id")?;
        }
        if let Some(id) = &self.span_id {
            validate_w3c_hex(id, 16, "span_id")?;
            if self.trace_id.is_none() {
                return Err(DomainError::Validation("span_id requires trace_id".into()));
            }
        }
        if self.kind == TelemetryKind::Trace {
            let locator_trace = self
                .locator
                .get("trace_id")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    DomainError::Validation("trace reference requires locator.trace_id".into())
                })?;
            validate_w3c_hex(locator_trace, 32, "locator.trace_id")?;
            if self
                .trace_id
                .as_deref()
                .is_some_and(|id| id != locator_trace)
            {
                return Err(DomainError::Validation(
                    "trace_id must match locator.trace_id when present".into(),
                ));
            }
        }
        Ok(())
    }
}

/// 通用 validator 成功响应，便于 JSON bridge。 / Generic successful validator response for the JSON bridge.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Validation {
    /// 成功时恒为 true。 / Always true on success.
    pub valid: bool,
}

/// 校验 RFC 9562 UUIDv7 的规范小写文本形式。 / Validates canonical lowercase RFC 9562 UUIDv7 text.
pub fn validate_uuid_v7(value: &str, field: &str) -> DomainResult<()> {
    let id = Uuid::parse_str(value)
        .map_err(|_| DomainError::Validation(format!("{field} must be UUIDv7")))?;
    if id.get_version() != Some(Version::SortRand) || id.hyphenated().to_string() != value {
        return Err(DomainError::Validation(format!(
            "{field} must be canonical lowercase UUIDv7"
        )));
    }
    Ok(())
}

pub(crate) fn validate_w3c_hex(value: &str, len: usize, field: &str) -> DomainResult<()> {
    if value.len() != len
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        || value.bytes().all(|byte| byte == b'0')
    {
        return Err(DomainError::Validation(format!(
            "{field} must be {len} lowercase non-zero hex characters"
        )));
    }
    Ok(())
}

fn validate_sha256(value: &str, field: &str) -> DomainResult<()> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return Err(DomainError::Validation(format!(
            "{field} must use sha256:<hex>"
        )));
    };
    validate_hex(hex, 64, field)
}

fn validate_git_oid(value: &str) -> DomainResult<()> {
    if !matches!(value.len(), 40 | 64) {
        return Err(DomainError::Validation(
            "git_commit must be a full 40- or 64-character OID".into(),
        ));
    }
    validate_hex(value, value.len(), "git_commit")
}

fn validate_hex(value: &str, len: usize, field: &str) -> DomainResult<()> {
    if value.len() != len
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        Err(DomainError::Validation(format!(
            "{field} must contain {len} lowercase hex characters"
        )))
    } else {
        Ok(())
    }
}

fn validate_non_empty(value: &str, field: &str) -> DomainResult<()> {
    if value.trim().is_empty() {
        Err(DomainError::Validation(format!(
            "{field} must be non-empty"
        )))
    } else {
        Ok(())
    }
}

fn valid_file_name(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value.len() <= 255
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'.' | b'_' | b'+' | b'-'))
        })
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;
    use serde_json::json;

    use super::*;

    const V7: &str = "0199d09a-b692-7ce0-a1c0-5138a43d7402";

    fn manifest() -> DeploymentManifest {
        DeploymentManifest {
            deployment_id: V7.into(),
            service_name: "identity".into(),
            environment: Environment::Production,
            service_version: "1.2.3".into(),
            repository_url: "https://github.com/moesegfault/identity".into(),
            git_commit: "a".repeat(40),
            git_ref: "refs/tags/v1.2.3".into(),
            artifact_digest: format!("sha256:{}", "b".repeat(64)),
            ci_provider: "github-actions".into(),
            ci_run_id: "1234".into(),
            deployed_at: Utc.with_ymd_and_hms(2026, 9, 8, 15, 0, 0).unwrap(),
            region: vec!["global".into()],
            artifacts: vec![],
        }
    }

    #[test]
    fn valid_manifest_and_exact_runtime_identity_pass() {
        let manifest = manifest();
        manifest.validate().unwrap();
        ResourceIdentity {
            service_name: manifest.service_name.clone(),
            environment: manifest.environment,
            service_version: manifest.service_version.clone(),
            deployment_id: manifest.deployment_id.clone(),
            build_revision: manifest.git_commit.clone(),
            artifact_digest: manifest.artifact_digest.clone(),
        }
        .validate_against(&manifest)
        .unwrap();
    }

    #[test]
    fn reused_deployment_id_with_changed_content_conflicts() {
        let original = manifest();
        let mut changed = original.clone();
        changed.git_commit = "c".repeat(40);
        assert!(original.ensure_same_registration(&changed).is_err());
    }

    #[test]
    fn query_reference_requires_time_range_and_structured_locator() {
        let reference = TelemetryReference {
            id: "0199d0a8-2e12-7a59-a51e-44aa9b6d1001".into(),
            kind: TelemetryKind::MetricQuery,
            backend: "grafana-cloud".into(),
            locator: BTreeMap::from([("query".into(), json!("rate(http_requests_total[5m])"))]),
            time_range: None,
            service_name: "identity".into(),
            deployment_id: V7.into(),
            correlation_id: None,
            trace_id: None,
            span_id: None,
            expires_at: None,
        };
        assert!(reference.validate().is_err());
    }

    #[test]
    fn rejects_uuid_versions_other_than_v7() {
        assert!(validate_uuid_v7("627cc493-f310-47de-96bd-71410b7dec09", "id").is_err());
    }
}

//! 有限、不可伪造的证据构建器。 / Finite unforgeable evidence builders.
use crate::propagation::valid_hex;
use serde_json::{json, Value};
use status_domain::{
    ArtifactKind, DiagnosticEvidence, DomainError, DomainResult, TelemetryKind, TimeRange,
};
use std::collections::BTreeMap;

/// 仅安全构建器可以构造。 / Constructible only through safe builders.
#[derive(Clone, Debug)]
pub struct SafeDiagnosticEvidence(DiagnosticEvidence);
impl SafeDiagnosticEvidence {
    /// 只读领域引用。 / Read-only domain reference.
    pub fn evidence(&self) -> &DiagnosticEvidence {
        &self.0
    }
}
/// 有限查询标量。 / Finite query scalar.
#[derive(Clone, Debug)]
pub enum SafeQueryValue {
    /// 分类文本而非用户输入。 / Classified text, never user input.
    Text(String),
    /// 有限数值。 / Finite number.
    Number(f64),
    /// 布尔分类。 / Boolean classification.
    Bool(bool),
}
/// 日志查询的固定键。 / Fixed log query keys.
#[derive(Clone, Copy, Debug, Ord, PartialOrd, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LogQueryKey {
    /// 服务。 / Service.
    Service,
    /// 环境。 / Environment.
    Environment,
    /// 部署。 / Deployment.
    DeploymentId,
    /// Trace。 / Trace.
    TraceId,
    /// Span。 / Span.
    SpanId,
    /// 严重度。 / Severity.
    Severity,
    /// 操作。 / Operation.
    Operation,
    /// 组件。 / Component.
    Component,
    /// 错误类型。 / Error type.
    ErrorType,
}
/// Profile 查询固定键。 / Fixed profile query keys.
#[derive(Clone, Copy, Debug, Ord, PartialOrd, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProfileQueryKey {
    /// 服务。 / Service.
    Service,
    /// 环境。 / Environment.
    Environment,
    /// 部署。 / Deployment.
    DeploymentId,
    /// 区域。 / Region.
    Region,
    /// 实例。 / Instance.
    InstanceId,
}
/// Metric 查询固定键。 / Fixed metric query keys.
#[derive(Clone, Copy, Debug, Ord, PartialOrd, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MetricQueryKey {
    /// 服务。 / Service.
    Service,
    /// 环境。 / Environment.
    Environment,
    /// 部署。 / Deployment.
    DeploymentId,
    /// 区域。 / Region.
    Region,
    /// 操作。 / Operation.
    Operation,
    /// 组件。 / Component.
    Component,
    /// 依赖。 / Dependency.
    Dependency,
}
/// 有限 Profile 类别。 / Finite profile types.
#[derive(Clone, Copy, Debug, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProfileType {
    /// CPU。 / CPU.
    Cpu,
    /// 内存。 / Memory.
    Memory,
    /// 分配。 / Allocations.
    Allocations,
    /// 锁。 / Mutex.
    Mutex,
    /// Goroutine。 / Goroutine.
    Goroutine,
    /// 墙钟时间。 / Wall time.
    Wall,
}
fn key_name<T: serde::Serialize>(key: T) -> String {
    serde_json::to_value(key)
        .expect("enum serialization")
        .as_str()
        .expect("string enum")
        .to_owned()
}
fn query<K: serde::Serialize + Ord>(input: BTreeMap<K, SafeQueryValue>) -> DomainResult<Value> {
    if input.is_empty() {
        return Err(invalid("query requires a fixed key"));
    }
    let mut result = BTreeMap::new();
    for (key, value) in input {
        let value = match value {
            SafeQueryValue::Text(s) => json!(required(&s, 512)?),
            SafeQueryValue::Bool(b) => json!(b),
            SafeQueryValue::Number(n) if n.is_finite() => json!(n),
            _ => return Err(invalid("query number must be finite")),
        };
        result.insert(key_name(key), value);
    }
    Ok(json!(result))
}
fn make(
    kind: TelemetryKind,
    backend: &str,
    locator: Value,
    time_range: Option<TimeRange>,
) -> DomainResult<SafeDiagnosticEvidence> {
    if backend.len() > 64
        || !regex::Regex::new(r"^[a-z0-9]+(?:[._-][a-z0-9]+)*$")
            .expect("constant regex")
            .is_match(backend)
    {
        return Err(invalid("invalid backend registry name"));
    }
    let evidence = DiagnosticEvidence {
        kind,
        backend: backend.into(),
        locator: serde_json::from_value(locator)?,
        time_range,
    };
    evidence.validate()?;
    Ok(SafeDiagnosticEvidence(evidence))
}
/// 构建 Trace 定位器。 / Builds a trace locator.
pub fn trace_evidence(
    backend: &str,
    trace_id: &str,
    span_id: Option<&str>,
) -> DomainResult<SafeDiagnosticEvidence> {
    if !valid_hex(trace_id, 32)
        || trace_id.bytes().all(|b| b == b'0')
        || span_id.is_some_and(|s| !valid_hex(s, 16) || s.bytes().all(|b| b == b'0'))
    {
        return Err(invalid("invalid trace identity"));
    }
    let mut locator = json!({"trace_id":trace_id});
    if let Some(s) = span_id {
        locator["span_id"] = json!(s);
    }
    make(TelemetryKind::Trace, backend, locator, None)
}
/// 构建日志查询。 / Builds a log query.
pub fn log_query_evidence(
    backend: &str,
    values: BTreeMap<LogQueryKey, SafeQueryValue>,
    range: TimeRange,
) -> DomainResult<SafeDiagnosticEvidence> {
    make(
        TelemetryKind::LogQuery,
        backend,
        json!({"query":query(values)?}),
        Some(range),
    )
}
/// 构建 Profile 查询或对象引用。 / Builds a profile query or object reference.
pub fn profile_evidence(
    backend: &str,
    kind: ProfileType,
    id: Option<&str>,
    values: Option<BTreeMap<ProfileQueryKey, SafeQueryValue>>,
    range: TimeRange,
) -> DomainResult<SafeDiagnosticEvidence> {
    if id.is_none() && values.is_none() {
        return Err(invalid("profile requires ID or query"));
    }
    let mut locator = json!({"profile_type":key_name(kind)});
    if let Some(id) = id {
        locator["profile_id"] = json!(required(id, 256)?);
    }
    if let Some(q) = values {
        locator["query"] = query(q)?;
    }
    make(TelemetryKind::Profile, backend, locator, Some(range))
}
/// 构建指标查询。 / Builds a metric query.
pub fn metric_query_evidence(
    backend: &str,
    name: &str,
    values: BTreeMap<MetricQueryKey, SafeQueryValue>,
    range: TimeRange,
) -> DomainResult<SafeDiagnosticEvidence> {
    make(
        TelemetryKind::MetricQuery,
        backend,
        json!({"metric_name":required(name,255)?,"query":query(values)?}),
        Some(range),
    )
}
/// 构建固定 commit 的无凭据源码引用。 / Builds a credential-free commit-pinned source reference.
pub fn source_evidence(
    backend: &str,
    repository: &str,
    commit: &str,
    path: &str,
    line: Option<u32>,
    column: Option<u32>,
) -> DomainResult<SafeDiagnosticEvidence> {
    let url = url::Url::parse(repository).map_err(|_| invalid("invalid repository URL"))?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || sanitize_text(url.as_str(), 2048) != url.as_str()
    {
        return Err(invalid("repository must be safe HTTPS"));
    }
    if !(valid_hex(commit, 40) || valid_hex(commit, 64)) {
        return Err(invalid("commit must be full Git OID"));
    }
    let path = required(path, 1024)?;
    if path.starts_with('/')
        || path.split('/').any(|p| p == "..")
        || line
            .into_iter()
            .chain(column)
            .any(|n| n == 0 || n > 10_000_000)
    {
        return Err(invalid("invalid source position"));
    }
    let mut locator = json!({"repository_url":url.as_str(),"git_commit":commit,"path":path});
    if let Some(n) = line {
        locator["line"] = json!(n);
    }
    if let Some(n) = column {
        locator["column"] = json!(n);
    }
    make(TelemetryKind::Source, backend, locator, None)
}
/// 构建内容寻址产物引用。 / Builds a content-addressed artifact reference.
pub fn artifact_evidence(
    backend: &str,
    digest: &str,
    kind: ArtifactKind,
    build_id: Option<&str>,
) -> DomainResult<SafeDiagnosticEvidence> {
    if !digest
        .strip_prefix("sha256:")
        .is_some_and(|v| valid_hex(v, 64))
    {
        return Err(invalid("invalid artifact digest"));
    }
    let mut locator = json!({"artifact_digest":digest,"artifact_kind":kind});
    if let Some(id) = build_id {
        locator["build_id"] = json!(required(id, 256)?);
    }
    make(TelemetryKind::Artifact, backend, locator, None)
}
/// 清理常见凭据形态；不是通用秘密检测器。 / Scrubs common credential shapes, not arbitrary secrets.
pub(crate) fn sanitize_text(value: &str, limit: usize) -> String {
    use std::sync::OnceLock;
    static SECRET: OnceLock<regex::Regex> = OnceLock::new();
    static JWT: OnceLock<regex::Regex> = OnceLock::new();
    let secret=SECRET.get_or_init(||regex::Regex::new(r"(?i)\b(?:bearer|basic)\s+[a-z0-9._~+\-/]+=*|\b(?:password|passwd|secret|token|api[_-]?key|authorization|cookie)\s*[:=]\s*[^\s,;]+|\b[a-z][a-z0-9+.-]*://[^\s/@:]+:[^\s/@]+@").expect("constant regex"));
    let jwt = JWT.get_or_init(|| {
        regex::Regex::new(r"\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b")
            .expect("constant regex")
    });
    let first = secret.replace_all(value, "[REDACTED]");
    let clean = jwt.replace_all(&first, "[REDACTED]");
    if clean.encode_utf16().count() <= limit {
        return clean.into_owned();
    }
    let mut result = String::new();
    let mut units = 0;
    for c in clean.chars() {
        if units + c.len_utf16() >= limit {
            break;
        }
        units += c.len_utf16();
        result.push(c);
    }
    result.push('…');
    result
}
pub(crate) fn required(value: &str, limit: usize) -> DomainResult<String> {
    let s = sanitize_text(value, limit);
    if s.trim().is_empty() {
        Err(invalid("required text is empty"))
    } else {
        Ok(s)
    }
}
pub(crate) fn invalid(message: &str) -> DomainError {
    DomainError::Validation(message.into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn safe_locators_and_redaction() {
        assert!(source_evidence(
            "source",
            "https://a.example/?token=x",
            &"a".repeat(40),
            "a.rs",
            None,
            None
        )
        .is_err());
        assert!(artifact_evidence("r2", "sha256:bad", ArtifactKind::Other, None).is_err());
        assert_eq!(
            sanitize_text("Bearer abc token=xyz", 512),
            "[REDACTED] [REDACTED]"
        );
        assert!(trace_evidence("tempo", &"a".repeat(32), Some(&"0".repeat(16))).is_err());
    }
}

#[cfg(test)]
mod all_kinds_tests {
    use super::*;
    #[test]
    fn six_kinds_and_query_constraints() {
        let range = TimeRange {
            start: chrono::DateTime::from_timestamp_millis(0).unwrap(),
            end: chrono::DateTime::from_timestamp_millis(1).unwrap(),
        };
        let evidence = [
            trace_evidence("tempo", &"a".repeat(32), None).unwrap(),
            log_query_evidence(
                "logs",
                BTreeMap::from([(LogQueryKey::Service, SafeQueryValue::Text("api".into()))]),
                range.clone(),
            )
            .unwrap(),
            profile_evidence(
                "profiles",
                ProfileType::Cpu,
                Some("profile-1"),
                None,
                range.clone(),
            )
            .unwrap(),
            metric_query_evidence(
                "metrics",
                "latency",
                BTreeMap::from([(MetricQueryKey::Service, SafeQueryValue::Text("api".into()))]),
                range.clone(),
            )
            .unwrap(),
            source_evidence(
                "git",
                "https://example.com/repo",
                &"a".repeat(40),
                "src/lib.rs",
                Some(1),
                None,
            )
            .unwrap(),
            artifact_evidence(
                "r2",
                &format!("sha256:{}", "a".repeat(64)),
                ArtifactKind::Other,
                None,
            )
            .unwrap(),
        ];
        for e in evidence {
            e.evidence().validate().unwrap();
        }
        assert!(log_query_evidence("logs", BTreeMap::new(), range.clone()).is_err());
        assert!(profile_evidence("profiles", ProfileType::Cpu, None, None, range.clone()).is_err());
        assert!(metric_query_evidence(
            "metrics",
            "n",
            BTreeMap::from([(MetricQueryKey::Service, SafeQueryValue::Number(f64::NAN))]),
            range
        )
        .is_err());
    }
}

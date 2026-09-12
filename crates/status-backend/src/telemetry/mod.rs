//! invocation 局部遥测、严格字段白名单和共享采集预算；从不写入 D1。
//! Invocation-local telemetry, strict attribute allowlists and shared collection budgets; never writes D1.

mod context;
pub mod exporter;
#[cfg(target_arch = "wasm32")]
pub use context::create_correlation_id;
pub use context::{parse_tracestate, should_sample, TraceContext};
#[cfg(target_arch = "wasm32")]
mod platform;
#[cfg(target_arch = "wasm32")]
pub use platform::{for_invocation, for_service_invocation, with_span};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{cell::Cell, future::Future, rc::Rc};

/// 部署身份配置；不得使用虚构实例或版本。 / Deployment identity; fabricated instances or versions are forbidden.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Resource {
    /// 注册服务。 / Registered service.
    pub service: String,
    /// 注册环境。 / Registered environment.
    pub environment: String,
    /// 发布版本。 / Release version.
    pub version: String,
    /// 不可变 deployment ID。 / Immutable deployment ID.
    pub deployment: String,
    /// 完整 commit OID。 / Full commit OID.
    pub revision: String,
    /// 实际产物摘要。 / Actual artifact digest.
    pub digest: String,
}

impl Resource {
    /// 校验完整来源，不把局部调试当作主链路证据。 / Validate full provenance; local debugging is not primary evidence.
    pub fn validate(&self) -> bool {
        !self.service.is_empty()
            && self.service.len() <= 63
            && self.service.split('-').all(|s| {
                !s.is_empty()
                    && s.bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
            })
            && matches!(
                self.environment.as_str(),
                "development" | "test" | "staging" | "production"
            )
            && safe_identity_attribute("service.version", &self.version)
            && status_domain::validate_uuid_v7(&self.deployment, "deployment").is_ok()
            && (context::hex(&self.revision, 40) || context::hex(&self.revision, 64))
            && self
                .digest
                .strip_prefix("sha256:")
                .is_some_and(|s| context::hex(s, 64))
    }
    /// OpenTelemetry Resource 属性；不伪造 Workers instance ID。 / OpenTelemetry Resource attributes; no fake Workers instance ID.
    pub fn attributes(&self) -> Value {
        json!({"service.namespace":"moeSegFault", "service.name":self.service,
            "service.version":self.version, "deployment.environment.name":self.environment,
            "moesegfault.deployment.id":self.deployment,"moesegfault.build.revision":self.revision,
            "moesegfault.artifact.digest":self.digest,"cloud.provider":"cloudflare"})
    }
}

/// 可替换的非阻塞信号出口；false 代表丢弃。 / Replaceable nonblocking signal sink; false indicates a drop.
pub type Sink = Rc<dyn Fn(&Value) -> bool>;

/// 共享状态只属于一次 invocation，clone 不重置预算。 / Shared state belongs to one invocation; cloning never resets budgets.
#[derive(Clone)]
pub struct Telemetry {
    /// 不可变已验证来源。 / Immutable validated provenance.
    resource: Rc<Resource>,
    /// 原生 Analytics 出口。 / Native Analytics sink.
    metrics: Sink,
    /// 原生日志出口。 / Native log sink.
    logs: Sink,
    /// 已尝试写入量（失败同样消耗预算）。 / Attempted writes, including failures.
    attempts: Rc<Cell<u16>>,
    /// 可观察丢弃总数。 / Observable drop count.
    dropped: Rc<Cell<u64>>,
}

impl Telemetry {
    /// 构造单次调用门面；出口不得阻塞或 panic。 / Construct an invocation facade; sinks must not block or panic.
    pub fn new(resource: Resource, metrics: Sink, logs: Sink) -> Result<Self, &'static str> {
        if !resource.validate() {
            return Err("provenance_unavailable");
        }
        Ok(Self {
            resource: Rc::new(resource),
            metrics,
            logs,
            attempts: Rc::new(Cell::new(0)),
            dropped: Rc::new(Cell::new(0)),
        })
    }
    /// 返回来源身份。 / Return provenance identity.
    pub fn resource(&self) -> &Resource {
        &self.resource
    }
    /// 原生 span 的来源与外部执行引用；不声称可手动指定平台父 span。
    /// Native span provenance and external execution references; does not claim manual platform parenting.
    pub fn span_attributes(
        &self,
        operation: &str,
        correlation: Option<&str>,
        trace: Option<&TraceContext>,
    ) -> Value {
        let mut attributes = self.resource.attributes();
        attributes["operation.name"] = json!(operation);
        if let Some(id) = correlation {
            attributes["moesegfault.correlation.id"] = json!(id);
        }
        if let Some(trace) = trace {
            attributes["moesegfault.external.trace_id"] = json!(trace.trace_id);
            attributes["moesegfault.external.span_id"] = json!(trace.span_id);
        }
        safe_attributes(&attributes)
    }
    /// 丢弃总数；不递归写指标。 / Drop count; never recursively writes metrics.
    pub fn dropped(&self) -> u64 {
        self.dropped.get()
    }
    /// 写共享预算数据点。 / Write a data point under the shared budget.
    fn point(&self, point: Value) -> bool {
        if self.attempts.get() >= 250 {
            return self.drop_sample();
        }
        self.attempts.set(self.attempts.get() + 1);
        if !(self.metrics)(&point) {
            return self.drop_sample();
        }
        true
    }
    /// 记录丢弃而不再导出新点。 / Account for a drop without exporting another point.
    fn drop_sample(&self) -> bool {
        self.dropped.set(self.dropped.get().saturating_add(1));
        false
    }
    /// 固定位置 schema：name/kind/unit/service/environment/deployment/operation。 / Fixed positional schema for name/kind/unit/service/environment/deployment/operation.
    pub fn metric(&self, name: &str, value: f64, operation: &str, histogram: bool) -> bool {
        if !stable_token(name, 128)
            || !stable_token(operation, 64)
            || context::hex(operation, 32)
            || status_domain::validate_uuid_v7(operation, "dimension").is_ok()
            || !value.is_finite()
            || value < 0.0
        {
            return self.drop_sample();
        }
        self.point(json!({"blobs":[name,if histogram {"histogram"} else {"counter"}, if histogram {"ms"} else {"1"},self.resource.service,self.resource.environment,self.resource.deployment,format!("operation.name={operation}")],"doubles":[value],"indexes":[format!("{}:{}",self.resource.service,self.resource.environment)]}))
    }
    /// Gauge 可表达瞬时值，UpDownCounter 可表达负增量。 / Gauges express instantaneous values; UpDownCounter permits negative deltas.
    pub fn instrument(&self, name: &str, value: f64, kind: &str, unit: &str) -> bool {
        if !stable_token(name, 128)
            || !value.is_finite()
            || !matches!(kind, "counter" | "histogram" | "gauge" | "up_down_counter")
            || !matches!(unit, "1" | "ms" | "s" | "By" | "%")
            || (matches!(kind, "counter" | "histogram") && value < 0.0)
        {
            return self.drop_sample();
        }
        self.point(json!({"blobs":[name,kind,unit,self.resource.service,self.resource.environment,self.resource.deployment],"doubles":[value],"indexes":[format!("{}:{}",self.resource.service,self.resource.environment)]}))
    }
    /// Probe 原始样本只进入 AE，monitor ID 是样本查询键而非 metric label。 / Probe raw samples go only to AE; monitor ID is a sample query key, not a metric label.
    pub fn observation(
        &self,
        monitor_id: &str,
        outcome: &str,
        error: Option<&str>,
        runtime: &str,
        location: &str,
        latency: f64,
    ) -> bool {
        if ![
            monitor_id,
            outcome,
            error.unwrap_or("none"),
            runtime,
            location,
        ]
        .iter()
        .all(|s| stable_token(s, 128))
            || !latency.is_finite()
            || latency < 0.0
        {
            return self.drop_sample();
        }
        self.point(json!({"blobs":["probe.observation",monitor_id,outcome,error.unwrap_or("none"),runtime,location,self.resource.deployment],"doubles":[latency],"indexes":[format!("{}:{}",self.resource.service,self.resource.environment)]}))
    }
    /// 记录安全 OTel 日志；正文固定为事件名，任意正文与秘密无法进入。 / Emit safe OTel logs; body is the event name, preventing arbitrary bodies and secrets.
    pub fn event(
        &self,
        name: &str,
        error: bool,
        attributes: Value,
        correlation: Option<&str>,
        trace: Option<&TraceContext>,
    ) {
        self.log(
            name,
            if error {
                exporter::Priority::Error
            } else {
                exporter::Priority::Info
            },
            attributes,
            correlation,
            trace,
        );
    }
    /// 完整 OTel 严重级别，TRACE 默认不导出。 / Full OTel severity range; TRACE is not exported by default.
    pub fn log(
        &self,
        name: &str,
        priority: exporter::Priority,
        attributes: Value,
        correlation: Option<&str>,
        trace: Option<&TraceContext>,
    ) {
        use exporter::Priority;
        let (number, severity) = match priority {
            Priority::Trace => return,
            Priority::Debug => (5, "DEBUG"),
            Priority::Info => (9, "INFO"),
            Priority::Warn => (13, "WARN"),
            Priority::Error => (17, "ERROR"),
            Priority::Fatal => (21, "FATAL"),
        };
        if !stable_token(name, 128) || name.split('.').count() < 3 {
            return;
        }
        let mut attrs = safe_attributes(&attributes);
        if let Some(id) =
            correlation.filter(|s| status_domain::validate_uuid_v7(s, "correlation").is_ok())
        {
            attrs["moesegfault.correlation.id"] = json!(id);
        }
        let timestamp = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(now_ms() as i64)
            .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
            .unwrap_or_default();
        let mut record = json!({"Timestamp":timestamp,"ObservedTimestamp":timestamp,"SeverityNumber":number,"SeverityText":severity,"Resource":self.resource.attributes(),"InstrumentationScope":{"name":"moesegfault-status-rust","version":self.resource.version},"EventName":name,"Body":name,"Attributes":attrs});
        if let Some(trace) = trace.filter(|t| TraceContext::parse(&t.traceparent()).is_some()) {
            record["TraceId"] = json!(trace.trace_id);
            record["SpanId"] = json!(trace.span_id);
            record["TraceFlags"] = json!(trace.trace_flags);
        }
        (self.logs)(&record);
    }
    /// 汇总丢弃一次；调用入口完成时使用。 / Report drop totals once at invocation completion.
    pub fn report_drops(&self) {
        if self.dropped() > 0 {
            self.log(
                "status.analytics.samples_dropped",
                exporter::Priority::Warn,
                json!({"analytics.sample.dropped":self.dropped()}),
                None,
                None,
            );
        }
    }
    /// 观察操作但保持原始业务结果及错误，不导出异常内容。 / Observe an operation while preserving its result and error, never exporting exception contents.
    pub async fn observed<T, E>(
        &self,
        operation: &'static str,
        future: impl Future<Output = Result<T, E>>,
    ) -> Result<T, E> {
        let start = now_ms();
        let result = future.await;
        self.metric(
            &format!("{operation}.duration"),
            (now_ms() - start).max(0.0),
            operation,
            true,
        );
        if result.is_err() {
            self.metric(&format!("{operation}.failure"), 1.0, operation, false);
        }
        result
    }
    /// HTTP 4xx 不自动作为服务错误。 / HTTP 4xx is not automatically a service failure.
    pub fn http(&self, status: u16, started: f64, correlation: &str, trace: Option<&TraceContext>) {
        self.metric("http.server.request.count", 1.0, "http", false);
        self.metric(
            "http.server.request.duration",
            (now_ms() - started).max(0.0),
            "http",
            true,
        );
        if status >= 500 {
            self.metric("http.server.request.failure", 1.0, "http", false);
        }
        self.event(
            "status.request.completed",
            status >= 500,
            json!({"http.response.status_code":status}),
            Some(correlation),
            trace,
        );
    }
}

/// 低基数分类 token；拒绝 URL、空格和任意自由文本。 / Low-cardinality classification token; reject URLs, whitespace and arbitrary text.
pub fn stable_token(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

/// 显式字段与标量白名单；永不递归复制输入对象。 / Explicit scalar/field allowlist; never recursively copies input objects.
pub fn safe_attributes(value: &Value) -> Value {
    let mut result = serde_json::Map::new();
    if let Some(object) = value.as_object() {
        for (key, value) in object {
            if value
                .as_str()
                .is_some_and(|s| safe_identity_attribute(key, s))
            {
                result.insert(key.clone(), value.clone());
                continue;
            }
            if key == "moesegfault.correlation.id"
                && value
                    .as_str()
                    .is_some_and(|s| status_domain::validate_uuid_v7(s, "correlation").is_ok())
            {
                result.insert(key.clone(), value.clone());
                continue;
            }
            if !matches!(
                key.as_str(),
                "operation.name"
                    | "outcome"
                    | "http.response.status_code"
                    | "error.type"
                    | "queue.batch.size"
                    | "analytics.sample.dropped"
                    | "before.revision"
                    | "after.revision"
                    | "audit.action"
                    | "audit.target.type"
                    | "failure.stage"
            ) {
                continue;
            }
            if value.is_number()
                || value.is_boolean()
                || value.as_str().is_some_and(|s| stable_token(s, 128))
            {
                result.insert(key.clone(), value.clone());
            }
        }
    }
    Value::Object(result)
}

/// 来源及外部 trace 引用单独校验，不能借白名单夹带自由文本。 / Validate provenance and external trace references separately, never admitting arbitrary text.
fn safe_identity_attribute(key: &str, value: &str) -> bool {
    match key {
        "service.namespace" => value == "moeSegFault",
        "service.name" => {
            value.len() <= 63
                && !value.is_empty()
                && value.split('-').all(|s| {
                    !s.is_empty()
                        && s.bytes()
                            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
                })
        }
        "service.version" => {
            !value.is_empty()
                && value.len() <= 128
                && value
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._-+".contains(&b))
        }
        "deployment.environment.name" => {
            matches!(value, "development" | "test" | "staging" | "production")
        }
        "moesegfault.deployment.id" => status_domain::validate_uuid_v7(value, "deployment").is_ok(),
        "moesegfault.build.revision" => context::hex(value, 40) || context::hex(value, 64),
        "moesegfault.artifact.digest" => value
            .strip_prefix("sha256:")
            .is_some_and(|s| context::hex(s, 64)),
        "cloud.provider" => value == "cloudflare",
        "moesegfault.external.trace_id" => {
            context::hex(value, 32) && value.bytes().any(|b| b != b'0')
        }
        "moesegfault.external.span_id" => {
            context::hex(value, 16) && value.bytes().any(|b| b != b'0')
        }
        _ => false,
    }
}

/// 保守清理不可信摘要，秘密模式出现时整段删去，不尝试恢复敏感片段。
/// Conservatively scrub untrusted summaries; redact the entire text on secret patterns rather than reconstructing sensitive fragments.
pub fn sanitize_text(value: &str, maximum: usize) -> String {
    let lower = value.to_ascii_lowercase();
    if [
        "bearer ",
        "authorization",
        "password",
        "passwd",
        "api_key",
        "api-key",
        "apikey",
        "access_token",
        "access-token",
        "secret",
        "cookie",
        "private key",
        "token=",
    ]
    .iter()
    .any(|s| lower.contains(s))
        || value
            .split_whitespace()
            .any(|s| s.contains("://") && s.contains('@'))
    {
        return "[REDACTED]".chars().take(maximum).collect();
    }
    let mut used = 0;
    value
        .chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .take_while(|c| {
            used += c.len_utf16();
            used <= maximum
        })
        .collect()
}

/// 平台时间，测试宿主使用 SystemTime。 / Platform time; native tests use SystemTime.
pub fn now_ms() -> f64 {
    #[cfg(target_arch = "wasm32")]
    {
        js_sys::Date::now()
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0.0, |d| d.as_secs_f64() * 1000.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn resource() -> Resource {
        Resource {
            service: "status".into(),
            environment: "test".into(),
            version: "1".into(),
            deployment: "0199d09a-b692-7ce0-a1c0-5138a43d7402".into(),
            revision: "a".repeat(40),
            digest: format!("sha256:{}", "b".repeat(64)),
        }
    }
    #[test]
    fn budget_is_shared_and_failures_count() {
        let telemetry = Telemetry::new(resource(), Rc::new(|_| false), Rc::new(|_| true)).unwrap();
        let child = telemetry.clone();
        for _ in 0..251 {
            child.metric("queue.count", 1.0, "queue", false);
        }
        assert_eq!(telemetry.attempts.get(), 250);
        assert_eq!(telemetry.dropped(), 251);
    }
    #[test]
    fn rejects_secrets_and_fake_provenance() {
        let safe = safe_attributes(
            &json!({"authorization":"Bearer secret","sql":"select secret","error.type":"https://secret","operation.name":"d1.query","after.revision":2}),
        );
        assert_eq!(
            safe,
            json!({"operation.name":"d1.query","after.revision":2})
        );
        let mut r = resource();
        r.revision = "main".into();
        assert!(!r.validate());
    }
    #[test]
    fn all_instruments_enforce_semantics() {
        let t = Telemetry::new(resource(), Rc::new(|_| true), Rc::new(|_| true)).unwrap();
        assert!(t.instrument("queue.depth", -1.0, "up_down_counter", "1"));
        assert!(!t.instrument("queue.depth", -1.0, "counter", "1"));
        assert!(!t.metric("latency", f64::NAN, "http", true));
        assert!(!t.metric("latency", 1.0, "https://secret", true));
    }
    #[test]
    fn logs_keep_context_without_private_fields_and_utf16_is_bounded() {
        let records = Rc::new(std::cell::RefCell::new(Vec::new()));
        let captured = records.clone();
        let t = Telemetry::new(
            resource(),
            Rc::new(|_| true),
            Rc::new(move |v| {
                captured.borrow_mut().push(v.clone());
                true
            }),
        )
        .unwrap();
        let trace =
            TraceContext::parse("00-0123456789abcdef0123456789abcdef-0123456789abcdef-01").unwrap();
        t.event("status.audit.committed",false,json!({"audit.action":"incident.update","authorization":"Bearer sensitive","before.revision":1,"after.revision":2}),Some(&resource().deployment),Some(&trace));
        let log = &records.borrow()[0];
        assert_eq!(log["TraceId"], trace.trace_id);
        assert!(log["Attributes"].get("authorization").is_none());
        assert_eq!(log["Attributes"]["after.revision"], 2);
        assert!(log["Timestamp"].as_str().unwrap().ends_with('Z'));
        assert_eq!(sanitize_text("😀😀x", 3), "😀");
        assert_eq!(sanitize_text("password=hunter2", 512), "[REDACTED]");
        assert!(!t.metric("counter", 1.0, &resource().deployment, false));
    }
}

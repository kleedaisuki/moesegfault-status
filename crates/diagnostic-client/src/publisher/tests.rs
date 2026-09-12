//! 原生发布器状态机测试；不把模拟传输当作平台证明。
//! Native publisher state-machine tests; mock transport is not platform evidence.
use super::*;
use crate::builder::DiagnosticEventInput;
use serde_json::json;
use std::cell::Cell;
/// 确定性可记录传输。 / Deterministic recording transport.
struct Mock {
    clock: Cell<u64>,
    outcomes: RefCell<VecDeque<Attempt>>,
    bodies: RefCell<Vec<Vec<u8>>>,
}
impl Transport for Mock {
    fn attempt(
        &self,
        _endpoint: Url,
        event: PreparedDiagnostic,
        _timeout: u64,
    ) -> LocalBoxFuture<'static, Attempt> {
        self.bodies.borrow_mut().push(event.bytes().to_vec());
        let result = self
            .outcomes
            .borrow_mut()
            .pop_front()
            .unwrap_or(Attempt::Accepted);
        async move { result }.boxed_local()
    }
    fn sleep(&self, millis: u64) -> LocalBoxFuture<'static, ()> {
        self.clock.set(self.clock.get() + millis);
        async {}.boxed_local()
    }
    fn now_millis(&self) -> u64 {
        self.clock.get()
    }
}
/// 完整部署fixture，不伪造prepared对象。 / Full deployment fixture, never a forged prepared object.
fn builder() -> DiagnosticEventBuilder {
    let manifest:status_domain::DeploymentManifest=serde_json::from_value(json!({"deployment_id":"0199d0a8-2e12-7a59-a51e-000000000001","service_name":"api","environment":"production","service_version":"1","repository_url":"https://github.com/example/repo","git_commit":"c".repeat(40),"git_ref":"main","artifact_digest":format!("sha256:{}","a".repeat(64)),"ci_provider":"github","ci_run_id":"1","deployed_at":"2026-09-12T00:00:00Z","region":["global"],"artifacts":[{"kind":"other","artifact_digest":format!("sha256:{}","a".repeat(64)),"size_bytes":1,"file_name":"app.wasm","media_type":"application/wasm"}]})).unwrap();
    DiagnosticEventBuilder::from_manifest(&manifest).unwrap()
}
/// 最小故障输入。 / Minimal fault input.
fn event(builder: &DiagnosticEventBuilder) -> PreparedDiagnostic {
    builder
        .fault(DiagnosticEventInput {
            kind: "dependency.failure".into(),
            severity: status_domain::DiagnosticSeverity::Error,
            summary: "Dependency failed".into(),
            fingerprint: [("dependency".into(), "database".into())].into(),
            attributes: Default::default(),
            evidence: vec![],
            propagation: None,
            occurred_at: None,
            instance_id: None,
        })
        .unwrap()
}
/// 独立内存transport与客户端。 / Independent in-memory transport and client.
fn client(outcomes: Vec<Attempt>) -> (DiagnosticClient, Rc<Mock>) {
    let transport = Rc::new(Mock {
        clock: Cell::new(1000),
        outcomes: RefCell::new(outcomes.into()),
        bodies: RefCell::new(vec![]),
    });
    let mut options = Options::new("https://status.example/v1/diagnostic-events");
    options.capacity = 2;
    options.base_backoff_ms = 1;
    options.max_backoff_ms = 1;
    (
        DiagnosticClient::new(builder(), options, transport.clone()).unwrap(),
        transport,
    )
}
#[test]
fn retries_identical_bytes_and_coalesces_flush() {
    let (client, transport) = client(vec![Attempt::Retry, Attempt::Accepted]);
    let event = event(client.builder());
    assert!(client.publish(event).unwrap());
    let first = client.flush();
    let second = client.flush();
    let (a, b) = futures_executor::block_on(futures_util::future::join(first, second));
    assert_eq!(a, b);
    assert_eq!(a.published, 1);
    assert_eq!(a.failed_attempts, 1);
    let bodies = transport.bodies.borrow();
    assert_eq!(bodies.len(), 2);
    assert_eq!(bodies[0], bodies[1]);
}
#[test]
fn preserves_head_after_timeout_round_and_honors_backoff() {
    let (client, transport) = client(vec![Attempt::Timeout; 3]);
    client.publish(event(client.builder())).unwrap();
    let stats = futures_executor::block_on(client.flush());
    assert_eq!(stats.depth, 1);
    assert_eq!(stats.timeouts, 3);
    assert_eq!(stats.consecutive_failures, 1);
    assert_eq!(futures_executor::block_on(client.flush()), stats);
    transport.clock.set(2000);
    let stats = futures_executor::block_on(client.flush());
    assert_eq!(stats.depth, 0);
    assert_eq!(stats.published, 1);
}
#[test]
fn bounds_capacity_and_drops_only_permanent_rejections() {
    let (client, _) = client(vec![Attempt::Rejected, Attempt::Accepted]);
    for _ in 0..2 {
        assert!(client.publish(event(client.builder())).unwrap());
    }
    assert!(!client.publish(event(client.builder())).unwrap());
    let stats = futures_executor::block_on(client.flush());
    assert_eq!(stats.dropped, 2);
    assert_eq!(stats.published, 1);
    assert_eq!(stats.depth, 0);
}
#[test]
fn cancelled_unpolled_flush_does_not_leak_or_consume_head() {
    let (client, transport) = client(vec![]);
    client.publish(event(client.builder())).unwrap();
    drop(client.flush());
    assert!(transport.bodies.borrow().is_empty());
    assert_eq!(futures_executor::block_on(client.flush()).published, 1);
}
#[test]
fn validates_endpoint_limits_and_auth_retry_classification() {
    for endpoint in [
        "http://status.example/v1/diagnostic-events",
        "https://secret@status.example/v1/diagnostic-events",
        "https://status.example/wrong",
        "https://status.example/v1/diagnostic-events?token=x",
        "https://status.example/v1/diagnostic-events#x",
    ] {
        assert!(Options::new(endpoint).validate().is_err());
    }
    assert!(!permanent_status(401));
    assert!(!permanent_status(403));
    assert!(!permanent_status(429));
    assert!(permanent_status(422));
    let mut options = Options::new("https://status.example/v1/diagnostic-events");
    options.capacity = 0;
    assert!(options.validate().is_err());
}

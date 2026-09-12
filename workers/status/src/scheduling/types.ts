/** 主动探针类型。 / Supported active probe kinds. */
export type ProbeKind = "http" | "tcp" | "dns" | "rpc" | "synthetic";

/** 状态目标；组件和服务使用同一个调度路径。 / Status target shared by services and components. */
export interface StatusTarget {
  /** 目标种类。 / Target kind. */
  readonly type: "service" | "component";
  /** 稳定目标身份。 / Stable target identity. */
  readonly id: string;
  /** 归属服务名。 / Owning service name. */
  readonly serviceName: string;
}

/** HTTP 探针配置；只允许无副作用的 GET/HEAD。 / HTTP probe configuration restricted to side-effect-free GET/HEAD. */
export interface HttpProbeSpec {
  readonly kind: "http";
  readonly url: string;
  readonly method?: "GET" | "HEAD";
  readonly expectedStatuses?: readonly number[];
  readonly maxRedirects?: number;
}

/** TCP 连接探针配置。 / TCP connect probe configuration. */
export interface TcpProbeSpec {
  readonly kind: "tcp";
  readonly hostname: string;
  readonly port: number;
}

/** DNS 探针配置。 / DNS probe configuration. */
export interface DnsProbeSpec {
  readonly kind: "dns";
  readonly hostname: string;
  readonly recordType: "A" | "AAAA";
}

/** 可信 Service Binding RPC 探针；不存在 URL 或任意代码入口。 / Trusted Service Binding RPC probe with no URL or code entry point. */
export interface RpcProbeSpec {
  readonly kind: "rpc";
  readonly binding: string;
  readonly operation: string;
}

/** 可信合成场景绑定；scenario 是标识符而非脚本。 / Trusted synthetic binding; scenario is an identifier, never a script. */
export interface SyntheticProbeSpec {
  readonly kind: "synthetic";
  readonly binding: string;
  readonly scenario: string;
}

/** 可执行探针配置的判别联合。 / Discriminated union of executable probe specifications. */
export type ProbeSpec =
  | HttpProbeSpec
  | TcpProbeSpec
  | DnsProbeSpec
  | RpcProbeSpec
  | SyntheticProbeSpec;

/** 固定修订的评估策略。 / Immutable evaluation-policy revision. */
export interface EvaluationPolicy {
  readonly policyId: string;
  readonly revision: number;
  readonly observationWindowMs: number;
  readonly minimumSamples: number;
  readonly failureThreshold: number;
  readonly recoveryThreshold: number;
  readonly latencyThresholdMs: number | null;
  readonly staleAfterMs: number;
  readonly locationQuorum: number;
  readonly fingerprintTemplate: Readonly<Record<string, unknown>>;
  readonly statusMapping: Readonly<Record<string, unknown>>;
}

/** 已由 D1 原子领取的到期监控。 / Due monitor atomically leased from D1. */
export interface ClaimedMonitor {
  /** 启用的逻辑执行位置。 / Enabled logical executor locations. */
  readonly locations: readonly string[];
  /** 领取后的 monitor revision，用于配置并发保护。 / Post-claim monitor revision guarding concurrent configuration edits. */
  readonly claimRevision?: number;
  readonly monitorId: string;
  readonly target: StatusTarget;
  readonly probe: ProbeSpec;
  readonly timeoutMs: number;
  readonly intervalMs: number;
  /** 本轮原计划时间，用于稳定幂等身份。 / Original due time used for stable idempotency identity. */
  readonly scheduledFor: string;
  readonly nextRunAt: string;
  readonly critical: boolean;
  readonly policy: EvaluationPolicy;
  /** 探针生成 Diagnostic 时所绑定的真实部署。 / Actual deployment provenance for probe-generated Diagnostics. */
  readonly deploymentId?: string;
  readonly environment?: "development" | "test" | "staging" | "production";
}

/** 实际执行来源；绝不把期望 locations 伪装为真实执行点。 / Actual execution provenance; desired locations are never presented as observed locations. */
export interface ExecutionProvenance {
  readonly runtime: "cloudflare-worker";
  /** 仅在平台提供可信元数据时填写。 / Present only when trusted platform metadata is available. */
  readonly location?: string;
  /** 受信执行器身份。 / Trusted executor identity. */
  readonly executorId?: string;
  /** 平台证明的实际机房。 / Platform-attested actual colo. */
  readonly actualColo?: string;
}

/** 单次主动探针结果。 / Result of one active probe. */
export interface Observation {
  readonly observationId: string;
  readonly monitorId: string;
  readonly observedAt: string;
  readonly execution: ExecutionProvenance;
  readonly outcome: "success" | "failure" | "timeout" | "invalid";
  readonly latencyMs: number;
  readonly protocolStatus: string | null;
  readonly errorType: string | null;
  readonly correlationId: string;
}

/** D1 中唯一保留的有界聚合检查点；不包含原始 Observation 列表。 / Bounded aggregate checkpoint retained in D1; it contains no raw Observation list. */
export interface MonitorCheckpoint {
  readonly monitorId: string;
  readonly location: string;
  /** 此窗口的受信执行器与真实机房。 / Trusted executor and actual colo of this window. */
  readonly executorId?: string;
  readonly actualColo?: string;
  readonly windowStartedAt: string;
  readonly lastObservedAt: string;
  readonly consecutiveSuccesses: number;
  readonly consecutiveFailures: number;
  readonly windowSamples: number;
  /** 失败、超时、非法或超延迟样本的去重并集。 / Deduplicated union of failed, timed-out, invalid, or slow samples. */
  readonly windowUnhealthySamples: number;
  readonly windowLatencyP95Ms: number | null;
  readonly evaluationStatus:
    "operational" | "degraded" | "partial_outage" | "major_outage" | "unknown";
  readonly evaluatedAt: string;
  readonly freshUntil: string;
  readonly policyId: string;
  readonly policyRevision: number;
  readonly revision: number;
}

/** Rust `evaluate_monitor` 的显式输入。 / Explicit input to Rust `evaluate_monitor`. */
export interface MonitorEvaluationInput {
  readonly monitor: ClaimedMonitor;
  readonly previous: MonitorCheckpoint | null;
  /** 其他真实执行位置的聚合检查点；绝不由期望 locations 合成。 / Aggregate checkpoints from other actual execution locations; desired locations are never synthesized. */
  readonly peerCheckpoints: readonly MonitorCheckpoint[];
  readonly observation: Observation;
}

/** Rust 评估结果；窗口仅返回聚合统计。 / Rust evaluation result containing aggregate window statistics only. */
export interface MonitorEvaluationResult {
  readonly checkpoint: MonitorCheckpoint;
  /** 可选诊断严重度；仅失败策略命中时存在。 / Optional Diagnostic severity emitted only when policy conditions match. */
  readonly diagnosticSeverity?: "info" | "warning" | "error" | "critical";
  readonly diagnosticKind?: string;
  readonly diagnosticSummary?: string;
}

/** Rust/Wasm 调度边界。 / Rust/Wasm dispatch boundary. */
export interface RustDispatcher {
  /** 执行一个纯领域命令。 / Execute one pure domain command. */
  dispatchJson(requestJson: string): string;
}

/** Monitor evaluator adapter。 / Adapter for the monitor evaluator. */
export interface MonitorEvaluator {
  /** 必须调用 Rust `evaluate_monitor`，不得在 TS 中复制状态机。 / Must call Rust `evaluate_monitor`; TypeScript must not duplicate the state machine. */
  evaluate(input: MonitorEvaluationInput): Promise<MonitorEvaluationResult>;
  /** 同轮先累积全部窗口，再执行一次区域仲裁。 / Fold all run windows before one regional quorum evaluation. */
  evaluateBatch?(
    monitor: ClaimedMonitor,
    previous: readonly MonitorCheckpoint[],
    observations: readonly Observation[],
  ): Promise<readonly MonitorEvaluationResult[]>;
}

/** Analytics Engine 的最小写入边界。 / Minimal Analytics Engine write boundary. */
export interface ObservationSink {
  /** 写入一次高频原始 Observation；D1 不接收该原始样本。 / Write one high-frequency raw Observation; D1 never receives it. */
  write(observation: Observation): void | Promise<void>;
}

/** 由健康评估产生并交给共享诊断聚合器的信封。 / Envelope generated by health evaluation and passed to the shared diagnostic aggregator. */
export interface HealthDiagnosticEnvelope {
  readonly schema_version: "1.0";
  readonly message_id: string;
  readonly event: {
    readonly event_id: string;
    readonly schema_version: "1.0";
    readonly kind: string;
    readonly severity: "info" | "warning" | "error" | "critical";
    readonly service_name: string;
    readonly environment: "development" | "test" | "staging" | "production";
    readonly deployment_id: string;
    readonly occurred_at: string;
    readonly correlation_id: string;
    readonly summary: string;
    readonly fingerprint: Readonly<Record<string, string>>;
    readonly evidence: readonly Readonly<Record<string, unknown>>[];
    readonly attributes: Readonly<Record<string, unknown>>;
  };
  readonly received_at: string;
  readonly origin: { readonly kind: "monitor"; readonly monitor_id: string };
  readonly producer: {
    readonly subject: "status-scheduler";
    readonly service_name: string;
    readonly environment: "development" | "test" | "staging" | "production";
    readonly deployment_id: string;
    readonly scopes: readonly ["diagnostics:write"];
    readonly token_id: string;
    readonly auth_method: "service_binding";
  };
  readonly trace_context: { readonly correlation_id: string };
}

/** 与 Queue consumer 共用的诊断聚合函数边界。 / Boundary of the exact Diagnostic aggregator shared with the Queue consumer. */
export interface DiagnosticAggregator {
  /** 实现应直接委托 `processDiagnosticEnvelope`。 / Implementations must directly delegate to `processDiagnosticEnvelope`. */
  process(
    envelope: HealthDiagnosticEnvelope,
  ): Promise<"processed" | "duplicate">;
}

/** 并发和租约边界。 / Concurrency and lease limits. */
export interface SchedulerLimits {
  readonly globalConcurrency: number;
  readonly perTargetConcurrency: number;
  readonly monitorBatchSize: number;
  readonly outboxBatchSize: number;
  readonly invocationDeadlineMs: number;
  readonly leaseMs: number;
}

/** 调度运行摘要，便于结构化日志与测试。 / Scheduler run summary for structured logs and tests. */
export interface SchedulerSummary {
  readonly claimed: number;
  readonly probed: number;
  readonly failed: number;
  readonly timedOut: number;
  readonly diagnostics: number;
  readonly outboxDelivered: number;
  readonly outboxRetried: number;
  readonly occurrencesPurged: number;
  readonly invocationTimedOut: boolean;
}

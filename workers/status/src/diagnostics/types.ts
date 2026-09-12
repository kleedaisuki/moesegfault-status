import type { Telemetry } from "@moesegfault/telemetry";
import type {
  DiagnosticEvent,
  DiagnosticQueueEnvelope,
} from "@moesegfault/contracts";

/**
 * 已由公共认证层验证的机器主体。 / Machine principal verified by the shared authentication layer.
 *
 * 集合表达 token 可能授权多个服务/环境；队列信封只保存本次请求已匹配的单个值。
 * Sets express the token's authorization bounds; the queue envelope stores only
 * the single service and environment matched for this request.
 */
export interface MachinePrincipal {
  /** 稳定的发行方主体。 / Stable issuer subject. */
  readonly subject: string;
  /** 允许的服务名。 / Authorized service names. */
  readonly serviceNames: ReadonlySet<string>;
  /** 允许的部署环境。 / Authorized deployment environments. */
  readonly environments: ReadonlySet<string>;
  /** 可选的部署身份约束。 / Optional deployment identity restriction. */
  readonly deploymentIds: ReadonlySet<string>;
  /** 已核验的 OAuth-style scopes。 / Verified OAuth-style scopes. */
  readonly scopes: ReadonlySet<string>;
  /** 唯一 token ID，用于证据来源而非授权。 / Unique token ID for provenance, never authorization. */
  readonly tokenId: string;
  /** 已验证的认证方式。 / Verified authentication mechanism. */
  readonly authMethod: "jwt" | "service_binding" | "mtls";
}

/**
 * 进入队列前的请求上下文。 / Request context captured before queue publication.
 */
export interface DiagnosticIngestContext {
  /** 由信任边界生成或验证的关联 ID。 / Correlation ID established at the trust boundary. */
  readonly correlationId: string;
  /** 已校验的 W3C traceparent。 / Validated W3C traceparent. */
  readonly traceparent?: string;
  /** 已校验的 W3C tracestate。 / Validated W3C tracestate. */
  readonly tracestate?: string;
  /** 可测试的时钟；生产环境应省略。 / Testable clock; omit in production. */
  readonly now?: () => Date;
}

/** Cloudflare Queue 发送所需的最小契约。 / Minimal Cloudflare Queue send contract. */
export interface QueueSender<T> {
  /** 发送一条不可变消息。 / Send one immutable message. */
  send(message: T, options?: { contentType?: "json" }): Promise<void>;
}

/** Diagnostic ingest 仅需队列，不得绑定 D1。 / Diagnostic ingest needs only a queue and must not bind D1. */
export interface DiagnosticIngestEnv {
  /** Diagnostic 主队列。 / Primary diagnostic queue. */
  readonly DIAGNOSTIC_QUEUE: QueueSender<DiagnosticQueueEnvelope>;
}

/** D1 prepared statement 的最小子集。 / Minimal subset of a D1 prepared statement. */
export interface D1StatementLike {
  /** 绑定参数并返回新语句。 / Bind parameters and return a statement. */
  bind(...values: unknown[]): D1StatementLike;
}

/** D1 batch 结果的最小子集。 / Minimal subset of a D1 batch result. */
export interface D1ResultLike {
  /** 查询返回的行。 / Rows returned by the statement. */
  readonly results?: unknown[];
  /** 执行元数据。 / Execution metadata. */
  readonly meta?: { readonly changes?: number };
  /** 语句是否成功。 / Whether the statement succeeded. */
  readonly success?: boolean;
}

/** D1 的原子 batch 契约。 / D1 atomic batch contract. */
export interface D1DatabaseLike {
  /** 准备 SQL。 / Prepare SQL. */
  prepare(sql: string): D1StatementLike;
  /** 在单个事务中执行所有语句。 / Execute all statements in one transaction. */
  batch(statements: D1StatementLike[]): Promise<D1ResultLike[]>;
}

/** Rust/Wasm 领域核心的 JSON 调度边界。 / JSON dispatch boundary of the Rust/Wasm domain core. */
export interface DiagnosticDomainCore {
  /** 调用一个纯领域操作。 / Invoke one pure domain operation. */
  dispatchJson(requestJson: string): string;
}

/** Consumer 依赖；不包含隐式全局状态。 / Consumer dependencies with no implicit global state. */
export interface DiagnosticConsumerEnv {
  /** invocation 共享的非序列化遥测。 / Nonserialized invocation-shared telemetry. */
  readonly TELEMETRY?: Telemetry;
  /** 权威领域数据库。 / Authoritative domain database. */
  readonly DB: D1DatabaseLike;
  /** 领域核心注入点。 / Injected domain core. */
  readonly DIAGNOSTIC_CORE: DiagnosticDomainCore;
  /** 可选显式 DLQ，用来附加失败证据。 / Optional explicit DLQ used to attach failure evidence. */
  readonly DIAGNOSTIC_DLQ?: QueueSender<DiagnosticDeadLetterEnvelope>;
  /** 进入 DLQ 前的最大尝试数，默认 5。 / Maximum attempts before DLQ; defaults to five. */
  readonly DIAGNOSTIC_MAX_ATTEMPTS?: number;
  /** 可测试时钟。 / Testable clock. */
  readonly now?: () => Date;
}

/** Cloudflare Queue message 所需的最小契约。 / Minimal Cloudflare Queue message contract. */
export interface QueueMessageLike<T> {
  /** 平台消息 ID。 / Platform message ID. */
  readonly id: string;
  /** 当前投递尝试数。 / Current delivery attempt. */
  readonly attempts: number;
  /** 消息正文。 / Message body. */
  readonly body: T;
  /** 确认消息。 / Acknowledge the message. */
  ack(): void;
  /** 保持原消息身份重试。 / Retry while preserving original message identity. */
  retry(options?: { delaySeconds?: number }): void;
}

/** Cloudflare Queue batch 所需的最小契约。 / Minimal Cloudflare Queue batch contract. */
export interface QueueBatchLike<T> {
  /** 本次投递的消息。 / Messages delivered in this batch. */
  readonly messages: readonly QueueMessageLike<T>[];
}

/** 可识别的 consumer 失败阶段。 / Stable consumer failure stage. */
export type DiagnosticFailureStage =
  | "envelope_validation"
  | "idempotency_conflict"
  | "domain_validation"
  | "policy_evaluation"
  | "d1_transaction";

/** 显式 DLQ 消息，保留来源与失败阶段。 / Explicit DLQ message preserving provenance and failure stage. */
export interface DiagnosticDeadLetterEnvelope {
  /** DLQ 契约版本。 / DLQ contract version. */
  readonly schema_version: "1.0";
  /** 原始队列正文；无法校验时保留未解析值。 / Original body, including unparseable values. */
  readonly original: unknown;
  /** 不可变的失败证据。 / Immutable failure evidence. */
  readonly failure: {
    readonly stage: DiagnosticFailureStage;
    readonly problem_type: string;
    readonly attempt: number;
    readonly failed_at: string;
    readonly queue_message_id: string;
  };
}

/** 领域核心返回的诊断评估。 / Diagnostic evaluation returned by the domain core. */
export interface DiagnosticEvaluation {
  /** 规范指纹的 SHA-256。 / SHA-256 of the canonical fingerprint. */
  readonly fingerprint_hash: string;
  /** 领域策略修订号。 / Domain policy revision. */
  readonly policy_revision: number;
  /** 聚合后 Issue 状态。 / Aggregated issue state. */
  readonly issue_state:
    "observed" | "active" | "recovering" | "suppressed" | "resolved";
  /** 聚合后 Issue 严重度。 / Aggregated issue severity. */
  readonly severity: DiagnosticEvent["severity"];
  /** 新的服务直接状态；`null` 表示当前证据不应改变状态。 / New direct status; null means no status change. */
  readonly direct_status:
    | "operational"
    | "degraded"
    | "partial_outage"
    | "major_outage"
    | "maintenance"
    | "unknown";
  /** 稳定的领域动作。 / Stable domain action. */
  readonly action:
    | "create_observed"
    | "create_active"
    | "increment_observed"
    | "confirm"
    | "reactivate"
    | "record_suppressed"
    | "record_out_of_order"
    | "create_recurrence"
    | "begin_recovery"
    | "resolve_recovery"
    | "record_stale_recovery"
    | "record_unmatched_recovery";
  /** 事件纳入后的 occurrence 数。 / Occurrence count after including the event. */
  readonly occurrence_count: number;
  /** 当前因果故障之后的连续恢复证据数。 / Consecutive recovery evidence after the causal fault head. */
  readonly recovery_count: number;
  /** 最新恢复证据时间。 / Latest recovery-evidence time. */
  readonly last_recovery_at: string | null;
  /** 不会被乱序事件倒退的 last-seen。 / Last-seen timestamp that never regresses for out-of-order events. */
  readonly last_seen_at: string;
  /** 评估所基于的 revision。 / Revision against which evaluation was performed. */
  readonly expected_revision: number | null;
}

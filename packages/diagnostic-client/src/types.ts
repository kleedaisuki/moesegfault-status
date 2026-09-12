import type {
  DiagnosticAttributes,
  DiagnosticEvent,
  DiagnosticFingerprint,
  DiagnosticSeverity,
  DeploymentManifest,
} from "@moesegfault/contracts";
import type { ResourceIdentity, WaitUntilLike } from "@moesegfault/telemetry";

import type { SafeDiagnosticEvidence } from "./evidence.js";
import type { DiagnosticPropagation } from "./propagation.js";

/** Diagnostic 构建器接受的 manifest 身份子集。/ Manifest identity accepted by the Diagnostic builder. */
export type DiagnosticManifestIdentity = Pick<
  DeploymentManifest,
  | "deployment_id"
  | "service_name"
  | "environment"
  | "service_version"
  | "git_commit"
  | "artifact_digest"
>;

/** 故障与恢复事件共享的显式、安全输入。/ Explicit safe input shared by fault and recovery events. */
export interface DiagnosticEventInput {
  /** 稳定、点分隔的诊断类型。/ Stable dot-separated diagnostic kind. */
  readonly kind: string;
  /** 与日志严重度独立的诊断严重度。/ Diagnostic severity, independent from log severity. */
  readonly severity: DiagnosticSeverity;
  /** 仅用于展示且会被清理的摘要；不得传入原始异常或请求正文。/ Display-only summary that is scrubbed; never pass raw exceptions or request bodies. */
  readonly summary: string;
  /** 调用方分类后的低基数聚合身份。/ Caller-classified low-cardinality aggregation identity. */
  readonly fingerprint: Readonly<DiagnosticFingerprint>;
  /** 固定允许列表属性；未知键不会进入事件。/ Fixed-allowlist attributes; unknown keys never enter the event. */
  readonly attributes?: Readonly<Record<string, unknown>>;
  /** 只能由本包有限 locator builder 构造的证据。/ Evidence constructed by this package's finite locator builders only. */
  readonly evidence?: readonly SafeDiagnosticEvidence[];
  /** 已解析的 W3C/关联身份；缺省时创建新的根上下文。/ Parsed W3C/correlation identity; a new root is created when omitted. */
  readonly propagation?: DiagnosticPropagation;
  /** 可测试的 UTC 发生时间；缺省为构建时刻。/ Testable UTC occurrence time; defaults to build time. */
  readonly occurredAt?: Date | string;
  /** 非秘密、非用户来源的实例 UUID。/ Non-secret, non-user-derived instance UUID. */
  readonly instanceId?: string;
}

/** 恢复事件必须因果引用一个既有故障事件。/ A recovery event must causally reference an existing fault event. */
export interface DiagnosticRecoveryInput extends DiagnosticEventInput {
  /** 被此正向恢复信号清除的故障 event ID。/ Fault event ID cleared by this positive recovery signal. */
  readonly recoveryOfEventId: string;
}

/** 已验证、深冻结并预序列化的事件；重试复用完全相同的字节。/ Validated, deeply frozen, pre-serialized event whose retries reuse identical bytes. */
export interface PreparedDiagnosticEvent {
  /** 不可变领域事件。/ Immutable domain event. */
  readonly event: Readonly<DiagnosticEvent>;
  /** UTF-8 HTTP body 大小。/ UTF-8 HTTP body size. */
  readonly bodyBytes: number;
  /** 重试复用的规范 JSON body；只包含已清理字段。/ Canonical JSON body reused by retries; contains sanitized fields only. */
  readonly wireBody: string;
  /** 与事件 trace/correlation 字段一致的出站传播身份。/ Outbound propagation identity matching the event trace/correlation fields. */
  readonly propagation: DiagnosticPropagation;
}

/** 本地有界发布器的丢弃原因。/ Drop reasons from the local bounded publisher. */
export type DiagnosticDropReason = "queue_full" | "permanent_rejection";

/** 发布器自观测快照；不包含 payload、URL 或凭据。/ Publisher self-observation snapshot with no payload, URL, or credentials. */
export interface DiagnosticPublisherStats {
  /** 当前内存队列深度。/ Current in-memory queue depth. */
  readonly depth: number;
  /** 成功入队总数。/ Total successfully enqueued. */
  readonly enqueued: number;
  /** 收到匹配 202 回执的总数。/ Total matching 202 acknowledgements. */
  readonly published: number;
  /** 为保护边界或因永久拒绝而丢弃的总数。/ Total dropped for boundary protection or permanent rejection. */
  readonly dropped: number;
  /** 可重试传输失败次数。/ Retryable transport failure count. */
  readonly failedAttempts: number;
  /** 失败次数中由墙钟超时造成的数量。/ Failures caused by wall-clock timeout. */
  readonly timeouts: number;
  /** 连续耗尽重试的 flush 轮数。/ Consecutive flush rounds that exhausted retries. */
  readonly consecutiveFailures: number;
  /** 最近一次成功回执的 epoch 毫秒。/ Epoch milliseconds of the most recent acknowledgement. */
  readonly lastSuccessAt?: number;
  /** 允许下一轮尝试的最早 epoch 毫秒。/ Earliest epoch millisecond for the next retry round. */
  readonly nextAttemptAt?: number;
}

/** Diagnostic 客户端配置。/ Diagnostic client configuration. */
export interface DiagnosticClientOptions {
  /** 固定 ingress URL；必须是无凭据、无 query/hash 的 HTTPS endpoint。/ Pinned ingress URL; must be credential-free HTTPS with no query or fragment. */
  readonly endpoint: string | URL;
  /** 从已登记 manifest 声明得到的不可变运行时资源。/ Immutable runtime resource declared by the registered manifest. */
  readonly resource: Readonly<ResourceIdentity>;
  /** 可选 manifest 交叉校验；提供时身份与产物字段必须逐项相等。/ Optional manifest cross-check; identity and artifact fields must match exactly when supplied. */
  readonly manifest?: DiagnosticManifestIdentity;
  /** 每次 HTTP 尝试即时取得完整 Authorization 值；SDK 不缓存、持久化或记录它。/ Obtains the full Authorization value just in time for each attempt; the SDK never caches, persists, or logs it. */
  readonly authorization: () => string | Promise<string>;
  /** 仅用于平台适配与测试的 fetch 注入。/ Fetch injection for platform adaptation and tests only. */
  readonly fetch?: typeof fetch;
  /** 内存事件硬上限。/ Hard in-memory event bound. */
  readonly capacity?: number;
  /** 单次认证加 HTTP 尝试的墙钟超时。/ Wall-clock timeout for one authorization-plus-HTTP attempt. */
  readonly timeoutMs?: number;
  /** 每轮 flush 对同一事件的最大尝试数。/ Maximum attempts for one event during a flush. */
  readonly maxAttempts?: number;
  /** 首次重试延迟。/ Initial retry delay. */
  readonly baseBackoffMs?: number;
  /** 重试延迟硬上限。/ Hard retry-delay bound. */
  readonly maxBackoffMs?: number;
  /** 安全丢弃计数回调；不得抛异常。/ Safe drop counter callback; must not throw. */
  readonly onDrop?: (count: number, reason: DiagnosticDropReason) => void;
  /** 可测试时钟。/ Testable clock. */
  readonly now?: () => number;
  /** 可测试睡眠函数。/ Testable sleep function. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

/** 与 Workers ExecutionContext 兼容的非阻塞 flush 调度器。/ Non-blocking flush scheduler compatible with Workers ExecutionContext. */
export type DiagnosticWaitUntil = WaitUntilLike;

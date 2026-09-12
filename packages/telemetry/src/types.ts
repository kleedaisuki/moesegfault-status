/**
 * 支持的部署环境。/ Supported deployment environments.
 */
export type DeploymentEnvironment =
  "development" | "test" | "staging" | "production";

/**
 * 每条遥测必须携带的不可变资源与来源身份。
 * Immutable resource and provenance identity required on every telemetry item.
 */
export interface ResourceIdentity {
  /** 固定平台命名空间。/ Fixed platform namespace. */
  readonly "service.namespace": "moeSegFault";
  /** 稳定的小写 kebab-case 服务名。/ Stable lowercase kebab-case service name. */
  readonly "service.name": string;
  /** 发布版本，或完整 Git OID。/ Release version, or the full Git OID. */
  readonly "service.version": string;
  /** 部署环境。/ Deployment environment. */
  readonly "deployment.environment.name": DeploymentEnvironment;
  /** Deployment Registry 中的 UUIDv7。/ UUIDv7 in the Deployment Registry. */
  readonly "moesegfault.deployment.id": string;
  /** 完整 Git commit OID。/ Full Git commit OID. */
  readonly "moesegfault.build.revision": string;
  /** 实际运行产物的 SHA-256 摘要。/ SHA-256 digest of the running artifact. */
  readonly "moesegfault.artifact.digest": `sha256:${string}`;
}

/**
 * OpenTelemetry 属性允许的标量或同类型数组。
 * OpenTelemetry-compatible scalar or homogeneous array attribute value.
 */
export type AttributeValue =
  | string
  | number
  | boolean
  | readonly string[]
  | readonly number[]
  | readonly boolean[];

/**
 * 属性安全策略；未在 allowed 中的键永远不会离开进程。
 * Attribute safety policy; keys absent from allowed never leave the process.
 */
export interface AttributePolicy {
  /** 可导出的键。/ Keys permitted for export. */
  readonly allowed: ReadonlySet<string>;
  /** 即使允许也必须替换值的键。/ Allowed keys whose values must still be replaced. */
  readonly redact?: ReadonlySet<string>;
  /** 单个字符串的上限，默认 1,024 UTF-16 code units。/ Per-string limit; defaults to 1,024 UTF-16 code units. */
  readonly maxStringLength?: number;
}

/**
 * 日志严重级别。/ Log severity level.
 */
export type SeverityText =
  "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL";

/**
 * 可写入的最小 Console 结构，便于测试并避免依赖 Node Console。
 * Minimal writable console shape for tests without depending on Node Console.
 */
export interface ConsoleLike {
  /** 输出 TRACE/DEBUG。/ Emits TRACE/DEBUG. */
  debug(value: unknown): void;
  /** 输出 INFO。/ Emits INFO. */
  info(value: unknown): void;
  /** 输出 WARN。/ Emits WARN. */
  warn(value: unknown): void;
  /** 输出 ERROR/FATAL。/ Emits ERROR/FATAL. */
  error(value: unknown): void;
}

/**
 * 可由 ExecutionContext.waitUntil 接收的调度器。
 * Scheduler compatible with ExecutionContext.waitUntil.
 */
export interface WaitUntilLike {
  /** 让遥测工作在响应后完成。/ Extends the invocation for post-response telemetry work. */
  waitUntil(promise: Promise<unknown>): void;
}

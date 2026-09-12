import type { Telemetry } from "@moesegfault/telemetry";
/**
 * D1 查询结果的最小契约。 / Minimal D1 query-result contract.
 */
export interface D1QueryResult<Row = Record<string, unknown>> {
  /** 查询行。 / Returned rows. */
  readonly results?: Row[];
  /** 执行是否成功。 / Whether execution succeeded. */
  readonly success?: boolean;
}

/**
 * 公共读 API 所需的 D1 prepared statement 子集。
 * D1 prepared-statement subset needed by the public read API.
 */
export interface D1PreparedStatementLike {
  /** 绑定位置参数。 / Bind positional parameters. */
  bind(...values: unknown[]): D1PreparedStatementLike;
  /** 返回全部结果行。 / Return all result rows. */
  all<Row = Record<string, unknown>>(): Promise<D1QueryResult<Row>>;
  /** 返回第一行。 / Return the first row. */
  first<Row = Record<string, unknown>>(): Promise<Row | null>;
}

/** D1 只读查询契约。 / D1 read-only query contract. */
export interface D1DatabaseLike {
  /** 预处理一条 SQL。 / Prepare one SQL statement. */
  prepare(sql: string): D1PreparedStatementLike;
}

/** Rust/Wasm 领域核心的 JSON 调度边界。 / JSON dispatch boundary for the Rust/Wasm domain core. */
export interface PublicDependencyCore {
  /** 执行纯依赖风险计算。 / Run a pure dependency-risk calculation. */
  dispatchJson(requestJson: string): string;
}

/**
 * 六个公共 GET handler 的显式依赖。
 * Explicit dependencies for the six public GET handlers.
 */
export interface PublicApiContext {
  /** invocation 共享遥测预算。 / Invocation-shared telemetry budget. */
  readonly telemetry?: Telemetry;
  /** 权威领域数据库。 / Authoritative domain database. */
  readonly DB: D1DatabaseLike;
  /** 用于 HMAC 不透明游标的必需 secret。 / Required secret for HMAC-authenticated opaque cursors. */
  readonly cursorSecret: string;
  /**
   * 公共 HTTPS 规范 origin；省略时使用生产域名，绝不信任请求 Host。
   * Canonical public HTTPS origin; defaults to the production origin and
   * never trusts the request Host.
   */
  readonly publicOrigin?: string;
  /** 入口已生成的 correlation ID；绝不信任匿名请求头。 / Ingress-generated correlation ID; anonymous request headers are never trusted. */
  readonly correlationId?: string;
  /** 循环安全的 Rust/Wasm 依赖风险计算器。 / Cycle-safe Rust/Wasm dependency-risk evaluator. */
  readonly dependencyCore: PublicDependencyCore;
  /** 可测试时钟。 / Testable clock. */
  readonly now?: () => Date;
}

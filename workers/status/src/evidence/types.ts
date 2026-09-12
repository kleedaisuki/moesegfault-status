import type {
  EvidenceQueryResult,
  TelemetryCapability,
  TelemetryQueryAdapter,
} from "../../../../packages/contracts/src/backend-query.js";
import type { TelemetryReference } from "@moesegfault/contracts";

/** 查询运行时配置；真实凭据不进入此对象 / Runtime query configuration; credential values stay outside this object. */
export interface EvidenceBackendConfig {
  /** 适配器 API 的固定 HTTPS 根地址 / Pinned HTTPS API root for the adapter. */
  readonly endpoint: string;
  /** API 与 UI/源码链接可使用的精确主机名 / Exact hostnames allowed for API and UI/source links. */
  readonly allowed_hosts: readonly string[];
  /** 固定鉴权协议 / Fixed authentication scheme. */
  readonly auth_scheme: "bearer" | "basic" | "none";
  /** 单请求超时毫秒数 / Per-request timeout in milliseconds. */
  readonly timeout_ms: number;
  /** 读取响应正文的硬上限 / Hard response-body byte limit. */
  readonly max_response_bytes: number;
  /** 可选 Grafana 租户；从部署配置而非 locator 获取 / Optional Grafana tenant from deployment config, never a locator. */
  readonly tenant_id?: string | undefined;
}

/** 数据库注册项与部署不可变来源 / Database registration plus immutable deployment provenance. */
export interface ResolvedEvidenceReference {
  readonly reference: TelemetryReference;
  readonly adapterText: string;
  readonly capabilities: readonly TelemetryCapability[];
  readonly uiUrlTemplate: string;
  readonly authReference: string;
  readonly enabled: boolean;
  readonly repositoryUrl: string;
  readonly gitCommit: string;
}

/** 适配器执行上下文 / Adapter execution context. */
export interface AdapterContext {
  readonly resolved: ResolvedEvidenceReference;
  readonly adapter: TelemetryQueryAdapter;
  readonly config: EvidenceBackendConfig;
  readonly credential: string | undefined;
  readonly fetch: typeof fetch;
  readonly now: Date;
}

/** 适配器返回的规范化子结果 / Normalized partial result returned by an adapter. */
export type AdapterResult = Pick<
  EvidenceQueryResult,
  "status" | "ui_url" | "records" | "truncated"
> & { readonly detail?: string };

/** Evidence service 需要的 Worker 绑定 / Worker bindings required by the evidence service. */
export interface EvidenceEnvironment {
  /** 权威运维数据库 / Authoritative operations database. */
  readonly DB: D1Database;
  /** 按 backend name 配置固定端点的非 secret JSON / Non-secret JSON pinning endpoints by backend name. */
  readonly TELEMETRY_BACKEND_CONFIG_JSON?: string;
  /** secret JSON：symbolic auth_reference 到凭据值 / Secret JSON mapping symbolic auth_reference to credential values. */
  readonly TELEMETRY_AUTH_JSON?: string;
}

/** 遥测证据查询公共入口 / Public entrypoint for telemetry evidence queries. */
export {
  createEvidenceService,
  queryEvidence,
  queryTelemetryReference,
} from "./service.js";
export type { EvidenceServiceOptions } from "./service.js";
export type { EvidenceBackendConfig, EvidenceEnvironment } from "./types.js";

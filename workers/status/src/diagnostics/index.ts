/** Diagnostic ingest 和 Queue consumer 公共表面。 / Public surface for Diagnostic ingest and Queue consumption. */
export { ingest, ingestDiagnosticEvent } from "./ingest.js";
export {
  consume,
  consumeDiagnosticBatch,
  processDiagnosticEnvelope,
} from "./consumer.js";
export {
  evaluateWithCore,
  fingerprintWithCore,
  validateWithCore,
} from "./domain.js";
export type {
  DiagnosticConsumerEnv,
  DiagnosticDeadLetterEnvelope,
  DiagnosticDomainCore,
  DiagnosticFailureStage,
  DiagnosticIngestContext,
  DiagnosticIngestEnv,
  MachinePrincipal,
  QueueBatchLike,
  QueueMessageLike,
} from "./types.js";

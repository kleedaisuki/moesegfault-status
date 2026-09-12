import type { ResourceIdentity } from "./types.js";

const SERVICE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const GIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ARTIFACT_DIGEST = /^sha256:[0-9a-f]{64}$/;
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * 校验并冻结资源身份，防止部署来源在请求间漂移。
 * Validates and freezes resource identity so deployment provenance cannot drift between requests.
 *
 * @example
 * ```ts
 * const resource = defineResource({
 *   "service.namespace": "moeSegFault",
 *   "service.name": "status-api",
 *   "service.version": "1.2.3",
 *   "deployment.environment.name": "production",
 *   "moesegfault.deployment.id": "0199d09a-b692-7ce0-a1c0-5138a43d7402",
 *   "moesegfault.build.revision": "0123456789abcdef0123456789abcdef01234567",
 *   "moesegfault.artifact.digest": `sha256:${"a".repeat(64)}`,
 * });
 * ```
 */
export function defineResource(
  input: ResourceIdentity,
): Readonly<ResourceIdentity> {
  if (input["service.namespace"] !== "moeSegFault") {
    throw new TypeError("service.namespace must be moeSegFault");
  }
  requireMatch("service.name", input["service.name"], SERVICE_NAME);
  if (input["service.name"].length > 63) {
    throw new TypeError("service.name must contain at most 63 characters");
  }
  requireNonempty("service.version", input["service.version"]);
  if (
    !["development", "test", "staging", "production"].includes(
      input["deployment.environment.name"],
    )
  ) {
    throw new TypeError("deployment.environment.name is invalid");
  }
  requireMatch(
    "moesegfault.deployment.id",
    input["moesegfault.deployment.id"],
    UUID_V7,
  );
  requireMatch(
    "moesegfault.build.revision",
    input["moesegfault.build.revision"],
    GIT_OID,
  );
  requireMatch(
    "moesegfault.artifact.digest",
    input["moesegfault.artifact.digest"],
    ARTIFACT_DIGEST,
  );
  return Object.freeze({
    "service.namespace": input["service.namespace"],
    "service.name": input["service.name"],
    "service.version": input["service.version"],
    "deployment.environment.name": input["deployment.environment.name"],
    "moesegfault.deployment.id": input["moesegfault.deployment.id"],
    "moesegfault.build.revision": input["moesegfault.build.revision"],
    "moesegfault.artifact.digest": input["moesegfault.artifact.digest"],
  });
}

/** 校验非空配置。/ Validates a non-empty configuration value. */
function requireNonempty(name: string, value: string): void {
  if (
    value.length === 0 ||
    value.length > 256 ||
    !/^[\x21-\x7e]+$/.test(value)
  ) {
    throw new TypeError(`${name} must contain 1..256 visible ASCII characters`);
  }
}

/** 校验身份格式。/ Validates an identity format. */
function requireMatch(name: string, value: string, pattern: RegExp): void {
  if (!pattern.test(value)) {
    throw new TypeError(`${name} has an invalid format`);
  }
}

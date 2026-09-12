import type { PreparedDiagnosticEvent } from "./types.js";

const OWNED = new WeakSet<object>();

/** 登记本 builder 构造的不可变事件。/ Registers an immutable event constructed by this builder. */
export function ownPrepared(
  value: PreparedDiagnosticEvent,
): PreparedDiagnosticEvent {
  OWNED.add(value);
  return value;
}

/** 拒绝伪造 prepared body，确保 locator 安全约束不能被绕过。/ Rejects forged prepared bodies so locator safety constraints cannot be bypassed. */
export function assertOwnedPrepared(value: PreparedDiagnosticEvent): void {
  if (
    typeof value !== "object" ||
    value === null ||
    !Object.isFrozen(value) ||
    !OWNED.has(value)
  ) {
    throw new TypeError(
      "event must be created by this package's DiagnosticEventBuilder",
    );
  }
}

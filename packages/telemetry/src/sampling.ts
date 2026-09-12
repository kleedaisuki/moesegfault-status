/**
 * 强制保留条件。/ Conditions that force retention.
 */
export interface SamplingOverrides {
  /** 当前操作失败。/ Current operation failed. */
  readonly error?: boolean;
  /** 当前操作超过延迟阈值。/ Current operation exceeded the latency threshold. */
  readonly slow?: boolean;
  /** 当前执行与开放 Incident 关联。/ Current execution is linked to an open incident. */
  readonly incident?: boolean;
}

/**
 * 按 trace ID 做确定性比例采样；错误、慢操作和 Incident 证据始终保留。
 * Performs deterministic ratio sampling by trace ID; errors, slow operations, and incident evidence are always kept.
 */
export function shouldSample(
  traceId: string,
  rate: number,
  force: SamplingOverrides = {},
): boolean {
  if (!/^[0-9a-f]{32}$/.test(traceId) || /^0{32}$/.test(traceId)) {
    throw new TypeError(
      "traceId must be 32 lowercase hexadecimal characters and non-zero",
    );
  }
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    throw new RangeError("rate must be between 0 and 1");
  }
  if (force.error === true || force.slow === true || force.incident === true)
    return true;
  if (rate === 0) return false;
  if (rate === 1) return true;

  // 13 hex digits fit exactly in JavaScript's 53-bit integer range.
  const bucket = Number.parseInt(traceId.slice(0, 13), 16);
  return bucket < rate * 0x10_0000_0000_0000;
}

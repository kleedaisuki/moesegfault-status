//! 持久租约调度、区域证据评估与原子状态重算。 / Durable lease scheduling, regional evidence evaluation, and atomic status recomputation.

pub mod monitor;
#[cfg(target_arch = "wasm32")]
mod probe_lifecycle;
#[cfg(target_arch = "wasm32")]
pub mod reevaluate;
#[cfg(target_arch = "wasm32")]
mod runtime;
pub mod schedule;
#[cfg(target_arch = "wasm32")]
pub mod store;
pub mod types;
#[cfg(target_arch = "wasm32")]
pub use runtime::scheduled;

/// 重试使用稳定时间身份，不依赖调用顺序。 / Stable timestamped identity keeps retries independent of invocation order.
pub fn stable_id(time_ms: i64, seed: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(seed.as_bytes());
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[..6].copy_from_slice(&time_ms.max(0).to_be_bytes()[2..]);
    bytes[6] = (bytes[6] & 15) | 0x70;
    bytes[8] = (bytes[8] & 63) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

/// 有界确定性抖动退避；即使高 attempt 也不溢出。 / Bounded deterministic jitter backoff cannot overflow at high attempts.
pub fn retry_delay_ms(key: &str, attempt: u32) -> u64 {
    let hash = key.encode_utf16().fold(2_166_136_261u32, |hash, value| {
        (hash ^ u32::from(value)).wrapping_mul(16_777_619)
    });
    let raw = (1_000u64 << attempt.saturating_sub(1).min(20)).min(900_000);
    (raw * (800 + u64::from(hash % 401)) / 1_000).clamp(1, 900_000)
}

#[cfg(test)]
mod tests {
    #[test]
    fn identities_and_retries_are_bounded() {
        let id = super::stable_id(1_700_000_000_000, "run");
        assert_eq!(id, super::stable_id(1_700_000_000_000, "run"));
        assert!(status_domain::validate_uuid_v7(&id, "id").is_ok());
        assert_ne!(id, super::stable_id(1_700_000_000_000, "other"));
        assert!((1..=900_000).contains(&super::retry_delay_ms(&id, u32::MAX)));
    }
}

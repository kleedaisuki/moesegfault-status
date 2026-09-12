//! 诊断摄入与事务消费；事件身份是永久幂等边界。 / Diagnostic ingestion and transactional consumption; event identity is the durable idempotency boundary.
#[cfg(target_arch = "wasm32")]
mod platform;
#[cfg(any(target_arch = "wasm32", test))]
mod validation;
#[cfg(any(target_arch = "wasm32", test))]
mod writes;
#[cfg(target_arch = "wasm32")]
pub use platform::{
    consume_raw, handle, handle_with_correlation, process_envelope, process_monitor_envelope,
};

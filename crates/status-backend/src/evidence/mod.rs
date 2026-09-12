//! 有限证据查询编译器与平台适配器。 / Finite evidence query compiler and platform adapters.
#[cfg(any(test, target_arch = "wasm32"))]
mod config;
#[cfg(any(test, target_arch = "wasm32"))]
mod normalize;
#[cfg(any(test, target_arch = "wasm32"))]
mod query;
mod reference;
#[cfg(target_arch = "wasm32")]
mod service;
pub use reference::map_reference;
#[cfg(target_arch = "wasm32")]
pub use service::query_telemetry_reference;

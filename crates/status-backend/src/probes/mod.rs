//! 私有区域探针与可信来源校验。 / Private regional probes and trusted provenance validation.
#[cfg(target_arch = "wasm32")]
mod bindings;
#[cfg(target_arch = "wasm32")]
mod dispatch;
pub mod model;
#[cfg(target_arch = "wasm32")]
mod runtime;
pub mod security;
#[cfg(any(target_arch = "wasm32", test))]
mod validation;
#[cfg(target_arch = "wasm32")]
pub use dispatch::dispatch;
#[cfg(target_arch = "wasm32")]
pub use runtime::handle;

/// 注册时校验绑定能力，不执行网络操作。 / Validate registered binding capabilities without executing I/O.
#[cfg(target_arch = "wasm32")]
pub fn validate_configuration(env: &worker::Env, spec: &model::Probe) -> worker::Result<()> {
    bindings::validate_configuration(env, spec)
}

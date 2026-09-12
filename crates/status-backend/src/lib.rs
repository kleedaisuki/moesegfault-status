//! Rust 后端应用服务；直接调用领域库，不经过 JS 桥接。
//! Rust application services call the domain library directly, without a JS bridge.

#![forbid(unsafe_code)]
#![deny(missing_docs)]

pub mod access;
pub mod admin;
pub mod auth;
pub mod bootstrap;
pub mod cursor;
pub mod database;
pub mod deployments;
pub mod diagnostics;
pub mod evidence;
pub mod gateway;
pub mod http;
pub mod notifications;
pub mod probes;
#[cfg(target_arch = "wasm32")]
pub mod public;
pub mod scheduling;
pub mod telemetry;
pub mod wire;

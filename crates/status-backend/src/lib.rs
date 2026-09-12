//! Rust 后端应用服务；直接调用领域库，不经过 JS 桥接。
//! Rust application services call the domain library directly, without a JS bridge.

#![forbid(unsafe_code)]
#![deny(missing_docs)]

pub mod cursor;
pub mod http;

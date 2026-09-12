//! 管理身份的授权角色；认证由单管理员会话模块负责。
//! Administrative authorization roles; authentication belongs to the single-admin session module.

use serde::{Deserialize, Serialize};

/// 包含关系 admin ≥ operator ≥ viewer。 / Role inclusion admin ≥ operator ≥ viewer.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AdminRole {
    /// 只读权限。 / Read-only access.
    Viewer,
    /// 运维操作。 / Operational changes.
    Operator,
    /// 管理配置。 / Administrative configuration.
    Admin,
}

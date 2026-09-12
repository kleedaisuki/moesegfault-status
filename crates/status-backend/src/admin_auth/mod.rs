//! 单管理员密码边界；秘密不进入日志或持久化明文。
//! Single-administrator password boundary; secrets are never logged or persisted in plaintext.

/// 仅接受本地随机生成的 192-bit 密钥，不接受人工密码。 / Accept only locally generated 192-bit key syntax, not human passwords.
/// 格式检查不能证明熵；安全生成由离线凭据工具负责。 / Syntax cannot prove entropy; the offline credential tool guarantees generation.
#[cfg(any(target_arch = "wasm32", test))]
fn valid_password(password: &str) -> bool {
    password.len() == 32
        && password
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

#[cfg(target_arch = "wasm32")]
mod platform;
#[cfg(target_arch = "wasm32")]
pub use platform::dispatch;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_only_generated_key_encoding() {
        assert!(valid_password("ABCDEFGHIJKLMNOPQRSTUVWXYZabcd_-"));
        for invalid in [
            "a".repeat(31),
            "a".repeat(33),
            "密".repeat(32),
            "a".repeat(31) + " ",
            "a".repeat(31) + "=",
            "a".repeat(31) + "+",
            "a".repeat(31) + "/",
        ] {
            assert!(!valid_password(&invalid));
        }
    }
}

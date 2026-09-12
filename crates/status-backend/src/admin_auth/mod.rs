//! 单管理员密码边界；秘密不进入日志或持久化明文。
//! Single-administrator password boundary; secrets are never logged or persisted in plaintext.

/// 密码按 Unicode 字符而非字节计数，不修剪空白。 / Count Unicode characters, never trim whitespace.
#[cfg(any(target_arch = "wasm32", test))]
fn valid_password(password: &str) -> bool {
    (15..=128).contains(&password.chars().count()) && password.len() <= 512
}

#[cfg(target_arch = "wasm32")]
mod platform;
#[cfg(target_arch = "wasm32")]
pub use platform::dispatch;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn password_bounds_preserve_unicode_and_spaces() {
        assert!(!valid_password(&"a".repeat(14)));
        assert!(valid_password(&"密".repeat(15)));
        assert!(valid_password(&"😀".repeat(128)));
        assert!(!valid_password(&"a".repeat(129)));
        assert!(valid_password("  a long password  "));
    }
}

//! 不可变部署与产物协议。 / Immutable deployment and artifact protocol.
#![cfg(any(target_arch = "wasm32", test))]
#[cfg(target_arch = "wasm32")]
mod platform;
mod signing;
use crate::http::HttpError;
#[cfg(target_arch = "wasm32")]
pub use platform::{cleanup, handle, handle_with_correlation};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// 安全的协议错误，不包含存储异常。 / Safe protocol error without storage exceptions.
const INVALID: HttpError = HttpError::new(
    422,
    "invalid-artifact",
    "Artifact violates the immutable provenance contract",
);
/// 规范 SHA-256。 / Canonical SHA-256.
fn digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}
/// 验证地图格式及 bundle 关联；不声称映射语义正确。 / Validate map format/linkage, not mapping correctness.
fn validate_map(bytes: &[u8], filename: &str) -> Result<(), HttpError> {
    let map: Value = serde_json::from_slice(bytes).map_err(|_| INVALID)?;
    if map["version"] != 3
        || !map["mappings"].is_string()
        || !map["sources"]
            .as_array()
            .is_some_and(|s| s.iter().all(Value::is_string))
        || map
            .get("file")
            .is_some_and(|f| f.as_str() != filename.strip_suffix(".map"))
    {
        return Err(INVALID);
    }
    Ok(())
}
/// 路径组件按 RFC3986 编码。 / Encode a path component per RFC3986.
fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}
/// 摘要与 deployment 共同拥有不可变键。 / Digest and deployment jointly own the immutable key.
fn object_key(id: &str, artifact: &status_domain::Artifact) -> String {
    let hex = artifact.artifact_digest.trim_start_matches("sha256:");
    format!(
        "observability/artifacts/sha256/{}/{hex}/{id}/{}/{}",
        &hex[..2],
        serde_json::to_value(artifact.kind)
            .unwrap()
            .as_str()
            .unwrap(),
        encode(&artifact.file_name)
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn map_rejects_wrong_bundle_and_non_string_sources() {
        assert!(validate_map(
            br#"{"version":3,"sources":["a.ts"],"mappings":"","file":"index.js"}"#,
            "index.js.map"
        )
        .is_ok());
        assert!(validate_map(
            br#"{"version":3,"sources":[1],"mappings":""}"#,
            "index.js.map"
        )
        .is_err());
        assert!(validate_map(
            br#"{"version":3,"sources":[],"mappings":"","file":"other.js"}"#,
            "index.js.map"
        )
        .is_err());
    }
    #[test]
    fn hash_is_content_not_metadata() {
        assert_eq!(
            digest(b"abc"),
            "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(encode("a b/%"), "a%20b%2F%25");
    }
}
/// 对所有运行时产物而非仅主入口要求可追踪调试产物。
/// Require traceable debug artifacts for every runtime, not just the primary entrypoint.
fn validate_manifest(manifest: &status_domain::DeploymentManifest) -> Result<(), HttpError> {
    use status_domain::ArtifactKind;
    if manifest.artifacts.len() > 128
        || manifest.region.len() > 64
        || manifest
            .region
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            != manifest.region.len()
    {
        return Err(INVALID);
    }
    for a in &manifest.artifacts {
        if a.size_bytes > 5 * 1024 * 1024 * 1024
            || a.media_type.len() > 255
            || !a.media_type.is_ascii()
            || a.media_type.bytes().any(|b| b < 32 || b == 127)
            || a.build_id.as_ref().is_some_and(|s| {
                s.len() > 256
                    || !s
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
            })
        {
            return Err(INVALID);
        }
        if a.kind == ArtifactKind::Binary
            && !manifest
                .artifacts
                .iter()
                .any(|s| s.kind == ArtifactKind::DebugSymbols && s.build_id == a.build_id)
        {
            return Err(INVALID);
        }
        let media = a
            .media_type
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if matches!(a.kind, ArtifactKind::Binary | ArtifactKind::Other)
            && ["application/javascript", "text/javascript"].contains(&media.as_str())
            && !manifest.artifacts.iter().any(|s| {
                s.kind == ArtifactKind::SourceMap && s.file_name == format!("{}.map", a.file_name)
            })
        {
            return Err(INVALID);
        }
    }
    Ok(())
}

#[cfg(test)]
mod manifest_tests {
    use super::*;
    use serde_json::json;
    /// 实际协议清单fixture。 / Actual wire manifest fixture.
    fn manifest() -> status_domain::DeploymentManifest {
        serde_json::from_value(json!({"deployment_id":"01994800-0000-7000-8000-000000000001","service_name":"status-api","environment":"production","service_version":"1","repository_url":"https://github.com/example/status","git_commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","git_ref":"refs/heads/main","artifact_digest":format!("sha256:{}","b".repeat(64)),"ci_provider":"github","ci_run_id":"1","deployed_at":"2026-09-12T00:00:00Z","region":["global"],"artifacts":[{"kind":"binary","file_name":"index.wasm","media_type":"application/wasm","size_bytes":8,"artifact_digest":format!("sha256:{}","b".repeat(64)),"build_id":"build-1"}]})).unwrap()
    }
    #[test]
    fn wasm_requires_matching_symbols_and_keys_bind_deployment() {
        let mut m = manifest();
        assert!(m.validate().is_ok());
        assert!(validate_manifest(&m).is_err());
        let mut symbols = m.artifacts[0].clone();
        symbols.kind = status_domain::ArtifactKind::DebugSymbols;
        symbols.file_name = "index.debug.wasm".into();
        m.artifacts.push(symbols);
        assert!(validate_manifest(&m).is_ok());
        m.artifacts[1].build_id = Some("different-build".into());
        assert!(validate_manifest(&m).is_err());
        assert_ne!(
            object_key(&m.deployment_id, &m.artifacts[0]),
            object_key("01994800-0000-7000-8000-000000000002", &m.artifacts[0])
        );
        assert!(object_key(&m.deployment_id, &m.artifacts[0]).ends_with("/binary/index.wasm"));
    }
    #[test]
    fn secondary_javascript_glue_also_requires_map() {
        let mut m = manifest();
        m.artifacts[0].kind = status_domain::ArtifactKind::Other;
        m.artifacts[0].media_type = "application/javascript; charset=utf-8".into();
        m.artifacts[0].file_name = "index.js".into();
        assert!(validate_manifest(&m).is_err());
        let mut map = m.artifacts[0].clone();
        map.kind = status_domain::ArtifactKind::SourceMap;
        map.file_name = "index.js.map".into();
        map.media_type = "application/json".into();
        m.artifacts.push(map);
        assert!(validate_manifest(&m).is_ok());
    }
}

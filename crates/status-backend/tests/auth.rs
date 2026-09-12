//! 使用 Node 独立签名的公开向量测试 Rust JWT 验证。 / Verify Node-signed public vectors with Rust.

use serde_json::{json, Value};
use status_backend::auth::{bearer, verify_machine, MachineTrust, PublicKeys};
use status_domain::Environment;

/// 已签名的历史测试向量。 / Signed historical test vectors.
fn vectors() -> Vec<Value> {
    serde_json::from_str(include_str!("../../../tests/fixtures/jwt-vectors.json")).unwrap()
}

/// 测试固定信任配置。 / Pinned test trust configuration.
fn trust() -> MachineTrust {
    MachineTrust::new(
        "https://issuer.example",
        "status",
        "https://issuer.example/jwks",
    )
    .unwrap()
}

/// 构造仅含公钥的 JWKS。 / Build a public-only JWKS.
fn keys(jwk: &Value) -> PublicKeys {
    PublicKeys::parse(&serde_json::to_vec(&json!({"keys": [jwk]})).unwrap()).unwrap()
}

#[test]
fn verifies_all_three_existing_algorithms_and_resource_scopes() {
    for vector in vectors() {
        let keys = keys(&vector["jwk"]);
        let token = vector["tokens"]["valid"].as_str().unwrap();
        let identity = verify_machine(token, &trust(), &keys, 1700000010.0).unwrap();
        assert_eq!(identity.subject(), "ci");
        assert_eq!(identity.token_id(), "test-token");
        assert!(identity.require_scope("diagnostics:write").is_ok());
        assert!(identity.require_scope("admin:write").is_err());
        assert!(identity.authorizes(
            "identity",
            Environment::Production,
            "0199d0a8-2e12-7a59-a51e-000000000001"
        ));
        assert!(!identity.authorizes(
            "other",
            Environment::Production,
            "0199d0a8-2e12-7a59-a51e-000000000001"
        ));
        assert!(verify_machine(
            vector["tokens"]["remote_url"].as_str().unwrap(),
            &trust(),
            &keys,
            1700000010.0
        )
        .is_ok());
    }
}

#[test]
fn rejects_signed_bad_claims_and_tampered_tokens() {
    for vector in vectors() {
        let keys = keys(&vector["jwk"]);
        for name in [
            "bad_issuer",
            "bad_audience",
            "long_lived",
            "future",
            "not_before",
            "bad_scope",
            "bad_deployment",
            "missing_subject",
            "critical",
        ] {
            assert!(
                verify_machine(
                    vector["tokens"][name].as_str().unwrap(),
                    &trust(),
                    &keys,
                    1700000010.0
                )
                .is_err(),
                "{} {name}",
                vector["alg"]
            );
        }
        let token = vector["tokens"]["valid"].as_str().unwrap();
        assert!(verify_machine(token, &trust(), &keys, 1700000305.0).is_err());
        let mut tampered = token.as_bytes().to_vec();
        let index = token.rfind('.').unwrap() + 1;
        tampered[index] = if tampered[index] == b'A' { b'B' } else { b'A' };
        assert!(verify_machine(
            std::str::from_utf8(&tampered).unwrap(),
            &trust(),
            &keys,
            1700000010.0
        )
        .is_err());
    }
}

#[test]
fn rejects_ambiguous_or_wrong_use_keys() {
    for vector in vectors() {
        let token = vector["tokens"]["valid"].as_str().unwrap();
        let duplicate = PublicKeys::parse(
            &serde_json::to_vec(&json!({"keys": [vector["jwk"], vector["jwk"]]})).unwrap(),
        )
        .unwrap();
        assert!(verify_machine(token, &trust(), &duplicate, 1700000010.0).is_err());
        let mut jwk = vector["jwk"].clone();
        jwk["use"] = json!("enc");
        assert!(verify_machine(token, &trust(), &keys(&jwk), 1700000010.0).is_err());
    }
}

#[test]
fn rejects_untrusted_configuration_and_unbounded_inputs() {
    assert!(MachineTrust::new(
        "http://issuer.example",
        "status",
        "http://issuer.example/jwks"
    )
    .is_err());
    assert!(MachineTrust::new(
        "https://issuer.example",
        "status",
        "https://other.example/jwks"
    )
    .is_err());
    assert!(MachineTrust::new(
        "https://issuer.example",
        "status",
        "https://user:pass@issuer.example/jwks"
    )
    .is_err());
    assert!(bearer(None).is_err());
    assert!(bearer(Some(&format!("Bearer {}", "x".repeat(8192)))).is_err());
    assert!(PublicKeys::parse(&vec![b' '; 262145]).is_err());
}

/// 自有信任源必须逐字匹配，规范化别名和路径变化不能取得本地公钥。
/// Own trust must match literally; normalized aliases and path changes never select local keys.
#[test]
fn embedded_keys_require_exact_configured_issuer_and_url() {
    let issuer = "https://status.moesegfault.dev";
    let url = "https://status.moesegfault.dev/.well-known/jwks.json";
    let own = MachineTrust::new(issuer, "status", url).unwrap();
    assert!(own.embedded_keys().unwrap().is_ok());
    for (issuer, url) in [
        ("https://status.moesegfault.dev/", url),
        ("https://status.moesegfault.dev/other", url),
        (issuer, "https://status.moesegfault.dev/other"),
        (
            issuer,
            "https://status.moesegfault.dev/.well-known/jwks.json?other=1",
        ),
        (
            issuer,
            "https://status.moesegfault.dev:443/.well-known/jwks.json",
        ),
        ("https://issuer.example", "https://issuer.example/jwks"),
    ] {
        assert!(MachineTrust::new(issuer, "status", url)
            .unwrap()
            .embedded_keys()
            .is_none());
    }
    // 有效的外部签名也不能冒充本站签发者。 / Even a valid external signature cannot impersonate our issuer.
    for vector in vectors() {
        let token = vector["tokens"]["valid"].as_str().unwrap();
        assert!(verify_machine(token, &own, &keys(&vector["jwk"]), 1700000010.0).is_err());
        assert!(verify_machine(
            token,
            &own,
            &own.embedded_keys().unwrap().unwrap(),
            1700000010.0
        )
        .is_err());
    }
}

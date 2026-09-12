//! 原生 WebCrypto KDF 与 D1 原子状态转换。 / Native WebCrypto KDF and atomic D1 state transitions.
use crate::{
    admin::RpcProblem,
    database::{Database, Query},
    wire::Id,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;
use worker::Env;

/// 不携带秘密的内部错误。 / Internal error without secret-bearing details.
type Result<T> = std::result::Result<T, u16>;
/// 公共 RPC 分发只接受固定方法和严格字段。 / Public RPC dispatch accepts only fixed methods and strict fields.
pub async fn dispatch(db: &Database, operation: &str, raw: Value, env: &Env) -> Value {
    let result = execute(db, operation, &raw, env).await;
    match result {
        Ok(data) => json!({"data":data}),
        Err(status) => {
            json!({"problem":RpcProblem::new(status, match status {400=>"Invalid authentication request",401=>"Invalid credentials",409=>"Administrator state changed",429=>"Authentication rate limit exceeded",_=>"Authentication unavailable"}, &raw, operation)})
        }
    }
}
/// 校验字段后才访问数据库，所有失败不泄漏凭据。 / Validate fields before database access; failures never disclose credentials.
async fn execute(db: &Database, operation: &str, raw: &Value, env: &Env) -> Result<Value> {
    let fields: &[&str] = match operation {
        "loginAdministrator" => &["password"],
        "authenticateAdministrator" | "logoutAdministrator" => &["session_token"],
        _ => return Err(400),
    };
    let object = raw.as_object().ok_or(400u16)?;
    if object.len() != fields.len() + 1
        || object
            .keys()
            .any(|k| k != "correlation_id" && !fields.contains(&k.as_str()))
    {
        return Err(400);
    }
    Id::new(raw["correlation_id"].as_str().ok_or(400u16)?.into()).map_err(|_| 400u16)?;
    for field in fields {
        let value = raw[*field].as_str().ok_or(400u16)?;
        if field.ends_with("password") && !super::valid_password(value) {
            return Err(400);
        }
        if field.ends_with("token") && !valid_token(value) {
            return Err(400);
        }
    }
    // 私有审计标识只来自平台 Secret，不作为公开配置或登录输入。 / Private audit identity comes only from a platform Secret, never public configuration or login input.
    let email = env.secret("ADMIN_EMAIL").map_err(|_| 503u16)?.to_string();
    if email.len() > 320 || !crate::admin::valid_email(&email) {
        return Err(503);
    }
    let (record, fingerprint) = record(env)?;
    let now = js_sys::Date::now() as i64;
    match operation {
        "loginAdministrator" => login(db, raw, now, &email, &record, &fingerprint).await,
        "authenticateAdministrator" => {
            let session = session(db, text(raw, "session_token"), now, &fingerprint).await?;
            Ok(json!({"principal":principal(&email,session["created_at"].as_i64().ok_or(503u16)?)}))
        }
        "logoutAdministrator" => {
            db.batch(&[Query::new(
                "DELETE FROM administrator_sessions WHERE token_hash=?",
                vec![digest(text(raw, "session_token").as_bytes()).into()],
            )])
            .await
            .map_err(|_| 503u16)?;
            Ok(json!({"ok":true}))
        }
        _ => Err(400),
    }
}
/// 已校验的字符串读取。 / Read a previously validated string.
fn text<'a>(raw: &'a Value, key: &str) -> &'a str {
    raw[key].as_str().unwrap_or_default()
}
/// 令牌必须为规范的 256-bit base64url。 / Tokens must be canonical 256-bit base64url.
fn valid_token(token: &str) -> bool {
    URL_SAFE_NO_PAD
        .decode(token)
        .is_ok_and(|b| b.len() == 32 && URL_SAFE_NO_PAD.encode(b) == token)
}
/// 仅摘要用于数据库检索。 / Only digests are used for database lookup.
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
/// 平台随机数不降级到伪随机。 / Platform randomness never falls back to a PRNG.
fn random<const N: usize>() -> Result<[u8; N]> {
    let mut bytes = [0; N];
    getrandom::getrandom(&mut bytes).map_err(|_| 503u16)?;
    Ok(bytes)
}
/// 固定管理身份由服务构造，调用者不能指定角色。 / The service constructs a fixed identity; callers cannot select roles.
fn principal(email: &str, created: i64) -> Value {
    json!({"subject":"single-admin","email":email,"roles":["admin"],"authenticated_at":iso(created),"access_application":"single-admin-password"})
}
/// UTC 毫秒时间。 / UTC millisecond timestamp.
fn iso(ms: i64) -> String {
    js_sys::Date::new(&JsValue::from_f64(ms as f64))
        .to_iso_string()
        .into()
}
/// 参数化查询，返回平台更新后的行。 / Parameterized query returning post-update rows.
async fn query(
    db: &Database,
    sql: &str,
    args: Vec<crate::database::SqlValue>,
) -> Result<Vec<Value>> {
    db.all(&Query::new(sql, args)).await.map_err(|_| 503u16)
}
/// 在每次 KDF 前原子消耗全局预算。 / Atomically consume global budget before every KDF.
async fn budget(db: &Database, now: i64) -> Result<()> {
    let rows=query(db,"UPDATE administrator_login_budget SET attempts=CASE WHEN window_start<=? THEN 1 ELSE attempts+1 END, window_start=CASE WHEN window_start<=? THEN ? ELSE window_start END WHERE singleton=1 AND (window_start<=? OR attempts<30) RETURNING attempts",vec![(now-600000).into(),(now-600000).into(),now.into(),(now-600000).into()]).await?;
    if rows.is_empty() {
        Err(429)
    } else {
        Ok(())
    }
}
/// 严格版本化的离线密码记录。 / Strictly versioned offline password record.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PasswordRecord {
    /// 固定算法。 / Fixed algorithm.
    algorithm: String,
    /// 固定工作因子。 / Fixed work factor.
    iterations: u32,
    /// 随机盐。 / Random salt.
    salt: String,
    /// 派生摘要。 / Derived digest.
    hash: String,
}
/// secret 轮换立即使旧 fingerprint 会话失效。 / Secret rotation immediately invalidates old-fingerprint sessions.
fn record(env: &Env) -> Result<(PasswordRecord, String)> {
    let secret = env
        .secret("ADMIN_PASSWORD_RECORD")
        .map_err(|_| 503u16)?
        .to_string();
    let record: PasswordRecord = serde_json::from_str(&secret).map_err(|_| 503u16)?;
    if record.algorithm != "PBKDF2-SHA256" || record.iterations != 600000 {
        return Err(503);
    }
    let salt = URL_SAFE_NO_PAD.decode(&record.salt).map_err(|_| 503u16)?;
    let hash = URL_SAFE_NO_PAD.decode(&record.hash).map_err(|_| 503u16)?;
    if salt.len() != 16
        || hash.len() != 32
        || URL_SAFE_NO_PAD.encode(salt) != record.salt
        || URL_SAFE_NO_PAD.encode(hash) != record.hash
    {
        return Err(503);
    }
    Ok((record, digest(secret.as_bytes())))
}
/// 常量时间比较固定 32 字节派生值。 / Constant-time comparison of fixed 32-byte derived values.
async fn verify(record: &PasswordRecord, password: &str) -> Result<()> {
    let salt = URL_SAFE_NO_PAD.decode(&record.salt).map_err(|_| 503u16)?;
    let expected = URL_SAFE_NO_PAD.decode(&record.hash).map_err(|_| 503u16)?;
    if salt.len() != 16 || expected.len() != 32 {
        return Err(503);
    }
    let actual = derive(password, &salt).await?;
    if bool::from(actual.as_slice().ct_eq(&expected)) {
        Ok(())
    } else {
        Err(401)
    }
}
/// 每个会话绑定密码 secret 摘要；轮换后旧 invocation 签发的会话同样失效。 / Every session binds the password-secret fingerprint, invalidating even sessions issued by old invocations after rotation.
async fn login(
    db: &Database,
    raw: &Value,
    now: i64,
    email: &str,
    record: &PasswordRecord,
    fingerprint: &str,
) -> Result<Value> {
    budget(db, now).await?;
    verify(record, text(raw, "password")).await?;
    let token = URL_SAFE_NO_PAD.encode(random::<32>()?);
    let now = js_sys::Date::now() as i64;
    let expires = now + 43200000;
    let results=db.batch(&[
        Query::new("DELETE FROM administrator_sessions WHERE expires_at<=?",vec![now.into()]),
        Query::new("INSERT INTO administrator_sessions(token_hash,record_fingerprint,created_at,expires_at) VALUES(?,?,?,?) RETURNING token_hash",vec![digest(token.as_bytes()).into(),fingerprint.into(),now.into(),expires.into()]),
    ]).await.map_err(|_|503u16)?;
    if results[1].results.is_empty() {
        return Err(409);
    }
    Ok(json!({"session_token":token,"expires_at":iso(expires),"principal":principal(email,now)}))
}
/// 绝对期限与当前 secret 摘要共同校验。 / Validate absolute expiry and the current secret fingerprint.
async fn session(db: &Database, token: &str, now: i64, fingerprint: &str) -> Result<Value> {
    query(db,"SELECT created_at FROM administrator_sessions WHERE token_hash=? AND expires_at>? AND record_fingerprint=?",vec![digest(token.as_bytes()).into(),now.into(),fingerprint.into()]).await?.into_iter().next().ok_or(401)
}
/// 普通平台对象，避免 serde 默认将对象编码为 JS Map。 / Plain platform objects avoid serde's default JS Map encoding.
fn object(value: Value) -> Result<JsValue> {
    value
        .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(|_| 503u16)
}
/// 原生 WebCrypto PBKDF2；不使用耗费 Wasm CPU 的软件回退。 / Native WebCrypto PBKDF2, with no Wasm-CPU software fallback.
async fn derive(password: &str, salt: &[u8]) -> Result<Vec<u8>> {
    let crypto = js_sys::Reflect::get(&js_sys::global(), &"crypto".into()).map_err(|_| 503u16)?;
    let subtle = js_sys::Reflect::get(&crypto, &"subtle".into()).map_err(|_| 503u16)?;
    let import: js_sys::Function = js_sys::Reflect::get(&subtle, &"importKey".into())
        .map_err(|_| 503u16)?
        .dyn_into()
        .map_err(|_| 503u16)?;
    let args = js_sys::Array::new();
    for arg in [
        JsValue::from_str("raw"),
        js_sys::Uint8Array::from(password.as_bytes()).into(),
        object(json!({"name":"PBKDF2"}))?,
        JsValue::FALSE,
        object(json!(["deriveBits"]))?,
    ] {
        args.push(&arg);
    }
    let key = JsFuture::from(js_sys::Promise::resolve(
        &import.apply(&subtle, &args).map_err(|_| 503u16)?,
    ))
    .await
    .map_err(|_| 503u16)?;
    let params = object(json!({"name":"PBKDF2","hash":"SHA-256","iterations":600000}))?;
    js_sys::Reflect::set(&params, &"salt".into(), &js_sys::Uint8Array::from(salt))
        .map_err(|_| 503u16)?;
    let derive: js_sys::Function = js_sys::Reflect::get(&subtle, &"deriveBits".into())
        .map_err(|_| 503u16)?
        .dyn_into()
        .map_err(|_| 503u16)?;
    let result = derive
        .call3(&subtle, &params, &key, &JsValue::from_f64(256.0))
        .map_err(|_| 503u16)?;
    let bytes = JsFuture::from(js_sys::Promise::resolve(&result))
        .await
        .map_err(|_| 503u16)?;
    Ok(js_sys::Uint8Array::new(&bytes).to_vec())
}

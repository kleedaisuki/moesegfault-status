//! Workers binding 上的部署注册与提交。 / Deployment registration/commit on Workers bindings.
use super::*;
use crate::{
    auth::{MachineIdentity, MachineTrust},
    database::{Database, Query, SqlValue},
    http::{read_json, HttpError},
};
use base64::Engine;
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::{json, Value};
use status_domain::{Artifact, DeploymentManifest, Environment};
use std::collections::{BTreeMap, HashMap};
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;
use worker::{Context, Env, Method, Request, Response};
const INTERNAL: HttpError = HttpError::new(
    503,
    "deployment-storage-unavailable",
    "Deployment storage is unavailable",
);
const CONFLICT: HttpError = HttpError::new(
    409,
    "immutable-conflict",
    "Immutable content or lifecycle conflicts",
);
const FORBIDDEN: HttpError = HttpError::new(
    403,
    "deployment-forbidden",
    "Deployment is outside machine authorization",
);
/// 单请求上下文。 / Per-request context.
struct State<'a> {
    /// 本次请求的D1绑定。 / Request-local D1 binding.
    db: Database,
    /// 本次调用配置和私有bucket。 / Invocation configuration and private bucket.
    env: &'a Env,
    /// 已验证机器声明。 / Verified machine claims.
    identity: MachineIdentity,
    /// 固定UTC毫秒时间。 / Fixed UTC millisecond timestamp.
    now: String,
    /// 服务端生成关联身份。 / Server-generated correlation identity.
    correlation: String,
}
/// 安全配置读取。 / Safe configuration lookup.
fn variable(env: &Env, name: &str) -> Result<String, HttpError> {
    env.var(name).map(|v| v.to_string()).map_err(|_| INTERNAL)
}
/// JSON枚举文本。 / JSON enum text.
fn label(value: impl Serialize) -> String {
    serde_json::to_value(value)
        .expect("enum serializes")
        .as_str()
        .expect("string enum")
        .into()
}
/// 可选 SQL 文本。 / Optional SQL text.
fn optional(value: Option<&str>) -> SqlValue {
    value.map(Into::into).unwrap_or(SqlValue::Null)
}
/// 随机 UUIDv7。 / Random UUIDv7.
fn id() -> String {
    let mut b = [0u8; 16];
    getrandom::getrandom(&mut b).expect("platform CSPRNG");
    let t = worker::Date::now().as_millis();
    b[..6].copy_from_slice(&t.to_be_bytes()[2..]);
    b[6] = (b[6] & 15) | 112;
    b[8] = (b[8] & 63) | 128;
    format!("{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",b[0],b[1],b[2],b[3],b[4],b[5],b[6],b[7],b[8],b[9],b[10],b[11],b[12],b[13],b[14],b[15])
}
/// 机器部署入口；不认识的路径返回 None。 / Machine deployment entrypoint; unknown routes return None.
pub async fn handle(
    request: &mut Request,
    env: &Env,
    ctx: &Context,
) -> worker::Result<Option<Response>> {
    handle_with_correlation(request, env, ctx, &id()).await
}

/// 生产入口复用根路由生成的可信关联ID；body、audit、header保持一致。
/// Production entry reuses the root router's trusted correlation ID across body, audit and header.
///
/// 调用者必须传服务端生成的UUIDv7，不能传未经校验的HTTP输入。
/// Caller must supply a server-generated UUIDv7, never unvalidated HTTP input.
pub async fn handle_with_correlation(
    request: &mut Request,
    env: &Env,
    _ctx: &Context,
    correlation: &str,
) -> worker::Result<Option<Response>> {
    let path = request.path();
    let Some(rest) = path.strip_prefix("/v1/deployments/") else {
        return Ok(None);
    };
    let parts = rest.split('/').collect::<Vec<_>>();
    if parts.len() > 3
        || parts.is_empty()
        || (parts.len() >= 2 && !["artifact-uploads", "artifacts"].contains(&parts[1]))
        || (parts.len() == 3 && parts[1] != "artifact-uploads")
    {
        return Ok(None);
    }
    status_domain::validate_uuid_v7(correlation, "correlation_id")
        .map_err(|_| worker::Error::RustError("Invalid trusted correlation ID".into()))?;
    let correlation = correlation.to_owned();
    let result = async {
        if status_domain::validate_uuid_v7(parts[0], "deployment_id").is_err() {
            return Err(INVALID);
        }
        if !(parts.len() == 1 && request.method() == Method::Put
            || parts.len() == 2 && request.method() == Method::Post
            || parts.len() == 3 && request.method() == Method::Put)
        {
            return Err(HttpError::new(
                405,
                "method-not-allowed",
                "Unsupported deployment method",
            ));
        }
        let trust = MachineTrust::new(
            &variable(env, "MACHINE_ISSUER")?,
            &variable(env, "MACHINE_AUDIENCE")?,
            &variable(env, "MACHINE_JWKS_URL")?,
        )?;
        let identity = crate::auth::cloudflare::authenticate_machine(request, &trust).await?;
        identity.require_scope(if parts.len() == 1 {
            "deployments:write"
        } else {
            "artifacts:write"
        })?;
        let state = State {
            db: Database::new(env.d1("DB").map_err(|_| INTERNAL)?),
            env,
            identity,
            now: chrono::DateTime::from_timestamp_millis(worker::Date::now().as_millis() as i64)
                .ok_or(INTERNAL)?
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            correlation: correlation.clone(),
        };
        if parts.len() == 1 {
            register(request, parts[0], &state).await
        } else if parts.len() == 3 {
            transfer(request, parts[0], parts[2], &state).await
        } else if parts[1] == "artifact-uploads" {
            upload(request, parts[0], &state).await
        } else {
            commit(request, parts[0], &state).await
        }
    }
    .await;
    let is_error = result.is_err();
    let mut response=match result {Ok((status,data))=>Response::from_json(&json!({"data":data,"meta":{"correlation_id":correlation}}))?.with_status(status),Err(e)=>Response::from_json(&json!({"type":format!("urn:moesegfault:problem:{}",e.code),"title":e.code,"status":e.status,"detail":e.detail,"correlation_id":correlation}))?.with_status(e.status)};
    response.headers_mut().set("cache-control", "no-store")?;
    response
        .headers_mut()
        .set("x-moesegfault-correlation-id", &correlation)?;
    if is_error {
        response
            .headers_mut()
            .set("content-type", "application/problem+json")?;
    }
    Ok(Some(response))
}
/// 读取并授权部署行。 / Load and authorize a deployment row.
async fn deployment(id: &str, s: &State<'_>) -> Result<Value, HttpError> {
    let row=s.db.first::<Value>(&Query::new("SELECT d.*,s.state FROM deployments d JOIN deployment_current_status s USING(deployment_id) WHERE deployment_id=?",vec![id.into()])).await.map_err(|_|INTERNAL)?.ok_or(HttpError::new(404,"deployment-not-found","Deployment not registered"))?;
    let environment: Environment =
        serde_json::from_value(row["environment"].clone()).map_err(|_| INTERNAL)?;
    if !s.identity.authorizes(
        row["service_name"].as_str().ok_or(INTERNAL)?,
        environment,
        id,
    ) {
        return Err(FORBIDDEN);
    }
    if ["failed", "retired"].contains(&row["state"].as_str().unwrap_or("")) {
        return Err(CONFLICT);
    }
    Ok(row)
}
/// 同事务不可变审计。 / Immutable audit in the same transaction.
fn audit(s: &State<'_>, action: &str, target: &str) -> Query {
    Query::new("INSERT INTO audit_log(audit_id,actor_type,actor_subject,actor_roles_json,action,target_type,target_id,correlation_id,occurred_at,details_json) VALUES (?,'machine',?,'[]',?,'deployment',?,?,?,'{}')",vec![id().into(),s.identity.subject().into(),action.into(),target.into(),s.correlation.clone().into(),s.now.clone().into()])
}
/// R2有界读取，拒绝manifest与map内存炸弹。 / Bounded R2 read, rejecting manifest/map memory bombs.
async fn bytes(env: &Env, key: &str, limit: usize) -> Result<Vec<u8>, HttpError> {
    let bucket = env.bucket("ARTIFACTS").map_err(|_| INTERNAL)?;
    let object = bucket
        .get(key)
        .execute()
        .await
        .map_err(|_| INTERNAL)?
        .ok_or(INVALID)?;
    let mut stream = object
        .body()
        .ok_or(INVALID)?
        .stream()
        .map_err(|_| INTERNAL)?;
    let mut result = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| INTERNAL)?;
        if result.len() + chunk.len() > limit {
            return Err(INVALID);
        }
        result.extend(chunk);
    }
    Ok(result)
}
/// 注册不可变清单，R2确认先于D1事务。 / Register immutable manifest; R2 confirmation precedes D1 transaction.
async fn register(
    request: &mut Request,
    deployment_id: &str,
    s: &State<'_>,
) -> Result<(u16, Value), HttpError> {
    let manifest: DeploymentManifest = read_json(request, 262144).await?;
    manifest.validate().map_err(|_| INVALID)?;
    validate_manifest(&manifest)?;
    if manifest.deployment_id != deployment_id {
        return Err(CONFLICT);
    }
    if !s
        .identity
        .authorizes(&manifest.service_name, manifest.environment, deployment_id)
    {
        return Err(FORBIDDEN);
    }
    let data = serde_json::to_value(&manifest).map_err(|_| INVALID)?;
    let data = serde_json::to_vec(&data).map_err(|_| INVALID)?;
    let hash = digest(&data);
    let exists =
        s.db.first::<Value>(&Query::new(
            "SELECT manifest_digest FROM deployments WHERE deployment_id=?",
            vec![deployment_id.into()],
        ))
        .await
        .map_err(|_| INTERNAL)?;
    if exists.is_some() {
        let row = deployment(deployment_id, s).await?;
        return registration(row, &hash, 200);
    }
    if s.db
        .first::<Value>(&Query::new(
            "SELECT service_name FROM services WHERE service_name=? AND enabled=1",
            vec![manifest.service_name.clone().into()],
        ))
        .await
        .map_err(|_| INTERNAL)?
        .is_none()
    {
        return Err(INVALID);
    }
    let key = format!("observability/manifests/{deployment_id}.json");
    let bucket = s.env.bucket("ARTIFACTS").map_err(|_| INTERNAL)?;
    bucket
        .put(&key, data.clone())
        .only_if(worker::Conditional {
            etag_does_not_match: Some("*".into()),
            ..Default::default()
        })
        .http_metadata(worker::HttpMetadata {
            content_type: Some("application/json".into()),
            ..Default::default()
        })
        .sha256(Sha256::digest(&data).to_vec())
        .execute()
        .await
        .map_err(|_| INTERNAL)?;
    if digest(&bytes(s.env, &key, 262144).await?) != hash {
        return Err(CONFLICT);
    }
    let mut queries=vec![Query::new("INSERT INTO deployments(deployment_id,service_name,environment,service_version,repository_url,git_commit,git_ref,artifact_digest,ci_provider,ci_run_id,deployed_at,manifest_object_key,manifest_digest,manifest_schema_version,registered_at,registered_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'1.0',?,?)",vec![deployment_id.into(),manifest.service_name.into(),label(manifest.environment).into(),manifest.service_version.into(),manifest.repository_url.into(),manifest.git_commit.into(),manifest.git_ref.into(),manifest.artifact_digest.into(),manifest.ci_provider.into(),manifest.ci_run_id.into(),manifest.deployed_at.to_rfc3339_opts(chrono::SecondsFormat::Millis,true).into(),key.into(),hash.clone().into(),s.now.clone().into(),s.identity.subject().into()])];
    for region in manifest.region {
        queries.push(Query::new(
            "INSERT INTO deployment_regions(deployment_id,region) VALUES(?,?)",
            vec![deployment_id.into(), region.into()],
        ));
    }
    for a in manifest.artifacts {
        queries.push(Query::new("INSERT INTO deployment_artifact_requirements(deployment_id,kind,file_name,media_type,size_bytes,artifact_digest,build_id,created_at) VALUES(?,?,?,?,?,?,?,?)",vec![deployment_id.into(),label(a.kind).into(),a.file_name.into(),a.media_type.into(),(a.size_bytes as i64).into(),a.artifact_digest.into(),optional(a.build_id.as_deref()),s.now.clone().into()]));
    }
    for (sequence, state) in [(1, "registered"), (2, "artifacts_pending")] {
        queries.push(Query::new("INSERT INTO deployment_status_history(deployment_id,sequence,state,reason,actor_subject,correlation_id,occurred_at) VALUES(?,?,?,'manifest registration',?,?,?)",vec![deployment_id.into(),sequence.into(),state.into(),s.identity.subject().into(),s.correlation.clone().into(),s.now.clone().into()]));
    }
    queries.push(audit(s, "deployment.registered", deployment_id));
    let status = if s.db.batch(&queries).await.is_ok() {
        201
    } else {
        200
    };
    registration(deployment(deployment_id, s).await?, &hash, status)
}
/// 幂等登记投影。 / Idempotent registration projection.
fn registration(row: Value, hash: &str, status: u16) -> Result<(u16, Value), HttpError> {
    if row["manifest_digest"] != hash {
        return Err(CONFLICT);
    }
    let state = if ["ready", "active"].contains(&row["state"].as_str().unwrap_or("")) {
        "ready"
    } else {
        "awaiting_artifacts"
    };
    Ok((
        status,
        json!({"deployment_id":row["deployment_id"],"manifest_digest":hash,"registered_at":row["registered_at"],"state":state}),
    ))
}
/// 上传字段与清单字段分离，拒绝额外属性。 / Separate upload fields and reject unknown properties.
fn input(value: Value, extra: &str) -> Result<(Artifact, String), HttpError> {
    let mut map = value.as_object().cloned().ok_or(INVALID)?;
    let extra = map
        .remove(extra)
        .and_then(|v| v.as_str().map(str::to_owned))
        .ok_or(INVALID)?;
    let a: Artifact = serde_json::from_value(Value::Object(map)).map_err(|_| INVALID)?;
    a.validate().map_err(|_| INVALID)?;
    if a.size_bytes > 64 * 1024 * 1024
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
    Ok((a, extra))
}
/// 精确比对需求表。 / Exact requirement-table match.
async fn required(s: &State<'_>, id: &str, a: &Artifact) -> Result<(), HttpError> {
    let row=s.db.first::<Value>(&Query::new("SELECT 1 AS present FROM deployment_artifact_requirements WHERE deployment_id=? AND kind=? AND file_name=? AND media_type=? AND size_bytes=? AND artifact_digest=? AND build_id IS ?",vec![id.into(),label(a.kind).into(),a.file_name.clone().into(),a.media_type.clone().into(),(a.size_bytes as i64).into(),a.artifact_digest.clone().into(),optional(a.build_id.as_deref())])).await.map_err(|_|INTERNAL)?;
    if row.is_none() {
        return Err(INVALID);
    }
    Ok(())
}
/// 服务端生成但不作为字节证据的来源元数据。 / Server-generated provenance metadata is not byte-level evidence.
fn metadata(row: &Value, a: &Artifact) -> HashMap<String, String> {
    HashMap::from([
        (
            "deployment-id".into(),
            row["deployment_id"].as_str().unwrap_or("").into(),
        ),
        (
            "git-commit".into(),
            row["git_commit"].as_str().unwrap_or("").into(),
        ),
        ("artifact-digest".into(), a.artifact_digest.clone()),
        ("artifact-kind".into(), label(a.kind)),
        ("artifact-file-name".into(), a.file_name.clone()),
        (
            "build-id".into(),
            a.build_id.clone().unwrap_or("none".into()),
        ),
    ])
}
/// 幂等会话重放也检查过期时间。 / Idempotent session replay also checks expiration.
async fn replay(
    s: &State<'_>,
    scope: &str,
    key: &str,
    hash: &str,
) -> Result<Option<Value>, HttpError> {
    let row=s.db.first::<Value>(&Query::new("SELECT i.request_digest,i.response_json,s.expires_at,s.created_by FROM idempotency_keys i JOIN artifact_upload_sessions s ON s.upload_id=i.resource_id WHERE i.scope=? AND i.idempotency_key=?",vec![scope.into(),key.into()])).await.map_err(|_|INTERNAL)?;
    let Some(row) = row else { return Ok(None) };
    if row["created_by"].as_str() != Some(s.identity.subject()) {
        return Err(FORBIDDEN);
    }
    if row["request_digest"] != hash {
        return Err(CONFLICT);
    }
    if row["expires_at"].as_str().ok_or(INTERNAL)? <= s.now.as_str() {
        return Err(HttpError::new(
            410,
            "upload-expired",
            "Create a new upload session",
        ));
    }
    Ok(Some(
        serde_json::from_str(row["response_json"].as_str().ok_or(INTERNAL)?)
            .map_err(|_| INTERNAL)?,
    ))
}
/// 只签发不可覆盖的PUT会话。 / Issue only non-overwriting PUT sessions.
async fn upload(
    request: &mut Request,
    deployment_id: &str,
    s: &State<'_>,
) -> Result<(u16, Value), HttpError> {
    let key = request
        .headers()
        .get("idempotency-key")
        .map_err(|_| INVALID)?
        .ok_or(INVALID)?;
    if !(8..=256).contains(&key.len())
        || !key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
    {
        return Err(INVALID);
    }
    let raw: Value = read_json(request, 16384).await?;
    let hash = digest(&serde_json::to_vec(&raw).map_err(|_| INVALID)?);
    let (a, md5) = input(raw, "content_md5")?;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(&md5)
        .map_err(|_| INVALID)?;
    if decoded.len() != 16 || base64::engine::general_purpose::STANDARD.encode(decoded) != md5 {
        return Err(INVALID);
    }
    deployment(deployment_id, s).await?;
    required(s, deployment_id, &a).await?;
    let scope = format!("deployment-artifact-upload:{deployment_id}");
    if let Some(body) = replay(s, &scope, &key, &hash).await? {
        return Ok((200, body));
    }
    let object = object_key(deployment_id, &a);
    let now = chrono::DateTime::parse_from_rfc3339(&s.now).map_err(|_| INTERNAL)?;
    let expires =
        (now + chrono::Duration::seconds(600)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let headers: BTreeMap<String, String> = BTreeMap::from([
        ("content-length".into(), a.size_bytes.to_string()),
        ("content-type".into(), a.media_type.clone()),
        ("content-md5".into(), md5.clone()),
        ("if-none-match".into(), "*".into()),
    ]);
    let upload_id = id();
    let origin = request
        .url()
        .map_err(|_| INVALID)?
        .origin()
        .ascii_serialization();
    let url = format!("{origin}/v1/deployments/{deployment_id}/artifact-uploads/{upload_id}");
    let body = json!({"upload_id":upload_id,"method":"PUT","upload_url":url,"required_headers":headers,"expires_at":expires});
    let queries=[Query::new("INSERT INTO artifact_upload_sessions(upload_id,deployment_id,idempotency_key,request_digest,object_key,kind,file_name,media_type,size_bytes,artifact_digest,content_md5,build_id,expires_at,created_at,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",vec![upload_id.clone().into(),deployment_id.into(),key.clone().into(),hash.clone().into(),object.into(),label(a.kind).into(),a.file_name.into(),a.media_type.into(),(a.size_bytes as i64).into(),a.artifact_digest.into(),md5.into(),optional(a.build_id.as_deref()),expires.into(),s.now.clone().into(),s.identity.subject().into()]),Query::new("INSERT INTO idempotency_keys(scope,idempotency_key,request_digest,resource_type,resource_id,response_status,response_json,created_at,expires_at) VALUES(?,?,?,'artifact_upload',?,201,?,?,?)",vec![scope.clone().into(),key.clone().into(),hash.clone().into(),upload_id.into(),body.to_string().into(),s.now.clone().into(),(now+chrono::Duration::days(1)).to_rfc3339_opts(chrono::SecondsFormat::Millis,true).into()]),audit(s,"deployment.artifact-upload.created",deployment_id)];
    if s.db.batch(&queries).await.is_err() {
        return replay(s, &scope, &key, &hash)
            .await?
            .map(|v| (200, v))
            .ok_or(INTERNAL);
    }
    Ok((201, body))
}
/// JWT 授权的有界原生流式上传；URL 本身不是凭据。
/// JWT-authorized bounded native streaming upload; the URL is not a credential.
async fn transfer(
    request: &mut Request,
    deployment_id: &str,
    upload_id: &str,
    s: &State<'_>,
) -> Result<(u16, Value), HttpError> {
    status_domain::validate_uuid_v7(upload_id, "upload_id").map_err(|_| INVALID)?;
    let row = deployment(deployment_id, s).await?;
    let session =
        s.db.first::<Value>(&Query::new(
            "SELECT * FROM artifact_upload_sessions WHERE upload_id=? AND deployment_id=?",
            vec![upload_id.into(), deployment_id.into()],
        ))
        .await
        .map_err(|_| INTERNAL)?
        .ok_or(INVALID)?;
    if session["created_by"].as_str() != Some(s.identity.subject()) {
        return Err(FORBIDDEN);
    }
    if session["expires_at"].as_str().ok_or(INTERNAL)? <= s.now.as_str() {
        return Err(HttpError::new(
            410,
            "upload-expired",
            "Create a new upload session",
        ));
    }
    let a: Artifact = serde_json::from_value(json!({
        "kind": session["kind"], "file_name": session["file_name"],
        "media_type": session["media_type"], "size_bytes": session["size_bytes"],
        "artifact_digest": session["artifact_digest"], "build_id": session["build_id"]
    }))
    .map_err(|_| INTERNAL)?;
    a.validate().map_err(|_| INVALID)?;
    if a.size_bytes > 64 * 1024 * 1024 {
        return Err(INVALID);
    }
    required(s, deployment_id, &a).await?;
    for (name, expected) in [
        ("content-length", a.size_bytes.to_string()),
        ("content-type", a.media_type.clone()),
        (
            "content-md5",
            session["content_md5"].as_str().ok_or(INTERNAL)?.into(),
        ),
        ("if-none-match", "*".into()),
    ] {
        if request.headers().get(name).map_err(|_| INVALID)?.as_deref() != Some(&expected) {
            return Err(INVALID);
        }
    }
    // 保留平台已知长度的请求流；不克隆、不转换为 Rust Vec、不信任客户端元数据。
    // Preserve the platform's known-length request stream; no clone, Rust Vec or client metadata.
    let body = request.inner().body().ok_or(INVALID)?;
    let sha = a.artifact_digest.strip_prefix("sha256:").ok_or(INVALID)?;
    let sha = (0..64)
        .step_by(2)
        .map(|i| u8::from_str_radix(&sha[i..i + 2], 16))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| INVALID)?;
    let bucket = s.env.bucket("ARTIFACTS").map_err(|_| INTERNAL)?;
    let object = bucket
        .put(session["object_key"].as_str().ok_or(INTERNAL)?, body)
        .only_if(worker::Conditional {
            etag_does_not_match: Some("*".into()),
            ..Default::default()
        })
        .sha256(sha)
        .http_metadata(worker::HttpMetadata {
            content_type: Some(a.media_type.clone()),
            ..Default::default()
        })
        .custom_metadata(metadata(&row, &a))
        .execute()
        .await
        .map_err(|_| INVALID)?
        .ok_or(HttpError::new(
            412,
            "artifact-already-exists",
            "Immutable object already exists",
        ))?;
    if object.size() != a.size_bytes {
        return Err(INVALID);
    }
    Ok((201, json!({"upload_id":upload_id})))
}

/// 比较会话/提交所有不可变字段。 / Compare all immutable session/commit fields.
fn matches(row: &Value, a: &Artifact) -> bool {
    row["kind"] == label(a.kind)
        && row["file_name"] == a.file_name
        && row["media_type"] == a.media_type
        && row["size_bytes"] == a.size_bytes
        && row["artifact_digest"] == a.artifact_digest
        && row["build_id"] == serde_json::to_value(&a.build_id).unwrap()
}
/// 平台原生流式 SHA-256；每个产物只有 32 字节摘要跨越 Wasm 边界。
/// Native streaming SHA-256; only the 32-byte artifact digest crosses the Wasm boundary.
async fn stream_digest(stream: web_sys::ReadableStream) -> Result<String, HttpError> {
    let crypto = js_sys::Reflect::get(&js_sys::global(), &"crypto".into()).map_err(|_| INTERNAL)?;
    let constructor = js_sys::Reflect::get(&crypto, &"DigestStream".into())
        .map_err(|_| INTERNAL)?
        .dyn_into::<js_sys::Function>()
        .map_err(|_| INTERNAL)?;
    let arguments = js_sys::Array::of1(&JsValue::from_str("SHA-256"));
    let sink = js_sys::Reflect::construct(&constructor, &arguments).map_err(|_| INTERNAL)?;
    let digest = js_sys::Reflect::get(&sink, &"digest".into())
        .map_err(|_| INTERNAL)?
        .dyn_into::<js_sys::Promise>()
        .map_err(|_| INTERNAL)?;
    let pipe = js_sys::Reflect::get(stream.as_ref(), &"pipeTo".into())
        .map_err(|_| INTERNAL)?
        .dyn_into::<js_sys::Function>()
        .map_err(|_| INTERNAL)?
        .call1(stream.as_ref(), &sink)
        .map_err(|_| INTERNAL)?
        .dyn_into::<js_sys::Promise>()
        .map_err(|_| INTERNAL)?;
    // 同时订阅两个 Promise，流错误不得成为未处理拒绝或成功摘要。
    // Observe both promises together; a stream error must not become an unhandled rejection or success.
    let (_, digest) = futures_util::try_join!(JsFuture::from(pipe), JsFuture::from(digest))
        .map_err(|_| INTERNAL)?;
    let digest = js_sys::Uint8Array::new(&digest).to_vec();
    if digest.len() != 32 {
        return Err(INTERNAL);
    }
    Ok(format!(
        "sha256:{}",
        digest
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    ))
}

/// 仅 source map 必须进 Rust 做结构校验；明确 8 MiB 内存上界。
/// Only source maps enter Rust for structural validation, with an explicit 8 MiB memory bound.
async fn read_map(stream: web_sys::ReadableStream, expected: u64) -> Result<Vec<u8>, HttpError> {
    if expected > 8 * 1024 * 1024 {
        return Err(INVALID);
    }
    let mut response =
        Response::from_body(worker::ResponseBody::Stream(stream)).map_err(|_| INTERNAL)?;
    let mut stream = response.stream().map_err(|_| INTERNAL)?;
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| INTERNAL)?;
        if bytes.len() as u64 + chunk.len() as u64 > expected {
            return Err(INVALID);
        }
        bytes.extend(chunk);
    }
    if bytes.len() as u64 != expected {
        return Err(INVALID);
    }
    Ok(bytes)
}
/// 验证真实字节并防止HEAD/GET替换。 / Verify actual bytes and detect HEAD/GET substitution.
async fn verify(s: &State<'_>, row: &Value, a: &Artifact, key: &str) -> Result<(), HttpError> {
    let bucket = s.env.bucket("ARTIFACTS").map_err(|_| INTERNAL)?;
    let object = bucket
        .get(key)
        .execute()
        .await
        .map_err(|_| INTERNAL)?
        .ok_or(INVALID)?;
    if object.key() != key
        || object.size() != a.size_bytes
        || object.http_metadata().content_type.as_deref() != Some(&a.media_type)
        || object.custom_metadata().map_err(|_| INTERNAL)? != metadata(row, a)
    {
        return Err(INVALID);
    }
    let version = object.version();
    let worker::ResponseBody::Stream(stream) = object
        .body()
        .ok_or(INVALID)?
        .response_body()
        .map_err(|_| INTERNAL)?
    else {
        return Err(INTERNAL);
    };
    let hash = if a.kind == status_domain::ArtifactKind::SourceMap {
        let branches = stream.tee();
        let hash_stream = branches.get(0).dyn_into().map_err(|_| INTERNAL)?;
        let map_stream = branches.get(1).dyn_into().map_err(|_| INTERNAL)?;
        let (hash, map) = futures_util::try_join!(
            stream_digest(hash_stream),
            read_map(map_stream, a.size_bytes)
        )?;
        validate_map(&map, &a.file_name)?;
        hash
    } else {
        stream_digest(stream).await?
    };
    if hash != a.artifact_digest {
        return Err(INVALID);
    }
    if bucket
        .head(key)
        .await
        .map_err(|_| INTERNAL)?
        .is_none_or(|o| o.version() != version)
    {
        return Err(CONFLICT);
    }
    Ok(())
}
/// 已登记artifact重放。 / Replay an existing committed artifact.
async fn artifact(s: &State<'_>, id: &str, a: &Artifact) -> Result<Option<Value>, HttpError> {
    s.db.first::<Value>(&Query::new("SELECT artifact_id,deployment_id,kind,file_name,media_type,size_bytes,artifact_digest,build_id,created_at AS committed_at FROM deployment_artifacts WHERE deployment_id=? AND kind=? AND file_name=?",vec![id.into(),label(a.kind).into(),a.file_name.clone().into()])).await.map_err(|_|INTERNAL)
}
/// 逐字节验证后原子提交并收敛就绪门禁。 / Atomically commit after byte verification, then reconcile readiness.
async fn commit(
    request: &mut Request,
    deployment_id: &str,
    s: &State<'_>,
) -> Result<(u16, Value), HttpError> {
    let raw: Value = read_json(request, 16384).await?;
    let (a, upload_id) = input(raw, "upload_id")?;
    status_domain::validate_uuid_v7(&upload_id, "upload_id").map_err(|_| INVALID)?;
    let deployment = deployment(deployment_id, s).await?;
    required(s, deployment_id, &a).await?;
    let session =
        s.db.first::<Value>(&Query::new(
            "SELECT * FROM artifact_upload_sessions WHERE upload_id=? AND deployment_id=?",
            vec![upload_id.clone().into(), deployment_id.into()],
        ))
        .await
        .map_err(|_| INTERNAL)?
        .ok_or(INVALID)?;
    if !matches(&session, &a) || !session["content_md5"].is_string() {
        return Err(CONFLICT);
    }
    if session["created_by"].as_str() != Some(s.identity.subject()) {
        return Err(FORBIDDEN);
    }
    if let Some(existing) = artifact(s, deployment_id, &a).await? {
        if !matches(&existing, &a) {
            return Err(CONFLICT);
        }
        ready(s, deployment_id).await?;
        return Ok((200, existing));
    }
    let key = session["object_key"].as_str().ok_or(INTERNAL)?;
    verify(s, &deployment, &a, key).await?;
    let artifact_id = id();
    let queries=[Query::new("INSERT INTO deployment_artifacts(artifact_id,deployment_id,upload_id,kind,object_key,file_name,media_type,size_bytes,artifact_digest,build_id,bundle_path,created_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM deployment_current_status WHERE deployment_id=? AND state NOT IN ('failed','retired'))",vec![artifact_id.clone().into(),deployment_id.into(),upload_id.into(),label(a.kind).into(),key.into(),a.file_name.clone().into(),a.media_type.clone().into(),(a.size_bytes as i64).into(),a.artifact_digest.clone().into(),optional(a.build_id.as_deref()),optional(if a.kind==status_domain::ArtifactKind::SourceMap{a.file_name.strip_suffix(".map")}else{None}),s.now.clone().into(),deployment_id.into()]),Query::new("INSERT INTO audit_log(audit_id,actor_type,actor_subject,actor_roles_json,action,target_type,target_id,correlation_id,occurred_at,details_json) SELECT ?,'machine',?,'[]','deployment.artifact.committed','deployment',?,?,?,'{}' WHERE EXISTS(SELECT 1 FROM deployment_artifacts WHERE artifact_id=?)",vec![id().into(),s.identity.subject().into(),deployment_id.into(),s.correlation.clone().into(),s.now.clone().into(),artifact_id.into()])];
    let status = if s.db.batch(&queries).await.is_ok() {
        201
    } else {
        200
    };
    let existing = artifact(s, deployment_id, &a).await?.ok_or(INTERNAL)?;
    if !matches(&existing, &a) {
        return Err(CONFLICT);
    }
    ready(s, deployment_id).await?;
    Ok((status, existing))
}
/// D1状态触发器是最终并发门禁；审计和状态同事务。 / D1 triggers are the final concurrency gate; audit and status share a transaction.
async fn ready(s: &State<'_>, id: &str) -> Result<(), HttpError> {
    let missing=s.db.first::<Value>(&Query::new("SELECT COUNT(*) AS missing FROM deployment_artifact_requirements r WHERE r.deployment_id=? AND NOT EXISTS(SELECT 1 FROM deployment_artifacts a WHERE a.deployment_id=r.deployment_id AND a.kind=r.kind AND a.file_name=r.file_name AND a.media_type=r.media_type AND a.size_bytes=r.size_bytes AND a.artifact_digest=r.artifact_digest AND a.build_id IS r.build_id)",vec![id.into()])).await.map_err(|_|INTERNAL)?.ok_or(INTERNAL)?;
    if missing["missing"] != 0 {
        return Ok(());
    }
    let row =
        s.db.first::<Value>(&Query::new(
            "SELECT state,revision FROM deployment_current_status WHERE deployment_id=?",
            vec![id.into()],
        ))
        .await
        .map_err(|_| INTERNAL)?
        .ok_or(INTERNAL)?;
    if !["registered", "artifacts_pending"].contains(&row["state"].as_str().unwrap_or("")) {
        return Ok(());
    }
    let revision = row["revision"].as_i64().ok_or(INTERNAL)? + 1;
    let queries=[Query::new("INSERT INTO deployment_status_history(deployment_id,sequence,state,reason,actor_subject,correlation_id,occurred_at) VALUES(?,?,'ready','all required artifacts verified',?,?,?)",vec![id.into(),revision.into(),s.identity.subject().into(),s.correlation.clone().into(),s.now.clone().into()]),audit(s,"deployment.ready",id)];
    if s.db.batch(&queries).await.is_err() {
        let row = deployment(id, s).await?;
        if !["ready", "active"].contains(&row["state"].as_str().unwrap_or("")) {
            return Err(INTERNAL);
        }
    }
    Ok(())
}

/// 仅回收终止部署的过期且未登记对象；永不删除取证产物。
/// Reclaim only expired, uncommitted objects of terminal deployments; never delete forensic artifacts.
///
/// 删除前终止状态阻止新的commit；已登记对象和manifest永久保留。
/// Terminal state prevents new commits before deletion; registered objects/manifests are retained.
pub async fn cleanup(env: &Env) -> worker::Result<()> {
    let db = Database::new(env.d1("DB")?);
    let now = chrono::DateTime::from_timestamp_millis(worker::Date::now().as_millis() as i64)
        .ok_or_else(|| worker::Error::RustError("Invalid clock".into()))?
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let rows=db.all::<Value>(&Query::new("SELECT DISTINCT s.object_key FROM artifact_upload_sessions s JOIN deployment_current_status d USING(deployment_id) WHERE d.state = 'retired' AND (SELECT MAX(expires_at) FROM artifact_upload_sessions latest WHERE latest.object_key=s.object_key)<? AND NOT EXISTS(SELECT 1 FROM deployment_artifacts a WHERE a.object_key=s.object_key) AND NOT EXISTS(SELECT 1 FROM audit_log log WHERE log.action='deployment.artifact.purged' AND log.target_id=s.object_key) LIMIT 100",vec![now.clone().into()])).await.map_err(|_|worker::Error::RustError("Artifact cleanup query failed".into()))?;
    if rows.is_empty() {
        return Ok(());
    }
    let bucket = env.bucket("ARTIFACTS")?;
    for row in rows {
        let key = row["object_key"]
            .as_str()
            .ok_or_else(|| worker::Error::RustError("Artifact cleanup row invalid".into()))?;
        if !key.starts_with("observability/artifacts/sha256/") {
            return Err(worker::Error::RustError(
                "Unsafe artifact cleanup key".into(),
            ));
        }
        bucket.delete(key).await?;
        // 删除后持久墓碑保证批量清理前进；崩溃重试只重复幂等delete。
        // A durable post-delete tombstone ensures batch progress; crash retries repeat only idempotent deletes.
        db.batch(&[Query::new("INSERT INTO audit_log(audit_id,actor_type,actor_subject,actor_roles_json,action,target_type,target_id,correlation_id,occurred_at,details_json) VALUES(?,'system','artifact-retention','[]','deployment.artifact.purged','artifact_object',?,?,?,'{}')",vec![id().into(),key.into(),id().into(),now.clone().into()])]).await.map_err(|_|worker::Error::RustError("Artifact cleanup audit failed".into()))?;
    }
    Ok(())
}

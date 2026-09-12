//! 不可变 Rust Worker 发布事务。 / Immutable Rust Worker release transaction.
//! 注册、受限上传和 ready 门禁先于部署；激活保留 Access admin 审批。
//! Registration, scoped uploads and readiness precede deployment; activation remains admin-approved.

use anyhow::{Context, Result, bail, ensure};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use chrono::{DateTime, Utc};
use md5::Md5;
use reqwest::{Method, Url, blocking::Client};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use status_domain::{Artifact, ArtifactKind, DeploymentManifest, Environment};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

/// 文件输入，不允许秘密或未知字段。 / File declaration; secrets and unknown fields are rejected.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactInput {
    /// 配置目录下的文件路径。 / File path beneath the configuration directory.
    pub path: PathBuf,
    /// 注册表类别。 / Registry kind.
    pub kind: ArtifactKind,
    /// MIME 类型。 / MIME type.
    pub media_type: String,
    /// Wasm 的规范非 custom section 摘要。 / Canonical non-custom-section Wasm digest.
    pub build_id: Option<String>,
}

/// 可审计且不含秘密的发布配置。 / Auditable secret-free release configuration.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReleaseConfig {
    /// 部署 UUIDv7。 / Deployment UUIDv7.
    pub deployment_id: String,
    /// 服务名称。 / Service name.
    pub service_name: String,
    /// 环境。 / Environment.
    pub environment: Environment,
    /// 版本。 / Version.
    pub service_version: String,
    /// HTTPS 源仓库。 / HTTPS source repository.
    pub repository_url: String,
    /// 必须解析到 HEAD 的 ref。 / Ref which must resolve to HEAD.
    pub git_ref: String,
    /// 首次尝试冻结的时间。 / Timestamp frozen on the first attempt.
    pub deployed_at: DateTime<Utc>,
    /// CI 提供者。 / CI provider.
    pub ci_provider: String,
    /// CI 运行身份。 / CI run identity.
    pub ci_run_id: String,
    /// 上传会话尝试编号。 / Upload-session attempt number.
    pub release_attempt: String,
    /// 运行区域。 / Runtime regions.
    pub region: Vec<String>,
    /// 完整运行时及符号文件。 / Complete runtime and symbol files.
    pub artifacts: Vec<ArtifactInput>,
    /// 无二次 build 的 Wrangler 配置。 / Wrangler configuration without a second build.
    pub wrangler_config: PathBuf,
    /// 已构建入口。 / Prebuilt entrypoint.
    pub wrangler_entrypoint: PathBuf,
    /// 必须显式声明 source map 策略。 / Explicit source-map policy.
    pub require_source_map: bool,
    /// Node 执行的 Wrangler JS 入口。 / Wrangler JavaScript entrypoint executed by Node.
    #[serde(default = "default_wrangler")]
    pub wrangler_cli: PathBuf,
}
/// 默认本地固定依赖。 / Default locally pinned dependency.
fn default_wrangler() -> PathBuf {
    "node_modules/wrangler/bin/wrangler.js".into()
}

/// 已哈希的不可变内存快照。 / Hashed immutable in-memory snapshot.
pub struct PreparedArtifact {
    /// 规范路径。 / Canonical path.
    pub path: PathBuf,
    /// 原始字节。 / Original bytes.
    pub bytes: Vec<u8>,
    /// 注册元数据。 / Registration metadata.
    pub declaration: Artifact,
    /// R2 传输 MD5。 / R2 transport MD5.
    pub content_md5: String,
}
/// 返回契约 SHA-256。 / Return the contract SHA-256 representation.
pub fn sha256(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}
/// JSON 对象键递归排序；数组顺序不变。 / Recursively sort JSON object keys without reordering arrays.
pub fn canonical(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<_> = map.keys().collect();
            keys.sort();
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|k| format!("{}:{}", json!(k), canonical(&map[k])))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        Value::Array(items) => format!(
            "[{}]",
            items.iter().map(canonical).collect::<Vec<_>>().join(",")
        ),
        _ => value.to_string(),
    }
}
/// 省略可选 build_id 的 null，匹配 HTTP 契约。 / Omit absent build_id to match the HTTP contract.
fn artifact_value(artifact: &Artifact) -> Result<Value> {
    let mut value = serde_json::to_value(artifact)?;
    if artifact.build_id.is_none() {
        value.as_object_mut().unwrap().remove("build_id");
    }
    Ok(value)
}
/// 限制所有文件都位于发布根内，包含 symlink 检查。 / Constrain all files beneath release root, including symlinks.
fn within(base: &Path, path: &Path) -> Result<PathBuf> {
    let full = fs::canonicalize(base.join(path)).context("release file cannot be resolved")?;
    ensure!(
        full.starts_with(base) && full.is_file(),
        "release path escapes root or is not a file"
    );
    Ok(full)
}
/// 读取严格发布配置并解析根。 / Read strict release configuration and resolve its root.
pub fn read_config(path: &Path) -> Result<(ReleaseConfig, PathBuf)> {
    let path = fs::canonicalize(path).context("cannot resolve release config")?;
    let config: ReleaseConfig =
        serde_json::from_slice(&fs::read(&path)?).context("invalid release configuration")?;
    ensure!(
        !config.release_attempt.starts_with('0')
            && config.release_attempt.len() <= 9
            && config
                .release_attempt
                .bytes()
                .all(|byte| byte.is_ascii_digit())
            && config.release_attempt.parse::<u32>().is_ok(),
        "release_attempt must be positive decimal"
    );
    Ok((config, path.parent().unwrap().to_path_buf()))
}
/// 加载全部字节并校验 JS map 和 Wasm 符号配对。 / Load bytes and validate JS maps and Wasm symbol pairing.
pub fn prepare(config: &ReleaseConfig, base: &Path) -> Result<Vec<PreparedArtifact>> {
    ensure!(!config.artifacts.is_empty(), "artifacts cannot be empty");
    let mut artifacts = Vec::new();
    let mut names = BTreeSet::new();
    for input in &config.artifacts {
        let path = within(base, &input.path)?;
        let name = path
            .file_name()
            .unwrap()
            .to_str()
            .context("non-UTF8 filename")?
            .to_owned();
        let lower = name.to_ascii_lowercase();
        ensure!(
            !lower.starts_with(".env")
                && ![".key", ".pem", ".p12", ".pfx"]
                    .iter()
                    .any(|x| lower.ends_with(x)),
            "secret-shaped artifact rejected"
        );
        ensure!(
            names.insert(name.clone()),
            "artifact filenames must be unique across kinds"
        );
        ensure!(
            fs::metadata(&path)?.len() <= 128 * 1024 * 1024,
            "artifact exceeds 128 MiB client limit"
        );
        let bytes = fs::read(&path)?;
        let declaration = Artifact {
            kind: input.kind,
            file_name: name,
            artifact_digest: sha256(&bytes),
            media_type: input.media_type.clone(),
            size_bytes: bytes.len() as u64,
            build_id: input.build_id.clone(),
        };
        declaration.validate()?;
        if input.kind == ArtifactKind::SourceMap {
            validate_source_map(&bytes, &declaration.file_name)?;
        }
        artifacts.push(PreparedArtifact {
            path,
            content_md5: STANDARD.encode(Md5::digest(&bytes)),
            bytes,
            declaration,
        });
    }
    let entry = within(base, &config.wrangler_entrypoint)?;
    ensure!(
        artifacts.iter().any(|a| a.path == entry
            && matches!(
                a.declaration.kind,
                ArtifactKind::Other | ArtifactKind::Binary
            )),
        "entrypoint must be registered runtime artifact"
    );
    for artifact in &artifacts {
        if ["application/javascript", "text/javascript"]
            .contains(&artifact.declaration.media_type.as_str())
        {
            validate_js_map(artifact, &artifacts)?;
        }
        if artifact.declaration.kind == ArtifactKind::Binary
            && artifact.declaration.media_type == "application/wasm"
        {
            let (identity, _) = wasm_identity(&artifact.bytes)?;
            ensure!(
                artifact.declaration.build_id.as_deref() == Some(identity.as_str()),
                "Wasm build_id must match non-custom sections SHA-256"
            );
            let symbols = artifacts
                .iter()
                .find(|a| {
                    a.declaration.kind == ArtifactKind::DebugSymbols
                        && a.declaration.build_id == artifact.declaration.build_id
                })
                .context("Wasm requires matching debug_symbols")?;
            let (symbol_identity, dwarf) = wasm_identity(&symbols.bytes)?;
            ensure!(
                symbol_identity == identity && dwarf,
                "debug_symbols must contain matching executable Wasm sections and DWARF debug_info"
            );
        }
    }
    ensure!(
        !config.require_source_map
            || artifacts
                .iter()
                .any(|a| a.declaration.kind == ArtifactKind::SourceMap),
        "source map required"
    );
    Ok(artifacts)
}
/// 验证 v3 map 与可复现相对路径。 / Validate v3 maps and reproducible relative source paths.
fn validate_source_map(bytes: &[u8], name: &str) -> Result<()> {
    let map: Value = serde_json::from_slice(bytes).context("source map is not JSON")?;
    ensure!(
        map["version"] == 3 && map["mappings"].is_string(),
        "source map requires version 3 mappings"
    );
    ensure!(
        map.get("file")
            .is_none_or(|v| v.as_str() == name.strip_suffix(".map")),
        "source map file mismatch"
    );
    let sources = map["sources"]
        .as_array()
        .context("source map sources missing")?;
    ensure!(!sources.is_empty(), "source map sources empty");
    for source in sources {
        let source = source.as_str().context("source path must be string")?;
        ensure!(
            !source.is_empty()
                && !source.starts_with(['/', '\\'])
                && !source.contains(':')
                && !source.contains('\\'),
            "unsafe source map path"
        );
    }
    Ok(())
}
/// 检查每个部署 JS 的相邻 sourceMappingURL。 / Check every deployed JS adjacent sourceMappingURL.
fn validate_js_map(js: &PreparedArtifact, artifacts: &[PreparedArtifact]) -> Result<()> {
    let name = format!("{}.map", js.declaration.file_name);
    let map = artifacts
        .iter()
        .find(|a| a.declaration.kind == ArtifactKind::SourceMap && a.declaration.file_name == name)
        .context("JavaScript source map missing")?;
    ensure!(
        map.path.parent() == js.path.parent(),
        "JavaScript map must be adjacent"
    );
    let text = std::str::from_utf8(&js.bytes).context("JavaScript is not UTF-8")?;
    ensure!(
        text.lines()
            .rev()
            .find_map(|line| line.trim().strip_prefix("//# sourceMappingURL="))
            .is_some_and(|url| url == name),
        "JavaScript sourceMappingURL mismatch"
    );
    Ok(())
}
/// 解码受界限约束的 Wasm u32 LEB128。 / Decode bounded Wasm u32 LEB128.
fn leb(bytes: &[u8], offset: &mut usize) -> Result<usize> {
    let mut value = 0u32;
    for shift in (0..35).step_by(7) {
        let byte = *bytes.get(*offset).context("truncated Wasm LEB")?;
        *offset += 1;
        ensure!(shift != 28 || byte < 16, "overflowing Wasm LEB");
        value |= u32::from(byte & 127) << shift;
        if byte & 128 == 0 {
            return Ok(value as usize);
        }
    }
    bail!("invalid Wasm LEB")
}
/// 去除所有 custom sections 后的 Build ID，以及 DWARF 是否存在。
/// Build ID excluding custom sections, plus whether DWARF debug information exists.
pub fn wasm_identity(bytes: &[u8]) -> Result<(String, bool)> {
    ensure!(
        bytes.starts_with(b"\0asm\x01\0\0\0"),
        "debug/runtime artifact must be a Wasm v1 module"
    );
    let mut offset = 8;
    let mut core = bytes[..8].to_vec();
    let mut dwarf = false;
    while offset < bytes.len() {
        let start = offset;
        let kind = bytes[offset];
        offset += 1;
        let size = leb(bytes, &mut offset)?;
        let end = offset
            .checked_add(size)
            .filter(|end| *end <= bytes.len())
            .context("truncated Wasm section")?;
        if kind == 0 {
            let length = leb(&bytes[..end], &mut offset)?;
            let name_end = offset
                .checked_add(length)
                .filter(|n| *n <= end)
                .context("invalid Wasm section name")?;
            dwarf |= &bytes[offset..name_end] == b".debug_info" && name_end < end;
        } else {
            core.extend_from_slice(&bytes[start..end]);
        }
        offset = end;
    }
    Ok((sha256(&core), dwarf))
}
/// 用 Git 命令参数而不是 shell 构造来源。 / Obtain provenance using Git arguments, never a shell.
fn git(base: &Path, args: &[&str]) -> Result<String> {
    let result = Command::new("git")
        .args(args)
        .current_dir(base)
        .output()
        .context("git failed to start")?;
    ensure!(result.status.success(), "git provenance check failed");
    Ok(String::from_utf8(result.stdout)?.trim().to_owned())
}
/// 构建并校验绑定当前干净 Git/CI 来源的 manifest。 / Build a manifest bound to clean current Git/CI provenance.
pub fn manifest(
    config: &ReleaseConfig,
    base: &Path,
    artifacts: &[PreparedArtifact],
) -> Result<Value> {
    ensure!(
        git(base, &["status", "--porcelain", "--untracked-files=no"])?.is_empty(),
        "tracked worktree must be clean"
    );
    let commit = git(base, &["rev-parse", "HEAD"])?;
    ensure!(
        git(
            base,
            &[
                "rev-parse",
                "--verify",
                "--end-of-options",
                &format!("{}^{{commit}}", config.git_ref)
            ]
        )? == commit,
        "git_ref must resolve to HEAD"
    );
    for (env, expected) in [
        (
            "GITHUB_REPOSITORY",
            config
                .repository_url
                .strip_prefix("https://github.com/")
                .unwrap_or(""),
        ),
        ("GITHUB_RUN_ATTEMPT", config.release_attempt.as_str()),
        ("GITHUB_RUN_ID", config.ci_run_id.as_str()),
        ("GITHUB_SHA", commit.as_str()),
    ] {
        if let Ok(actual) = std::env::var(env) {
            ensure!(actual == expected, "CI provenance mismatch for {env}");
        }
    }
    let entry = within(base, &config.wrangler_entrypoint)?;
    let primary = artifacts
        .iter()
        .find(|a| a.path == entry)
        .context("entrypoint missing")?;
    let value = json!({"deployment_id":config.deployment_id,"service_name":config.service_name,"environment":config.environment,"service_version":config.service_version,"repository_url":config.repository_url,"git_commit":commit,"git_ref":config.git_ref,"artifact_digest":primary.declaration.artifact_digest,"ci_provider":config.ci_provider,"ci_run_id":config.ci_run_id,"deployed_at":config.deployed_at.to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"region":config.region,"artifacts":artifacts.iter().map(|a| artifact_value(&a.declaration)).collect::<Result<Vec<_>>>()?});
    serde_json::from_value::<DeploymentManifest>(value.clone())?.validate()?;
    Ok(value)
}

/// 源站安全 URL；禁止重定向与 URL 凭据。 / Secure origin URL; redirects and embedded credentials are forbidden.
fn secure_url(value: &str) -> Result<Url> {
    let url = Url::parse(value).map_err(|_| anyhow::anyhow!("invalid HTTPS URL"))?;
    ensure!(
        url.scheme() == "https"
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.fragment().is_none(),
        "HTTPS without credentials or fragments required"
    );
    Ok(url)
}
/// 预检未验签 claims；服务端仍必须验签。 / Preflight unsigned claims; the server must still verify the signature.
fn validate_token(token: &str, config: &ReleaseConfig) -> Result<()> {
    let parts: Vec<_> = token.split('.').collect();
    ensure!(parts.len() == 3, "machine token must be compact JWT");
    let bytes = URL_SAFE_NO_PAD
        .decode(parts[1])
        .context("invalid JWT payload encoding")?;
    let claims: Value = serde_json::from_slice(&bytes).context("invalid JWT payload")?;
    ensure!(
        claims["deployment_id"] == config.deployment_id
            && claims["service_name"] == config.service_name
            && claims["environment"] == json!(config.environment),
        "JWT deployment claims mismatch"
    );
    let scopes: BTreeSet<_> = claims["scope"]
        .as_str()
        .unwrap_or("")
        .split_whitespace()
        .collect();
    ensure!(
        scopes.contains("deployments:write") && scopes.contains("artifacts:write"),
        "JWT release scopes missing"
    );
    let iat = claims["iat"].as_i64().context("JWT iat missing")?;
    let exp = claims["exp"].as_i64().context("JWT exp missing")?;
    let now = Utc::now().timestamp();
    ensure!(
        iat <= now + 30 && exp > now + 600 && exp > iat && exp - iat <= 900,
        "JWT must have <=15 minute lifetime and >10 minutes remaining"
    );
    Ok(())
}
/// 注册客户端，不导出或记录 bearer 与预签名 URL。 / Registry client; never exports or logs bearer or presigned URLs.
struct Registry {
    /// 不重定向的 HTTP 客户端。 / Non-redirecting HTTP client.
    client: Client,
    /// 注册器基准 URL。 / Registry base URL.
    base: Url,
    /// 短期机器凭据。 / Short-lived machine credential.
    token: String,
}
impl Registry {
    /// 读取环境秘密。 / Read environment secrets.
    fn from_env(config: &ReleaseConfig) -> Result<Self> {
        let base = secure_url(
            &std::env::var("MOE_RELEASE_API_URL").context("MOE_RELEASE_API_URL required")?,
        )?;
        ensure!(base.query().is_none(), "registry URL cannot contain query");
        let token = std::env::var("MOE_MACHINE_JWT").context("MOE_MACHINE_JWT required")?;
        validate_token(&token, config)?;
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(120))
            .build()
            .context("HTTP client initialization failed")?;
        Ok(Self {
            client,
            base,
            token,
        })
    }
    /// 限定 JSON envelope，错误体完全抑制。 / Require a JSON envelope and suppress error bodies entirely.
    fn request(
        &self,
        method: Method,
        path: &str,
        body: &Value,
        key: Option<&str>,
    ) -> Result<Value> {
        let url = self.base.join(path).context("invalid registry endpoint")?;
        let mut request = self
            .client
            .request(method, url)
            .timeout(Duration::from_secs(30))
            .bearer_auth(&self.token)
            .header("content-type", "application/json")
            .body(canonical(body));
        if let Some(key) = key {
            request = request.header("idempotency-key", key);
        }
        let response = request
            .send()
            .map_err(|_| anyhow::anyhow!("registry transport failed (details suppressed)"))?;
        ensure!(
            response.status().is_success(),
            "registry request failed: HTTP {}",
            response.status().as_u16()
        );
        let value: Value = response
            .json()
            .map_err(|_| anyhow::anyhow!("invalid registry response JSON"))?;
        value
            .get("data")
            .filter(|v| v.is_object())
            .cloned()
            .context("registry response lacks data object")
    }
    /// session -> 不可变 PUT -> 服务端验证 commit。 / Session -> immutable PUT -> server-verified commit.
    fn artifact(
        &self,
        path: &str,
        deployment: &str,
        attempt: &str,
        artifact: &PreparedArtifact,
    ) -> Result<()> {
        let body = artifact_value(&artifact.declaration)?;
        let key = format!(
            "release:{deployment}:{attempt}:{}",
            &sha256(canonical(&body).as_bytes())[7..39]
        );
        let mut upload_body = body.clone();
        upload_body["content_md5"] = json!(artifact.content_md5);
        let session = self.request(
            Method::POST,
            &format!("{path}/artifact-uploads"),
            &upload_body,
            Some(&key),
        )?;
        let url = secure_url(
            session["upload_url"]
                .as_str()
                .context("upload URL missing")?,
        )?;
        let expires = DateTime::parse_from_rfc3339(
            session["expires_at"]
                .as_str()
                .context("upload expiry missing")?,
        )
        .context("invalid upload expiry")?;
        ensure!(
            expires > Utc::now(),
            "upload session expired; increment release_attempt"
        );
        let headers = session["required_headers"]
            .as_object()
            .context("upload required_headers missing")?;
        let mut actual = reqwest::header::HeaderMap::new();
        for (key, value) in headers {
            ensure!(
                !["authorization", "cookie", "host", "proxy-authorization"]
                    .contains(&key.to_ascii_lowercase().as_str()),
                "upload session contains forbidden header"
            );
            actual.insert(
                reqwest::header::HeaderName::from_bytes(key.as_bytes())
                    .context("invalid upload header name")?,
                reqwest::header::HeaderValue::from_str(
                    value.as_str().context("invalid upload header value")?,
                )
                .context("invalid upload header value")?,
            );
        }
        let expected = [
            ("content-type", artifact.declaration.media_type.clone()),
            ("content-length", artifact.bytes.len().to_string()),
            ("content-md5", artifact.content_md5.clone()),
            ("x-amz-meta-deployment-id", deployment.into()),
            (
                "x-amz-meta-artifact-digest",
                artifact.declaration.artifact_digest.clone(),
            ),
            (
                "x-amz-meta-artifact-kind",
                serde_json::to_value(artifact.declaration.kind)?
                    .as_str()
                    .unwrap()
                    .to_owned(),
            ),
            (
                "x-amz-meta-artifact-file-name",
                artifact.declaration.file_name.clone(),
            ),
            ("if-none-match", "*".into()),
        ];
        for (name, value) in expected {
            ensure!(
                actual.get(name).and_then(|h| h.to_str().ok()) == Some(value.as_str()),
                "upload headers do not match immutable artifact"
            );
        }
        let response = self
            .client
            .put(url)
            .headers(actual)
            .body(artifact.bytes.clone())
            .send()
            .map_err(|_| {
                anyhow::anyhow!("artifact upload transport failed (details suppressed)")
            })?;
        ensure!(
            response.status().is_success() || response.status().as_u16() == 412,
            "artifact upload failed: HTTP {}",
            response.status().as_u16()
        );
        let mut commit = body;
        commit["upload_id"] = json!(session["upload_id"].as_str().context("upload_id missing")?);
        self.request(Method::POST, &format!("{path}/artifacts"), &commit, None)?;
        Ok(())
    }
    /// ready 必须来自最后一次服务器重算。 / Readiness must come from final server recomputation.
    fn register(
        &self,
        config: &ReleaseConfig,
        manifest: &Value,
        artifacts: &[PreparedArtifact],
    ) -> Result<()> {
        let path = format!("/v1/deployments/{}", config.deployment_id);
        self.request(Method::PUT, &path, manifest, None)?;
        for artifact in artifacts {
            self.artifact(
                &path,
                &config.deployment_id,
                &config.release_attempt,
                artifact,
            )?;
        }
        let ready = self.request(Method::PUT, &path, manifest, None)?;
        ensure!(
            ready["state"] == "ready",
            "deployment readiness gate failed"
        );
        Ok(())
    }
}
/// 检查部署前文件未被更改。 / Verify files have not changed before deployment.
fn unchanged(artifacts: &[PreparedArtifact]) -> Result<()> {
    for artifact in artifacts {
        ensure!(
            fs::read(&artifact.path)? == artifact.bytes,
            "artifact changed after provenance registration"
        );
    }
    Ok(())
}
/// 独立的冻结部署目录，防止注册期间 workspace 新增模块绕过摘要门禁。
/// Isolated frozen deployment directory preventing workspace additions from bypassing the digest gate.
struct Snapshot {
    /// 自动清理且不暴露给构建步骤的私有目录。 / Private directory automatically cleaned and not exposed to build steps.
    directory: tempfile::TempDir,
    /// 冻结入口。 / Frozen entrypoint.
    entry: PathBuf,
    /// 冻结平台配置。 / Frozen platform configuration.
    configuration: PathBuf,
    /// 固定工具位置；工具链仍属于受信 runner。 / Pinned tool location; toolchain remains part of the trusted runner.
    cli: PathBuf,
}
impl Snapshot {
    /// 只复制清单内的 runtime/map，保留 import 和 map 的相对目录关系。
    /// Copy only declared runtime/maps while preserving relative import and map layout.
    fn new(config: &ReleaseConfig, base: &Path, artifacts: &[PreparedArtifact]) -> Result<Self> {
        let original_config = within(base, &config.wrangler_config)?;
        let mut parsed: Value = json5::from_str(&fs::read_to_string(original_config)?)
            .context("invalid Wrangler JSON/JSONC configuration")?;
        for field in [
            "build",
            "assets",
            "site",
            "wasm_modules",
            "text_blobs",
            "data_blobs",
            "env",
            "alias",
            "tsconfig",
            "python_modules",
            "unsafe",
        ] {
            ensure!(
                parsed.get(field).is_none(),
                "release config contains unsupported build, environment or external-file mechanism: {field}"
            );
        }
        let original_entry = within(base, &config.wrangler_entrypoint)?;
        let original_root = original_entry
            .parent()
            .context("entrypoint parent missing")?;
        let directory =
            tempfile::tempdir().context("cannot create immutable deployment snapshot")?;
        let runtime = directory.path().join("runtime");
        fs::create_dir(&runtime)?;
        for artifact in artifacts.iter().filter(|a| {
            matches!(
                a.declaration.kind,
                ArtifactKind::Binary | ArtifactKind::Other | ArtifactKind::SourceMap
            )
        }) {
            let relative = artifact
                .path
                .strip_prefix(original_root)
                .context("all runtime modules and maps must be beneath the entrypoint directory")?;
            let destination = runtime.join(relative);
            fs::create_dir_all(
                destination
                    .parent()
                    .context("snapshot file parent missing")?,
            )?;
            fs::write(destination, &artifact.bytes)?;
        }
        let entry = runtime.join(
            original_entry
                .file_name()
                .context("entrypoint filename missing")?,
        );
        parsed["main"] = json!(entry);
        parsed["base_dir"] = json!(runtime);
        parsed["find_additional_modules"] = json!(true);
        let configuration = directory.path().join("wrangler.json");
        fs::write(&configuration, serde_json::to_vec(&parsed)?)?;
        Ok(Self {
            directory,
            entry,
            configuration,
            cli: within(base, &config.wrangler_cli)?,
        })
    }
}
/// 构造不经过 shell 的 Wrangler 参数，仅使用同一冻结快照。
/// Construct shell-free Wrangler arguments using only the same frozen snapshot.
fn wrangler(
    config: &ReleaseConfig,
    snapshot: &Snapshot,
    manifest: &Value,
    artifacts: &[PreparedArtifact],
    dry_run: bool,
    bootstrap: bool,
) -> Result<()> {
    let mut command = Command::new("node");
    command
        .arg(&snapshot.cli)
        .arg("deploy")
        .arg(&snapshot.entry)
        .args([
            "--no-bundle",
            "--upload-source-maps",
            "--strict",
            "--config",
        ])
        .arg(&snapshot.configuration);
    for (key, value) in [
        ("DEPLOYMENT_ID", manifest["deployment_id"].as_str().unwrap()),
        ("GIT_COMMIT", manifest["git_commit"].as_str().unwrap()),
        (
            "ARTIFACT_DIGEST",
            manifest["artifact_digest"].as_str().unwrap(),
        ),
        ("STATUS_VERSION", config.service_version.as_str()),
        ("ENVIRONMENT", manifest["environment"].as_str().unwrap()),
        ("BOOTSTRAP_MODE", if bootstrap { "true" } else { "false" }),
    ] {
        command.arg("--var").arg(format!("{key}:{value}"));
    }
    let output_dir = tempfile::tempdir().context("cannot create bundle audit directory")?;
    if dry_run {
        command
            .arg("--dry-run")
            .arg("--outdir")
            .arg(output_dir.path());
    }
    command
        .current_dir(snapshot.directory.path())
        .env_remove("CLOUDFLARE_ENV")
        .env_remove("MOE_MACHINE_JWT")
        .env_remove("MOE_BOOTSTRAP_ACK");
    // 子进程日志可能带平台秘密，因此只报告退出状态。 / Child logs can contain platform secrets; report exit status only.
    let result = command.output().context("Wrangler failed to start")?;
    ensure!(
        result.status.success(),
        "Wrangler failed; child output suppressed to protect secrets"
    );
    if dry_run {
        let mut seen = BTreeSet::new();
        audit_bundle(output_dir.path(), artifacts, &mut seen)?;
        for artifact in artifacts.iter().filter(|a| {
            matches!(
                a.declaration.kind,
                ArtifactKind::Binary | ArtifactKind::Other
            )
        }) {
            ensure!(
                seen.contains(&artifact.declaration.file_name),
                "declared runtime missing from Wrangler output"
            );
        }
    }
    Ok(())
}
/// 执行完整发布，或显式只启动拒绝业务的 bootstrap 注册器。
/// Perform a complete release, or explicitly bootstrap a registry which rejects business traffic.
///
/// `--bootstrap-only` 之后必须重新运行正常发布完成 ready；不自动激活。
/// After `--bootstrap-only`, rerun normal release to reach ready; activation is never automatic.
pub fn release(
    config: &ReleaseConfig,
    base: &Path,
    artifacts: &[PreparedArtifact],
    manifest: &Value,
    dry_run: bool,
    bootstrap: bool,
) -> Result<()> {
    ensure!(
        self::manifest(config, base, artifacts)? == *manifest,
        "release manifest does not match current Git/config/artifacts"
    );
    unchanged(artifacts)?;
    let snapshot = Snapshot::new(config, base, artifacts)?;
    // 本地预检也必须发生在网络注册之前。 / Local preflight must also precede registry writes.
    wrangler(config, &snapshot, manifest, artifacts, true, bootstrap)?;
    if dry_run {
        println!("local Wrangler dry-run passed; no registry or deployment writes");
        return Ok(());
    }
    ensure!(
        std::env::var("CLOUDFLARE_API_TOKEN").is_ok_and(|token| token.len() >= 16),
        "CLOUDFLARE_API_TOKEN environment secret required for deployment"
    );
    if bootstrap {
        ensure!(
            std::env::var("MOE_BOOTSTRAP_ACK").ok().as_deref()
                == Some("I_ACKNOWLEDGE_FIRST_DEPLOYMENT_ONLY"),
            "bootstrap requires MOE_BOOTSTRAP_ACK=I_ACKNOWLEDGE_FIRST_DEPLOYMENT_ONLY"
        );
        ensure!(
            config.service_name == "status",
            "bootstrap is restricted to the status registry service"
        );
        wrangler(config, &snapshot, manifest, artifacts, false, true)?;
        println!(
            "bootstrap registry deployed with business traffic disabled; provision secrets then run normal release"
        );
        return Ok(());
    }
    let registry = Registry::from_env(config)?;
    registry.register(config, manifest, artifacts)?;
    wrangler(config, &snapshot, manifest, artifacts, false, false)?;
    println!(
        "deployment completed after ready gate; Access admin activation remains pending smoke/canary approval"
    );
    Ok(())
}

/// 对 dry-run 实际上传字节逐个核对，禁止遗漏模块或二次转换。
/// Match every dry-run module against registered bytes; reject omissions or transformations.
fn audit_bundle(
    dir: &Path,
    artifacts: &[PreparedArtifact],
    seen: &mut BTreeSet<String>,
) -> Result<()> {
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_dir() {
            audit_bundle(&path, artifacts, seen)?;
            continue;
        }
        if path.file_name().is_some_and(|name| name == "README.md") {
            continue;
        }
        let bytes = fs::read(&path)?;
        ensure!(
            artifacts
                .iter()
                .any(|a| a.path.file_name() == path.file_name() && a.bytes == bytes),
            "Wrangler dry-run output contains unregistered or transformed bytes"
        );
        seen.insert(path.file_name().unwrap().to_string_lossy().into_owned());
    }
    Ok(())
}

/// 从最终 SDK Wasm 分离 DWARF；只删除 .debug_*，保留 name/producers。
/// Split DWARF from final SDK Wasm, removing only .debug_* and preserving name/producers.
/// 返回 `(runtime, build_id)`；原输入即 debug_symbols，应单独保存。
/// Returns `(runtime, build_id)`; save the original input separately as debug_symbols.
///
/// ```no_run
/// # fn main() -> anyhow::Result<()> {
/// let symbols = std::fs::read("build/worker_bg.wasm")?;
/// let (runtime, build_id) = status_release::split_wasm(&symbols)?;
/// std::fs::write("dist/worker_bg.wasm", runtime)?;
/// std::fs::write("symbols/worker_bg.debug.wasm", symbols)?;
/// // 两份声明使用同一个 ID。 / Use this ID for both declarations.
/// assert!(build_id.starts_with("sha256:"));
/// # Ok(())
/// # }
/// ```
pub fn split_wasm(bytes: &[u8]) -> Result<(Vec<u8>, String)> {
    let (identity, dwarf) = wasm_identity(bytes)?;
    ensure!(
        dwarf,
        "Wasm has no DWARF .debug_info; rebuild with debug=2 and wasm-bindgen --keep-debug"
    );
    let mut output = bytes[..8].to_vec();
    let mut offset = 8;
    while offset < bytes.len() {
        let start = offset;
        let kind = bytes[offset];
        offset += 1;
        let size = leb(bytes, &mut offset)?;
        let end = offset + size;
        let mut debug = false;
        if kind == 0 {
            let length = leb(&bytes[..end], &mut offset)?;
            debug = bytes[offset..offset + length].starts_with(b".debug_");
        }
        if !debug {
            output.extend_from_slice(&bytes[start..end]);
        }
        offset = end;
    }
    ensure!(
        wasm_identity(&output)?.0 == identity,
        "Wasm split changed executable sections"
    );
    Ok((output, identity))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::Arc,
        thread,
    };

    /// 可选实际 Wrangler 本地打包验证；需要 pnpm install。 / Optional real local Wrangler audit; requires pnpm install.
    #[test]
    #[ignore = "requires installed Wrangler; run explicitly"]
    fn real_wrangler_no_bundle_audit() {
        let root = fs::canonicalize(Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")).unwrap();
        let dir = tempfile::tempdir_in(&root).unwrap();
        fs::write(dir.path().join("worker.js"), "export default {fetch(){return new Response('ok')}};\n//# sourceMappingURL=worker.js.map\n").unwrap();
        fs::write(
            dir.path().join("worker.js.map"),
            r#"{"version":3,"file":"worker.js","sources":["src/lib.rs"],"mappings":"AAAA"}"#,
        )
        .unwrap();
        fs::write(
            dir.path().join("wrangler.jsonc"),
            r#"{"name":"status-release-local-audit","compatibility_date":"2026-09-12"}"#,
        )
        .unwrap();
        let mut config = config();
        config.wrangler_entrypoint = dir.path().join("worker.js");
        config.wrangler_config = dir.path().join("wrangler.jsonc");
        config.artifacts = serde_json::from_value(json!([
            {"path":dir.path().join("worker.js"),"kind":"other","media_type":"text/javascript"},
            {"path":dir.path().join("worker.js.map"),"kind":"source_map","media_type":"application/json"}
        ])).unwrap();
        let artifacts = prepare(&config, &root).unwrap();
        let manifest = json!({"deployment_id":config.deployment_id,"git_commit":"0123456789abcdef0123456789abcdef01234567","artifact_digest":artifacts[0].declaration.artifact_digest,"environment":"production"});
        let snapshot = Snapshot::new(&config, &root, &artifacts).unwrap();
        // 创建额外模块并破坏原字节，快照仍只上传原已登记字节。
        // Add an extra module and mutate original bytes; snapshot still uploads only registered originals.
        fs::write(
            dir.path().join("extra.js"),
            "export default 'unregistered';",
        )
        .unwrap();
        fs::write(dir.path().join("worker.js"), "mutated workspace").unwrap();
        wrangler(&config, &snapshot, &manifest, &artifacts, true, false).unwrap();
    }

    /// 可复用的无秘密配置。 / Reusable secret-free configuration.
    fn config() -> ReleaseConfig {
        serde_json::from_value(json!({"deployment_id":"0199d09a-b692-7ce0-a1c0-5138a43d7402","service_name":"status","environment":"production","service_version":"1","repository_url":"https://github.com/moesegfault/status","git_ref":"HEAD","deployed_at":"2026-09-12T00:00:00Z","ci_provider":"github-actions","ci_run_id":"1","release_attempt":"1","region":["global"],"artifacts":[],"wrangler_config":"wrangler.jsonc","wrangler_entrypoint":"worker.js","require_source_map":true})).unwrap()
    }
    /// 真实文件 fixture。 / Real-file fixture.
    fn fixture() -> (tempfile::TempDir, ReleaseConfig, Vec<PreparedArtifact>) {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("worker.js"),
            b"export default {};\n//# sourceMappingURL=worker.js.map\n",
        )
        .unwrap();
        fs::write(
            dir.path().join("worker.js.map"),
            br#"{"version":3,"file":"worker.js","sources":["src/lib.rs"],"mappings":"AAAA"}"#,
        )
        .unwrap();
        let mut config = config();
        config.artifacts = serde_json::from_value(json!([{ "path":"worker.js", "kind":"other", "media_type":"text/javascript" }, { "path":"worker.js.map", "kind":"source_map", "media_type":"application/json" }])).unwrap();
        let base = fs::canonicalize(dir.path()).unwrap();
        let artifacts = prepare(&config, &base).unwrap();
        (dir, config, artifacts)
    }
    #[test]
    fn hashes_are_real_and_optional_fields_are_omitted() {
        assert_eq!(
            sha256(b"abc"),
            "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            STANDARD.encode(Md5::digest(b"abc")),
            "kAFQmDzST7DWlj99KOF/cg=="
        );
        let (_, _, artifacts) = fixture();
        assert!(
            artifact_value(&artifacts[0].declaration)
                .unwrap()
                .get("build_id")
                .is_none()
        );
        assert_eq!(
            canonical(&json!({"z":1,"a":{"b":2,"a":1}})),
            r#"{"a":{"a":1,"b":2},"z":1}"#
        );
    }
    #[test]
    fn maps_paths_and_mutation_fail_closed() {
        let (dir, config, artifacts) = fixture();
        fs::write(dir.path().join("worker.js"), "changed").unwrap();
        assert!(unchanged(&artifacts).is_err());
        assert!(prepare(&config, &fs::canonicalize(dir.path()).unwrap()).is_err());
        assert!(
            validate_source_map(
                br#"{"version":3,"sources":["C:/secret"],"mappings":""}"#,
                "worker.js.map"
            )
            .is_err()
        );
        assert!(secure_url("http://example.com").is_err());
        assert!(secure_url("https://secret@example.com").is_err());
        assert!(secure_url("https://example.com/#secret").is_err());
    }
    #[test]
    fn snapshot_isolated_from_workspace_mutation_and_external_file_channels() {
        let (dir, mut config, artifacts) = fixture();
        config.wrangler_cli = "wrangler.js".into();
        fs::write(dir.path().join("wrangler.js"), "toolchain").unwrap();
        fs::write(dir.path().join("wrangler.jsonc"), "{}").unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        let snapshot = Snapshot::new(&config, &root, &artifacts).unwrap();
        fs::write(dir.path().join("worker.js"), "changed").unwrap();
        fs::write(dir.path().join("extra.wasm"), b"unregistered").unwrap();
        assert_eq!(fs::read(&snapshot.entry).unwrap(), artifacts[0].bytes);
        assert!(!snapshot.entry.parent().unwrap().join("extra.wasm").exists());
        fs::write(
            dir.path().join("wrangler.jsonc"),
            r#"{"assets":{"directory":"outside"}}"#,
        )
        .unwrap();
        assert!(Snapshot::new(&config, &root, &artifacts).is_err());
        let frozen: Value =
            serde_json::from_slice(&fs::read(&snapshot.configuration).unwrap()).unwrap();
        assert!(frozen.get("assets").is_none());
    }
    #[test]
    fn wasm_split_preserves_code_and_non_debug_custom_sections() {
        let mut bytes = b"\0asm\x01\0\0\0".to_vec();
        bytes.extend_from_slice(&[1, 1, 0]);
        bytes.extend_from_slice(&[0, 13, 11]);
        bytes.extend_from_slice(b".debug_info");
        bytes.push(1);
        bytes.extend_from_slice(&[0, 6, 4]);
        bytes.extend_from_slice(b"name");
        bytes.push(0);
        let (runtime, id) = split_wasm(&bytes).unwrap();
        assert_eq!(wasm_identity(&runtime).unwrap(), (id, false));
        assert!(runtime.windows(4).any(|b| b == b"name"));
        assert!(split_wasm(&runtime).is_err());
        assert!(wasm_identity(&bytes[..bytes.len() - 1]).is_err());
    }
    #[test]
    fn token_lifetime_and_identity_are_enforced() {
        let config = config();
        let now = Utc::now().timestamp();
        let mut claims = json!({"deployment_id":config.deployment_id,"service_name":"status","environment":"production","scope":"deployments:write artifacts:write","iat":now,"exp":now+899});
        let token = |value: &Value| {
            format!(
                "e30.{}.signature",
                URL_SAFE_NO_PAD.encode(value.to_string())
            )
        };
        assert!(validate_token(&token(&claims), &config).is_ok());
        claims["exp"] = json!(now + 901);
        assert!(validate_token(&token(&claims), &config).is_err());
        claims["exp"] = json!(now + 500);
        assert!(validate_token(&token(&claims), &config).is_err());
        claims["exp"] = json!(now + 899);
        claims["service_name"] = json!("wrong");
        assert!(validate_token(&token(&claims), &config).is_err());
    }
    /// 单连接 HTTPS 测试服务器，完整读取 HTTP body。 / One-request HTTPS test server reading the full HTTP body.
    fn read_request(stream: &mut impl Read) -> (String, Vec<u8>) {
        let mut bytes = Vec::new();
        let mut byte = [0];
        while !bytes.ends_with(b"\r\n\r\n") {
            stream.read_exact(&mut byte).unwrap();
            bytes.push(byte[0]);
        }
        let headers = String::from_utf8(bytes).unwrap();
        let length = headers
            .lines()
            .find_map(|line| {
                line.to_ascii_lowercase()
                    .strip_prefix("content-length: ")
                    .map(|s| s.parse::<usize>().unwrap())
            })
            .unwrap_or(0);
        let mut body = vec![0; length];
        stream.read_exact(&mut body).unwrap();
        (headers, body)
    }
    #[test]
    fn real_https_registration_upload_commit_ready_and_412() {
        for scenario in [
            "success",
            "existing",
            "not-ready",
            "expired",
            "checksum",
            "put-failed",
            "commit-failed",
            "redirect",
        ] {
            let steps = match scenario {
                "expired" | "checksum" => 2,
                "put-failed" | "redirect" => 3,
                "commit-failed" => 4,
                _ => 5,
            };
            let upload_status = match scenario {
                "existing" => 412,
                "put-failed" => 503,
                "redirect" => 307,
                _ => 200,
            };
            let (_, config, mut artifacts) = fixture();
            artifacts.truncate(1);
            let expected_bytes = artifacts[0].bytes.clone();
            let declaration = artifact_value(&artifacts[0].declaration).unwrap();
            let md5 = artifacts[0].content_md5.clone();
            let certificate = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
            let cert_der = certificate.cert.der().clone();
            let key =
                rustls::pki_types::PrivatePkcs8KeyDer::from(certificate.key_pair.serialize_der());
            let tls = Arc::new(
                rustls::ServerConfig::builder()
                    .with_no_client_auth()
                    .with_single_cert(vec![cert_der.clone()], key.into())
                    .unwrap(),
            );
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let base = format!(
                "https://localhost:{}",
                listener.local_addr().unwrap().port()
            );
            let upload_url = format!("{base}/upload?signature=do-not-log");
            let deployment = config.deployment_id.clone();
            let server = thread::spawn(move || {
                for step in 0..steps {
                    let (socket, _) = listener.accept().unwrap();
                    socket
                        .set_read_timeout(Some(Duration::from_secs(10)))
                        .unwrap();
                    let mut stream = rustls::StreamOwned::new(
                        rustls::ServerConnection::new(tls.clone()).unwrap(),
                        socket,
                    );
                    let (headers, body) = read_request(&mut stream);
                    let mut response = match step {
                        0 => {
                            assert!(headers.starts_with("PUT /v1/deployments/"));
                            json!({"data":{"state":"registered"}})
                        }
                        1 => {
                            assert!(headers.contains("idempotency-key: release:"));
                            assert_eq!(
                                serde_json::from_slice::<Value>(&body).unwrap()["content_md5"],
                                md5
                            );
                            json!({"data":{"upload_id":"upload-1","upload_url":upload_url,"expires_at":(Utc::now()+chrono::Duration::minutes(10)).to_rfc3339(),"required_headers":{"content-type":declaration["media_type"],"content-length":expected_bytes.len().to_string(),"content-md5":md5,"x-amz-meta-deployment-id":deployment,"x-amz-meta-artifact-digest":declaration["artifact_digest"],"x-amz-meta-artifact-kind":"other","x-amz-meta-artifact-file-name":"worker.js","if-none-match":"*"}}})
                        }
                        2 => {
                            assert!(headers.starts_with("PUT /upload?"));
                            assert!(!headers.contains("authorization:"));
                            assert_eq!(body, expected_bytes);
                            json!({})
                        }
                        3 => {
                            assert_eq!(
                                serde_json::from_slice::<Value>(&body).unwrap()["upload_id"],
                                "upload-1"
                            );
                            json!({"data":declaration})
                        }
                        _ => json!({"data":{"state":"ready"}}),
                    };
                    if scenario == "expired" && step == 1 {
                        response["data"]["expires_at"] =
                            json!((Utc::now() - chrono::Duration::minutes(1)).to_rfc3339());
                    }
                    if scenario == "checksum" && step == 1 {
                        response["data"]["required_headers"]["content-md5"] = json!("wrong");
                    }
                    if scenario == "not-ready" && step == 4 {
                        response["data"]["state"] = json!("registered");
                    }
                    let status = if step == 2 {
                        upload_status
                    } else if step == 3 && scenario == "commit-failed" {
                        409
                    } else {
                        200
                    };
                    let text = response.to_string();
                    write!(stream,"HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",text.len()).unwrap();
                    stream.flush().unwrap();
                }
            });
            let client = Client::builder()
                .add_root_certificate(reqwest::Certificate::from_der(&cert_der).unwrap())
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(10))
                .build()
                .unwrap();
            let registry = Registry {
                client,
                base: Url::parse(&base).unwrap(),
                token: "private-test-token".into(),
            };
            let result = registry.register(
                &config,
                &json!({"deployment_id":config.deployment_id}),
                &artifacts,
            );
            assert_eq!(
                result.is_ok(),
                matches!(scenario, "success" | "existing"),
                "scenario {scenario}: {result:?}"
            );
            server.join().unwrap();
        }
    }
}

//! 不可变 Rust Worker 发布事务。 / Immutable Rust Worker release transaction.
//! 注册、受限上传和 ready 门禁先于部署；激活保留管理员审批。
//! Registration, scoped uploads and readiness precede deployment; activation remains administrator-approved.

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
    io::Read,
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
    /// 静态站点内的相对 URL 路径；缺省表示 Worker 模块或私有符号。
    /// Relative static-site URL path; absent for Worker modules or private symbols.
    pub asset_path: Option<String>,
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
    /// 绑定静态 URL 路径、MIME 和字节的 manifest 产物路径。
    /// Manifest artifact binding static URL paths, MIME types and exact bytes.
    pub asset_manifest: Option<PathBuf>,
    /// 固定机器令牌 issuer origin；仅从环境私钥签发时必需。
    /// Pinned machine-token issuer origin; required when minting from an environment private key.
    pub status_origin: Option<String>,
    /// 仓库内受审查的公共 JWKS 文件。 / Reviewed public JWKS file inside the repository.
    #[serde(default = "default_machine_jwks")]
    pub machine_jwks: PathBuf,
}
/// 默认公共密钥路径。 / Default public key path.
fn default_machine_jwks() -> PathBuf {
    "config/machine-jwks.json".into()
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
    /// 静态资产路径，不进入 Worker 模块集合。 / Static asset path, excluded from Worker modules.
    pub asset_path: Option<String>,
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
            fs::metadata(&path)?.len() <= 64 * 1024 * 1024,
            "artifact exceeds 64 MiB client limit"
        );
        if input.kind == ArtifactKind::SourceMap {
            ensure!(
                fs::metadata(&path)?.len() <= 8 * 1024 * 1024,
                "source map exceeds 8 MiB client limit"
            );
        }
        let bytes = fs::read(&path)?;
        if let Some(asset_path) = &input.asset_path {
            asset_record(asset_path, &input.media_type, &bytes)?;
            ensure!(
                matches!(input.kind, ArtifactKind::Other | ArtifactKind::SourceMap),
                "static assets must retain other/source_map classification"
            );
        }
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
            asset_path: input.asset_path.clone(),
        });
    }
    let entry = within(base, &config.wrangler_entrypoint)?;
    ensure!(
        artifacts.iter().any(|a| a.path == entry
            && a.asset_path.is_none()
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
    validate_asset_manifest(config, base, &artifacts)?;
    Ok(artifacts)
}

/// 校验静态路径并生成可独立审计的内容记录；路径从不作为 shell 参数拼接。
/// Validate a static path and produce an auditable content record; paths are never shell-interpolated.
pub fn asset_record(path: &str, media_type: &str, bytes: &[u8]) -> Result<Value> {
    ensure!(
        !path.is_empty()
            && path.split('/').all(|part| !part.is_empty()
                && part != "."
                && part != ".."
                && part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._+-".contains(&b))),
        "unsafe static asset URL path"
    );
    ensure!(
        !path
            .split('/')
            .any(|part| part.starts_with('.') || ["_headers", "_redirects"].contains(&part)),
        "static asset control/hidden files are not supported"
    );
    ensure!(
        !bytes.is_empty() && bytes.len() <= 25 * 1024 * 1024,
        "static asset must contain 1 byte to 25 MiB"
    );
    ensure!(
        asset_media_type(path)? == media_type,
        "static asset MIME does not match its reviewed file type"
    );
    Ok(
        json!({"path":path,"media_type":media_type,"artifact_digest":sha256(bytes),"size_bytes":bytes.len()}),
    )
}
/// 静态资源使用明确审核的真实 MIME；未知格式失败，不伪装成通用二进制。
/// Use explicitly reviewed real static MIME types; unknown formats fail instead of masquerading as binary.
pub fn asset_media_type(path: &str) -> Result<&'static str> {
    let extension = Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let media = match extension.to_ascii_lowercase().as_str() {
        "html" => "text/html",
        "css" => "text/css",
        "js" | "mjs" => "text/javascript",
        "map" | "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        "txt" => "text/plain",
        "xml" => "application/xml",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        "" if path == "CNAME" => "text/plain",
        _ => bail!("unsupported static asset MIME; add an explicit reviewed mapping"),
    };
    Ok(media)
}
/// 将静态资产集合与已登记 manifest 严格绑定。
/// Bind the complete static asset set to its registered manifest.
fn validate_asset_manifest(
    config: &ReleaseConfig,
    base: &Path,
    artifacts: &[PreparedArtifact],
) -> Result<()> {
    let mut entries = Vec::new();
    let mut paths = BTreeSet::new();
    for artifact in artifacts {
        if let Some(path) = &artifact.asset_path {
            ensure!(paths.insert(path), "duplicate static asset path");
            entries.push(asset_record(
                path,
                &artifact.declaration.media_type,
                &artifact.bytes,
            )?);
        }
    }
    if entries.is_empty() {
        ensure!(
            config.asset_manifest.is_none(),
            "asset manifest declared without assets"
        );
        return Ok(());
    }
    entries.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
    let manifest_path = within(
        base,
        config
            .asset_manifest
            .as_deref()
            .context("static assets require asset_manifest")?,
    )?;
    let declaration = artifacts
        .iter()
        .find(|a| {
            a.path == manifest_path
                && a.declaration.kind == ArtifactKind::Manifest
                && a.asset_path.is_none()
        })
        .context("asset_manifest must be a registered manifest artifact")?;
    let actual: Value =
        serde_json::from_slice(&declaration.bytes).context("invalid static asset manifest JSON")?;
    ensure!(
        actual == json!({"schema_version":1,"files":entries}),
        "static asset manifest differs from actual paths/MIME/bytes"
    );
    Ok(())
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
/// 仅允许精确的同源上传能力路径，绝不把 bearer 发给注册表指定的其他目标。
/// Accept only the exact same-origin upload capability path; never forward bearer to another target.
fn native_upload_url(base: &Url, value: &str, deployment: &str, upload: &str) -> Result<Url> {
    ensure!(
        [deployment, upload]
            .iter()
            .all(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')),
        "invalid upload capability identifier"
    );
    let url = secure_url(value)?;
    let mut expected = base.clone();
    expected.set_path("/");
    expected.set_query(None);
    expected.set_fragment(None);
    expected
        .path_segments_mut()
        .map_err(|_| anyhow::anyhow!("invalid registry origin"))?
        .clear()
        .extend(["v1", "deployments", deployment, "artifact-uploads", upload]);
    ensure!(
        url.origin() == base.origin()
            && url.query().is_none()
            && url.path() == expected.path()
            && value == expected.as_str(),
        "upload URL must be the exact same-origin capability endpoint"
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
/// 从环境私钥签发短期机器JWT；公钥参数与唯一受信kid匹配后再签名并自验。
/// Mint a short-lived machine JWT from an environment key; match public parameters and a unique trusted kid, then sign and self-verify.
fn mint_machine_token(
    config: &ReleaseConfig,
    api_origin: &str,
    private_pem: &[u8],
    jwks: &[u8],
) -> Result<String> {
    use jsonwebtoken::{
        Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode, jwk::Jwk,
    };
    let issuer = config
        .status_origin
        .as_deref()
        .context("status_origin required to mint machine JWT")?;
    let origin = secure_url(issuer)?;
    ensure!(
        issuer == api_origin,
        "minted machine JWT issuer must equal MOE_RELEASE_API_URL origin"
    );
    ensure!(
        origin.origin().ascii_serialization() == issuer,
        "status_origin must be a canonical HTTPS origin without path or trailing slash"
    );
    let key = EncodingKey::from_rsa_pem(private_pem)
        .map_err(|_| anyhow::anyhow!("invalid RSA private-key PEM"))?;
    let derived = Jwk::from_encoding_key(&key, Algorithm::RS256)
        .map_err(|_| anyhow::anyhow!("cannot derive RSA public parameters"))?;
    let public = serde_json::to_value(&derived).context("cannot encode RSA public parameters")?;
    let modulus = URL_SAFE_NO_PAD
        .decode(public["n"].as_str().context("RSA modulus missing")?)
        .context("invalid RSA modulus")?;
    let modulus_bits = modulus.len() * 8
        - modulus
            .first()
            .context("RSA modulus empty")?
            .leading_zeros() as usize;
    ensure!(
        modulus_bits >= 3072,
        "release signing key must be at least RSA-3072"
    );
    let document: Value = serde_json::from_slice(jwks).context("invalid public machine JWKS")?;
    let keys = document["keys"]
        .as_array()
        .context("public machine JWKS keys missing")?;
    let mut identifiers = BTreeSet::new();
    let mut matches = Vec::new();
    for candidate in keys {
        let kid = candidate["kid"]
            .as_str()
            .filter(|kid| !kid.is_empty())
            .context("JWKS key requires kid")?;
        ensure!(identifiers.insert(kid), "JWKS contains duplicate kid");
        ensure!(
            ["d", "p", "q", "dp", "dq", "qi"]
                .iter()
                .all(|field| candidate.get(*field).is_none()),
            "machine JWKS must contain public keys only"
        );
        if candidate["kty"] == "RSA"
            && candidate["alg"] == "RS256"
            && candidate["use"] == "sig"
            && candidate["n"] == public["n"]
            && candidate["e"] == public["e"]
        {
            matches.push(candidate);
        }
    }
    ensure!(
        matches.len() == 1,
        "RSA private key must match exactly one trusted RS256 public JWKS key"
    );
    let trusted = matches[0];
    let now = Utc::now().timestamp();
    let claims = json!({"iss":issuer,"aud":"moesegfault-status","sub":"status-release","jti":uuid::Uuid::new_v4().to_string(),"iat":now,"exp":now+900,"deployment_id":config.deployment_id,"service_name":config.service_name,"environment":config.environment,"scope":"deployments:write artifacts:write"});
    let mut header = Header::new(Algorithm::RS256);
    header.kid = trusted["kid"].as_str().map(str::to_owned);
    let token = encode(&header, &claims, &key)
        .map_err(|_| anyhow::anyhow!("machine JWT signing failed"))?;
    let trusted: Jwk =
        serde_json::from_value(trusted.clone()).context("invalid trusted public JWK")?;
    let decoder = DecodingKey::from_jwk(&trusted)
        .map_err(|_| anyhow::anyhow!("invalid trusted RSA public key"))?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_issuer(&[issuer]);
    validation.set_audience(&["moesegfault-status"]);
    validation.leeway = 0;
    let verified = decode::<Value>(&token, &decoder, &validation)
        .map_err(|_| anyhow::anyhow!("new machine JWT failed pinned-key self-verification"))?;
    ensure!(
        verified.claims == claims,
        "new machine JWT claims changed during signing"
    );
    validate_token(&token, config)?;
    Ok(token)
}
/// 只映射固定协议分类；任意响应文本都不能流入发布日志。
/// Map only fixed protocol categories; arbitrary response text must never reach release logs.
fn registry_problem(bytes: &[u8]) -> &'static str {
    if bytes.len() > 8192 {
        return "details-suppressed";
    }
    let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
        return "details-suppressed";
    };
    match value["type"].as_str() {
        Some("urn:moesegfault:problem:invalid-machine-token") => "invalid-machine-token",
        Some("urn:moesegfault:problem:authentication-required") => "authentication-required",
        Some("urn:moesegfault:problem:authentication-unavailable") => "authentication-unavailable",
        Some("urn:moesegfault:problem:invalid-machine-claims") => "invalid-machine-claims",
        Some("urn:moesegfault:problem:insufficient-scope") => "insufficient-scope",
        _ => "details-suppressed",
    }
}

/// 注册客户端，不导出或记录 bearer 与上传 URL。 / Registry client; never exports or logs bearer or upload URLs.
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
    fn from_env(config: &ReleaseConfig, release_root: &Path) -> Result<Self> {
        let base = secure_url(
            &std::env::var("MOE_RELEASE_API_URL").context("MOE_RELEASE_API_URL required")?,
        )?;
        ensure!(base.query().is_none(), "registry URL cannot contain query");
        let token = match std::env::var("MOE_MACHINE_JWT") {
            Ok(token) => token,
            Err(std::env::VarError::NotPresent) => {
                let private = std::env::var("MACHINE_JWT_PRIVATE_KEY")
                    .context("MOE_MACHINE_JWT or MACHINE_JWT_PRIVATE_KEY required")?;
                let jwks = fs::read(within(release_root, &config.machine_jwks)?)
                    .context("public machine JWKS unavailable")?;
                mint_machine_token(
                    config,
                    &base.origin().ascii_serialization(),
                    private.as_bytes(),
                    &jwks,
                )?
            }
            Err(_) => bail!("MOE_MACHINE_JWT must be UTF-8"),
        };
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
    /// 限定 JSON envelope，仅输出固定白名单错误分类。 / Require a JSON envelope; report only allowlisted static error categories.
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
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let mut bytes = Vec::new();
            let category = match response.take(8193).read_to_end(&mut bytes) {
                Ok(_) => registry_problem(&bytes),
                Err(_) => "details-suppressed",
            };
            bail!("registry request failed: HTTP {status} ({category})");
        }
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
        let upload_id = session["upload_id"].as_str().context("upload_id missing")?;
        let url = native_upload_url(
            &self.base,
            session["upload_url"]
                .as_str()
                .context("upload URL missing")?,
            deployment,
            upload_id,
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
                [
                    "content-type",
                    "content-length",
                    "content-md5",
                    "if-none-match"
                ]
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
            .bearer_auth(&self.token)
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
        commit["upload_id"] = json!(upload_id);
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
    /// 可选静态资产快照根。 / Optional frozen static-assets root.
    assets: Option<PathBuf>,
}
impl Snapshot {
    /// 只复制清单内的 runtime/map，保留 import 和 map 的相对目录关系。
    /// Copy only declared runtime/maps while preserving relative import and map layout.
    fn new(config: &ReleaseConfig, base: &Path, artifacts: &[PreparedArtifact]) -> Result<Self> {
        let original_config = within(base, &config.wrangler_config)?;
        let mut parsed: Value = json5::from_str(&fs::read_to_string(&original_config)?)
            .context("invalid Wrangler JSON/JSONC configuration")?;
        for field in [
            "build",
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
        // 版本发布不能更改域名、DNS、routes 或 triggers；本机初始部署单独管理。
        // Version releases cannot change domains, DNS, routes or triggers; local bootstrap manages them separately.
        for field in [
            "route",
            "routes",
            "triggers",
            "workers_dev",
            "preview_urls",
            "zone_id",
        ] {
            parsed
                .as_object_mut()
                .context("Wrangler config must be an object")?
                .remove(field);
        }
        validate_asset_manifest(config, base, artifacts)?;
        let original_entry = within(base, &config.wrangler_entrypoint)?;
        let original_root = original_entry
            .parent()
            .context("entrypoint parent missing")?;
        let directory =
            tempfile::tempdir().context("cannot create immutable deployment snapshot")?;
        let runtime = directory.path().join("runtime");
        fs::create_dir(&runtime)?;
        for artifact in artifacts.iter().filter(|a| {
            a.asset_path.is_none()
                && matches!(
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
        let assets = freeze_assets(&mut parsed, &original_config, directory.path(), artifacts)?;
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
            assets,
        })
    }
}

/// 只接受已登记的 SPA 资产策略，并把整个集合复制到独立快照。
/// Accept only the registered SPA asset policy and copy the complete set into an isolated snapshot.
fn freeze_assets(
    parsed: &mut Value,
    original_config: &Path,
    snapshot: &Path,
    artifacts: &[PreparedArtifact],
) -> Result<Option<PathBuf>> {
    let static_files: Vec<_> = artifacts
        .iter()
        .filter(|a| a.asset_path.is_some())
        .collect();
    if static_files.is_empty() {
        ensure!(
            parsed.get("assets").is_none(),
            "assets config requires registered static assets"
        );
        return Ok(None);
    }
    let policy = parsed["assets"]
        .as_object()
        .context("static assets require explicit Wrangler assets policy")?;
    ensure!(
        policy.keys().all(
            |key| ["directory", "not_found_handling", "run_worker_first"].contains(&key.as_str())
        ),
        "unsupported static assets policy option"
    );
    ensure!(
        parsed["assets"]["not_found_handling"] == "single-page-application"
            && parsed["assets"]["run_worker_first"] == json!(["/api/*"]),
        "static assets require SPA handling and /api/* Worker-first isolation"
    );
    let original_root = fs::canonicalize(
        original_config
            .parent()
            .context("config parent missing")?
            .join(
                parsed["assets"]["directory"]
                    .as_str()
                    .context("assets.directory missing")?,
            ),
    )?;
    let assets = snapshot.join("assets");
    fs::create_dir(&assets)?;
    let mut expected = BTreeSet::new();
    for artifact in static_files {
        let path = artifact.asset_path.as_ref().unwrap();
        ensure!(
            fs::canonicalize(original_root.join(path))? == artifact.path,
            "static asset declaration does not match configured directory"
        );
        expected.insert(path.clone());
        let destination = assets.join(path);
        fs::create_dir_all(destination.parent().context("asset parent missing")?)?;
        fs::write(destination, &artifact.bytes)?;
    }
    ensure!(
        static_files_in(&original_root)? == expected,
        "configured static directory contains missing or unregistered files"
    );
    parsed["assets"]["directory"] = json!(assets);
    Ok(Some(assets))
}
/// 枚举静态目录，拒绝符号链接和非普通文件，避免逃逸与未审计控制文件。
/// Enumerate a static directory, rejecting symlinks and non-files to prevent escape and unaudited control files.
pub fn static_files_in(root: &Path) -> Result<BTreeSet<String>> {
    fn walk(root: &Path, directory: &Path, files: &mut BTreeSet<String>) -> Result<()> {
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            ensure!(!kind.is_symlink(), "static assets cannot contain symlinks");
            if kind.is_dir() {
                walk(root, &entry.path(), files)?;
                continue;
            }
            ensure!(kind.is_file(), "static asset must be a regular file");
            let path = entry
                .path()
                .strip_prefix(root)?
                .to_str()
                .context("static path must be UTF-8")?
                .replace('\\', "/");
            files.insert(path);
        }
        Ok(())
    }
    let mut files = BTreeSet::new();
    walk(root, root, &mut files)?;
    Ok(files)
}
/// 对私有静态目录进行集合与逐字节复查；不声称 dry-run 等于云上传。
/// Recheck the private static directory's set and exact bytes; dry-run is not claimed as cloud upload.
fn audit_assets(snapshot: &Snapshot, artifacts: &[PreparedArtifact]) -> Result<()> {
    if let Some(root) = &snapshot.assets {
        let mut expected = BTreeSet::new();
        for artifact in artifacts.iter().filter(|a| a.asset_path.is_some()) {
            let path = artifact.asset_path.as_ref().unwrap();
            expected.insert(path.clone());
            ensure!(
                fs::read(root.join(path))? == artifact.bytes,
                "frozen static asset changed"
            );
        }
        ensure!(
            static_files_in(root)? == expected,
            "frozen static asset set changed"
        );
    }
    Ok(())
}
/// 构造不经过 shell 的 Wrangler 参数，仅使用同一冻结快照。
/// Construct shell-free Wrangler arguments using only the same frozen snapshot.
fn wrangler(
    config: &ReleaseConfig,
    snapshot: &Snapshot,
    manifest: &Value,
    artifacts: &[PreparedArtifact],
    dry_run: bool,
) -> Result<Option<String>> {
    audit_assets(snapshot, artifacts)?;
    let mut command = Command::new("node");
    command
        .arg(&snapshot.cli)
        .args(["versions", "upload"])
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
        ("BOOTSTRAP_MODE", "false"),
    ] {
        command.arg("--var").arg(format!("{key}:{value}"));
    }
    let output_dir = tempfile::tempdir().context("cannot create bundle audit directory")?;
    let receipt = tempfile::NamedTempFile::new_in(snapshot.directory.path())?.into_temp_path();
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
        .env_remove("MACHINE_JWT_PRIVATE_KEY")
        .env_remove("MOE_BOOTSTRAP_ACK")
        .env("WRANGLER_OUTPUT_FILE_PATH", receipt.as_os_str());
    // 子进程日志可能带平台秘密，因此只报告退出状态。 / Child logs can contain platform secrets; report exit status only.
    let result = command.output().context("Wrangler failed to start")?;
    ensure!(
        result.status.success(),
        "Wrangler failed; child output suppressed to protect secrets"
    );
    if dry_run {
        audit_assets(snapshot, artifacts)?;
        let mut seen = BTreeSet::new();
        audit_bundle(output_dir.path(), artifacts, &mut seen)?;
        for artifact in artifacts.iter().filter(|a| {
            a.asset_path.is_none()
                && matches!(
                    a.declaration.kind,
                    ArtifactKind::Binary | ArtifactKind::Other
                )
        }) {
            ensure!(
                seen.contains(&artifact.declaration.file_name),
                "declared runtime missing from Wrangler output"
            );
        }
    } else {
        let version = uploaded_version(
            &fs::read_to_string(&receipt).context("Wrangler upload receipt missing")?,
        )?;
        deploy_version(snapshot, &version)?;
        return Ok(Some(version));
    }
    Ok(None)
}

/// 只使用这次上传的结构化 receipt，不解析日志或查询可能竞争的 latest version。
/// Use only this upload's structured receipt, never logs or a racing latest-version lookup.
fn uploaded_version(receipt: &str) -> Result<String> {
    let mut versions = Vec::new();
    for line in receipt.lines().filter(|line| !line.trim().is_empty()) {
        let value: Value = serde_json::from_str(line).context("invalid Wrangler output receipt")?;
        if value["type"] != "version-upload" {
            continue;
        }
        let id = value["version_id"]
            .as_str()
            .context("Wrangler upload receipt lacks version_id")?;
        ensure!(
            id.len() == 36
                && id
                    .chars()
                    .enumerate()
                    .all(|(index, c)| if [8, 13, 18, 23].contains(&index) {
                        c == '-'
                    } else {
                        c.is_ascii_hexdigit()
                    }),
            "invalid uploaded version identifier"
        );
        versions.push(id.to_owned());
    }
    ensure!(
        versions.len() == 1,
        "expected exactly one uploaded version receipt"
    );
    Ok(versions.remove(0))
}
/// 100% 切换到已上传版本；绝不调用 routes/domain/DNS/triggers API。
/// Switch 100% to the uploaded version; never invoke routes/domain/DNS/triggers APIs.
fn deploy_version(snapshot: &Snapshot, version: &str) -> Result<()> {
    let result = Command::new("node")
        .arg(&snapshot.cli)
        .args(["versions", "deploy"])
        .arg(format!("{version}@100%"))
        .args(["--yes", "--config"])
        .arg(&snapshot.configuration)
        .current_dir(snapshot.directory.path())
        .env_remove("CLOUDFLARE_ENV")
        .env_remove("MOE_MACHINE_JWT")
        .env_remove("MACHINE_JWT_PRIVATE_KEY")
        .env_remove("MOE_BOOTSTRAP_ACK")
        .output()
        .context("Wrangler version deploy failed to start")?;
    ensure!(
        result.status.success(),
        "Wrangler version deploy failed (output suppressed)"
    );
    Ok(())
}
/// 执行带 ready 门禁的纯版本发布；首次引导与 DNS 只允许独立本机 CLI 操作。
/// Perform readiness-gated version-only release; initial bootstrap and DNS belong to separate local CLI operations.
pub fn release(
    config: &ReleaseConfig,
    base: &Path,
    artifacts: &[PreparedArtifact],
    manifest: &Value,
    dry_run: bool,
) -> Result<()> {
    ensure!(
        self::manifest(config, base, artifacts)? == *manifest,
        "release manifest does not match current Git/config/artifacts"
    );
    unchanged(artifacts)?;
    let snapshot = Snapshot::new(config, base, artifacts)?;
    // 本地预检也必须发生在网络注册之前。 / Local preflight must also precede registry writes.
    wrangler(config, &snapshot, manifest, artifacts, true)?;
    if dry_run {
        println!("local Wrangler dry-run passed; no registry or deployment writes");
        return Ok(());
    }
    ensure!(
        std::env::var("CLOUDFLARE_API_TOKEN").is_ok_and(|token| token.len() >= 16),
        "CLOUDFLARE_API_TOKEN environment secret required for deployment"
    );
    let registry = Registry::from_env(config, base)?;
    registry.register(config, manifest, artifacts)?;
    let version = wrangler(config, &snapshot, manifest, artifacts, false)?
        .context("published version receipt missing")?;
    println!(
        "{}",
        json!({"type":"release-completed","deployment_id":config.deployment_id,"version_id":version,"state":"ready","activation":"pending"})
    );
    println!(
        "deployment completed after ready gate; authenticated administrator activation remains pending smoke/canary approval"
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

    /// 错误分类有界且不回显秘密或攻击者控制的字段。 / Error classification is bounded and never reflects secrets or attacker-controlled fields.
    #[test]
    fn registry_problem_suppresses_untrusted_details() {
        assert_eq!(
            registry_problem(br#"{"type":"urn:moesegfault:problem:invalid-machine-token","detail":"secret-value"}"#),
            "invalid-machine-token"
        );
        for bytes in [
            br#"{"type":"secret-value"}"#.as_slice(),
            br#"{"title":"invalid-machine-token","detail":"secret-value"}"#,
            b"secret-value",
            &vec![b'x'; 8193],
        ] {
            assert_eq!(registry_problem(bytes), "details-suppressed");
        }
    }
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
        wrangler(&config, &snapshot, &manifest, &artifacts, true).unwrap();
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
    /// 大于传输上限的文件在读入前拒绝；常见 45.8 MiB 调试文件在限额内。
    /// Reject oversized files before reading; a typical 45.8 MiB debug artifact is within the bound.
    #[test]
    fn artifact_size_limit_rejects_more_than_64_mib() {
        let (dir, config, _) = fixture();
        let file = fs::OpenOptions::new()
            .write(true)
            .open(dir.path().join("worker.js"))
            .unwrap();
        file.set_len(64 * 1024 * 1024 + 1).unwrap();
        let error = prepare(&config, &fs::canonicalize(dir.path()).unwrap())
            .err()
            .unwrap();
        assert!(error.to_string().contains("64 MiB"));
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
    /// 添加真实静态文件与路径清单的 fixture。 / Add real static files and their path manifest to a fixture.
    fn static_fixture(config: &mut ReleaseConfig, root: &Path) {
        fs::create_dir(root.join("site")).unwrap();
        fs::write(
            root.join("site/index.html"),
            "<!doctype html><title>Ops</title>",
        )
        .unwrap();
        fs::write(root.join("site/style.css"), "body { color: pink; }").unwrap();
        let mut records = Vec::new();
        for (path, media) in [("index.html", "text/html"), ("style.css", "text/css")] {
            let bytes = fs::read(root.join("site").join(path)).unwrap();
            records.push(asset_record(path, media, &bytes).unwrap());
            config.artifacts.push(serde_json::from_value(json!({"path":format!("site/{path}"),"kind":"other","media_type":media,"asset_path":path})).unwrap());
        }
        fs::write(
            root.join("assets-manifest.json"),
            canonical(&json!({"schema_version":1,"files":records})),
        )
        .unwrap();
        config.artifacts.push(serde_json::from_value(json!({"path":"assets-manifest.json","kind":"manifest","media_type":"application/json"})).unwrap());
        config.asset_manifest = Some("assets-manifest.json".into());
        fs::write(root.join("wrangler.jsonc"), r#"{"name":"static-snapshot-test","assets":{"directory":"site","not_found_handling":"single-page-application","run_worker_first":["/api/*"]},"routes":[{"pattern":"never-change.example","custom_domain":true}],"triggers":{"crons":["* * * * *"]},"workers_dev":false,"preview_urls":false,"compatibility_date":"2026-09-12"}"#).unwrap();
    }
    #[test]
    fn static_snapshots_bind_path_mime_and_bytes_without_module_injection() {
        let (dir, mut config, _) = fixture();
        let root = fs::canonicalize(dir.path()).unwrap();
        config.wrangler_cli = "wrangler.js".into();
        fs::write(root.join("wrangler.js"), "unused").unwrap();
        static_fixture(&mut config, &root);
        let artifacts = prepare(&config, &root).unwrap();
        let snapshot = Snapshot::new(&config, &root, &artifacts).unwrap();
        let frozen: Value =
            serde_json::from_slice(&fs::read(&snapshot.configuration).unwrap()).unwrap();
        for key in ["routes", "route", "triggers", "workers_dev", "preview_urls"] {
            assert!(frozen.get(key).is_none());
        }
        assert!(!snapshot.entry.parent().unwrap().join("index.html").exists());
        fs::write(root.join("site/extra.js"), "unregistered").unwrap();
        assert!(Snapshot::new(&config, &root, &artifacts).is_err());
        fs::write(root.join("site/index.html"), "modified").unwrap();
        audit_assets(&snapshot, &artifacts).unwrap();
        assert!(prepare(&config, &root).is_err());
        fs::write(
            snapshot.assets.as_ref().unwrap().join("extra.js"),
            "injected",
        )
        .unwrap();
        assert!(audit_assets(&snapshot, &artifacts).is_err());
        assert!(asset_record("../escape.js", "text/javascript", b"x").is_err());
        assert!(asset_record(".assetsignore", "text/plain", b"x").is_err());
        assert!(asset_record("_redirects", "text/plain", b"x").is_err());
    }
    #[test]
    fn version_receipts_reject_missing_ambiguous_or_argument_shaped_ids() {
        let valid =
            r#"{"type":"version-upload","version_id":"01234567-89ab-cdef-0123-456789abcdef"}"#;
        assert_eq!(
            uploaded_version(valid).unwrap(),
            "01234567-89ab-cdef-0123-456789abcdef"
        );
        assert!(uploaded_version("").is_err());
        assert!(uploaded_version(&format!("{valid}\n{valid}")).is_err());
        assert!(
            uploaded_version(r#"{"type":"version-upload","version_id":"--name=other"}"#).is_err()
        );
    }
    /// 真实子进程夹具验证只执行 upload/100% deploy，不调用完整 deploy 或 DNS 命令。
    /// A real subprocess fixture verifies upload/100% deploy only, never full deploy or DNS commands.
    #[test]
    #[ignore = "requires Node"]
    fn subprocess_release_uses_only_versions_and_exact_upload_receipt() {
        let (dir, mut config, artifacts) = fixture();
        let root = fs::canonicalize(dir.path()).unwrap();
        config.wrangler_cli = "wrangler.js".into();
        fs::write(root.join("wrangler.jsonc"), "{}").unwrap();
        fs::write(root.join("wrangler.js"), r#"
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify(args) + '\n');
if (args[0] !== 'versions') process.exit(9);
if (args[1] === 'upload') fs.appendFileSync(process.env.WRANGLER_OUTPUT_FILE_PATH, JSON.stringify({type: 'version-upload', version_id: '01234567-89ab-cdef-0123-456789abcdef'}) + '\n');
"#).unwrap();
        let snapshot = Snapshot::new(&config, &root, &artifacts).unwrap();
        let manifest = json!({"deployment_id":config.deployment_id,"git_commit":"0123456789abcdef0123456789abcdef01234567","artifact_digest":artifacts[0].declaration.artifact_digest,"environment":"production"});
        wrangler(&config, &snapshot, &manifest, &artifacts, false).unwrap();
        let calls: Vec<Value> = fs::read_to_string(root.join("calls.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0][0], "versions");
        assert_eq!(calls[0][1], "upload");
        assert_eq!(calls[1][0], "versions");
        assert_eq!(calls[1][1], "deploy");
        assert_eq!(calls[1][2], "01234567-89ab-cdef-0123-456789abcdef@100%");
    }
    /// 真实 Wrangler 版本 dry-run 加载静态快照，不进行上传或 DNS 操作。
    /// Actual Wrangler versions dry-run loads static snapshots without uploads or DNS operations.
    #[test]
    #[ignore = "requires installed Wrangler"]
    fn real_wrangler_versions_static_snapshot_dry_run() {
        let repo = fs::canonicalize(Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")).unwrap();
        let (dir, mut config, _) = fixture();
        let root = fs::canonicalize(dir.path()).unwrap();
        static_fixture(&mut config, &root);
        let artifacts = prepare(&config, &root).unwrap();
        // snapshot factory constrains CLI location, then test substitutes the already-installed trusted tool.
        // 快照构造限制CLI路径；测试随后替换为已经安装的受信工具。
        config.wrangler_cli = "wrangler.js".into();
        fs::write(root.join("wrangler.js"), "unused").unwrap();
        let mut snapshot = Snapshot::new(&config, &root, &artifacts).unwrap();
        snapshot.cli = repo.join("node_modules/wrangler/bin/wrangler.js");
        fs::write(root.join("site/extra.js"), "unregistered workspace file").unwrap();
        let manifest = json!({"deployment_id":config.deployment_id,"git_commit":"0123456789abcdef0123456789abcdef01234567","artifact_digest":artifacts[0].declaration.artifact_digest,"environment":"production"});
        wrangler(&config, &snapshot, &manifest, &artifacts, true).unwrap();
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
    /// 仅在内存中生成测试RSA密钥，验证pinning、kid、claims和错误origin；不打印令牌。
    /// Generate an in-memory test RSA key and verify pinning, kid, claims and wrong-origin rejection without printing tokens.
    #[test]
    #[ignore = "requires Node to generate an ephemeral RSA-3072 test key"]
    fn native_mint_requires_matching_public_key_and_pinned_origin() {
        let result = Command::new("node").args(["-e", "const c=require('node:crypto');const k=c.generateKeyPairSync('rsa',{modulusLength:3072});process.stdout.write(JSON.stringify({private:k.privateKey.export({type:'pkcs8',format:'pem'}),public:{...k.publicKey.export({format:'jwk'}),kid:'test-kid',alg:'RS256',use:'sig'}}))"]).output().unwrap();
        assert!(result.status.success());
        let fixture: Value = serde_json::from_slice(&result.stdout).unwrap();
        let private = fixture["private"].as_str().unwrap();
        let mut document = json!({"keys":[fixture["public"].clone()]});
        let mut config = config();
        config.status_origin = Some("https://status.example".into());
        let token = mint_machine_token(
            &config,
            "https://status.example",
            private.as_bytes(),
            &serde_json::to_vec(&document).unwrap(),
        )
        .unwrap();
        let header = jsonwebtoken::decode_header(&token).unwrap();
        assert_eq!(header.kid.as_deref(), Some("test-kid"));
        assert_eq!(header.alg, jsonwebtoken::Algorithm::RS256);
        let claims: Value = serde_json::from_slice(
            &URL_SAFE_NO_PAD
                .decode(token.split('.').nth(1).unwrap())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(claims["iss"], "https://status.example");
        assert_eq!(claims["aud"], "moesegfault-status");
        assert_eq!(claims["scope"], "deployments:write artifacts:write");
        assert_eq!(
            claims["exp"].as_i64().unwrap() - claims["iat"].as_i64().unwrap(),
            900
        );
        assert!(uuid::Uuid::parse_str(claims["jti"].as_str().unwrap()).is_ok());
        assert!(
            mint_machine_token(
                &config,
                "https://wrong.example",
                private.as_bytes(),
                &serde_json::to_vec(&document).unwrap()
            )
            .is_err()
        );
        document["keys"]
            .as_array_mut()
            .unwrap()
            .push(fixture["public"].clone());
        assert!(
            mint_machine_token(
                &config,
                "https://status.example",
                private.as_bytes(),
                &serde_json::to_vec(&document).unwrap()
            )
            .is_err()
        );
        document["keys"].as_array_mut().unwrap().pop();
        document["keys"][0]["n"] = json!("mismatching-public-key");
        assert!(
            mint_machine_token(
                &config,
                "https://status.example",
                private.as_bytes(),
                &serde_json::to_vec(&document).unwrap()
            )
            .is_err()
        );
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
    /// URL 能力约束覆盖编码、其他路径和凭据泄漏。 / Capability URL checks cover encoding, path substitution and credential leaks.
    #[test]
    fn upload_capability_url_rejects_ambiguous_or_external_targets() {
        let base = Url::parse("https://registry.example").unwrap();
        let good = "https://registry.example/v1/deployments/deploy-1/artifact-uploads/upload-1";
        assert!(native_upload_url(&base, good, "deploy-1", "upload-1").is_ok());
        for bad in [
            good.replace("registry.example", "attacker.example"),
            good.replace("registry.example", "registry.example:444"),
            good.replace("https://", "https://user@"),
            good.replace("deploy-1", "deploy-2"),
            good.replace("upload-1", "%75pload-1"),
            good.replace("/artifact-uploads/", "/other/../artifact-uploads/"),
            format!("{good}?signature=x"),
            format!("{good}#x"),
            format!("{good}/"),
        ] {
            assert!(native_upload_url(&base, &bad, "deploy-1", "upload-1").is_err());
        }
        assert!(native_upload_url(&base, good, "..", "upload-1").is_err());
        assert!(native_upload_url(&base, good, "deploy-1", "upload/1").is_err());
    }
    #[test]
    fn real_https_registration_upload_commit_ready_and_412() {
        for scenario in [
            "success",
            "existing",
            "not-ready",
            "expired",
            "checksum",
            "cross-origin",
            "wrong-path",
            "header-injection",
            "existing-commit-failed",
            "put-failed",
            "commit-failed",
            "redirect",
        ] {
            let steps = match scenario {
                "expired" | "checksum" | "cross-origin" | "wrong-path" | "header-injection" => 2,
                "put-failed" | "redirect" => 3,
                "commit-failed" | "existing-commit-failed" => 4,
                _ => 5,
            };
            let upload_status = match scenario {
                "existing" | "existing-commit-failed" => 412,
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
            let upload_url = format!(
                "{base}/v1/deployments/{}/artifact-uploads/upload-1",
                config.deployment_id
            );
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
                            json!({"data":{"upload_id":"upload-1","upload_url":upload_url,"expires_at":(Utc::now()+chrono::Duration::minutes(10)).to_rfc3339(),"required_headers":{"content-type":declaration["media_type"],"content-length":expected_bytes.len().to_string(),"content-md5":md5,"if-none-match":"*"}}})
                        }
                        2 => {
                            assert!(headers.starts_with(&format!(
                                "PUT /v1/deployments/{deployment}/artifact-uploads/upload-1 "
                            )));
                            assert!(headers.contains("authorization: Bearer private-test-token"));
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
                    if scenario == "cross-origin" && step == 1 {
                        response["data"]["upload_url"] = json!(
                            "https://attacker.invalid/v1/deployments/other/artifact-uploads/upload-1"
                        );
                    }
                    if scenario == "wrong-path" && step == 1 {
                        response["data"]["upload_url"] = json!(format!("{upload_url}/extra"));
                    }
                    if scenario == "header-injection" && step == 1 {
                        response["data"]["required_headers"]["Authorization"] =
                            json!("Bearer attacker");
                    }
                    if scenario == "not-ready" && step == 4 {
                        response["data"]["state"] = json!("registered");
                    }
                    let status = if step == 2 {
                        upload_status
                    } else if step == 3
                        && matches!(scenario, "commit-failed" | "existing-commit-failed")
                    {
                        409
                    } else {
                        200
                    };
                    let text = response.to_string();
                    let location = if status == 307 {
                        "Location: https://attacker.invalid/collect\r\n"
                    } else {
                        ""
                    };
                    write!(stream,"HTTP/1.1 {status} OK\r\n{location}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",text.len()).unwrap();
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

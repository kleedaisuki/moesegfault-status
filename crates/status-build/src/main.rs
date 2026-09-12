//! 原生 Rust 构建组装：SDK 字节、真实 JS source map、独立 DWARF。
//! Native Rust assembly: SDK bytes, genuine JavaScript source maps and separate DWARF.
use anyhow::{Context, Result, ensure};
use clap::{Parser, ValueEnum};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

/// 构建目标；status 包含公开入口和私有命名 AdminRpc。 / Build target; status contains public and named private AdminRpc entrypoints.
#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
enum Service {
    Status,
    Ops,
    Probe,
    All,
}
impl Service {
    /// 稳定输出目录名。 / Stable output directory name.
    fn name(self) -> &'static str {
        match self {
            Self::Status => "status",
            Self::Ops => "ops",
            Self::Probe => "probe",
            Self::All => "all",
        }
    }
    /// 现有平台配置路径；从不改写源配置。 / Existing platform config path; source configs are never rewritten.
    fn config(self) -> &'static str {
        match self {
            Self::Status => "wrangler.jsonc",
            Self::Ops => "workers/ops-gateway/wrangler.jsonc",
            Self::Probe => "workers/probe-executor/wrangler.jsonc",
            Self::All => unreachable!(),
        }
    }
    /// SDK crate 与无碰撞模块名。 / SDK crate and collision-free module name.
    fn modules(self) -> &'static [(&'static str, &'static str)] {
        match self {
            Self::Status => &[("status-worker", "public"), ("admin-rpc-worker", "admin")],
            Self::Ops => &[("ops-gateway-worker", "ops")],
            Self::Probe => &[("probe-worker", "probe")],
            Self::All => unreachable!(),
        }
    }
}
/// 无 shell 参数的构建命令。 / Build command with shell-free arguments.
#[derive(Parser)]
struct Args {
    /// 单项或完整构建。 / Individual or complete build.
    #[arg(long, value_enum, default_value = "all")]
    service: Service,
    /// 仓库根目录。 / Repository root directory.
    #[arg(long, default_value = ".")]
    root: PathBuf,
    /// 单项发布的非秘密 metadata JSON；生成根目录 release.<service>.json。
    /// Secret-free metadata JSON for one release; generates root release.<service>.json.
    #[arg(long)]
    release_template: Option<PathBuf>,
}
/// 输出受限编译诊断，掩盖继承环境中的凭据值；stdout 不输出。
/// Emit bounded compiler diagnostics with inherited credential values redacted; never print stdout.
fn execute(command: &mut Command, phase: &str) -> Result<()> {
    let result = command
        .output()
        .with_context(|| format!("{phase} could not start"))?;
    if !result.status.success() {
        let diagnostics = redact_diagnostics(&String::from_utf8_lossy(&result.stderr));
        eprintln!("{}", diagnostics.chars().take(16_384).collect::<String>());
    }
    ensure!(
        result.status.success(),
        "{phase} failed (see redacted compiler diagnostics; exit {})",
        result
            .status
            .code()
            .map_or("unknown".into(), |code| code.to_string())
    );
    Ok(())
}
/// 已知环境秘密按值替换，先处理长值防止部分匹配泄漏。
/// Replace known environment-secret values longest-first to prevent partial-match leakage.
fn redact_diagnostics(text: &str) -> String {
    let mut secrets: Vec<_> = std::env::vars()
        .filter(|(key, value)| {
            !value.is_empty()
                && [
                    "TOKEN",
                    "SECRET",
                    "PASSWORD",
                    "AUTH",
                    "API_KEY",
                    "ACCESS_KEY",
                    "JWT",
                    "PROXY",
                ]
                .iter()
                .any(|part| key.to_ascii_uppercase().contains(part))
        })
        .map(|(_, value)| value)
        .collect();
    secrets.sort_by_key(|value| std::cmp::Reverse(value.len()));
    secrets.into_iter().fold(text.to_owned(), |output, secret| {
        output.replace(&secret, "[REDACTED]")
    })
}
/// 固定 SDK 工具版本，不能默默升级构建格式。 / Pin SDK tooling; never silently upgrade the output format.
fn verify_tools(root: &Path) -> Result<()> {
    let version = Command::new("worker-build")
        .arg("--version")
        .output()
        .context("install worker-build 0.8.5 first")?;
    ensure!(
        version.status.success() && String::from_utf8_lossy(&version.stdout).trim() == "0.8.5",
        "worker-build must be exactly 0.8.5"
    );
    ensure!(
        root.join("node_modules/esbuild/package.json").is_file(),
        "install pinned pnpm dependencies first"
    );
    Ok(())
}
/// 实际构建 SDK 模块；禁止自定义 JS shim 覆盖入口策略。
/// Actually build an SDK module; forbid custom JS shim overrides of entrypoint policy.
fn sdk_build(root: &Path, crate_name: &str) -> Result<PathBuf> {
    let crate_dir = root.join("crates").join(crate_name);
    ensure!(
        crate_dir.join("Cargo.toml").is_file(),
        "required Rust worker crate is missing"
    );
    let mut command = Command::new("worker-build");
    command
        .arg(&crate_dir)
        .args(["--release", "--no-opt", "--", "--locked"])
        .current_dir(root)
        .env("CARGO_PROFILE_RELEASE_DEBUG", "2")
        .env("CARGO_PROFILE_RELEASE_STRIP", "none")
        .env("NO_MINIFY", "1")
        .env_remove("CUSTOM_SHIM")
        .env_remove("COREDUMP")
        .env_remove("COREDUMP_FLAGS")
        .env_remove("RUN_TO_COMPLETION")
        .env_remove("MOE_MACHINE_JWT")
        .env_remove("CLOUDFLARE_API_TOKEN");
    execute(&mut command, &format!("worker-build {crate_name}"))?;
    Ok(crate_dir.join("build"))
}
/// 使用真正 esbuild transform 生成映射到 SDK glue 的 source map；Rust 栈使用 DWARF。
/// Use a genuine esbuild transform for source maps to SDK glue; Rust frames use DWARF.
fn transform(root: &Path, input: &Path, output: &Path) -> Result<()> {
    fs::create_dir_all(output.parent().context("output parent missing")?)?;
    let mut command = Command::new("node");
    // Windows canonical \?\ 路径会被 esbuild 转成绝对 file: URL；使用稳定相对参数。
    // esbuild turns Windows canonical extended paths into absolute file: URLs; use stable relative arguments.
    let source_directory = input.parent().context("source directory missing")?;
    let staging = source_directory
        .parent()
        .context("staging directory missing")?;
    let relative_output = PathBuf::from("..").join(
        output
            .strip_prefix(staging)
            .context("output must share source staging directory")?,
    );
    let options = json!({
        "entryPoints": [input.file_name().and_then(|name| name.to_str()).context("source filename must be UTF-8")?],
        "bundle": false,
        "format": "esm",
        "target": "es2022",
        "sourcemap": "linked",
        "sourcesContent": true,
        "outfile": slash(&relative_output),
        "write": true,
    });
    // npm 在 Linux 可把 bin/esbuild 替换为 ELF；只使用官方包的 Node API。
    // npm may replace bin/esbuild with ELF on Linux; use only the official package's Node API.
    // 固定表达式不拼接源码或路径，全部选项作为独立 JSON 参数传递。
    // The fixed expression interpolates neither code nor paths; options are a separate JSON argument.
    command
        .args([
            "--input-type=commonjs",
            "-e",
            "require(process.argv[1]).buildSync(JSON.parse(process.argv[2]))",
            "--",
        ])
        .arg(root.join("node_modules/esbuild"))
        .arg(serde_json::to_string(&options)?)
        .current_dir(source_directory)
        .env_remove("MOE_MACHINE_JWT")
        .env_remove("CLOUDFLARE_API_TOKEN");
    execute(&mut command, "esbuild source-map transform")
}
/// 仅重定位 SDK 的 Wasm 模块路径，不改写任何运行时业务代码。
/// Relocate only the SDK Wasm module path, without rewriting runtime business code.
fn relocate_glue(glue: &str, name: &str) -> Result<String> {
    ensure!(
        glue.contains("./index_bg.wasm"),
        "SDK glue format changed: expected Wasm import missing"
    );
    let updated = glue
        .replace("\"./index_bg.wasm\"", &format!("\"./{name}_bg.wasm\""))
        .replace("'./index_bg.wasm'", &format!("'./{name}_bg.wasm'"));
    ensure!(
        !updated.contains("index_bg.wasm"),
        "SDK glue contains unsupported Wasm import form"
    );
    Ok(updated)
}
/// 注册表文件声明的输入形状。 / Registry artifact-input shape.
fn declaration(path: String, kind: &str, media: &str, build_id: Option<&str>) -> Value {
    let mut value = json!({"path":path,"kind":kind,"media_type":media});
    if let Some(id) = build_id {
        value["build_id"] = json!(id);
    }
    value
}
/// 根目录相对路径统一为 URL 风格，跨平台保持 manifest 稳定。
/// Normalize root-relative paths to slash form for cross-platform manifest stability.
fn slash(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}
/// 组装一个 SDK 输出并登记 runtime、map 与匹配的 DWARF 文件。
/// Assemble one SDK output and declare runtime, map and matching DWARF files.
fn assemble_module(
    root: &Path,
    stage: &Path,
    service: Service,
    crate_name: &str,
    name: &str,
    artifacts: &mut Vec<Value>,
) -> Result<()> {
    let sdk = sdk_build(root, crate_name)?;
    let symbols = fs::read(sdk.join("index_bg.wasm")).context("SDK Wasm output missing")?;
    let (runtime, build_id) = status_release::split_wasm(&symbols)?;
    let module_dir = if service == Service::Status {
        PathBuf::from(name)
    } else {
        PathBuf::new()
    };
    let runtime_dir = stage.join("runtime").join(&module_dir);
    fs::create_dir_all(&runtime_dir)?;
    let wasm_name = format!("{name}_bg.wasm");
    fs::write(runtime_dir.join(&wasm_name), runtime)?;
    fs::write(
        stage.join("symbols").join(format!("{name}.debug.wasm")),
        symbols,
    )?;
    let source = stage.join("sources").join(format!("{name}.generated.js"));
    fs::write(
        &source,
        relocate_glue(&fs::read_to_string(sdk.join("index.js"))?, name)?,
    )?;
    transform(root, &source, &runtime_dir.join(format!("{name}.js")))?;
    let prefix = PathBuf::from("dist/rust")
        .join(service.name())
        .join(module_dir);
    artifacts.push(declaration(
        slash(&prefix.join(format!("{name}.js"))),
        "other",
        "text/javascript",
        None,
    ));
    artifacts.push(declaration(
        slash(&prefix.join(format!("{name}.js.map"))),
        "source_map",
        "application/json",
        None,
    ));
    artifacts.push(declaration(
        slash(&prefix.join(wasm_name)),
        "binary",
        "application/wasm",
        Some(&build_id),
    ));
    artifacts.push(declaration(
        format!("dist/rust/symbols/{}/{name}.debug.wasm", service.name()),
        "debug_symbols",
        "application/wasm",
        Some(&build_id),
    ));
    Ok(())
}
/// 单一声明式组合器，不注入任何鉴权、路由或业务逻辑。
/// Single declarative composition module; no authentication, routing or business logic is injected.
const STATUS_ENTRY: &str = "export { default } from './public/public.js';\nexport { default as AdminRpc } from './admin/admin.js';\n";
/// 原子替换本工具独占的生成目录，失败时恢复旧目录。
/// Atomically replace this tool's owned generated directory, restoring the old directory on failure.
fn install_directory(source: &Path, destination: &Path, root: &Path) -> Result<()> {
    let parent = fs::canonicalize(destination.parent().context("destination parent missing")?)?;
    ensure!(
        parent.starts_with(root) && destination != root,
        "generated directory escapes workspace"
    );
    let backup = tempfile::tempdir_in(&parent)?;
    let previous = backup.path().join("previous");
    if destination.exists() {
        ensure!(
            fs::canonicalize(destination)?.starts_with(root),
            "generated destination symlink escapes workspace"
        );
        fs::rename(destination, &previous)?;
    }
    if let Err(error) = fs::rename(source, destination) {
        if previous.exists() {
            fs::rename(&previous, destination).context("failed to restore previous build")?;
        }
        return Err(error).context("cannot install complete build directory");
    }
    Ok(())
}
/// 构建单项服务，并在最后写入可审计 artifact inventory。
/// Build one service, writing its auditable artifact inventory only after successful assembly.
fn build_service(root: &Path, service: Service) -> Result<Value> {
    let out = root.join("dist/rust");
    let ancestor = out
        .ancestors()
        .find(|path| path.exists())
        .context("output ancestor missing")?;
    ensure!(
        fs::canonicalize(ancestor)?.starts_with(root),
        "generated output symlink escapes workspace"
    );
    fs::create_dir_all(out.join("symbols"))?;
    let stage = tempfile::tempdir_in(&out)?;
    for directory in ["runtime", "symbols", "sources"] {
        fs::create_dir(stage.path().join(directory))?;
    }
    let mut artifacts = Vec::new();
    for (crate_name, name) in service.modules() {
        assemble_module(
            root,
            stage.path(),
            service,
            crate_name,
            name,
            &mut artifacts,
        )?;
    }
    if service == Service::Status {
        let source = stage.path().join("sources/status.generated.js");
        fs::write(&source, STATUS_ENTRY)?;
        transform(root, &source, &stage.path().join("runtime/status.js"))?;
        artifacts.push(declaration(
            "dist/rust/status/status.js".into(),
            "other",
            "text/javascript",
            None,
        ));
        artifacts.push(declaration(
            "dist/rust/status/status.js.map".into(),
            "source_map",
            "application/json",
            None,
        ));
    }
    install_directory(
        &stage.path().join("symbols"),
        &out.join("symbols").join(service.name()),
        root,
    )?;
    install_directory(
        &stage.path().join("runtime"),
        &out.join(service.name()),
        root,
    )?;
    let inventory = json!({"wrangler_config":service.config(),"wrangler_entrypoint":format!("dist/rust/{0}/{0}.js",service.name()),"require_source_map":true,"artifacts":artifacts});
    fs::write(
        out.join(format!("{}.artifacts.json", service.name())),
        serde_json::to_vec_pretty(&inventory)?,
    )?;
    Ok(inventory)
}
/// 合并非秘密模板，使用 release crate 的严格配置和产物校验。
/// Merge secret-free metadata and use release crate's strict configuration and artifact validation.
fn write_release(root: &Path, service: Service, template: &Path, inventory: &Value) -> Result<()> {
    let mut metadata: Value = serde_json::from_slice(&fs::read(root.join(template))?)
        .context("release template is not JSON")?;
    let object = metadata
        .as_object_mut()
        .context("release template must be an object")?;
    for (key, value) in inventory.as_object().unwrap() {
        object.insert(key.clone(), value.clone());
    }
    let encoded = serde_json::to_vec_pretty(&metadata)?;
    let config: status_release::ReleaseConfig = serde_json::from_slice(&encoded)
        .context("release template violates strict secret-free release configuration")?;
    status_release::prepare(&config, root)?;
    let destination = root.join(format!("release.{}.json", service.name()));
    if destination.exists() {
        ensure!(
            fs::read(&destination)? == encoded,
            "release config already exists with different metadata; remove explicitly or preserve the frozen original"
        );
    } else {
        fs::write(destination, encoded)?;
    }
    Ok(())
}
/// 构建不调用任何云 API，也不会开通 R2 或部署。
/// Building never calls cloud APIs, provisions R2 or deploys.
fn run() -> Result<()> {
    let args = Args::parse();
    let root = fs::canonicalize(args.root).context("repository root missing")?;
    ensure!(
        root.join("Cargo.toml").is_file() && root.join("crates/status-release").is_dir(),
        "not the status workspace root"
    );
    ensure!(
        args.service != Service::All || args.release_template.is_none(),
        "release-template requires one explicit service and distinct deployment metadata"
    );
    verify_tools(&root)?;
    let services = if args.service == Service::All {
        vec![Service::Status, Service::Ops, Service::Probe]
    } else {
        vec![args.service]
    };
    for service in services {
        println!("building Rust service {}", service.name());
        let inventory = build_service(&root, service)?;
        if let Some(template) = &args.release_template {
            write_release(&root, service, template, &inventory)?;
        }
        println!(
            "assembled {} with actual source maps and matching DWARF; no deployment performed",
            service.name()
        );
    }
    Ok(())
}
/// 顶层错误不打印子进程输出或秘密。 / Top-level errors never print child output or secrets.
fn main() {
    if let Err(error) = run() {
        eprintln!("build failed: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    /// 真正的 esbuild 映射必须保持相对源路径，尤其覆盖 Windows canonical 路径。
    /// Actual esbuild maps must retain relative sources, especially with Windows canonical paths.
    #[test]
    #[ignore = "requires installed esbuild"]
    fn real_esbuild_maps_use_relative_sources() {
        let root = fs::canonicalize(Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")).unwrap();
        let stage = tempfile::tempdir().unwrap();
        let stage = fs::canonicalize(stage.path()).unwrap();
        fs::create_dir(stage.join("sources")).unwrap();
        let input = stage.join("sources/test.generated.js");
        let source = "export const answer = () => 42;\n";
        fs::write(&input, source).unwrap();
        transform(&root, &input, &stage.join("runtime/test.js")).unwrap();
        let map: Value =
            serde_json::from_slice(&fs::read(stage.join("runtime/test.js.map")).unwrap()).unwrap();
        assert_eq!(map["sourcesContent"][0], source);
        assert!(
            map["sources"][0]
                .as_str()
                .is_some_and(|path| !path.contains(':') && !path.starts_with('/'))
        );
        assert!(!map["mappings"].as_str().unwrap().is_empty());
    }
    /// 即使 bin/esbuild 是 ELF 而非 JS，也必须通过真实官方 Node API 构建。
    /// Build through the real official Node API even when bin/esbuild is ELF, not JavaScript.
    #[test]
    #[ignore = "requires installed esbuild"]
    fn real_esbuild_api_ignores_native_binary_cli_entry() {
        let root = fs::canonicalize(Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")).unwrap();
        let fixture = tempfile::tempdir().unwrap();
        let fixture_root = fs::canonicalize(fixture.path()).unwrap();
        let package = fixture_root.join("node_modules/esbuild");
        fs::create_dir_all(package.join("bin")).unwrap();
        // 测试 package main 指向已安装的真实 API；原生 CLI 是不可执行的 ELF fixture。
        // Test package main points to the installed real API; the native CLI is a non-executable ELF fixture.
        fs::write(
            package.join("package.json"),
            serde_json::to_vec(&json!({"main":root.join("node_modules/esbuild/lib/main.js")}))
                .unwrap(),
        )
        .unwrap();
        fs::write(
            package.join("bin/esbuild"),
            b"\x7fELF\x02\x01\x01\0not JavaScript",
        )
        .unwrap();
        fs::create_dir(fixture_root.join("sources")).unwrap();
        let input = fixture_root.join("sources/input.generated.js");
        fs::write(&input, "export const answer = 42;\n").unwrap();
        let output = fixture_root.join("runtime/output.js");
        transform(&fixture_root, &input, &output).unwrap();
        assert!(
            fs::read_to_string(output)
                .unwrap()
                .contains("sourceMappingURL=output.js.map")
        );
        let map: Value =
            serde_json::from_slice(&fs::read(fixture_root.join("runtime/output.js.map")).unwrap())
                .unwrap();
        assert_eq!(map["sourcesContent"][0], "export const answer = 42;\n");
        assert!(!map["sources"][0].as_str().unwrap().contains(':'));
    }
    /// 完整构建后用发布器再次验证真实 runtime/map/DWARF；不登记或部署。
    /// Revalidate actual runtime/maps/DWARF after a complete build without registering or deploying.
    #[test]
    #[ignore = "requires all three assembled real builds"]
    fn real_inventories_pass_release_artifact_validation() {
        let root = fs::canonicalize(Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")).unwrap();
        for service in [Service::Status, Service::Ops, Service::Probe] {
            let inventory: Value = serde_json::from_slice(
                &fs::read(root.join(format!("dist/rust/{}.artifacts.json", service.name())))
                    .unwrap(),
            )
            .unwrap();
            let mut config = json!({"deployment_id":"0199d09a-b692-7ce0-a1c0-5138a43d7402","service_name":service.name(),"environment":"test","service_version":"validation","repository_url":"https://github.com/example/validation","git_ref":"HEAD","deployed_at":"2026-09-12T00:00:00Z","ci_provider":"local-validation","ci_run_id":"fixture","release_attempt":"1","region":["global"]});
            for (key, value) in inventory.as_object().unwrap() {
                config[key] = value.clone();
            }
            let config = serde_json::from_value::<status_release::ReleaseConfig>(config).unwrap();
            let prepared = status_release::prepare(&config, &root).unwrap();
            assert!(!prepared.is_empty());
        }
    }
    #[test]
    fn relocation_is_exact_and_module_names_are_unique() {
        assert_eq!(
            relocate_glue("import wasm from './index_bg.wasm';", "public").unwrap(),
            "import wasm from './public_bg.wasm';"
        );
        assert!(relocate_glue("export default {};", "public").is_err());
        assert!(relocate_glue("import wasm from `./index_bg.wasm`;", "public").is_err());
        assert_eq!(
            Service::Status.modules(),
            &[("status-worker", "public"), ("admin-rpc-worker", "admin")]
        );
        assert_eq!(STATUS_ENTRY.lines().count(), 2);
        assert!(!STATUS_ENTRY.contains("function"));
    }
    #[test]
    fn owned_directory_install_replaces_without_stale_modules() {
        let root = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(root.path()).unwrap();
        let old = root.join("old");
        let new = root.join("new");
        fs::create_dir(&old).unwrap();
        fs::create_dir(&new).unwrap();
        fs::write(old.join("stale.js"), "old").unwrap();
        fs::write(new.join("fresh.js"), "new").unwrap();
        install_directory(&new, &old, &root).unwrap();
        assert!(!old.join("stale.js").exists());
        assert!(old.join("fresh.js").exists());
    }
}

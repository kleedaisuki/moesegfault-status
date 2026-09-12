//! Rust 发布 CLI。 / Rust release CLI.
use clap::Parser;
use std::path::PathBuf;
/// 发布命令，默认执行真实注册及部署。 / Release command; default performs real registration and deployment.
#[derive(Parser)]
struct Args {
    /// 发布 JSON 路径。 / Release JSON path.
    #[arg(long)]
    config: PathBuf,
    /// 只校验并输出 manifest。 / Validate and print manifest only.
    #[arg(long, conflicts_with = "dry_run")]
    verify_only: bool,
    /// 校验并执行 Wrangler 本地 dry-run，不访问注册表。 / Validate and execute local Wrangler dry-run without registry access.
    #[arg(long)]
    dry_run: bool,
}
/// 将错误输出限制在不含秘密的上下文。 / Restrict error output to secret-free context.
fn main() {
    if let Err(error) = run() {
        eprintln!("release failed: {error}");
        std::process::exit(1);
    }
}
/// 执行一次发布事务。 / Execute one release transaction.
fn run() -> anyhow::Result<()> {
    let args = Args::parse();
    let (config, base) = status_release::read_config(&args.config)?;
    let artifacts = status_release::prepare(&config, &base)?;
    let manifest = status_release::manifest(&config, &base, &artifacts)?;
    if args.verify_only {
        println!("{}", status_release::canonical(&manifest));
        return Ok(());
    }
    status_release::release(&config, &base, &artifacts, &manifest, args.dry_run)
}

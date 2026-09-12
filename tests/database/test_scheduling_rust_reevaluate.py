"""运行真实 Rust 重评模块的原生单测。 / Run native tests from the real Rust reevaluation module.

运行 / Run:
    python -m unittest discover -s tests/database -p test_scheduling_rust_reevaluate.py -v

需要已安装 Rust 工具链及已缓存 Cargo 依赖；测试不访问网络。
Requires a Rust toolchain and cached Cargo dependencies; tests never access the network.
隔离 crate 引用生产源码，只替换不可用于原生平台的 D1 传输层。
The isolated crate references production sources and replaces only the non-native D1 transport.
SQL、D1 binding 和异步事务执行仍需独立集成测试。
SQL, the D1 binding, and asynchronous transaction execution require separate integration tests.
"""

import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

# 从文件位置解析仓库，支持任意工作目录。 / Resolve the repository independently of the working directory.
ROOT = Path(__file__).resolve().parents[2]


class SchedulingReevaluationNativeTest(unittest.TestCase):
    """使 Wasm-only 模块的业务单测进入日常 Python suite。 / Include Wasm-only business tests in the Python suite."""

    def test_native_reevaluation_unit_tests(self):
        """编译真实源码并执行其全部单测，临时目录由标准库安全清理。 / Compile real sources and run all tests with safe temporary cleanup."""
        cargo = shutil.which("cargo")
        self.assertIsNotNone(cargo, "Rust cargo is required for reevaluation regression tests")
        with tempfile.TemporaryDirectory(prefix="moesegfault-reevaluate-tests-") as temporary:
            directory = Path(temporary)
            (directory / "src").mkdir()
            manifest = self.manifest()
            (directory / "Cargo.toml").write_text(manifest, encoding="utf-8")
            # 复用仓库已解析依赖；Cargo 仅补充测试 crate，不改变仓库 lockfile。
            # Reuse resolved dependencies; Cargo adds the harness without modifying the repository lockfile.
            lock = ROOT / "Cargo.lock"
            if lock.exists():
                shutil.copyfile(lock, directory / "Cargo.lock")
            (directory / "src/lib.rs").write_text(self.harness(), encoding="utf-8")
            result = subprocess.run(
                [cargo, "test", "--manifest-path", str(directory / "Cargo.toml"),
                 "--offline", "--target-dir", str(directory / "target"), "--lib"],
                cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace",
                timeout=600, check=False,
            )
            output = result.stdout + result.stderr
            self.assertEqual(result.returncode, 0, output)
            # 防止模块未加载时出现 0 tests 假阳性。 / Prevent a zero-tests false positive if the module is omitted.
            self.assertIn("reevaluate::tests::quorum_one_allows_missing_other_location", output)
            self.assertIn("reevaluate::tests::two_aliases_of_same_colo_do_not_meet_quorum_two", output)
            self.assertIn("reevaluate::tests::ownership_parameter_order_is_preserved", output)
            self.assertIn("probe_lifecycle::tests::pinned_five_observations_and_retries_gate_resolution", output)
            self.assertIn("probe_lifecycle::tests::service_candidate_is_carried_to_following_component", output)

    @staticmethod
    def manifest():
        """最小原生依赖，领域 crate 始终来自当前仓库。 / Minimal native dependencies with the domain crate from the current repository."""
        domain = json.dumps((ROOT / "crates/status-domain").as_posix())
        return f'''[package]
name = "reevaluate-isolated-tests"
version = "0.0.0"
edition = "2021"
[dependencies]
status-domain = {{ path = {domain} }}
serde = {{ version = "1", features = ["derive"] }}
serde_json = "1"
thiserror = "2"
sha2 = "0.10"
chrono = {{ version = "0.4", default-features = false, features = ["std"] }}
'''

    @staticmethod
    def harness():
        """D1 stub 永远报错，不伪装事务成功；纯函数仍使用实际生产实现。 / The D1 stub always fails; pure functions use production implementations."""
        database = json.dumps((ROOT / "crates/status-backend/src/database.rs").as_posix())
        reevaluate = json.dumps((ROOT / "crates/status-backend/src/scheduling/reevaluate.rs").as_posix())
        scheduling = json.dumps((ROOT / "crates/status-backend/src/scheduling/mod.rs").as_posix())
        lifecycle = json.dumps((ROOT / "crates/status-backend/src/scheduling/probe_lifecycle.rs").as_posix())
        return f'''#[path = {database}]
mod original_database;
mod database {{
    pub use super::original_database::{{Query, QueryResult, SqlValue, DatabaseError}};
    /// 原生测试没有 D1 binding。 / Native tests have no D1 binding.
    pub struct Database;
    impl Database {{
        /// 不模拟事务成功。 / Never simulate successful transactions.
        pub async fn batch(&self, _: &[Query]) -> Result<Vec<QueryResult<serde_json::Value>>, DatabaseError> {{
            Err(DatabaseError::Execution)
        }}
        /// 不模拟读取成功。 / Never simulate successful reads.
        pub async fn first<T: serde::de::DeserializeOwned>(&self, _: &Query) -> Result<Option<T>, DatabaseError> {{
            Err(DatabaseError::Execution)
        }}
        /// 不模拟查询成功。 / Never simulate successful queries.
        pub async fn all<T: serde::de::DeserializeOwned>(&self, _: &Query) -> Result<Vec<T>, DatabaseError> {{
            Err(DatabaseError::Execution)
        }}
    }}
}}
#[path = {reevaluate}]
mod reevaluate;
#[path = {scheduling}]
mod scheduling;
pub use scheduling::{{stable_id, types}};
#[path = {lifecycle}]
mod probe_lifecycle;
'''


if __name__ == "__main__":
    unittest.main()

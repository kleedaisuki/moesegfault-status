import { readFileSync } from "node:fs";

import {
  dispatch_json,
  initSync,
} from "../../packages/domain-wasm/pkg/status_domain.js";

let initialized = false;

/**
 * 加载真实 Rust/Wasm 领域核心；产物缺失时测试必须失败。
 * Load the real Rust/Wasm domain core; tests must fail when the build artifact is missing.
 *
 * CI 应在 Vitest 前运行 `pnpm build:wasm`。直接导入生成的 JS 可避免 Node
 * 尝试加载仅供 Workers bundler 使用的 `.wasm` 模块导入。
 * CI must run `pnpm build:wasm` before Vitest. Importing generated JS directly
 * prevents Node from loading the `.wasm` module form intended for the Workers bundler.
 */
export function realDomainCore(): {
  dispatchJson(requestJson: string): string;
} {
  if (!initialized) {
    const bytes = readFileSync(
      new URL(
        "../../packages/domain-wasm/pkg/status_domain_bg.wasm",
        import.meta.url,
      ),
    );
    const module = new WebAssembly.Module(Uint8Array.from(bytes).buffer);
    initSync({ module });
    initialized = true;
  }
  return { dispatchJson: dispatch_json };
}

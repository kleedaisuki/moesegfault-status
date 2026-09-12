import wasm from "../pkg/status_domain_bg.wasm";
import { initSync, dispatch_json } from "../pkg/status_domain.js";

// Workers 导入的是已编译 Module，initSync 避免 fetch 与 eval。 / Workers imports a compiled Module; initSync avoids fetch and eval.
initSync({ module: wasm });

/** 唯一领域执行桥；不包含 TypeScript 规则副本。 / Sole domain bridge; no duplicate TypeScript policy implementation.
 * @example dispatchJson(JSON.stringify({ operation: "canonical_fingerprint", payload: input }));
 */
export function dispatchJson(requestJson: string): string {
  return dispatch_json(requestJson);
}

/** 已编译核心的最小可注入接口。 / Minimal injectable interface for the compiled core. */
export const domainCore = Object.freeze({ dispatchJson });

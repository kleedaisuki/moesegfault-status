import { defineConfig } from "vitest/config";

/** 只发现本项目测试，不执行 target 中临时上游检出的代码。 / Discover project tests only, never temporary upstream checkouts in target. */
export default defineConfig({
  test: {
    include: [
      "apps/ops/src/**/*.{test,spec}.{ts,tsx,js,mjs}",
      "packages/**/*.{test,spec}.{ts,tsx,js,mjs}",
      "tests/**/*.{test,spec}.{ts,tsx,js,mjs}",
      "scripts/**/*.{test,spec}.{ts,tsx,js,mjs}",
    ],
  },
});

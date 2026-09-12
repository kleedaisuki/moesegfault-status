import { defineConfig } from "vitest/config";

/** Gateway 纯安全助手测试配置 / Test configuration for pure gateway security helpers. */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});

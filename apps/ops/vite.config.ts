import { defineConfig } from "vite";

/**
 * GitHub Pages 使用自定义域名，资源必须从根路径加载。
 * GitHub Pages uses a custom domain, so assets are served from the root path.
 */
export default defineConfig({
  base: "/",
  build: { target: "es2022", sourcemap: true },
});

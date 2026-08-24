import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Miniflare D1 测试文件共享 workerd 运行时，不能并行执行
    fileParallelism: false,
    // Miniflare 首次启动 workerd 并应用完整 migration 链时可能超过 Vitest 默认 10 秒。
    hookTimeout: 30_000,
  },
});

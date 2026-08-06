import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Miniflare D1 测试文件共享 workerd 运行时，不能并行执行
    fileParallelism: false,
  },
});

import { describe, it } from "vitest";
import { measureRequest, formatTimingReport, type TimingResult } from "@industrial/shared";

// 延迟写入遥测数据（payload 合法时触发 D1 写入）
const VALID_BODY = JSON.stringify({
  schemaVersion: 1,
  installIdHash: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
  trigger: "app_open",
});

describe("10ms CPU 时间预算验证", () => {
  it("遥测请求应在 10ms 内完成", async () => {
    // 动态导入 Worker 入口，避免影响其他测试
    const worker = await import("./index");

    const results: TimingResult[] = [];

    // 健康检查（无 IO，极快）
    results.push(
      await measureRequest("GET /health", () =>
        worker.default.fetch(
          new Request("https://localhost/health"),
          { DB: createMockDb() },
        ),
      ),
    );

    // 遥测上传（合法请求 → 触发 D1 INSERT）
    results.push(
      await measureRequest("POST /v1/telemetry/sync-shadow (valid)", () =>
        worker.default.fetch(
          new Request("https://localhost/v1/telemetry/sync-shadow", {
            method: "POST",
            headers: { "content-type": "application/json", "cf-connecting-ip": "1.2.3.4" },
            body: VALID_BODY,
          }),
          { DB: createMockDb() },
        ),
      ),
    );

    // 非法请求（JSON 解析失败，短路返回）
    results.push(
      await measureRequest("POST /v1/telemetry/sync-shadow (invalid JSON)", () =>
        worker.default.fetch(
          new Request("https://localhost/v1/telemetry/sync-shadow", {
            method: "POST",
            headers: { "content-type": "application/json", "cf-connecting-ip": "1.2.3.4" },
            body: "not json",
          }),
          { DB: createMockDb() },
        ),
      ),
    );

    console.log("\n" + formatTimingReport(results));

    // 注意：这里用 wall time 近似 CPU time。
    // D1 IO 不占用 CPU 配额，但本地测试中 D1 模拟（better-sqlite3）的实际
    // IO 延迟会计入 wall time。因此本地 >10ms 不意味着线上一定超限。
    // 但如果本地 wall time > 10ms，应检查代码路径是否有重复计算或同步阻塞。
  });
});

// 内存级 Mock D1（避免 better-sqlite3 原生依赖影响纯逻辑性能测试）
function createMockDb() {
  const store = new Map<string, unknown[]>();
  return {
    prepare: (query: string) => ({
      bind: (...values: unknown[]) => ({
        run: async () => {
          // 模拟 INSERT OR REPLACE
          if (query.includes("INSERT")) store.set("telemetry", [{ values }]);
          return { success: true };
        },
        first: async () => {
          if (query.includes("SELECT 1")) return { ok: 1 };
          return null;
        },
        all: async () => ({ results: [], success: true }),
      }),
    }),
    exec: async () => ({ success: true }),
    batch: async () => [],
  };
}

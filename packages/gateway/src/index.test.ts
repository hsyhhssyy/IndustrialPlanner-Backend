import { describe, it, expect } from "vitest";

// Gateway Worker 的入口导出测试（当前阶段骨架）
describe("gateway", () => {
  it("fetch handler 存在并可调用", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const worker = await import("./index");
    expect(worker.default).toBeDefined();
    expect(typeof worker.default.fetch).toBe("function");
  });

  it("健康检查返回 ok", async () => {
    const worker = await import("./index");
    const request = new Request("https://localhost/health");
    const response = await worker.default.fetch(request, {});
    expect(response.status).toBe(200);
    const body = await response.json() as { status: string };
    expect(body.status).toBe("ok");
  });

  it("未知路径返回 404", async () => {
    const worker = await import("./index");
    const request = new Request("https://localhost/unknown");
    const response = await worker.default.fetch(request, {});
    expect(response.status).toBe(404);
  });
});

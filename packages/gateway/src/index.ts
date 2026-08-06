import { Hono } from "hono";
import { handleCorsPreflight, withCors, Errors } from "@industrial/shared";

// 当前阶段：仅遥测 Worker 已实现，其他路由返回 501
const app = new Hono();

// CORS 预检处理
app.options("*", (c) => {
  return handleCorsPreflight();
});

// 健康检查
app.get("/health", (c) => {
  return c.json({ status: "ok", version: "0.1.0" });
});

// 遥测路由 → 转发到 telemetry-worker（当前暂直连，Service Binding 就绪后使用 env.TELEMETRY.fetch）
// 其他路由 → 501 Not Implemented
app.all("/v1/telemetry/*", async (c) => {
  // 当前阶段：遥测尚未拆出独立 Worker 时直接在此处理。
  // 遥测 Worker 实现后改为：return c.env.TELEMETRY.fetch(c.req.raw);
  return c.json(
    { error: "not_implemented", message: "遥测 Worker 尚未部署，请使用独立遥测端点" },
    501,
  );
});

// 同步路由 → 转发到 sync-worker
app.all("/v1/sync/*", async (c) => {
  if (c.env?.SYNC && typeof (c.env.SYNC as { fetch: unknown }).fetch === "function") {
    return (c.env.SYNC as { fetch: (r: Request) => Promise<Response> }).fetch(c.req.raw);
  }
  return c.json(
    { error: "not_implemented", message: "同步服务未绑定" },
    501,
  );
});

// 未匹配路由
app.all("*", (c) => {
  return Errors.notFound(`路径 ${new URL(c.req.url).pathname} 未实现`);
});

// 全局 CORS 包装
export default {
  fetch: async (request: Request, env: Record<string, unknown>) => {
    const response = await app.fetch(request, env);
    return withCors(response);
  },
};

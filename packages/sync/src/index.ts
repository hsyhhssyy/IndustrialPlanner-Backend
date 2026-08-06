// Sync Worker 入口（空壳，阶段四实现）
// 能力范围：revision 条件写入、幂等键、冲突响应

import { Hono } from "hono";
import { withCors, Errors } from "@industrial/shared";

const app = new Hono();

app.all("*", (c) => {
  return Errors.internal("Sync Worker 尚未实现");
});

export default {
  fetch: async (request: Request, env: Record<string, unknown>) => {
    const response = await app.fetch(request, env);
    return withCors(response);
  },
};

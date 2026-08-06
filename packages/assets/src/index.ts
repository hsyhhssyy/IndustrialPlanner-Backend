// Assets Worker 入口（空壳，阶段三实现）
// 能力范围：资产 Meta（D1）+ 资产 Content（R2）、数量配额

import { Hono } from "hono";
import { withCors, Errors } from "@industrial/shared";

const app = new Hono();

app.all("*", (c) => {
  return Errors.internal("Assets Worker 尚未实现");
});

export default {
  fetch: async (request: Request, env: Record<string, unknown>) => {
    const response = await app.fetch(request, env);
    return withCors(response);
  },
};

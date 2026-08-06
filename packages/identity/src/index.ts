// Identity Worker 入口（空壳，阶段二实现）
// 能力范围：账户主体、邮箱密码凭据、邮箱验证、密码找回、登录会话

import { Hono } from "hono";
import { withCors, Errors } from "@industrial/shared";

const app = new Hono();

app.all("*", (c) => {
  return Errors.internal("Identity Worker 尚未实现");
});

export default {
  fetch: async (request: Request, env: Record<string, unknown>) => {
    const response = await app.fetch(request, env);
    return withCors(response);
  },
};

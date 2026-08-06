// OAuth Worker 入口（空壳，阶段五实现）
// 能力范围：OAuth 登录身份映射、第三方服务授权连接

import { Hono } from "hono";
import { withCors, Errors } from "@industrial/shared";

const app = new Hono();

app.all("*", (c) => {
  return Errors.internal("OAuth Worker 尚未实现");
});

export default {
  fetch: async (request: Request, env: Record<string, unknown>) => {
    const response = await app.fetch(request, env);
    return withCors(response);
  },
};

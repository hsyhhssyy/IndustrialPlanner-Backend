// Identity Worker 入口（空壳，阶段二实现）
// 能力范围：账户主体、邮箱密码凭据、邮箱验证、密码找回、登录会话
// AI-CORRECTION 2026-08-23: Stage 2 只启用 OIDC 所需的最小账户与后端会话能力，不实现邮箱密码体系。

import { withCors } from "@industrial/shared";
import { createIdentityApp, type IdentityEnv } from "./http";

const app = createIdentityApp();

export default {
  fetch: async (request: Request, env: IdentityEnv) => {
    const response = await app.fetch(request, env);
    return withCors(response);
  },
};

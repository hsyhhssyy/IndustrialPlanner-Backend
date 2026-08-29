// OAuth Worker 入口（空壳，阶段五实现）
// 能力范围：OAuth 登录身份映射、第三方服务授权连接
// AI-CORRECTION 2026-08-23: Stage 2 实现单 Provider OIDC 登录身份映射，不保存 Provider token 或提供第三方业务授权连接。
// AI-CORRECTION 2026-08-29: Stage 2 M8 支持部署时在 OIDC 与 OrangeAuth 登录适配器中唯一选择一个，仍不持久化 Provider token 或提供第三方业务授权连接。

import { withCors, errorDebugInfo } from "@industrial/shared";
import { createOAuthApp, type OAuthEnv } from "./http";

const app = createOAuthApp();

export default {
  fetch: async (request: Request, env: OAuthEnv) => {
    try {
      const response = await app.fetch(request, env);
      return withCors(response);
    } catch (error) {
      const response = new Response(
        JSON.stringify({
          error: "internal_error",
          message: "OAuth 服务异常",
          ...errorDebugInfo(env, error),
        }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
      return withCors(response);
    }
  },
};

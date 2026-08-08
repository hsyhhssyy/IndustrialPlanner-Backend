// Sync Worker 入口 — 组合根
//
// 能力范围：cf-sync-v1 协议上传路径（prepare + R2 预签名 PUT + commit）
// Phase 1：无鉴权，自管资产 meta

import { createApp, type SyncEnv } from "./http";
import { withCors, ANONYMOUS_CORS_HEADERS } from "@industrial/shared";

const app = createApp();

export default {
  fetch: async (request: Request, env: SyncEnv) => {
    try {
      const response = await app.fetch(request, env);
      return withCors(response, ANONYMOUS_CORS_HEADERS);
    } catch (e) {
      // 异常也必须带 CORS 头，否则浏览器报 CORS 错误而非真正的错误信息
      const errorResponse = new Response(
        JSON.stringify({ error: "internal_error", message: `同步服务异常: ${(e as Error).message}` }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
      return withCors(errorResponse, ANONYMOUS_CORS_HEADERS);
    }
  },
};

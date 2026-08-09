// Sync Worker 入口 — 组合根
//
// 能力范围：cf-sync-v1 协议上传路径（prepare + R2 预签名 PUT + commit）
// Phase 1：无鉴权，自管资产 meta
// AI-CORRECTION 2026-08-09: active 协议已升级为 cf-sync-v2；prepare 获取 space 级独占租约，
// commit 原子推进 space revision，full-only 模式同时推进 epoch。

import { createSpaceSyncApp, runScheduledCleanup, type SpaceSyncEnv } from "./space_http";
import { withCors, ANONYMOUS_CORS_HEADERS } from "@industrial/shared";

const app = createSpaceSyncApp();

export default {
  fetch: async (request: Request, env: SpaceSyncEnv) => {
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
  scheduled: async (_controller: ScheduledController, env: SpaceSyncEnv, ctx: ExecutionContext) => {
    ctx.waitUntil(runScheduledCleanup(env));
  },
};

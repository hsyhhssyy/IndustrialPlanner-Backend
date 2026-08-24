// Sync Worker 入口
//
// 能力范围：cf-sync-v2 协议 space revision 独占上传事务。
// prepare 原子获取 space 租约，客户端并行 PUT，commit 推进 revision/epoch。
// 资产删除通过同一 space 批次的 deletions[] 声明，固定 R2 key 幂等删除后 D1 finalize。

import { createSpaceSyncApp, runScheduledCleanup, type SpaceSyncEnv } from "./space_http";
import { withCors, ANONYMOUS_CORS_HEADERS, errorDebugInfo } from "@industrial/shared";

const app = createSpaceSyncApp();

export default {
  fetch: async (request: Request, env: SpaceSyncEnv) => {
    try {
      const response = await app.fetch(request, env);
      return withCors(response, ANONYMOUS_CORS_HEADERS);
    } catch (e) {
      // 异常也必须带 CORS 头，否则浏览器报 CORS 错误而非真正的错误信息
      const errorResponse = new Response(
        JSON.stringify({ error: "internal_error", message: "同步服务异常", ...errorDebugInfo(env, e) }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
      return withCors(errorResponse, ANONYMOUS_CORS_HEADERS);
    }
  },
  scheduled: async (controller: ScheduledController, env: SpaceSyncEnv, ctx: ExecutionContext) => {
    ctx.waitUntil(runScheduledCleanup(env, controller.scheduledTime));
  },
};

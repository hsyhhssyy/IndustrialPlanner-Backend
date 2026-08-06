// Sync Worker 入口 — 组合根
//
// 能力范围：cf-sync-v1 协议上传路径（prepare + R2 预签名 PUT + commit）
// Phase 1：无鉴权，自管资产 meta

import { createApp, type SyncEnv } from "./http";
import { withCors, ANONYMOUS_CORS_HEADERS } from "@industrial/shared";

const app = createApp();

export default {
  fetch: async (request: Request, env: SyncEnv) => {
    const response = await app.fetch(request, env);
    return withCors(response, ANONYMOUS_CORS_HEADERS);
  },
};

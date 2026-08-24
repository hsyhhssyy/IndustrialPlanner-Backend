import { Hono } from "hono";
import {
  handleCorsPreflight,
  withCors,
  Errors,
  errorDebugInfo,
  verifyRequestJwt,
} from "@industrial/shared";

export interface GatewayEnv {
  SYNC?: Fetcher;
  OAUTH?: Fetcher;
  TELEMETRY?: Fetcher;
  JWT_SECRET?: string;
  ALLOW_ANONYMOUS_SPACES?: string;
  ENVIRONMENT?: string;
}

// 当前阶段：仅遥测 Worker 已实现，其他路由返回 501
// AI-CORRECTION 2026-08-23: Stage 2 已接入 oauth/sync Service Binding 与会话门禁；缺失 binding 仍返回 501。
const app = new Hono<{ Bindings: GatewayEnv }>();

function anonymousSpacesAllowed(env: GatewayEnv): boolean | null {
  if (env.ALLOW_ANONYMOUS_SPACES === "true") return true;
  if (env.ALLOW_ANONYMOUS_SPACES === "false") return false;
  return null;
}

async function authorizeSyncRequest(c: {
  env: GatewayEnv;
  req: { raw: Request; path: string };
  json(body: unknown, status: 401 | 500): Response;
}): Promise<Response | null> {
  const anonymousAllowed = anonymousSpacesAllowed(c.env);
  if (anonymousAllowed === null) {
    return c.json({ error: "configuration_error", message: "网关访问控制配置无效" }, 500);
  }
  const accountRequired = c.req.path === "/v1/sync/spaces/mine";
  if (c.req.raw.headers.get("authorization") === null) {
    return anonymousAllowed && !accountRequired
      ? null
      : c.json({ error: "token_missing", message: "需要 Bearer 会话" }, 401);
  }
  if (!c.env.JWT_SECRET) {
    return c.json({ error: "configuration_error", message: "网关访问控制配置无效" }, 500);
  }
  try {
    const verification = await verifyRequestJwt(c.req.raw, c.env.JWT_SECRET);
    if (!verification.ok) {
      return c.json({ error: verification.code, message: "Bearer 会话无效或已过期" }, 401);
    }
  } catch {
    return c.json({ error: "configuration_error", message: "网关访问控制配置无效" }, 500);
  }
  return null;
}

// CORS 预检处理
app.options("*", (c) => {
  return handleCorsPreflight();
});

// 健康检查
app.get("/health", (c) => {
  return c.json({ status: "ok", version: "0.1.0" });
});

// 遥测路由 → 转发到 telemetry-worker（当前暂直连，Service Binding 就绪后使用 env.TELEMETRY.fetch）
// 其他路由 → 501 Not Implemented
app.all("/v1/telemetry/*", async (c) => {
  // 当前阶段：遥测尚未拆出独立 Worker 时直接在此处理。
  // 遥测 Worker 实现后改为：return c.env.TELEMETRY.fetch(c.req.raw);
  // AI-CORRECTION 2026-08-23: 已有 TELEMETRY binding 时直接转发，且该路径始终不要求会话。
  if (c.env.TELEMETRY && typeof c.env.TELEMETRY.fetch === "function") {
    return c.env.TELEMETRY.fetch(c.req.raw);
  }
  return c.json(
    { error: "not_implemented", message: "遥测 Worker 尚未部署，请使用独立遥测端点" },
    501,
  );
});

app.all("/v1/oauth/*", async (c) => {
  if (c.env.OAUTH && typeof c.env.OAUTH.fetch === "function") {
    return c.env.OAUTH.fetch(c.req.raw);
  }
  return c.json(
    { error: "not_implemented", message: "OAuth 服务未绑定" },
    501,
  );
});

app.all("/v1/sync/capabilities", async (c) => {
  if (c.env.SYNC && typeof c.env.SYNC.fetch === "function") {
    return c.env.SYNC.fetch(c.req.raw);
  }
  return c.json(
    { error: "not_implemented", message: "同步服务未绑定" },
    501,
  );
});

// 同步路由 → 转发到 sync-worker
app.all("/v1/sync/*", async (c) => {
  const denied = await authorizeSyncRequest(c);
  if (denied) return denied;
  if (c.env.SYNC && typeof c.env.SYNC.fetch === "function") {
    return c.env.SYNC.fetch(c.req.raw);
  }
  return c.json(
    { error: "not_implemented", message: "同步服务未绑定" },
    501,
  );
});

// 未匹配路由
app.all("*", (c) => {
  return Errors.notFound(`路径 ${new URL(c.req.url).pathname} 未实现`);
});

// 全局 CORS 包装
export default {
  fetch: async (request: Request, env: GatewayEnv) => {
    try {
      const response = await app.fetch(request, env);
      return withCors(response);
    } catch (e) {
      // 异常也必须带 CORS 头，否则浏览器报 CORS 错误而非真正的错误信息
      const errorResponse = new Response(
        JSON.stringify({ error: "bad_gateway", message: "网关转发异常", ...errorDebugInfo(env as { ENVIRONMENT?: string }, e) }),
        { status: 502, headers: { "content-type": "application/json" } },
      );
      return withCors(errorResponse);
    }
  },
};

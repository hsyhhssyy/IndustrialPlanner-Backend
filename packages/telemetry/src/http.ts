// HTTP 适配层 — 路由与请求/响应转换

import { Hono } from "hono";
import type { Context } from "hono";
import {
  handleCorsPreflight,
  withCors,
  ANONYMOUS_CORS_HEADERS,
  successResponse,
  Errors,
} from "@industrial/shared";
import { handleTelemetryUpload, handleHealthCheck } from "./service";
import type { TelemetryDb } from "./repository";

// 从 Hono context 提取客户端 IP
function getClientIp(c: Context): string {
  // Cloudflare Workers 默认提供 cf-connecting-ip header
  const cfIp = c.req.header("cf-connecting-ip");
  if (cfIp) return cfIp;

  // 从 x-forwarded-for 取第一个 IP（可信代理场景）
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    return xff.split(",")[0]?.trim() ?? "127.0.0.1";
  }

  return "127.0.0.1";
}

// Telemetry Worker 依赖类型
export interface TelemetryEnv {
  DB: TelemetryDb;
}

export function createApp() {
  const app = new Hono<{ Bindings: TelemetryEnv }>();

  // CORS 预检
  app.options("*", (c) => {
    return handleCorsPreflight(ANONYMOUS_CORS_HEADERS);
  });

  // 健康检查
  app.get("/health", async (c) => {
    const result = await handleHealthCheck(c.env.DB);
    if (!result.ok) {
      return Errors.internal("服务不可用");
    }
    return c.json({ status: "ok", version: "0.1.0" });
  });

  // 匿名遥测上传
  app.post("/v1/telemetry/sync-shadow", async (c) => {
    const clientIp = getClientIp(c);
    const result = await handleTelemetryUpload(
      c.req.raw,
      c.env.DB,
      clientIp,
    );

    if (!result.ok) {
      return c.json(
        { error: result.error, message: result.message },
        result.status,
      );
    }

    return successResponse({ received: true }, 201);
  });

  return app;
}

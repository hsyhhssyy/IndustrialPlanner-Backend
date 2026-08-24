import { Hono } from "hono";
import {
  INTERNAL_SERVICE_AUTH_HEADER,
  type CreateSessionRequest,
} from "@industrial/shared";
import { isAccountId } from "./model";
import { createAccountRepository } from "./repository";
import {
  IdentityServiceError,
  createAccount,
  createSession,
} from "./service";

export interface IdentityEnv {
  DB: D1Database;
  JWT_SECRET?: string;
  INTERNAL_SERVICE_SECRET?: string;
  SESSION_TTL_SECONDS?: string;
}

function parseSessionTtl(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : Number.NaN;
}

function configurationError(c: { json(body: unknown, status: 500): Response }, message: string): Response {
  return c.json({ error: "configuration_error", message }, 500);
}

function serviceDependencies(env: IdentityEnv) {
  return {
    accounts: createAccountRepository(env.DB),
    jwtSecret: env.JWT_SECRET ?? "",
    sessionTtlSeconds: parseSessionTtl(env.SESSION_TTL_SECONDS),
  };
}

export function createIdentityApp(): Hono<{ Bindings: IdentityEnv }> {
  const app = new Hono<{ Bindings: IdentityEnv }>();

  app.onError((error, c) => {
    if (error instanceof IdentityServiceError) {
      return c.json({ error: error.code, message: error.message }, error.status);
    }
    return c.json({ error: "internal_error", message: "Identity 服务内部错误" }, 500);
  });

  app.get("/health", async (c) => {
    const healthy = await createAccountRepository(c.env.DB).checkHealth();
    return healthy
      ? c.json({ status: "ok", version: "0.2.0" })
      : c.json({ error: "database_unavailable", message: "数据库不可用" }, 503);
  });

  app.use("/internal/*", async (c, next) => {
    const secret = c.env.INTERNAL_SERVICE_SECRET;
    if (!secret || new TextEncoder().encode(secret).byteLength < 32) {
      return configurationError(c, "INTERNAL_SERVICE_SECRET 配置无效");
    }
    if (c.req.header(INTERNAL_SERVICE_AUTH_HEADER) !== secret) {
      return c.json({ error: "forbidden", message: "禁止访问内部端点" }, 403);
    }
    return next();
  });

  app.post("/internal/accounts", async (c) => {
    const result = await createAccount(serviceDependencies(c.env));
    return c.json(result, 201);
  });

  app.post("/internal/sessions", async (c) => {
    let body: CreateSessionRequest;
    try {
      body = await c.req.json<CreateSessionRequest>();
    } catch {
      return c.json({ error: "bad_request", message: "请求体不是合法 JSON" }, 400);
    }
    if (!isAccountId(body.accountId)) {
      return c.json({ error: "bad_request", message: "accountId 无效" }, 400);
    }
    const result = await createSession(body.accountId, serviceDependencies(c.env));
    c.header("cache-control", "no-store");
    return c.json(result);
  });

  app.all("*", (c) => c.json({ error: "not_found", message: "路径未实现" }, 404));
  return app;
}

import { describe, it, expect } from "vitest";
import { signJwt } from "@industrial/shared";
import worker, { type GatewayEnv } from "./index";

const JWT_SECRET = "gateway-test-jwt-secret-with-at-least-32-bytes";

function binding(name: string): Fetcher {
  return {
    fetch: async (request: Request) => Response.json({
      binding: name,
      path: new URL(request.url).pathname,
      authorization: request.headers.get("authorization"),
    }),
  } as unknown as Fetcher;
}

function request(pathname: string, env: GatewayEnv, init?: RequestInit): Promise<Response> {
  return worker.fetch(new Request(`https://gateway.test${pathname}`, init), env);
}

// Gateway Worker 的入口导出测试（当前阶段骨架）
describe("gateway", () => {
  it("fetch handler 存在并可调用", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const worker = await import("./index");
    expect(worker.default).toBeDefined();
    expect(typeof worker.default.fetch).toBe("function");
  });

  it("健康检查返回 ok", async () => {
    const worker = await import("./index");
    const request = new Request("https://localhost/health");
    const response = await worker.default.fetch(request, {});
    expect(response.status).toBe(200);
    const body = await response.json() as { status: string };
    expect(body.status).toBe("ok");
  });

  it("未知路径返回 404", async () => {
    const worker = await import("./index");
    const request = new Request("https://localhost/unknown");
    const response = await worker.default.fetch(request, {});
    expect(response.status).toBe(404);
  });
});

describe("gateway OIDC 与双环境门禁", () => {
  it("OAuth、telemetry 与 capabilities 在 stable 配置下仍匿名转发", async () => {
    const env: GatewayEnv = {
      OAUTH: binding("oauth"),
      TELEMETRY: binding("telemetry"),
      SYNC: binding("sync"),
      ALLOW_ANONYMOUS_SPACES: "false",
    };
    const responses = await Promise.all([
      request("/v1/oauth/authorize", env),
      request("/v1/telemetry/events", env),
      request("/v1/sync/capabilities", env),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    await expect(responses[0]!.json()).resolves.toMatchObject({ binding: "oauth" });
    await expect(responses[1]!.json()).resolves.toMatchObject({ binding: "telemetry" });
    await expect(responses[2]!.json()).resolves.toMatchObject({ binding: "sync" });
  });

  it("stable 拒绝匿名同步，beta 允许匿名同步但 mine 仍需会话", async () => {
    const stable: GatewayEnv = { SYNC: binding("sync"), ALLOW_ANONYMOUS_SPACES: "false" };
    const beta: GatewayEnv = { SYNC: binding("sync"), ALLOW_ANONYMOUS_SPACES: "true" };
    expect((await request("/v1/sync/spaces/example/check?knownRevision=0", stable)).status).toBe(401);
    expect((await request("/v1/sync/spaces/example/check?knownRevision=0", beta)).status).toBe(200);
    expect((await request("/v1/sync/spaces/mine", beta)).status).toBe(401);
  });

  it("beta 不把错误 token 降级为匿名，合法 token 原样转发", async () => {
    const env: GatewayEnv = {
      SYNC: binding("sync"),
      ALLOW_ANONYMOUS_SPACES: "true",
      JWT_SECRET,
    };
    const invalid = await request("/v1/sync/spaces/example/plan", env, {
      headers: { authorization: "Bearer invalid" },
    });
    expect(invalid.status).toBe(401);
    expect(await invalid.json()).toMatchObject({ error: "token_invalid" });

    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt({ sub: "account-1", iat: now, exp: now + 60 }, JWT_SECRET);
    const valid = await request("/v1/sync/spaces/mine", env, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(valid.status).toBe(200);
    expect(await valid.json()).toMatchObject({
      binding: "sync",
      authorization: `Bearer ${token}`,
    });
  });

  it("访问控制开关或 JWT secret 缺失时 fail-closed", async () => {
    const missingFlag = await request("/v1/sync/spaces/example/plan", {
      SYNC: binding("sync"),
    });
    expect(missingFlag.status).toBe(500);
    const missingSecret = await request("/v1/sync/spaces/example/plan", {
      SYNC: binding("sync"),
      ALLOW_ANONYMOUS_SPACES: "true",
    }, { headers: { authorization: "Bearer token" } });
    expect(missingSecret.status).toBe(500);
  });
});

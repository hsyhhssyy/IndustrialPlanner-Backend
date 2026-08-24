import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import fs from "node:fs";
import path from "node:path";
import { verifyJwt } from "@industrial/shared";
import worker from "./index";
import type { IdentityEnv } from "./http";

const JWT_SECRET = "identity-test-jwt-secret-with-at-least-32-bytes";
const INTERNAL_SECRET = "identity-test-internal-secret-at-least-32-bytes";
let miniflare: Miniflare;
let env: IdentityEnv;

async function applySchema(db: D1Database): Promise<void> {
  const sql = fs.readFileSync(
    path.resolve(__dirname, "..", "migrations", "0001_create_accounts.sql"),
    "utf8",
  );
  for (const statement of sql.split(";").map((value) => value.trim()).filter(Boolean)) {
    await db.prepare(statement).run();
  }
}

function request(pathname: string, init?: RequestInit, targetEnv = env): Promise<Response> {
  return worker.fetch(new Request(`https://identity.test${pathname}`, init), targetEnv);
}

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2025-08-06",
    d1Databases: ["DB"],
  });
  const db = await miniflare.getD1Database("DB") as unknown as D1Database;
  await applySchema(db);
  env = {
    DB: db,
    JWT_SECRET,
    INTERNAL_SERVICE_SECRET: INTERNAL_SECRET,
    SESSION_TTL_SECONDS: "3600",
  };
});

afterAll(async () => {
  await miniflare.dispose();
});

describe("identity 最小账户与会话", () => {
  it("拒绝未认证的内部调用", async () => {
    const response = await request("/internal/accounts", { method: "POST" });
    expect(response.status).toBe(403);
  });

  it("创建不同账户并为真实账户签发可验证会话", async () => {
    const headers = { "x-industrial-internal-auth": INTERNAL_SECRET };
    const first = await request("/internal/accounts", { method: "POST", headers });
    const second = await request("/internal/accounts", { method: "POST", headers });
    expect(first.status, await first.clone().text()).toBe(201);
    expect(second.status, await second.clone().text()).toBe(201);
    const firstBody = await first.json() as { accountId: string };
    const secondBody = await second.json() as { accountId: string };
    expect(firstBody.accountId).not.toBe(secondBody.accountId);

    const session = await request("/internal/sessions", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ accountId: firstBody.accountId }),
    });
    expect(session.status).toBe(200);
    expect(session.headers.get("cache-control")).toBe("no-store");
    const sessionBody = await session.json() as { accessToken: string };
    const verified = await verifyJwt(sessionBody.accessToken, JWT_SECRET);
    expect(verified.ok && verified.payload.sub).toBe(firstBody.accountId);
  });

  it("拒绝为不存在账户签发会话", async () => {
    const response = await request("/internal/sessions", {
      method: "POST",
      headers: {
        "x-industrial-internal-auth": INTERNAL_SECRET,
        "content-type": "application/json",
      },
      body: JSON.stringify({ accountId: "missing-account" }),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "account_not_found" });
  });

  it("缺失服务 secret 时 fail-closed", async () => {
    const response = await request("/internal/accounts", { method: "POST" }, {
      ...env,
      INTERNAL_SERVICE_SECRET: undefined,
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "configuration_error" });
  });
});

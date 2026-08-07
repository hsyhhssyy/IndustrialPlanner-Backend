// http.ts 路由骨架 — HTTP 端点测试（E2E 通过 worker.fetch）

import { describe, it, expect, beforeAll } from "vitest";
import { createApp, type SyncEnv } from "./http";

// 最小 mock D1Database（满足 env.DB 的 truthy 检查）
function mockDb(): D1Database {
  return { prepare: () => ({}), batch: () => [], exec: () => ({}), dump: () => Promise.resolve([]) } as unknown as D1Database;
}

// 测试用 env（有 DB 则 health 返回 200）
function testEnv(): SyncEnv {
  return {
    DB: mockDb(),
    BLOB_STORE: undefined as unknown as R2Bucket,
    PROTOCOL_VERSION: "cf-sync-v1",
    MAX_MUTATIONS_PER_BATCH: "32",
    MAX_METADATA_SIZE: "262144",
    COMMIT_TOKEN_SECRET: "test-secret-key-32-bytes-long!!",
    R2_ACCESS_KEY_ID: "test-key",
    R2_SECRET_ACCESS_KEY: "test-secret",
    R2_ACCOUNT_ID: "test-account",
    R2_BUCKET_NAME: "test-bucket",
    LOCAL_DEV_HOST: "",
  };
}

let app: ReturnType<typeof createApp>;

beforeAll(() => {
  app = createApp();
});

describe("http routes", () => {
  describe("GET /health", () => {
    it("返回 200 {status:'ok'}", async () => {
      const req = new Request("https://localhost/health");
      const res = await app.fetch(req, testEnv());
      expect(res.status).toBe(200);
      const body = await res.json() as { status: string; version: string };
      expect(body.status).toBe("ok");
      expect(body.version).toBeDefined();
    });

    it("D1 不可用时返回 503", async () => {
      const noDbEnv = { ...testEnv(), DB: undefined as unknown as D1Database };
      const req = new Request("https://localhost/health");
      const res = await app.fetch(req, noDbEnv);
      expect(res.status).toBe(503);
    });
  });

  describe("GET /v1/sync/capabilities", () => {
    it("返回协议信息", async () => {
      const req = new Request("https://localhost/v1/sync/capabilities");
      const res = await app.fetch(req, testEnv());
      expect(res.status).toBe(200);
      const body = await res.json() as {
        protocol: string;
        maxMutationsPerBatch: number;
        maxMetadataSize: number;
      };
      expect(body.protocol).toBe("cf-sync-v1");
      expect(body.maxMutationsPerBatch).toBe(32);
      expect(body.maxMetadataSize).toBe(262144);
    });
  });

  describe("CORS 预检", () => {
    it("OPTIONS 返回 204 + CORS 头", async () => {
      const req = new Request(
        "https://localhost/v1/sync/spaces/test/mutations",
        { method: "OPTIONS" },
      );
      const res = await app.fetch(req, testEnv());
      expect(res.status).toBe(204);
      expect(
        res.headers.get("access-control-allow-origin"),
      ).toBe("*");
    });
  });

  describe("未知路由", () => {
    it("未知路径返回 404", async () => {
      const req = new Request("https://localhost/unknown");
      const res = await app.fetch(req, testEnv());
      expect(res.status).toBe(404);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("not_found");
    });
  });

  describe("POST /v1/sync/spaces/:spaceId/mutations", () => {
    it("未知 action 返回 400", async () => {
      const req = new Request(
        "https://localhost/v1/sync/spaces/test/mutations",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "unknown" }),
        },
      );
      const res = await app.fetch(req, testEnv());
      expect(res.status).toBe(400);
    });

    it("缺少 Content-Type 返回 400", async () => {
      const req = new Request(
        "https://localhost/v1/sync/spaces/test/mutations",
        {
          method: "POST",
          body: JSON.stringify({ action: "prepare" }),
        },
      );
      const res = await app.fetch(req, testEnv());
      expect(res.status).toBe(400);
    });

    it("非法 JSON body 返回 400", async () => {
      const req = new Request(
        "https://localhost/v1/sync/spaces/test/mutations",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "not-json",
        },
      );
      const res = await app.fetch(req, testEnv());
      expect(res.status).toBe(400);
    });

    it("commit 缺少 commitToken 返回 400", async () => {
      const req = new Request(
        "https://localhost/v1/sync/spaces/test/mutations",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "commit",
            spaceEpoch: "epoch-1",
            mutations: [],
          }),
        },
      );
      const res = await app.fetch(req, testEnv());
      expect(res.status).toBe(400);
    });
  });

  describe("CORS 头出现在所有响应中", () => {
    it("404 响应含 CORS 头", async () => {
      const req = new Request("https://localhost/unknown");
      const res = await app.fetch(req, testEnv());
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    });

    it("400 响应含 CORS 头", async () => {
      const req = new Request(
        "https://localhost/v1/sync/spaces/test/mutations",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "unknown" }),
        },
      );
      const res = await app.fetch(req, testEnv());
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    });
  });
});

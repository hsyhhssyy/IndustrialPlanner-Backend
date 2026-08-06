// index.ts 入口 — 全流程 E2E 测试（Miniflare D1 + R2）

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPlatformProxy } from "wrangler";
import path from "path";
import fs from "node:fs";
import { createRepository } from "./repository";
import { signCommitToken } from "./commit_token";
import { handleCommit } from "./service";
import type { SpaceRow } from "./repository";

function execMigrationSync(db: D1Database, sql: string) {
  const cleaned = sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
  for (const stmt of cleaned.split(";").map((s) => s.trim()).filter((s) => s.length > 0)) {
    db.prepare(stmt).run();
  }
}

const MOCK_SECRET = "test-secret-key-32-bytes-long!!";
let db: D1Database;
let r2: R2Bucket;

beforeAll(async () => {
  const proxy = await getPlatformProxy<{ DB: D1Database; BLOB_STORE: R2Bucket }>({
    configPath: path.resolve(__dirname, "..", "wrangler.toml"),
  });
  db = proxy.env.DB;
  r2 = proxy.env.BLOB_STORE;
  const sqlPath = path.resolve(__dirname, "..", "migrations", "0001_create_sync_tables.sql");
  execMigrationSync(db, fs.readFileSync(sqlPath, "utf-8"));
});

afterAll(async () => {
  await db.prepare("DELETE FROM sync_mutation_results").run();
  await db.prepare("DELETE FROM sync_asset_versions").run();
  await db.prepare("DELETE FROM sync_blobs").run();
  await db.prepare("DELETE FROM sync_assets").run();
  await db.prepare("DELETE FROM sync_spaces").run();
});

// HTTP 合约 E2E
describe("E2E — worker.fetch 集成（真实 D1）", () => {
  const env = () => ({
    DB: db, BLOB_STORE: r2,
    PROTOCOL_VERSION: "cf-sync-v1", MAX_MUTATIONS_PER_BATCH: "32", MAX_METADATA_SIZE: "262144",
    COMMIT_TOKEN_SECRET: MOCK_SECRET,
    R2_ACCESS_KEY_ID: "", R2_SECRET_ACCESS_KEY: "", R2_ACCOUNT_ID: "", R2_BUCKET_NAME: "",
    LOCAL_DEV_HOST: "http://localhost:8792",
  });

  it("GET /health → 200", async () => {
    const w = await import("./index");
    const res = await w.default.fetch(new Request("https://localhost/health"), env());
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("ok");
  });

  it("GET /v1/sync/capabilities → 200", async () => {
    const w = await import("./index");
    const res = await w.default.fetch(new Request("https://localhost/v1/sync/capabilities"), env());
    expect(res.status).toBe(200);
    expect(((await res.json()) as { protocol: string }).protocol).toBe("cf-sync-v1");
  });

  it("OPTIONS → 204 + CORS", async () => {
    const w = await import("./index");
    const res = await w.default.fetch(
      new Request("https://localhost/v1/sync/spaces/test/mutations", { method: "OPTIONS" }), env());
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("PUT blob 直传 → 写入本地 R2", async () => {
    const w = await import("./index");
    const blobBody = "binary-blob-content";
    const hash = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2"; // 64 字符
    const url = `/v1/sync/spaces/test-space/blobs/epoch-1/sha256/a1/${hash}`;

    // PUT blob
    const putRes = await w.default.fetch(
      new Request(`https://localhost${url}`, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: blobBody,
      }),
      env(),
    );
    expect(putRes.status).toBe(200);

    // HEAD 验证
    const head = await r2.head(`sync/v1/test-space/epoch-1/blobs/sha256/a1/${hash}`);
    expect(head).not.toBeNull();
    expect(head!.size).toBe(blobBody.length);
  });
});

// 全流程 E2E（真实 D1 + R2）
describe("E2E — 上传全流程（真实 D1 + R2）", () => {
  const S = "e2e-space", E = "epoch-1", N = Date.now(), P = "2026-08-06T00:00:00Z";

  beforeAll(async () => {
    await createRepository(db).insertSpace({
      spaceId: S, activeEpoch: E, head: 0, minRetainedHead: 0, updatedAt: P,
    } satisfies SpaceRow);
  });

  it("space head 可读 → head=0 epoch 匹配", async () => {
    const space = await createRepository(db).getSpaceHead(S);
    expect(space).not.toBeNull();
    expect(space!.head).toBe(0);
  });

  it("commit 新资产 → head +1，数据原子写入 D1", async () => {
    const repo = createRepository(db);
    const h = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
    await r2.put(`sync/v1/${S}/${E}/blobs/sha256/a1/${h}`, "data");

    const token = await signCommitToken({
      spaceId: S, epoch: E, clientBatchId: "b1", observedHead: 0,
      mutations: [{ clientMutationId: "cm1", assetType: "bp", assetId: "bp-1", baseRevision: null }],
      expiresAt: N + 300_000,
    }, MOCK_SECRET);

    const r = await handleCommit(S, E, token, [{
      clientMutationId: "cm1", assetType: "bp", assetId: "bp-1",
      baseRevision: null, baseContentHash: null, metadata: "{}",
      blobHash: h, blobByteSize: 4, storageMode: "full",
      schemaVersion: 1, encoding: "identity", writerAppVersion: "1.0.0", writerBuildId: "b1",
    }], { repo, commitTokenSecret: MOCK_SECRET, r2Bucket: r2, now: N, presentTime: P });

    expect(r.status).toBe("committed");
    expect(r.head).toBe(1);
    expect(r.applied![0]?.revision).toBe(1);

    const space = await repo.getSpaceHead(S);
    expect(space!.head).toBe(1);
    const asset = await repo.getAssetHead(S, E, "bp", "bp-1");
    expect(asset!.contentHash).toBe(h);
  });

  it("重复 commit → already-committed，head 不增长", async () => {
    const repo = createRepository(db);
    const h = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";

    const token = await signCommitToken({
      spaceId: S, epoch: E, clientBatchId: "b2", observedHead: 1,
      mutations: [{ clientMutationId: "cm1", assetType: "bp", assetId: "bp-1", baseRevision: 1 }],
      expiresAt: N + 300_000,
    }, MOCK_SECRET);

    const r = await handleCommit(S, E, token, [{
      clientMutationId: "cm1", assetType: "bp", assetId: "bp-1",
      baseRevision: 1, baseContentHash: h, metadata: "{}",
      blobHash: h, blobByteSize: 4, storageMode: "full",
      schemaVersion: 1, encoding: "identity", writerAppVersion: "1.0.0", writerBuildId: "b1",
    }], { repo, commitTokenSecret: MOCK_SECRET, r2Bucket: r2, now: N, presentTime: P });

    expect(r.status).toBe("already-committed");
    expect(r.head).toBe(1);
  });

  it("并发 CAS → 第一个成功，第二个 revision 冲突", async () => {
    const repoSeed = createRepository(db);
    await repoSeed.upsertAssetHead({
      spaceId: S, epoch: E, assetType: "bp", assetId: "bp-cc",
      revision: 1, currentHead: 1, contentHash: "init", deletedAt: null,
      schemaVersion: 1, minReadableSchemaVersion: 1,
      writerAppVersion: "1.0.0", writerBuildId: "b1", committedAt: P,
      storageMode: "full", baseFullBlobHash: null, deltaDepth: 0,
    });

    const h = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    await r2.put(`sync/v1/${S}/${E}/blobs/sha256/de/${h}`, "data");

    const deps = { commitTokenSecret: MOCK_SECRET, r2Bucket: r2, now: N, presentTime: P };

    // request A succeeds
    const tA = await signCommitToken({
      spaceId: S, epoch: E, clientBatchId: "cc-a", observedHead: 1,
      mutations: [{ clientMutationId: "cm-cc-a", assetType: "bp", assetId: "bp-cc", baseRevision: 1 }],
      expiresAt: N + 300_000,
    }, MOCK_SECRET);
    const rA = await handleCommit(S, E, tA, [{
      clientMutationId: "cm-cc-a", assetType: "bp", assetId: "bp-cc",
      baseRevision: 1, baseContentHash: "init", metadata: "{}",
      blobHash: h, blobByteSize: 4, storageMode: "full",
      schemaVersion: 1, encoding: "identity", writerAppVersion: "1.0.0", writerBuildId: "b1",
    }], { ...deps, repo: createRepository(db) });
    expect(rA.status).toBe("committed");

    // request B gets conflict
    const tB = await signCommitToken({
      spaceId: S, epoch: E, clientBatchId: "cc-b", observedHead: 1,
      mutations: [{ clientMutationId: "cm-cc-b", assetType: "bp", assetId: "bp-cc", baseRevision: 1 }],
      expiresAt: N + 300_000,
    }, MOCK_SECRET);
    const rB = await handleCommit(S, E, tB, [{
      clientMutationId: "cm-cc-b", assetType: "bp", assetId: "bp-cc",
      baseRevision: 1, baseContentHash: "init", metadata: "{}",
      blobHash: "different-hash-12345678901234567890123456789012",
      blobByteSize: 4, storageMode: "full",
      schemaVersion: 1, encoding: "identity", writerAppVersion: "1.0.0", writerBuildId: "b1",
    }], { ...deps, repo: createRepository(db) });

    expect(rB.status).toBe("conflict");
    expect(rB.conflicts?.[0]?.reason).toBe("revision-mismatch");
  });
});

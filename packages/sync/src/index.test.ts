// index.ts 入口 — 全流程 E2E 测试（Miniflare D1 + R2）

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPlatformProxy } from "wrangler";
import path from "path";
import fs from "node:fs";
import { createRepository } from "./repository";
import { signCommitToken } from "./commit_token";
import { handleCommit } from "./service";
import type { SpaceRow } from "./repository";
import type { PlanResponse, AssetSummary, CheckResponse, ResetResponse, DownloadsSignResponse } from "./model";

function execMigrationSync(db: D1Database, sql: string) {
  const cleaned = sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
  for (const stmt of cleaned.split(";").map((s) => s.trim()).filter((s) => s.length > 0)) {
    db.prepare(stmt).run();
  }
}

const MOCK_SECRET = "test-secret-key-32-bytes-long!!";
let db: D1Database;
let r2: R2Bucket;

function getR2(): R2Bucket {
  return r2;
}

beforeAll(async () => {
  const proxy = await getPlatformProxy<{ DB: D1Database; BLOB_STORE: R2Bucket }>({
    configPath: path.resolve(__dirname, "..", "wrangler.toml"),
  });
  db = proxy.env.DB;
  r2 = proxy.env.BLOB_STORE;
  const sqlPath1 = path.resolve(__dirname, "..", "migrations", "0001_create_sync_tables.sql");
  execMigrationSync(db, fs.readFileSync(sqlPath1, "utf-8"));
  const sqlPath2 = path.resolve(__dirname, "..", "migrations", "0002_add_download_tables.sql");
  execMigrationSync(db, fs.readFileSync(sqlPath2, "utf-8"));
});

afterAll(async () => {
  await db.prepare("DELETE FROM sync_mutation_results").run();
  await db.prepare("DELETE FROM sync_changes").run();
  await db.prepare("DELETE FROM sync_module_heads").run();
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

// ============================================================================
// plan endpoint E2E
// ============================================================================
describe("E2E — plan 端点（GET /v1/sync/spaces/:spaceId/plan）", () => {
  const S = "plan-space", E = "epoch-1", N = Date.now(), P = "2026-08-07T00:00:00Z";
  const env = () => ({
    DB: db, BLOB_STORE: r2,
    PROTOCOL_VERSION: "cf-sync-v1", MAX_MUTATIONS_PER_BATCH: "32", MAX_METADATA_SIZE: "262144",
    COMMIT_TOKEN_SECRET: MOCK_SECRET,
    R2_ACCESS_KEY_ID: "", R2_SECRET_ACCESS_KEY: "", R2_ACCOUNT_ID: "", R2_BUCKET_NAME: "",
    LOCAL_DEV_HOST: "http://localhost:8792",
  });

  beforeAll(async () => {
    await createRepository(db).insertSpace({
      spaceId: S, activeEpoch: E, head: 0, minRetainedHead: 0, updatedAt: P,
    } satisfies SpaceRow);

    // 上传一个资产，使 plan 有数据可返回
    const repo = createRepository(db);
    const h = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
    await r2.put(`sync/v1/${S}/${E}/blobs/sha256/a1/${h}`, "plan-asset-data");

    const token = await signCommitToken({
      spaceId: S, epoch: E, clientBatchId: "plan-b1", observedHead: 0,
      mutations: [{ clientMutationId: "plan-cm1", assetType: "bp", assetId: "bp-1", baseRevision: null }],
      expiresAt: N + 300_000,
    }, MOCK_SECRET);

    await handleCommit(S, E, token, [{
      clientMutationId: "plan-cm1", assetType: "bp", assetId: "bp-1",
      baseRevision: null, baseContentHash: null, metadata: "{}",
      blobHash: h, blobByteSize: 4, storageMode: "full",
      schemaVersion: 1, encoding: "identity", writerAppVersion: "1.0.0", writerBuildId: "b1",
    }], { repo, commitTokenSecret: MOCK_SECRET, r2Bucket: r2, now: N, presentTime: P });
  });

  it("GET plan → 200，返回 space head + 按模块分组的 asset 列表", async () => {
    const w = await import("./index");
    const res = await w.default.fetch(
      new Request(`https://localhost/v1/sync/spaces/${S}/plan`),
      env(),
    );
    expect(res.status).toBe(200);

    const body = await res.json() as PlanResponse;
    expect(body.head).toBe(1);
    expect(body.snapshotHead).toBe(1);
    expect(body.epoch).toBe(E);
    expect(body.modules).toBeDefined();
    expect(body.modules.length).toBeGreaterThanOrEqual(1);

    // 验证 capabilities 嵌入
    expect(body.capabilities).toBeDefined();
    expect(body.capabilities.protocol).toBe("cf-sync-v1");
    expect(body.nextPageToken).toBeNull();
    expect(body.minRetainedHead).toBe(0);

    const bpModule = body.modules.find((m) => m.moduleType === "bp");
    expect(bpModule).toBeDefined();
    const bp1 = bpModule!.assets.find((a) => a.assetId === "bp-1");
    expect(bp1).toBeDefined();
    expect(bp1!.assetType).toBe("bp");
    expect(bp1!.revision).toBe(1);
    expect(bp1!.contentHash).toBe("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0");
    expect(bp1!.schemaVersion).toBe(1);
    expect(bp1!.storageMode).toBe("full");
    // 本地开发模式：downloadUrl 应为本地直传 URL
    expect(bp1!.downloadUrl).toContain("/blobs/");
    expect(bp1!.downloadUrl).toContain("sha256");
  });

  it("GET plan with assetTypes filter → 只返回匹配类型的 modules", async () => {
    const w = await import("./index");
    const res = await w.default.fetch(
      new Request(`https://localhost/v1/sync/spaces/${S}/plan?assetTypes=bp`),
      env(),
    );
    expect(res.status).toBe(200);

    const body = await res.json() as PlanResponse;
    expect(body.modules.length).toBeGreaterThanOrEqual(1);
    expect(body.modules.every((m) => m.moduleType === "bp")).toBe(true);
  });

  it("GET plan with non-matching assetTypes → 返回空 modules", async () => {
    const w = await import("./index");
    const res = await w.default.fetch(
      new Request(`https://localhost/v1/sync/spaces/${S}/plan?assetTypes=base`),
      env(),
    );
    expect(res.status).toBe(200);

    const body = await res.json() as PlanResponse;
    expect(body.modules).toHaveLength(0);
  });

  it("GET plan for non-existent space → 404", async () => {
    const w = await import("./index");
    const res = await w.default.fetch(
      new Request("https://localhost/v1/sync/spaces/nonexistent/plan"),
      env(),
    );
    expect(res.status).toBe(404);
  });
});

// ============================================================================
// check endpoint E2E
// ============================================================================
describe("E2E — check 端点（GET /v1/sync/spaces/:spaceId/check）", () => {
  const S = "check-space", E = "epoch-1", N = Date.now(), P = "2026-08-07T00:00:00Z";
  const env = () => ({
    DB: db, BLOB_STORE: r2,
    PROTOCOL_VERSION: "cf-sync-v1", MAX_MUTATIONS_PER_BATCH: "32", MAX_METADATA_SIZE: "262144",
    COMMIT_TOKEN_SECRET: MOCK_SECRET,
    R2_ACCESS_KEY_ID: "", R2_SECRET_ACCESS_KEY: "", R2_ACCOUNT_ID: "", R2_BUCKET_NAME: "",
    LOCAL_DEV_HOST: "http://localhost:8792",
  });

  beforeAll(async () => {
    await createRepository(db).insertSpace({
      spaceId: S, activeEpoch: E, head: 0, minRetainedHead: 0, updatedAt: P,
    } satisfies SpaceRow);

    // 上传一个资产到 head=1
    const repo = createRepository(db);
    const h = "c1c2c3c4c5c6c7c8c9c0d1d2d3d4d5d6d7d8d9d0";
    await r2.put(`sync/v1/${S}/${E}/blobs/sha256/c1/${h}`, "check-data");

    const token = await signCommitToken({
      spaceId: S, epoch: E, clientBatchId: "check-b1", observedHead: 0,
      mutations: [{ clientMutationId: "check-cm1", assetType: "bp", assetId: "chk-1", baseRevision: null }],
      expiresAt: N + 300_000,
    }, MOCK_SECRET);

    await handleCommit(S, E, token, [{
      clientMutationId: "check-cm1", assetType: "bp", assetId: "chk-1",
      baseRevision: null, baseContentHash: null, metadata: "{}",
      blobHash: h, blobByteSize: 4, storageMode: "full",
      schemaVersion: 1, encoding: "identity", writerAppVersion: "1.0.0", writerBuildId: "b1",
    }], { repo, commitTokenSecret: MOCK_SECRET, r2Bucket: r2, now: N, presentTime: P });
  });

  it("GET check with knownHead=1 → changed=false，204 No Content", async () => {
    const w = await import("./index");
    const res = await w.default.fetch(
      new Request(`https://localhost/v1/sync/spaces/${S}/check?knownHead=1`),
      env(),
    );
    expect(res.status).toBe(204);
    // 204 无响应体
    const text = await res.text();
    expect(text).toBe("");
  });

  it("GET check with knownHead=0 → changed=true，200 + changes/planRequired", async () => {
    const w = await import("./index");
    const res = await w.default.fetch(
      new Request(`https://localhost/v1/sync/spaces/${S}/check?knownHead=0`),
      env(),
    );
    expect(res.status).toBe(200);

    const body = await res.json() as CheckResponse;
    expect(body.changed).toBe(true);
    expect(body.planRequired).toBe(true);
    expect(body.changes).toBeDefined();
    expect(body.changes.length).toBeGreaterThanOrEqual(1);
    // 变更资产应包含 chk-1
    const chk1 = body.changes.find((a) => a.assetId === "chk-1");
    expect(chk1).toBeDefined();
    expect(chk1!.assetType).toBe("bp");
    // moduleHeads 来自 sync_module_heads（commitBatch 已写入）
    expect(body.moduleHeads.length).toBeGreaterThanOrEqual(1);
    expect(body.moduleHeads.some((mh) => mh.moduleType === "bp")).toBe(true);
  });

  it("GET check with knownHead > current head → changed=false，204", async () => {
    const w = await import("./index");
    const res = await w.default.fetch(
      new Request(`https://localhost/v1/sync/spaces/${S}/check?knownHead=999`),
      env(),
    );
    expect(res.status).toBe(204);
  });

  it("GET check without knownHead → changed=true，200", async () => {
    const w = await import("./index");
    const res = await w.default.fetch(
      new Request(`https://localhost/v1/sync/spaces/${S}/check`),
      env(),
    );
    expect(res.status).toBe(200);

    const body = await res.json() as CheckResponse;
    expect(body.changed).toBe(true);
    expect(body.planRequired).toBe(true);
  });

  it("GET check for non-existent space → 404", async () => {
    const w = await import("./index");
    const res = await w.default.fetch(
      new Request("https://localhost/v1/sync/spaces/nonexistent/check"),
      env(),
    );
    expect(res.status).toBe(404);
  });
});

// ============================================================================
// 跨浏览器可见性 — b1 commit 后 b2 plan/check 可见
// ============================================================================
describe("E2E — 跨浏览器可见性（b1 commit → b2 plan/check）", () => {
  const S = "cross-space", E = "epoch-1", N = Date.now(), P = "2026-08-07T00:00:00Z";
  const env = () => ({
    DB: db, BLOB_STORE: r2,
    PROTOCOL_VERSION: "cf-sync-v1", MAX_MUTATIONS_PER_BATCH: "32", MAX_METADATA_SIZE: "262144",
    COMMIT_TOKEN_SECRET: MOCK_SECRET,
    R2_ACCESS_KEY_ID: "", R2_SECRET_ACCESS_KEY: "", R2_ACCOUNT_ID: "", R2_BUCKET_NAME: "",
    LOCAL_DEV_HOST: "http://localhost:8792",
  });

  beforeAll(async () => {
    await createRepository(db).insertSpace({
      spaceId: S, activeEpoch: E, head: 0, minRetainedHead: 0, updatedAt: P,
    } satisfies SpaceRow);
  });

  it("b1 commit → b2 check 看到 changed=true → b2 plan 拿到资产", async () => {
    // b1: 上传资产
    const repo = createRepository(db);
    const h = "cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe";
    await getR2().put(`sync/v1/${S}/${E}/blobs/sha256/ca/${h}`, "cross-browser-data");

    const token = await signCommitToken({
      spaceId: S, epoch: E, clientBatchId: "cross-b1", observedHead: 0,
      mutations: [{ clientMutationId: "cross-cm1", assetType: "bp", assetId: "cross-1", baseRevision: null }],
      expiresAt: N + 300_000,
    }, MOCK_SECRET);

    const r = await handleCommit(S, E, token, [{
      clientMutationId: "cross-cm1", assetType: "bp", assetId: "cross-1",
      baseRevision: null, baseContentHash: null, metadata: "{}",
      blobHash: h, blobByteSize: 4, storageMode: "full",
      schemaVersion: 1, encoding: "identity", writerAppVersion: "1.0.0", writerBuildId: "b1",
    }], { repo, commitTokenSecret: MOCK_SECRET, r2Bucket: r2, now: N, presentTime: P });

    expect(r.status).toBe("committed");
    expect(r.head).toBe(1);

    // b2: check — 应该看到 changed
    const w = await import("./index");
    const checkRes = await w.default.fetch(
      new Request(`https://localhost/v1/sync/spaces/${S}/check?knownHead=0`),
      env(),
    );
    expect(checkRes.status).toBe(200);
    const checkBody = await checkRes.json() as CheckResponse;
    expect(checkBody.head).toBe(1);
    expect(checkBody.changed).toBe(true);
    expect(checkBody.planRequired).toBe(true);
    expect(checkBody.changes.some((a) => a.assetId === "cross-1")).toBe(true);
    expect(checkBody.moduleHeads.some((mh) => mh.moduleType === "bp")).toBe(true);

    // b2: plan — 应该拿到资产
    const planRes = await w.default.fetch(
      new Request(`https://localhost/v1/sync/spaces/${S}/plan`),
      env(),
    );
    expect(planRes.status).toBe(200);
    const planBody = await planRes.json() as PlanResponse;
    expect(planBody.head).toBe(1);
    expect(planBody.modules.length).toBeGreaterThanOrEqual(1);
    const bpModule = planBody.modules.find((m) => m.moduleType === "bp");
    expect(bpModule).toBeDefined();
    expect(bpModule!.assets.some((a) => a.assetId === "cross-1")).toBe(true);
  });

  it("b1 commit 后 b2 check with knownHead=0 → changed=true, b2 check with knownHead=1 → 204", async () => {
    const repo = createRepository(db);
    const hash2 = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    await getR2().put(`sync/v1/${S}/${E}/blobs/sha256/de/${hash2}`, "cross-data-2");

    const token = await signCommitToken({
      spaceId: S, epoch: E, clientBatchId: "cross-b2", observedHead: 1,
      mutations: [{ clientMutationId: "cross-cm2", assetType: "bp", assetId: "cross-2", baseRevision: null }],
      expiresAt: N + 300_000,
    }, MOCK_SECRET);

    const r = await handleCommit(S, E, token, [{
      clientMutationId: "cross-cm2", assetType: "bp", assetId: "cross-2",
      baseRevision: null, baseContentHash: null, metadata: "{}",
      blobHash: hash2, blobByteSize: 4, storageMode: "full",
      schemaVersion: 1, encoding: "identity", writerAppVersion: "1.0.0", writerBuildId: "b1",
    }], { repo, commitTokenSecret: MOCK_SECRET, r2Bucket: getR2(), now: N, presentTime: P });

    expect(r.status).toBe("committed");
    expect(r.head).toBe(2);

    const w = await import("./index");

    // knownHead=0 → changed
    const r1 = await w.default.fetch(
      new Request(`https://localhost/v1/sync/spaces/${S}/check?knownHead=0`),
      env(),
    );
    expect(r1.status).toBe(200);
    expect(((await r1.json()) as CheckResponse).changed).toBe(true);

    // knownHead=2 → 204
    const r2 = await w.default.fetch(
      new Request(`https://localhost/v1/sync/spaces/${S}/check?knownHead=2`),
      env(),
    );
    expect(r2.status).toBe(204);
  });
});

// ============================================================================
// reset endpoint E2E
// ============================================================================
describe("E2E — reset 端点（POST /v1/sync/spaces/:spaceId/reset）", () => {
  const S = "reset-space", E = "epoch-1", N = Date.now(), P = "2026-08-07T00:00:00Z";
  const env = () => ({
    DB: db, BLOB_STORE: r2,
    PROTOCOL_VERSION: "cf-sync-v1", MAX_MUTATIONS_PER_BATCH: "32", MAX_METADATA_SIZE: "262144",
    COMMIT_TOKEN_SECRET: MOCK_SECRET,
    R2_ACCESS_KEY_ID: "", R2_SECRET_ACCESS_KEY: "", R2_ACCOUNT_ID: "", R2_BUCKET_NAME: "",
    LOCAL_DEV_HOST: "http://localhost:8792",
  });

  beforeAll(async () => {
    await createRepository(db).insertSpace({
      spaceId: S, activeEpoch: E, head: 5, minRetainedHead: 0, updatedAt: P,
    } satisfies SpaceRow);
  });

  it("POST reset → epoch 递增，head 重置为 0", async () => {
    const w = await import("./index");
    const res = await w.default.fetch(
      new Request(`https://localhost/v1/sync/spaces/${S}/reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
      env(),
    );
    expect(res.status).toBe(200);

    const body = await res.json() as ResetResponse;
    expect(body.ok).toBe(true);
    expect(body.spaceId).toBe(S);
    expect(body.newEpoch).not.toBe(E);
    expect(body.previousEpoch).toBe(E);

    // 验证 DB
    const space = await createRepository(db).getSpaceHead(S);
    expect(space).not.toBeNull();
    expect(space!.activeEpoch).not.toBe(E);
    expect(space!.head).toBe(0);
  });

  it("POST reset for non-existent space → 404", async () => {
    const w = await import("./index");
    const res = await w.default.fetch(
      new Request("https://localhost/v1/sync/spaces/nonexistent/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
      env(),
    );
    expect(res.status).toBe(404);
  });
});

// ============================================================================
// downloads:sign endpoint E2E
// ============================================================================
describe("E2E — downloads:sign 端点（POST /v1/sync/spaces/:spaceId/downloads:sign）", () => {
  const S = "dlsign-space", E = "epoch-1", P = "2026-08-07T00:00:00Z";
  const env = () => ({
    DB: db, BLOB_STORE: r2,
    PROTOCOL_VERSION: "cf-sync-v1", MAX_MUTATIONS_PER_BATCH: "32", MAX_METADATA_SIZE: "262144",
    COMMIT_TOKEN_SECRET: MOCK_SECRET,
    R2_ACCESS_KEY_ID: "", R2_SECRET_ACCESS_KEY: "", R2_ACCOUNT_ID: "", R2_BUCKET_NAME: "",
    LOCAL_DEV_HOST: "http://localhost:8792",
  });

  beforeAll(async () => {
    await createRepository(db).insertSpace({
      spaceId: S, activeEpoch: E, head: 0, minRetainedHead: 0, updatedAt: P,
    } satisfies SpaceRow);
  });

  it("POST downloads:sign → 返回本地下载 URL", async () => {
    const w = await import("./index");
    const hash = "d1d2d3d4d5d6d7d8d9d0e1e2e3e4e5e6e7e8e9e0";
    const res = await w.default.fetch(
      new Request(`https://localhost/v1/sync/spaces/${S}/downloads:sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blobHashes: [hash] }),
      }),
      env(),
    );
    expect(res.status).toBe(200);

    const body = await res.json() as DownloadsSignResponse;
    expect(body.urls).toBeDefined();
    expect(body.urls).toHaveLength(1);
    expect(body.urls[0].blobHash).toBe(hash);
    // 本地模式：localDevHost URL
    expect(body.urls[0].url).toContain("/blobs/");
    expect(body.urls[0].url).toContain("sha256");
  });

  it("POST downloads:sign empty blobHashes → 返回空数组", async () => {
    const w = await import("./index");
    const res = await w.default.fetch(
      new Request(`https://localhost/v1/sync/spaces/${S}/downloads:sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blobHashes: [] }),
      }),
      env(),
    );
    expect(res.status).toBe(200);

    const body = await res.json() as DownloadsSignResponse;
    expect(body.urls).toHaveLength(0);
  });

  it("POST downloads:sign missing blobHashes → 400", async () => {
    const w = await import("./index");
    const res = await w.default.fetch(
      new Request(`https://localhost/v1/sync/spaces/${S}/downloads:sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
      env(),
    );
    expect(res.status).toBe(400);
  });

  it("POST downloads:sign for non-existent space → 404", async () => {
    const w = await import("./index");
    const res = await w.default.fetch(
      new Request("https://localhost/v1/sync/spaces/nonexistent/downloads:sign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blobHashes: ["d1d2d3d4d5d6d7d8d9d0e1e2e3e4e5e6e7e8e9e0"] }),
      }),
      env(),
    );
    expect(res.status).toBe(404);
  });
});

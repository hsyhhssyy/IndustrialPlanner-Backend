// repository.ts D1 持久化 — 集成测试（Miniflare D1）

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPlatformProxy } from "wrangler";
import fs from "node:fs";
import path from "node:path";
import {
  createRepository,
  type SyncRepository,
  type SpaceRow,
  type AssetHeadRow,
  type MutationResultRow,
  type UploadSessionRow,
} from "./repository";

let db: D1Database;
let repo: SyncRepository;

// 执行 migration SQL（逐条 prepare + run）
async function execMigration(database: D1Database, sql: string): Promise<void> {
  // 移除以 -- 开头的整行注释
  const cleaned = sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  // 按分号拆分，逐条执行
  const statements = cleaned
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const stmt of statements) {
    try {
      await database.prepare(stmt).run();
    } catch (error) {
      if (!String(error).includes("duplicate column name:")) throw error;
    }
  }
}

function prepare(database: D1Database, query: string, ...params: unknown[]) {
  return database.prepare(query).bind(...params);
}

beforeAll(async () => {
  // 获取 Miniflare 平台代理
  const proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: path.resolve(__dirname, "..", "wrangler.toml"),
  });
  db = proxy.env.DB;

  // 执行 migration 0001
  const sqlPath1 = path.resolve(
    __dirname,
    "..",
    "migrations",
    "0001_create_sync_tables.sql",
  );
  await execMigration(db, fs.readFileSync(sqlPath1, "utf-8"));

  // 执行 migration 0002
  const sqlPath2 = path.resolve(
    __dirname,
    "..",
    "migrations",
    "0002_add_download_tables.sql",
  );
  await execMigration(db, fs.readFileSync(sqlPath2, "utf-8"));

  const sqlPath3 = path.resolve(
    __dirname,
    "..",
    "migrations",
    "0003_tiered_latest_storage.sql",
  );
  await execMigration(db, fs.readFileSync(sqlPath3, "utf-8"));

  const sqlPath4 = path.resolve(
    __dirname,
    "..",
    "migrations",
    "0004_delete_intent_recovery.sql",
  );
  await execMigration(db, fs.readFileSync(sqlPath4, "utf-8"));

  repo = createRepository(db);
});

afterAll(async () => {
  // 清理测试数据
  await prepare(db, "DELETE FROM sync_delete_intents").run();
  await prepare(db, "DELETE FROM sync_commit_guards").run();
  await prepare(db, "DELETE FROM sync_commit_intents").run();
  await prepare(db, "DELETE FROM sync_upload_sessions").run();
  await prepare(db, "DELETE FROM sync_asset_storage").run();
  await prepare(db, "DELETE FROM sync_mutation_results").run();
  await prepare(db, "DELETE FROM sync_changes").run();
  await prepare(db, "DELETE FROM sync_module_heads").run();
  await prepare(db, "DELETE FROM sync_asset_versions").run();
  await prepare(db, "DELETE FROM sync_blobs").run();
  await prepare(db, "DELETE FROM sync_assets").run();
  await prepare(db, "DELETE FROM sync_spaces").run();
});

describe("repository — D1 操作", () => {
  const testSpace: SpaceRow = {
    spaceId: "test-space",
    activeEpoch: "epoch-1",
    head: 0,
    minRetainedHead: 0,
    updatedAt: "2026-08-06T00:00:00Z",
  };

  describe("insertSpace / getSpaceHead", () => {
    it("插入 space 后可通过 getSpaceHead 读取", async () => {
      await repo.insertSpace(testSpace);

      const head = await repo.getSpaceHead("test-space");
      expect(head).not.toBeNull();
      expect(head!.activeEpoch).toBe("epoch-1");
      expect(head!.head).toBe(0);
      expect(head!.spaceId).toBe("test-space");
    });

    it("读取不存在的 space 返回 null", async () => {
      const head = await repo.getSpaceHead("nonexistent");
      expect(head).toBeNull();
    });
  });

  describe("upsertAssetHead / getAssetHead", () => {
    const assetHead: AssetHeadRow = {
      spaceId: "test-space",
      epoch: "epoch-1",
      assetType: "blueprint",
      assetId: "bp-001",
      revision: 1,
      currentHead: 0,
      contentHash: "abc123",
      deletedAt: null,
      schemaVersion: 1,
      minReadableSchemaVersion: 1,
      writerAppVersion: "1.0.0",
      writerBuildId: "build-1",
      committedAt: "2026-08-06T00:00:00Z",
      storageMode: "full",
      baseFullBlobHash: "abc123",
      deltaDepth: 0,
    };

    it("插入资产头后可通过 getAssetHead 读取", async () => {
      await repo.upsertAssetHead(assetHead);
      const head = await repo.getAssetHead(
        "test-space",
        "epoch-1",
        "blueprint",
        "bp-001",
      );
      expect(head).not.toBeNull();
      expect(head!.assetType).toBe("blueprint");
      expect(head!.assetId).toBe("bp-001");
      expect(head!.revision).toBe(1);
      expect(head!.contentHash).toBe("abc123");
      expect(head!.storageMode).toBe("full");
    });

    it("读取不存在的资产返回 null", async () => {
      const head = await repo.getAssetHead(
        "test-space",
        "epoch-1",
        "blueprint",
        "nonexistent",
      );
      expect(head).toBeNull();
    });

    it("update 覆盖现有资产头", async () => {
      const updated: AssetHeadRow = {
        ...assetHead,
        revision: 2,
        contentHash: "def456",
        currentHead: 1,
        committedAt: "2026-08-06T01:00:00Z",
      };
      await repo.upsertAssetHead(updated);

      const head = await repo.getAssetHead(
        "test-space",
        "epoch-1",
        "blueprint",
        "bp-001",
      );
      expect(head!.revision).toBe(2);
      expect(head!.contentHash).toBe("def456");
      expect(head!.currentHead).toBe(1);
    });
  });

  describe("getMutationResult / insertMutationResult", () => {
    const mutationResult: MutationResultRow = {
      spaceId: "test-space",
      epoch: "epoch-1",
      clientMutationId: "cm-001",
      assetType: "blueprint",
      assetId: "bp-001",
      appliedRevision: 1,
      appliedHead: 0,
      contentHash: "abc123",
      createdAt: "2026-08-06T00:00:00Z",
    };

    it("插入幂等结果后可通过 getMutationResult 读取", async () => {
      await repo.insertMutationResult(mutationResult);
      const result = await repo.getMutationResult(
        "test-space",
        "epoch-1",
        "cm-001",
      );
      expect(result).not.toBeNull();
      expect(result!.clientMutationId).toBe("cm-001");
      expect(result!.assetType).toBe("blueprint");
      expect(result!.appliedRevision).toBe(1);
    });

    it("读取不存在的幂等结果返回 null", async () => {
      const result = await repo.getMutationResult(
        "test-space",
        "epoch-1",
        "nonexistent",
      );
      expect(result).toBeNull();
    });
  });

  describe("replaceIssuedUploadSession", () => {
    it("只替换未 claim 且没有暂存数据的 issued session", async () => {
      const original: UploadSessionRow = {
        sessionId: "replace-session-old",
        spaceId: "test-space",
        epoch: "epoch-1",
        assetType: "blueprint",
        assetId: "replace-asset",
        sourceBackend: "d1",
        targetBackend: "d1",
        objectKey: "sync/v2/test-space/blueprint/replace-asset/payload",
        blobHash: "old-hash",
        byteSize: 8,
        encoding: "identity",
        r2MultipartUploadId: null,
        partEtag: null,
        d1Content: null,
        state: "issued",
        leaseExpiresAt: null,
        expiresAt: "2026-08-09T09:00:00Z",
        createdAt: "2026-08-09T08:00:00Z",
        updatedAt: "2026-08-09T08:00:00Z",
      };
      await repo.createUploadSession(original);

      const replacement: UploadSessionRow = {
        ...original,
        sessionId: "replace-session-new",
        blobHash: "new-hash",
        byteSize: 9,
        expiresAt: "2026-08-09T09:01:00Z",
        createdAt: "2026-08-09T08:01:00Z",
        updatedAt: "2026-08-09T08:01:00Z",
      };
      expect(await repo.replaceIssuedUploadSession(original.sessionId, replacement)).toBe(true);
      expect(await repo.getUploadSession(original.sessionId)).toBeNull();
      expect(await repo.getUploadSession(replacement.sessionId)).toMatchObject({
        blobHash: "new-hash",
        byteSize: 9,
        state: "issued",
      });

      expect(await repo.claimUploadSession(
        replacement.sessionId,
        "2026-08-09T08:01:01Z",
        "2026-08-09T08:02:01Z",
      )).toBe(true);
      const racedReplacement: UploadSessionRow = {
        ...replacement,
        sessionId: "replace-session-raced",
        blobHash: "raced-hash",
      };
      expect(await repo.replaceIssuedUploadSession(
        replacement.sessionId,
        racedReplacement,
      )).toBe(false);
      expect(await repo.getUploadSession(replacement.sessionId)).toMatchObject({
        state: "uploading",
        blobHash: "new-hash",
      });
      expect(await repo.getUploadSession(racedReplacement.sessionId)).toBeNull();
    });
  });

  describe("getModuleHeads / listChanges — 新表", () => {
    it("新 space 无 module head 记录 → 返回空数组", async () => {
      const heads = await repo.getModuleHeads("test-space");
      expect(heads).toEqual([]);
    });

    it("新 space 无 changes → 返回空数组", async () => {
      const changes = await repo.listChanges("test-space", 0);
      expect(changes).toEqual([]);
    });

    it("commitBatch 写入 module_heads + changes", async () => {
      const h = "sha256:f1f2f3f4f5f6f7f8f9f0a1a2a3a4a5a6a7a8a9a0b1b2b3b4b5b6b7b8b9c0";
      await prepare(db,
        `INSERT OR IGNORE INTO sync_blobs (space_id, epoch, blob_hash, r2_key, byte_size, encoding, created_at, last_referenced_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`,
        "test-space", "epoch-1", h, `sync/v1/test-space/epoch-1/blobs/sha256/f1/${h}`, 100, "identity", "2026-08-07T00:00:00Z", "2026-08-07T00:00:00Z",
      ).run();

      await prepare(db,
        `UPDATE sync_spaces SET head = 0 WHERE space_id = 'test-space'`,
      ).run();

      await repo.commitBatch(
        "test-space", "epoch-1", 1,
        [{
          clientMutationId: "cm-heads", assetType: "bp", assetId: "bp-h1",
          kind: "full", baseContentHash: null, targetContentHash: h,
          blobHash: h, byteSize: 100, encoding: "identity",
          revision: 1, schemaVersion: 1, minReadableSchemaVersion: 1,
          writerAppVersion: "1.0.0", writerBuildId: "b1",
          storageMode: "full", baseFullBlobHash: h, deltaDepth: 0,
          contentHash: h,
        }],
        [h],
        [`sync/v1/test-space/epoch-1/blobs/sha256/f1/${h}`],
        "2026-08-07T00:00:00Z",
      );

      // 验证 module_heads
      const heads = await repo.getModuleHeads("test-space");
      expect(heads.length).toBe(1);
      expect(heads[0]!.moduleType).toBe("bp");
      expect(heads[0]!.head).toBe(1);

      // 验证 changes
      const changes = await repo.listChanges("test-space", 0);
      expect(changes.length).toBe(1);
      expect(changes[0]!.head).toBe(1);
      expect(changes[0]!.assetType).toBe("bp");
      expect(changes[0]!.assetId).toBe("bp-h1");
      expect(changes[0]!.revision).toBe(1);
      expect(changes[0]!.kind).toBe("upsert");
    });

    it("同一 module_type 多次 commit → module_heads 覆盖为最新 head", async () => {
      const h = "sha256:aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
      await prepare(db,
        "INSERT OR IGNORE INTO sync_blobs (space_id, epoch, blob_hash, r2_key, byte_size, encoding, created_at, last_referenced_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        "test-space", "epoch-1", h, `sync/v1/test-space/epoch-1/blobs/sha256/aa/${h}`, 100, "identity", "2026-08-07T00:00:00Z", "2026-08-07T00:00:00Z",
      ).run();

      await prepare(db, "UPDATE sync_spaces SET head = 1 WHERE space_id = 'test-space'").run();

      await repo.commitBatch(
        "test-space", "epoch-1", 2,
        [{
          clientMutationId: "cm-heads2", assetType: "bp", assetId: "bp-h2",
          kind: "full", baseContentHash: null, targetContentHash: h,
          blobHash: h, byteSize: 100, encoding: "identity",
          revision: 1, schemaVersion: 1, minReadableSchemaVersion: 1,
          writerAppVersion: "1.0.0", writerBuildId: "b1",
          storageMode: "full", baseFullBlobHash: h, deltaDepth: 0,
          contentHash: h,
        }],
        [h],
        [`sync/v1/test-space/epoch-1/blobs/sha256/aa/${h}`],
        "2026-08-07T00:00:00Z",
      );

      const heads = await repo.getModuleHeads("test-space");
      const bpHead = heads.find((h) => h.moduleType === "bp");
      expect(bpHead?.head).toBe(2);
    });
  });

  describe("checkDbHealth", () => {
    it("D1 可用时返回 ok", async () => {
      const result = await repo.checkDbHealth();
      expect(result.ok).toBe(true);
    });
  });
});

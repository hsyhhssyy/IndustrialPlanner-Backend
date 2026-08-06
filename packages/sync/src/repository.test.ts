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
    await database.prepare(stmt).run();
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

  // 执行 migration
  const sqlPath = path.resolve(
    __dirname,
    "..",
    "migrations",
    "0001_create_sync_tables.sql",
  );
  const sql = fs.readFileSync(sqlPath, "utf-8");
  await execMigration(db, sql);

  repo = createRepository(db);
});

afterAll(async () => {
  // 清理测试数据
  await prepare(db, "DELETE FROM sync_mutation_results").run();
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

  describe("checkDbHealth", () => {
    it("D1 可用时返回 ok", async () => {
      const result = await repo.checkDbHealth();
      expect(result.ok).toBe(true);
    });
  });
});

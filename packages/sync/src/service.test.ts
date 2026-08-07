// service.ts — handlePrepare 业务场景测试

import { describe, it, expect, vi } from "vitest";
import { handlePrepare, handleCommit, type HandleCommitDeps } from "./service";
import type { SyncRepository, SpaceRow, AssetHeadRow, MutationResultRow, CommitVersionInput } from "./repository";
import type { PresignedUrlConfig } from "./presigned_url";
import type { PrepareMutation } from "./model";
import { signCommitToken } from "./commit_token";

// ============================================================================
// 测试辅助
// ============================================================================

function mockSpace(overrides?: Partial<SpaceRow>): SpaceRow {
  return {
    spaceId: "test-space",
    activeEpoch: "epoch-1",
    head: 0,
    minRetainedHead: 0,
    updatedAt: "2026-08-06T00:00:00Z",
    ...overrides,
  };
}

function mockRepo(overrides?: Partial<SyncRepository>): SyncRepository {
  return {
    insertSpace: vi.fn(),
    getSpaceHead: vi.fn().mockResolvedValue(mockSpace()),
    resetSpace: vi.fn().mockResolvedValue(null),
    upsertAssetHead: vi.fn(),
    getAssetHead: vi.fn().mockResolvedValue(null),
    listAssetHeads: vi.fn().mockResolvedValue([]),
    listChangedAssetHeads: vi.fn().mockResolvedValue([]),
    getMutationResult: vi.fn().mockResolvedValue(null),
    insertMutationResult: vi.fn(),
    commitBatch: vi.fn().mockResolvedValue([]),
    getModuleHeads: vi.fn().mockResolvedValue([]),
    listChanges: vi.fn().mockResolvedValue([]),
    checkDbHealth: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  };
}

function newMutation(
  overrides?: Partial<PrepareMutation>,
): PrepareMutation {
  return {
    clientMutationId: "cm-new",
    assetType: "blueprint",
    assetId: "bp-001",
    baseRevision: null,
    baseContentHash: null,
    metadata: "{}",
    blobHash: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
    blobByteSize: 100,
    storageMode: "full",
    schemaVersion: 1,
    encoding: "identity",
    writerAppVersion: "1.0.0",
    writerBuildId: "build-1",
    ...overrides,
  };
}

const MOCK_TOKEN_SECRET = "test-secret-key-32-bytes!!";
const MOCK_NOW = Date.now();

// ============================================================================
// 测试
// ============================================================================

describe("handlePrepare", () => {
  describe("成功路径", () => {
    it("新建资产 prepare 成功 — 返回 upload.url 和 commitToken", async () => {
      const repo = mockRepo();
      const result = await handlePrepare("test-space", "epoch-1", "batch-1", [
        newMutation(),
      ], {
        repo,
        commitTokenSecret: MOCK_TOKEN_SECRET,
        presignedUrlConfig: {
          accountId: "test-account",
          accessKeyId: "test-key",
          secretAccessKey: "test-secret",
          bucketName: "test-bucket",
        },
        now: MOCK_NOW,
      });

      expect(result.status).toBe("ready");
      expect(result.uploads).toHaveLength(1);
      expect(result.uploads![0]?.required).toBe(true);
      expect(result.uploads![0]?.url).toContain("https://");
      expect(result.commitToken).toBeDefined();
    });

    it("已存在 asset head + baseRevision 匹配 → 通过 CAS", async () => {
      const repo = mockRepo({
        getAssetHead: vi.fn().mockResolvedValue({
          spaceId: "test-space",
          epoch: "epoch-1",
          assetType: "blueprint",
          assetId: "bp-001",
          revision: 3,
          currentHead: 2,
          contentHash: "existing-hash",
          deletedAt: null,
          schemaVersion: 1,
          minReadableSchemaVersion: 1,
          writerAppVersion: "1.0.0",
          writerBuildId: "build-1",
          committedAt: "2026-08-06T00:00:00Z",
          storageMode: "full",
          baseFullBlobHash: null,
          deltaDepth: 0,
        } satisfies AssetHeadRow),
      });

      const result = await handlePrepare("test-space", "epoch-1", "batch-1", [
        newMutation({ baseRevision: 3, baseContentHash: "existing-hash" }),
      ], {
        repo,
        commitTokenSecret: MOCK_TOKEN_SECRET,
        presignedUrlConfig: {
          accountId: "test-account",
          accessKeyId: "test-key",
          secretAccessKey: "test-secret",
          bucketName: "test-bucket",
        },
        now: MOCK_NOW,
      });

      expect(result.status).toBe("ready");
    });

    it("幂等重试 — 返回 alreadyApplied", async () => {
      const repo = mockRepo({
        getMutationResult: vi.fn().mockResolvedValue({
          spaceId: "test-space",
          epoch: "epoch-1",
          clientMutationId: "cm-already",
          assetType: "blueprint",
          assetId: "bp-001",
          appliedRevision: 1,
          appliedHead: 0,
          contentHash: "a1b2c3",
          createdAt: "2026-08-06T00:00:00Z",
        } satisfies MutationResultRow),
      });

      const result = await handlePrepare("test-space", "epoch-1", "batch-1", [
        newMutation({ clientMutationId: "cm-already" }),
      ], {
        repo,
        commitTokenSecret: MOCK_TOKEN_SECRET,
        presignedUrlConfig: {
          accountId: "test-account",
          accessKeyId: "test-key",
          secretAccessKey: "test-secret",
          bucketName: "test-bucket",
        },
        now: MOCK_NOW,
      });

      expect(result.status).toBe("ready");
      expect(result.alreadyApplied).toHaveLength(1);
      expect(result.alreadyApplied![0]?.clientMutationId).toBe("cm-already");
      expect(result.uploads).toHaveLength(0);
    });
  });

  describe("冲突路径", () => {
    it("epoch 不匹配 → 409 space-epoch-changed", async () => {
      const repo = mockRepo({
        getSpaceHead: vi.fn().mockResolvedValue(
          mockSpace({ activeEpoch: "epoch-2" }),
        ),
      });

      const result = await handlePrepare("test-space", "epoch-1", "batch-1", [
        newMutation(),
      ], {
        repo,
        commitTokenSecret: MOCK_TOKEN_SECRET,
        presignedUrlConfig: {
          accountId: "test-account",
          accessKeyId: "test-key",
          secretAccessKey: "test-secret",
          bucketName: "test-bucket",
        },
        now: MOCK_NOW,
      });

      expect(result.status).toBe("conflict");
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts![0]?.reason).toBe("space-epoch-changed");
    });

    it("revision CAS 失败 → conflict revision-mismatch", async () => {
      const repo = mockRepo({
        getAssetHead: vi.fn().mockResolvedValue({
          spaceId: "test-space",
          epoch: "epoch-1",
          assetType: "blueprint",
          assetId: "bp-001",
          revision: 5,
          currentHead: 3,
          contentHash: "other-hash",
          deletedAt: null,
          schemaVersion: 1,
          minReadableSchemaVersion: 1,
          writerAppVersion: "1.0.0",
          writerBuildId: "build-1",
          committedAt: "2026-08-06T00:00:00Z",
          storageMode: "full",
          baseFullBlobHash: null,
          deltaDepth: 0,
        } satisfies AssetHeadRow),
      });

      const result = await handlePrepare("test-space", "epoch-1", "batch-1", [
        newMutation({ baseRevision: 3 }),
      ], {
        repo,
        commitTokenSecret: MOCK_TOKEN_SECRET,
        presignedUrlConfig: {
          accountId: "test-account",
          accessKeyId: "test-key",
          secretAccessKey: "test-secret",
          bucketName: "test-bucket",
        },
        now: MOCK_NOW,
      });

      expect(result.status).toBe("conflict");
      expect(result.conflicts![0]?.reason).toBe("revision-mismatch");
    });

    it("hash CAS 失败 → conflict hash-mismatch", async () => {
      const repo = mockRepo({
        getAssetHead: vi.fn().mockResolvedValue({
          spaceId: "test-space",
          epoch: "epoch-1",
          assetType: "blueprint",
          assetId: "bp-001",
          revision: 3,
          currentHead: 3,
          contentHash: "actual-hash",
          deletedAt: null,
          schemaVersion: 1,
          minReadableSchemaVersion: 1,
          writerAppVersion: "1.0.0",
          writerBuildId: "build-1",
          committedAt: "2026-08-06T00:00:00Z",
          storageMode: "full",
          baseFullBlobHash: null,
          deltaDepth: 0,
        } satisfies AssetHeadRow),
      });

      const result = await handlePrepare("test-space", "epoch-1", "batch-1", [
        newMutation({ baseRevision: 3, baseContentHash: "expected-hash" }),
      ], {
        repo,
        commitTokenSecret: MOCK_TOKEN_SECRET,
        presignedUrlConfig: {
          accountId: "test-account",
          accessKeyId: "test-key",
          secretAccessKey: "test-secret",
          bucketName: "test-bucket",
        },
        now: MOCK_NOW,
      });

      expect(result.status).toBe("conflict");
      expect(result.conflicts![0]?.reason).toBe("hash-mismatch");
    });

    it("space 不存在 → 409 space-epoch-changed", async () => {
      const repo = mockRepo({
        getSpaceHead: vi.fn().mockResolvedValue(null),
      });

      const result = await handlePrepare("test-space", "epoch-1", "batch-1", [
        newMutation(),
      ], {
        repo,
        commitTokenSecret: MOCK_TOKEN_SECRET,
        presignedUrlConfig: {
          accountId: "test-account",
          accessKeyId: "test-key",
          secretAccessKey: "test-secret",
          bucketName: "test-bucket",
        },
        now: MOCK_NOW,
      });

      expect(result.status).toBe("conflict");
    });
  });

  describe("边界", () => {
    it("空 mutations 数组返回空 uploads", async () => {
      const repo = mockRepo();
      const result = await handlePrepare("test-space", "epoch-1", "batch-1", [], {
        repo,
        commitTokenSecret: MOCK_TOKEN_SECRET,
        presignedUrlConfig: {
          accountId: "test-account",
          accessKeyId: "test-key",
          secretAccessKey: "test-secret",
          bucketName: "test-bucket",
        },
        now: MOCK_NOW,
      });

      expect(result.status).toBe("ready");
      expect(result.uploads).toHaveLength(0);
      expect(result.commitToken).toBeDefined();
    });

    it("已存在的 asset (baseRevision=null) → 视为新建", async () => {
      // baseRevision=null 且 getAssetHead 返回 null → 新建
      const repo = mockRepo();
      const result = await handlePrepare("test-space", "epoch-1", "batch-1", [
        newMutation(), // baseRevision: null by default
      ], {
        repo,
        commitTokenSecret: MOCK_TOKEN_SECRET,
        presignedUrlConfig: {
          accountId: "test-account",
          accessKeyId: "test-key",
          secretAccessKey: "test-secret",
          bucketName: "test-bucket",
        },
        now: MOCK_NOW,
      });

      expect(result.status).toBe("ready");
    });
  });
});

// ============================================================================
// handleCommit 测试
// ============================================================================

describe("handleCommit", () => {
  function commitDeps(
    overrides?: Partial<HandleCommitDeps>,
  ): HandleCommitDeps {
    return {
      repo: mockRepo(),
      commitTokenSecret: MOCK_TOKEN_SECRET,
      r2Bucket: {
        head: vi.fn().mockResolvedValue({ key: "test", size: 100 }),
      } as unknown as R2Bucket,
      now: MOCK_NOW,
      presentTime: "2026-08-06T00:00:00Z",
      ...overrides,
    };
  }

  async function makeToken(
    mutations: Array<{
      clientMutationId: string;
      assetType: string;
      assetId: string;
      baseRevision: number | null;
    }>,
    expiresAt?: number,
  ): Promise<string> {
    return signCommitToken(
      {
        spaceId: "test-space",
        epoch: "epoch-1",
        clientBatchId: "batch-1",
        observedHead: 0,
        mutations,
        expiresAt: expiresAt ?? Date.now() + 300_000,
      },
      MOCK_TOKEN_SECRET,
    );
  }

  describe("成功路径", () => {
    it("commit 成功 — head +1，返回 applied", async () => {
      const repo = mockRepo({
        getSpaceHead: vi.fn().mockResolvedValue(mockSpace({ head: 0 })),
        getAssetHead: vi.fn().mockResolvedValue(null), // 新资产
        commitBatch: vi.fn().mockResolvedValue([
          {
            clientMutationId: "cm-1",
            assetType: "blueprint",
            assetId: "bp-001",
            revision: 1,
            contentHash: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
          },
        ]),
      });

      const token = await makeToken([
        { clientMutationId: "cm-1", assetType: "blueprint", assetId: "bp-001", baseRevision: null },
      ]);

      const result = await handleCommit(
        "test-space",
        "epoch-1",
        token,
        [
          {
            clientMutationId: "cm-1",
            assetType: "blueprint",
            assetId: "bp-001",
            baseRevision: null,
            baseContentHash: null,
            metadata: "{}",
            blobHash: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
            blobByteSize: 100,
            storageMode: "full",
            schemaVersion: 1,
            encoding: "identity",
            writerAppVersion: "1.0.0",
            writerBuildId: "build-1",
          },
        ],
        commitDeps({ repo }),
      );

      expect(result.status).toBe("committed");
      expect(result.applied).toHaveLength(1);
      expect(result.head).toBe(1);
    });

    it("重复 commit 幂等 — 返回 already-committed", async () => {
      const repo = mockRepo({
        getMutationResult: vi.fn().mockResolvedValue({
          spaceId: "test-space",
          epoch: "epoch-1",
          clientMutationId: "cm-1",
          assetType: "blueprint",
          assetId: "bp-001",
          appliedRevision: 1,
          appliedHead: 1,
          contentHash: "a1b2c3",
          createdAt: "2026-08-06T00:00:00Z",
        } satisfies MutationResultRow),
        getSpaceHead: vi.fn().mockResolvedValue(mockSpace({ head: 1 })),
      });

      const token = await makeToken([
        { clientMutationId: "cm-1", assetType: "blueprint", assetId: "bp-001", baseRevision: null },
      ]);

      const result = await handleCommit(
        "test-space",
        "epoch-1",
        token,
        [
          {
            clientMutationId: "cm-1",
            assetType: "blueprint",
            assetId: "bp-001",
            baseRevision: null,
            baseContentHash: null,
            metadata: "{}",
            blobHash: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
            blobByteSize: 100,
            storageMode: "full",
            schemaVersion: 1,
            encoding: "identity",
            writerAppVersion: "1.0.0",
            writerBuildId: "build-1",
          },
        ],
        commitDeps({ repo }),
      );

      expect(result.status).toBe("already-committed");
      expect(result.applied).toHaveLength(1);
    });
  });

  describe("失败路径", () => {
    it("token 过期 → 400 token_expired", async () => {
      const token = await makeToken(
        [{ clientMutationId: "cm-1", assetType: "blueprint", assetId: "bp-001", baseRevision: null }],
        Date.now() - 1000,
      );

      const result = await handleCommit(
        "test-space",
        "epoch-1",
        token,
        [],
        commitDeps(),
      );

      expect(result.status).toBe("conflict");
      expect(result.conflicts?.[0]?.reason).toBeDefined();
    });

    it("token spaceId 不匹配 → 返回 conflict", async () => {
      const token = await makeToken([
        { clientMutationId: "cm-1", assetType: "blueprint", assetId: "bp-001", baseRevision: null },
      ]);

      const result = await handleCommit(
        "wrong-space",
        "epoch-1",
        token,
        [],
        commitDeps(),
      );

      expect(result.status).toBe("conflict");
    });

    it("prepare 后 revision 被其他请求更新 → 409 conflict", async () => {
      const repo = mockRepo({
        getSpaceHead: vi.fn().mockResolvedValue(mockSpace({ head: 1 })),
        getAssetHead: vi.fn().mockResolvedValue({
          spaceId: "test-space",
          epoch: "epoch-1",
          assetType: "blueprint",
          assetId: "bp-001",
          revision: 5, // token 中 expected null/baseRevision，但远端已是 5
          currentHead: 1,
          contentHash: "other-hash",
          deletedAt: null,
          schemaVersion: 1,
          minReadableSchemaVersion: 1,
          writerAppVersion: "1.0.0",
          writerBuildId: "build-1",
          committedAt: "2026-08-06T00:00:00Z",
          storageMode: "full",
          baseFullBlobHash: null,
          deltaDepth: 0,
        } satisfies AssetHeadRow),
      });

      const token = await makeToken([
        { clientMutationId: "cm-1", assetType: "blueprint", assetId: "bp-001", baseRevision: null },
      ]);

      const result = await handleCommit(
        "test-space",
        "epoch-1",
        token,
        [
          {
            clientMutationId: "cm-1",
            assetType: "blueprint",
            assetId: "bp-001",
            baseRevision: null,
            baseContentHash: null,
            metadata: "{}",
            blobHash: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
            blobByteSize: 100,
            storageMode: "full",
            schemaVersion: 1,
            encoding: "identity",
            writerAppVersion: "1.0.0",
            writerBuildId: "build-1",
          },
        ],
        commitDeps({ repo }),
      );

      expect(result.status).toBe("conflict");
      expect(result.conflicts?.[0]?.reason).toBe("revision-mismatch");
    });

    it("请求体 mutations 与 token 不匹配 → token-invalid", async () => {
      const token = await makeToken([
        { clientMutationId: "cm-1", assetType: "blueprint", assetId: "bp-001", baseRevision: null },
      ]);

      const result = await handleCommit(
        "test-space",
        "epoch-1",
        token,
        [
          {
            clientMutationId: "cm-evil", // 不在 token 中
            assetType: "blueprint",
            assetId: "bp-999",
            baseRevision: null,
            baseContentHash: null,
            metadata: "{}",
            blobHash: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
            blobByteSize: 100,
            storageMode: "full",
            schemaVersion: 1,
            encoding: "identity",
            writerAppVersion: "1.0.0",
            writerBuildId: "build-1",
          },
        ],
        commitDeps(),
      );

      expect(result.status).toBe("conflict");
      expect(result.conflicts?.[0]?.reason).toBe("token-invalid");
    });

    it("R2 blob 不存在 → blob-missing", async () => {
      const repo = mockRepo({
        getSpaceHead: vi.fn().mockResolvedValue(mockSpace({ head: 0 })),
        getAssetHead: vi.fn().mockResolvedValue(null), // 新资产
      });
      const deps = commitDeps({
        repo,
        r2Bucket: {
          head: vi.fn().mockResolvedValue(null), // blob 不存在
        } as unknown as R2Bucket,
      });

      const token = await makeToken([
        { clientMutationId: "cm-1", assetType: "blueprint", assetId: "bp-001", baseRevision: null },
      ]);

      const result = await handleCommit(
        "test-space",
        "epoch-1",
        token,
        [
          {
            clientMutationId: "cm-1",
            assetType: "blueprint",
            assetId: "bp-001",
            baseRevision: null,
            baseContentHash: null,
            metadata: "{}",
            blobHash: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
            blobByteSize: 100,
            storageMode: "full",
            schemaVersion: 1,
            encoding: "identity",
            writerAppVersion: "1.0.0",
            writerBuildId: "build-1",
          },
        ],
        deps,
      );

      expect(result.status).toBe("conflict");
      expect(result.conflicts?.[0]?.reason).toBe("blob-missing");
    });

    it("已存在资产 baseRevision 匹配但 hash 不匹配 → hash-mismatch", async () => {
      const repo = mockRepo({
        getSpaceHead: vi.fn().mockResolvedValue(mockSpace({ head: 1 })),
        getAssetHead: vi.fn().mockResolvedValue({
          spaceId: "test-space",
          epoch: "epoch-1",
          assetType: "blueprint",
          assetId: "bp-001",
          revision: 3,
          currentHead: 1,
          contentHash: "actual-hash",
          deletedAt: null,
          schemaVersion: 1,
          minReadableSchemaVersion: 1,
          writerAppVersion: "1.0.0",
          writerBuildId: "build-1",
          committedAt: "2026-08-06T00:00:00Z",
          storageMode: "full",
          baseFullBlobHash: null,
          deltaDepth: 0,
        } satisfies AssetHeadRow),
      });

      const token = await makeToken([
        { clientMutationId: "cm-1", assetType: "blueprint", assetId: "bp-001", baseRevision: 3 },
      ]);

      const result = await handleCommit(
        "test-space",
        "epoch-1",
        token,
        [
          {
            clientMutationId: "cm-1",
            assetType: "blueprint",
            assetId: "bp-001",
            baseRevision: 3,
            baseContentHash: "expected-hash", // 与 actual-hash 不匹配
            metadata: "{}",
            blobHash: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
            blobByteSize: 100,
            storageMode: "full",
            schemaVersion: 1,
            encoding: "identity",
            writerAppVersion: "1.0.0",
            writerBuildId: "build-1",
          },
        ],
        commitDeps({ repo }),
      );

      expect(result.status).toBe("conflict");
      expect(result.conflicts?.[0]?.reason).toBe("hash-mismatch");
    });
  });
});

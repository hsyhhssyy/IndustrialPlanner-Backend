// model.ts 类型约束与校验 — 单元测试

import { describe, it, expect } from "vitest";
import {
  PROTOCOL_VERSION,
  DEFAULT_MAX_MUTATIONS_PER_BATCH,
  DEFAULT_MAX_METADATA_SIZE,
  validateProtocolVersion,
  validateMutationBatch,
  isValidStorageMode,
  type SyncSpace,
  type RemoteAssetHead,
  type PrepareMutation,
  type PrepareMutationsRequest,
  type PrepareMutationsResponse,
  type CommitMutationsRequest,
  type CommitMutationsResponse,
  type MutationUpload,
  type AlreadyAppliedMutation,
  type ConflictItem,
} from "./model";

describe("model constants", () => {
  it("PROTOCOL_VERSION 为 cf-sync-v1", () => {
    expect(PROTOCOL_VERSION).toBe("cf-sync-v1");
  });

  it("DEFAULT_MAX_MUTATIONS_PER_BATCH 为 32", () => {
    expect(DEFAULT_MAX_MUTATIONS_PER_BATCH).toBe(32);
  });

  it("DEFAULT_MAX_METADATA_SIZE 为 262144 (256KB)", () => {
    expect(DEFAULT_MAX_METADATA_SIZE).toBe(262144);
  });
});

describe("validateProtocolVersion", () => {
  it("匹配的协议版本返回 ok", () => {
    const result = validateProtocolVersion("cf-sync-v1");
    expect(result.ok).toBe(true);
  });

  it("不匹配的协议版本返回 error", () => {
    const result = validateProtocolVersion("cf-sync-v0");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("protocol_mismatch");
    }
  });
});

describe("isValidStorageMode", () => {
  it("'full' 有效", () => {
    expect(isValidStorageMode("full")).toBe(true);
  });

  it("'patch-chain' 有效", () => {
    expect(isValidStorageMode("patch-chain")).toBe(true);
  });

  it("null 有效", () => {
    expect(isValidStorageMode(null)).toBe(true);
  });

  it("undefined 有效", () => {
    expect(isValidStorageMode(undefined)).toBe(true);
  });

  it("非法值返回 false", () => {
    expect(isValidStorageMode("delta")).toBe(false);
  });
});

describe("validateMutationBatch", () => {
  it("空 mutations 数组返回 ok", () => {
    const result = validateMutationBatch([], 32);
    expect(result.ok).toBe(true);
  });

  it("数量 ≤ max 返回 ok", () => {
    const mutations = Array.from({ length: 3 }, (_, i) => ({
      clientMutationId: `m-${i}`,
      assetType: "blueprint",
      assetId: `asset-${i}`,
      baseRevision: null,
      baseContentHash: null,
      metadata: "{}",
      blobHash: `hash-${i}`,
      blobByteSize: 100,
      storageMode: "full" as const,
      schemaVersion: 1,
      encoding: "identity" as const,
      writerAppVersion: "1.0.0",
      writerBuildId: "build-1",
    }));
    const result = validateMutationBatch(mutations, 32);
    expect(result.ok).toBe(true);
  });

  it("数量超过 max 返回 batch_too_large", () => {
    const mutations = Array.from({ length: 5 }, (_, i) => ({
      clientMutationId: `m-${i}`,
      assetType: "blueprint",
      assetId: `asset-${i}`,
      baseRevision: null,
      baseContentHash: null,
      metadata: "{}",
      blobHash: `hash-${i}`,
      blobByteSize: 100,
      storageMode: "full" as const,
      schemaVersion: 1,
      encoding: "identity" as const,
      writerAppVersion: "1.0.0",
      writerBuildId: "build-1",
    }));
    const result = validateMutationBatch(mutations, 3);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("batch_too_large");
    }
  });

  it("批次内重复 assetType+assetId 返回 bad_request", () => {
    const mutations = [
      {
        clientMutationId: "m-1",
        assetType: "blueprint",
        assetId: "asset-1",
        baseRevision: null,
        baseContentHash: null,
        metadata: "{}",
        blobHash: "hash-1",
        blobByteSize: 100,
        storageMode: "full" as const,
        schemaVersion: 1,
        encoding: "identity" as const,
        writerAppVersion: "1.0.0",
        writerBuildId: "build-1",
      },
      {
        clientMutationId: "m-2",
        assetType: "blueprint",
        assetId: "asset-1",
        baseRevision: null,
        baseContentHash: null,
        metadata: "{}",
        blobHash: "hash-2",
        blobByteSize: 100,
        storageMode: "full" as const,
        schemaVersion: 1,
        encoding: "identity" as const,
        writerAppVersion: "1.0.0",
        writerBuildId: "build-1",
      },
    ];
    const result = validateMutationBatch(mutations, 32);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("bad_request");
    }
  });

  it("非法 storageMode 返回 bad_request", () => {
    const mutations = [
      {
        clientMutationId: "m-1",
        assetType: "blueprint",
        assetId: "asset-1",
        baseRevision: null,
        baseContentHash: null,
        metadata: "{}",
        blobHash: "hash-1",
        blobByteSize: 100,
        storageMode: "invalid",
        schemaVersion: 1,
        encoding: "identity" as const,
        writerAppVersion: "1.0.0",
        writerBuildId: "build-1",
      },
    ];
    const result = validateMutationBatch(mutations, 32);
    expect(result.ok).toBe(false);
  });
});

describe("type guards — 编译期验证 (运行时结构)", () => {
  it("SyncSpace 类型结构正确", () => {
    const space: SyncSpace = {
      spaceId: "test-space",
      activeEpoch: "epoch-1",
      head: 0,
      minRetainedHead: 0,
      updatedAt: "2026-08-06T00:00:00Z",
    };
    expect(space.spaceId).toBe("test-space");
    expect(space.head).toBe(0);
  });

  it("RemoteAssetHead 类型结构正确", () => {
    const head: RemoteAssetHead = {
      spaceId: "test-space",
      epoch: "epoch-1",
      assetType: "blueprint",
      assetId: "asset-1",
      revision: 1,
      currentHead: 0,
      contentHash: "hash-1",
      deletedAt: null,
      schemaVersion: 1,
      minReadableSchemaVersion: 1,
      writerAppVersion: "1.0.0",
      writerBuildId: "build-1",
      committedAt: "2026-08-06T00:00:00Z",
      storageMode: "full",
      baseFullBlobHash: "hash-1",
      deltaDepth: 0,
    };
    expect(head.assetType).toBe("blueprint");
    expect(head.revision).toBe(1);
    expect(head.storageMode).toBe("full");
  });

  it("PrepareMutationsRequest 带 baseRevision=null (新建)", () => {
    const req: PrepareMutationsRequest = {
      protocol: "cf-sync-v1",
      spaceEpoch: "epoch-1",
      clientBatchId: "batch-1",
      mutations: [
        {
          clientMutationId: "cm-1",
          assetType: "blueprint",
          assetId: "asset-1",
          baseRevision: null,
          baseContentHash: null,
          metadata: "{}",
          blobHash: "hash-1",
          blobByteSize: 100,
          storageMode: "full",
          schemaVersion: 1,
          encoding: "identity",
          writerAppVersion: "1.0.0",
          writerBuildId: "build-1",
        },
      ],
    };
    expect(req.protocol).toBe("cf-sync-v1");
    expect(req.mutations[0]?.baseRevision).toBeNull();
  });

  it("PrepareMutationsResponse 结构正确", () => {
    const resp: PrepareMutationsResponse = {
      status: "ready",
      uploads: [
        {
          assetType: "blueprint",
          assetId: "asset-1",
          required: true,
          url: "https://r2.example.com/presigned",
          headers: { "Content-Type": "application/octet-stream" },
        },
      ],
      commitToken: "token-xxx",
      alreadyApplied: [],
    };
    expect(resp.status).toBe("ready");
    expect(resp.uploads?.[0]?.required).toBe(true);
    expect(resp.commitToken).toBe("token-xxx");
  });

  it("CommitMutationsResponse 结构正确", () => {
    const resp: CommitMutationsResponse = {
      status: "committed",
      applied: [
        {
          clientMutationId: "cm-1",
          assetType: "blueprint",
          assetId: "asset-1",
          revision: 1,
          contentHash: "hash-1",
        },
      ],
      head: 1,
      serverTime: "2026-08-06T00:00:00Z",
    };
    expect(resp.status).toBe("committed");
    expect(resp.head).toBe(1);
  });
});

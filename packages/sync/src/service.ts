// 服务层 — 用例编排（handlePrepare / handleCommit / handlePlan）
//
// 职责：协调 repository、commit_token、presigned_url 完成业务逻辑。
// 不直接访问 D1/R2，通过注入的依赖接口操作。

import type { SyncRepository, AssetHeadRow, CommitVersionInput, AppliedVersionResult, MutationResultRow } from "./repository";
import type { PresignedUrlConfig } from "./presigned_url";
import { generatePresignedUploadUrl, generatePresignedDownloadUrl } from "./presigned_url";
import {
  signCommitToken,
  verifyCommitToken,
  type TokenMutation,
} from "./commit_token";
import type {
  PrepareMutation,
  PrepareMutationsResponse,
  CommitMutationsResponse,
  MutationUpload,
  AlreadyAppliedMutation,
  ConflictItem,
  PlanResponse,
  PlanCapabilities,
  PlanModule,
  AssetSummary,
  CheckResponse,
  ModuleHead,
  ResetResponse,
  DownloadsSignResponse,
} from "./model";

// ============================================================================
// 依赖注入
// ============================================================================

export interface HandlePrepareDeps {
  repo: SyncRepository;
  commitTokenSecret: string;
  presignedUrlConfig: PresignedUrlConfig;
  /** 本地开发时直传 URL 的 base（如 http://localhost:8792），有值则跳过 S3 预签名 */
  localDevHost?: string;
  now: number;
}

// ============================================================================
// handlePrepare
// ============================================================================

export async function handlePrepare(
  spaceId: string,
  requestEpoch: string,
  clientBatchId: string,
  mutations: PrepareMutation[],
  deps: HandlePrepareDeps,
): Promise<PrepareMutationsResponse> {
  // 1. 读取 space head
  const space = await deps.repo.getSpaceHead(spaceId);
  if (!space) {
    return {
      status: "conflict",
      conflicts: [
        {
          assetType: "",
          assetId: "",
          reason: "space-epoch-changed",
          expectedRevision: null,
          actualRevision: 0,
          expectedHash: null,
          actualHash: null,
        },
      ],
    };
  }

  // 2. epoch 校验
  if (space.activeEpoch !== requestEpoch) {
    return {
      status: "conflict",
      conflicts: [
        {
          assetType: "",
          assetId: "",
          reason: "space-epoch-changed",
          expectedRevision: null,
          actualRevision: 0,
          expectedHash: null,
          actualHash: null,
        },
      ],
    };
  }

  const observedHead = space.head;
  const currentEpoch = space.activeEpoch;

  const uploads: MutationUpload[] = [];
  const alreadyApplied: AlreadyAppliedMutation[] = [];
  const conflicts: ConflictItem[] = [];
  const tokenMutations: TokenMutation[] = [];

  // 3. 逐项处理
  for (const m of mutations) {
    // 3a. 幂等检查
    const existingResult = await deps.repo.getMutationResult(
      spaceId,
      currentEpoch,
      m.clientMutationId,
    );
    if (existingResult) {
      alreadyApplied.push({
        clientMutationId: m.clientMutationId,
        assetType: m.assetType,
        assetId: m.assetId,
        revision: existingResult.appliedRevision,
        contentHash: existingResult.contentHash ?? "",
      });
      continue;
    }

    // 3b. 读取当前资产头
    const currentHead = await deps.repo.getAssetHead(
      spaceId,
      currentEpoch,
      m.assetType,
      m.assetId,
    );

    // 3c. CAS 校验
    if (m.baseRevision !== null || m.baseContentHash !== null) {
      if (!currentHead) {
        // 客户端以为资产存在，但远端不存在 → revision mismatch
        conflicts.push({
          assetType: m.assetType,
          assetId: m.assetId,
          reason: "revision-mismatch",
          expectedRevision: m.baseRevision,
          actualRevision: 0,
          expectedHash: m.baseContentHash,
          actualHash: null,
        });
        continue;
      }

      // revision 校验
      if (
        m.baseRevision !== null &&
        m.baseRevision !== currentHead.revision
      ) {
        conflicts.push({
          assetType: m.assetType,
          assetId: m.assetId,
          reason: "revision-mismatch",
          expectedRevision: m.baseRevision,
          actualRevision: currentHead.revision,
          expectedHash: m.baseContentHash,
          actualHash: currentHead.contentHash,
        });
        continue;
      }

      // hash 校验
      if (
        m.baseContentHash !== null &&
        m.baseContentHash !== currentHead.contentHash
      ) {
        conflicts.push({
          assetType: m.assetType,
          assetId: m.assetId,
          reason: "hash-mismatch",
          expectedRevision: m.baseRevision,
          actualRevision: currentHead.revision,
          expectedHash: m.baseContentHash,
          actualHash: currentHead.contentHash,
        });
        continue;
      }
    } else if (currentHead) {
      // baseRevision 和 baseContentHash 都为空但资产存在 → revision 冲突
      // 客户端以为新建，但远端已存在
      conflicts.push({
        assetType: m.assetType,
        assetId: m.assetId,
        reason: "revision-mismatch",
        expectedRevision: null,
        actualRevision: currentHead.revision,
        expectedHash: null,
        actualHash: currentHead.contentHash,
      });
      continue;
    }

    // 3d. 生成上传 URL（本地直传 或 S3 预签名）
    let uploadUrl: string | undefined;
    if (deps.localDevHost) {
      // 本地开发：直接提供本地 blob 直传 URL
      const prefix = m.blobHash.substring(0, 2);
      uploadUrl = `${deps.localDevHost}/v1/sync/spaces/${encodeURIComponent(spaceId)}/blobs/${encodeURIComponent(currentEpoch)}/sha256/${prefix}/${encodeURIComponent(m.blobHash)}`;
    } else if (deps.presignedUrlConfig.accessKeyId) {
      try {
        uploadUrl = await generatePresignedUploadUrl(
          deps.presignedUrlConfig,
          spaceId,
          currentEpoch,
          m.blobHash,
          m.blobByteSize,
        );
      } catch {
        // S3 API 失败时不阻塞
      }
    }

    uploads.push({
      assetType: m.assetType,
      assetId: m.assetId,
      required: true,
      url: uploadUrl,
      headers: uploadUrl
        ? { "Content-Type": "application/octet-stream" }
        : undefined,
    });

    tokenMutations.push({
      clientMutationId: m.clientMutationId,
      assetType: m.assetType,
      assetId: m.assetId,
      baseRevision: m.baseRevision,
    });
  }

  // 4. 任意冲突 → 返回 409
  if (conflicts.length > 0) {
    return {
      status: "conflict",
      conflicts,
    };
  }

  // 5. 签发 commit token
  const token = await signCommitToken(
    {
      spaceId,
      epoch: currentEpoch,
      clientBatchId,
      observedHead,
      mutations: tokenMutations,
      expiresAt: deps.now + 300_000, // 5 分钟
    },
    deps.commitTokenSecret,
  );

  return {
    status: "ready",
    uploads,
    commitToken: token,
    alreadyApplied: alreadyApplied.length > 0 ? alreadyApplied : undefined,
  };
}

// ============================================================================
// handleCommit
// ============================================================================

export interface HandleCommitDeps {
  repo: SyncRepository;
  commitTokenSecret: string;
  r2Bucket: R2Bucket;
  now: number;
  presentTime: string;
}

export async function handleCommit(
  spaceId: string,
  requestEpoch: string,
  rawToken: string,
  mutations: PrepareMutation[],
  deps: HandleCommitDeps,
): Promise<CommitMutationsResponse> {
  // 1. 验证 commit token
  const tokenResult = await verifyCommitToken(rawToken, deps.commitTokenSecret);
  if (!tokenResult.ok) {
    return {
      status: "conflict",
      conflicts: [
        {
          assetType: "",
          assetId: "",
          reason: tokenResult.code === "token_expired" ? "token-expired" : "token-invalid",
          expectedRevision: null,
          actualRevision: 0,
          expectedHash: null,
          actualHash: null,
        },
      ],
    };
  }

  const tokenPayload = tokenResult.payload;

  // 2. token spaceId / epoch 与请求一致
  if (tokenPayload.spaceId !== spaceId || tokenPayload.epoch !== requestEpoch) {
    return {
      status: "conflict",
      conflicts: [
        {
          assetType: "",
          assetId: "",
          reason: "space-epoch-changed",
          expectedRevision: null,
          actualRevision: 0,
          expectedHash: null,
          actualHash: null,
        },
      ],
    };
  }

  // 3. 幂等检查（全部 mutation 已提交 → already-committed）
  const mutationResults: Map<string, MutationResultRow> = new Map();
  for (const m of mutations) {
    const existing = await deps.repo.getMutationResult(
      spaceId,
      requestEpoch,
      m.clientMutationId,
    );
    if (existing) {
      mutationResults.set(m.clientMutationId, existing);
    }
  }
  if (mutationResults.size === mutations.length && mutations.length > 0) {
    const space = await deps.repo.getSpaceHead(spaceId);
    return {
      status: "already-committed",
      applied: mutations.map((m) => {
        const mr = mutationResults.get(m.clientMutationId)!;
        return {
          clientMutationId: m.clientMutationId,
          assetType: m.assetType,
          assetId: m.assetId,
          revision: mr.appliedRevision,
          contentHash: mr.contentHash ?? m.blobHash,
        };
      }),
      head: space?.head ?? 0,
      serverTime: deps.presentTime,
    };
  }

  // 4. 读取当前 space head
  const space = await deps.repo.getSpaceHead(spaceId);
  if (!space) {
    return {
      status: "conflict",
      conflicts: [
        {
          assetType: "",
          assetId: "",
          reason: "space-epoch-changed",
          expectedRevision: null,
          actualRevision: 0,
          expectedHash: null,
          actualHash: null,
        },
      ],
    };
  }

  // 5. 对每个 mutation 重新校验 revision CAS
  const conflicts: ConflictItem[] = [];
  const versions: CommitVersionInput[] = [];
  const blobHashes: string[] = [];
  const blobR2Keys: string[] = [];

  for (const m of mutations) {
    const currentAsset = await deps.repo.getAssetHead(
      spaceId,
      requestEpoch,
      m.assetType,
      m.assetId,
    );

    // CAS 校验（与 prepare 对称：同时检查 baseRevision 和 baseContentHash）
    if (m.baseRevision !== null || m.baseContentHash !== null) {
      if (!currentAsset) {
        // 客户端以为资产存在，但远端不存在
        conflicts.push({
          assetType: m.assetType,
          assetId: m.assetId,
          reason: "revision-mismatch",
          expectedRevision: m.baseRevision,
          actualRevision: 0,
          expectedHash: m.baseContentHash,
          actualHash: null,
        });
        continue;
      }

      // revision 校验
      if (
        m.baseRevision !== null &&
        m.baseRevision !== currentAsset.revision
      ) {
        conflicts.push({
          assetType: m.assetType,
          assetId: m.assetId,
          reason: "revision-mismatch",
          expectedRevision: m.baseRevision,
          actualRevision: currentAsset.revision,
          expectedHash: m.baseContentHash,
          actualHash: currentAsset.contentHash,
        });
        continue;
      }

      // hash 校验
      if (
        m.baseContentHash !== null &&
        m.baseContentHash !== currentAsset.contentHash
      ) {
        conflicts.push({
          assetType: m.assetType,
          assetId: m.assetId,
          reason: "hash-mismatch",
          expectedRevision: m.baseRevision,
          actualRevision: currentAsset.revision,
          expectedHash: m.baseContentHash,
          actualHash: currentAsset.contentHash,
        });
        continue;
      }
    } else if (currentAsset) {
      // baseRevision 和 baseContentHash 都为空但资产已存在 → 冲突
      // 客户端以为新建，但远端已存在（可能来自之前 CAS_FAILED 的部分写入）
      conflicts.push({
        assetType: m.assetType,
        assetId: m.assetId,
        reason: "revision-mismatch",
        expectedRevision: null,
        actualRevision: currentAsset.revision,
        expectedHash: null,
        actualHash: currentAsset.contentHash,
      });
      continue;
    }

    // CAS 校验通过后：校验 blob 在 R2 中存在
    const blobPrefix = m.blobHash.substring(0, 2);
    const blobR2Key = `sync/v1/${spaceId}/${requestEpoch}/blobs/sha256/${blobPrefix}/${m.blobHash}`;
    try {
      const obj = await deps.r2Bucket.head(blobR2Key);
      if (!obj) {
        conflicts.push({
          assetType: m.assetType,
          assetId: m.assetId,
          reason: "blob-missing",
          expectedRevision: m.baseRevision,
          actualRevision: currentAsset?.revision ?? 0,
          expectedHash: m.baseContentHash,
          actualHash: m.blobHash,
        });
        continue;
      }
    } catch {
      // R2 不可用时跳过校验（本地环境可容忍）
    }

    // 构造 version 输入
    const newRevision = (currentAsset?.revision ?? 0) + 1;

    versions.push({
      clientMutationId: m.clientMutationId,
      assetType: m.assetType,
      assetId: m.assetId,
      kind: "full",
      baseContentHash: m.baseContentHash,
      targetContentHash: m.blobHash,
      blobHash: m.blobHash,
      byteSize: m.blobByteSize,
      encoding: m.encoding,
      revision: newRevision,
      schemaVersion: m.schemaVersion,
      minReadableSchemaVersion: m.schemaVersion,
      writerAppVersion: m.writerAppVersion,
      writerBuildId: m.writerBuildId,
      storageMode: m.storageMode,
      baseFullBlobHash: m.baseRevision === null ? m.blobHash : null,
      deltaDepth: 0,
      contentHash: m.blobHash,
    });

    blobHashes.push(m.blobHash);
    blobR2Keys.push(blobR2Key);
  }

  // 6. 任意冲突 → 拒绝整批
  if (conflicts.length > 0) {
    return { status: "conflict", conflicts };
  }

  // 7. D1 batch 提交（含 CAS 校验）
  const newHead = space.head + 1;
  let applied: AppliedVersionResult[];
  try {
    applied = await deps.repo.commitBatch(
      spaceId,
      requestEpoch,
      newHead,
      versions,
      blobHashes,
      blobR2Keys,
      deps.presentTime,
    );
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('CAS_FAILED:')) {
      // D1 batch() 非事务：sync_assets / sync_asset_versions 已写入但 sync_spaces.head 未推进。
      // 这会导致资产对 plan/check 不可见（head 不变），但重试 prepare 时
      // baseRevision=null + currentHead 存在 → revision-mismatch → 客户端重新 plan 获取
      // 正确 head 后再次提交。
      return {
        status: "conflict",
        conflicts: [
          {
            assetType: "",
            assetId: "",
            reason: "concurrent-commit-conflict",
            expectedRevision: null,
            actualRevision: 0,
            expectedHash: null,
            actualHash: null,
          },
        ],
      };
    }
    throw e;
  }

  return {
    status: "committed",
    applied,
    head: newHead,
    serverTime: deps.presentTime,
  };
}

// ============================================================================
// handlePlan
// ============================================================================

export interface HandlePlanDeps {
  repo: SyncRepository;
  presignedUrlConfig: PresignedUrlConfig;
  localDevHost?: string;
  /** 嵌入 plan 响应的能力声明 */
  capabilities: PlanCapabilities;
}

export async function handlePlan(
  spaceId: string,
  assetTypes: string[],
  deps: HandlePlanDeps,
): Promise<PlanResponse | null> {
  const space = await deps.repo.getSpaceHead(spaceId);
  if (!space) return null;

  const rows = await deps.repo.listAssetHeads(spaceId, space.activeEpoch, assetTypes.length > 0 ? assetTypes : undefined);

  // 按 assetType 分组为 modules
  const moduleMap = new Map<string, AssetSummary[]>();
  for (const row of rows) {
    let downloadUrl: string | undefined;
    if (row.blobHash) {
      if (deps.localDevHost) {
        const prefix = row.blobHash.substring(0, 2);
        downloadUrl = `${deps.localDevHost}/v1/sync/spaces/${encodeURIComponent(spaceId)}/blobs/${encodeURIComponent(space.activeEpoch)}/sha256/${prefix}/${encodeURIComponent(row.blobHash)}`;
      } else if (deps.presignedUrlConfig.accessKeyId) {
        try {
          downloadUrl = await generatePresignedDownloadUrl(
            deps.presignedUrlConfig,
            spaceId,
            space.activeEpoch,
            row.blobHash,
          );
        } catch {
          // S3 失败不阻塞
        }
      }
    }

    const asset: AssetSummary = {
      assetType: row.assetType,
      assetId: row.assetId,
      revision: row.revision,
      contentHash: row.contentHash,
      schemaVersion: row.schemaVersion,
      storageMode: row.storageMode,
      blobHash: row.blobHash,
      byteSize: row.byteSize,
      encoding: row.encoding,
      downloadUrl,
      deletedAt: row.deletedAt,
    };

    const list = moduleMap.get(row.assetType);
    if (list) {
      list.push(asset);
    } else {
      moduleMap.set(row.assetType, [asset]);
    }
  }

  const modules: PlanModule[] = Array.from(moduleMap.entries()).map(
    ([moduleType, assets]) => ({ moduleType, assets }),
  );

  return {
    head: space.head,
    epoch: space.activeEpoch,
    snapshotHead: space.head,
    modules,
    capabilities: deps.capabilities,
    nextPageToken: null,
    minRetainedHead: space.minRetainedHead,
    serverTime: new Date().toISOString(),
  };
}

// ============================================================================
// handleCheck
// ============================================================================

export interface HandleCheckDeps {
  repo: SyncRepository;
}

export async function handleCheck(
  spaceId: string,
  knownHead: number | null,
  deps: HandleCheckDeps,
): Promise<CheckResponse | null> {
  const space = await deps.repo.getSpaceHead(spaceId);
  if (!space) return null;

  const changed = knownHead === null || knownHead < space.head;

  let changes: AssetSummary[] = [];
  const moduleHeads: ModuleHead[] = [];

  if (changed && knownHead !== null) {
    // 查询 since knownHead 以来变更的资产
    const rows = await deps.repo.listChangedAssetHeads(spaceId, space.activeEpoch, knownHead);
    changes = rows.map((row) => ({
      assetType: row.assetType,
      assetId: row.assetId,
      revision: row.revision,
      contentHash: row.contentHash,
      schemaVersion: row.schemaVersion,
      storageMode: row.storageMode,
      blobHash: row.blobHash,
      byteSize: row.byteSize,
      encoding: row.encoding,
      deletedAt: row.deletedAt,
    }));
  }

  // 读取模块级 head（来自 sync_module_heads）
  const mhRows = await deps.repo.getModuleHeads(spaceId);
  for (const mh of mhRows) {
    moduleHeads.push({ moduleType: mh.moduleType, head: mh.head });
  }

  // Phase 1: 有变更即要求 plan（后续根据变更量/epoch 变化细化）
  const planRequired = changed;

  return {
    head: space.head,
    epoch: space.activeEpoch,
    changed,
    planRequired,
    changes,
    moduleHeads,
    serverTime: new Date().toISOString(),
  };
}

// ============================================================================
// handleReset
// ============================================================================

export interface HandleResetDeps {
  repo: SyncRepository;
}

export async function handleReset(
  spaceId: string,
  deps: HandleResetDeps,
): Promise<ResetResponse | null> {
  const space = await deps.repo.getSpaceHead(spaceId);
  if (!space) return null;

  // epoch 递增：epoch-N → epoch-(N+1)
  const match = space.activeEpoch.match(/^(.+-)(\d+)$/);
  const newEpoch = match
    ? `${match[1]}${parseInt(match[2], 10) + 1}`
    : `${space.activeEpoch}-reset-${Date.now()}`;

  const result = await deps.repo.resetSpace(spaceId, newEpoch, space.activeEpoch);
  if (!result) return null;

  return {
    ok: true,
    spaceId,
    previousEpoch: result.previousEpoch,
    newEpoch: result.newEpoch,
  };
}

// ============================================================================
// handleDownloadsSign
// ============================================================================

export interface HandleDownloadsSignDeps {
  repo: SyncRepository;
  presignedUrlConfig: PresignedUrlConfig;
  localDevHost?: string;
}

export async function handleDownloadsSign(
  spaceId: string,
  blobHashes: string[],
  deps: HandleDownloadsSignDeps,
): Promise<DownloadsSignResponse | null> {
  const space = await deps.repo.getSpaceHead(spaceId);
  if (!space) return null;

  const urls: DownloadsSignResponse["urls"] = [];
  for (const blobHash of blobHashes) {
    let url: string | undefined;
    if (deps.localDevHost) {
      const prefix = blobHash.substring(0, 2);
      url = `${deps.localDevHost}/v1/sync/spaces/${encodeURIComponent(spaceId)}/blobs/${encodeURIComponent(space.activeEpoch)}/sha256/${prefix}/${encodeURIComponent(blobHash)}`;
    } else if (deps.presignedUrlConfig.accessKeyId) {
      try {
        url = await generatePresignedDownloadUrl(
          deps.presignedUrlConfig,
          spaceId,
          space.activeEpoch,
          blobHash,
        );
      } catch {
        // S3 失败不阻塞
      }
    }
    urls.push({ blobHash, url: url ?? "" });
  }

  return { urls };
}

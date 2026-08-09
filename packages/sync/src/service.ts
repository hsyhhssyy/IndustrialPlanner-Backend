// 服务层 — 用例编排（handlePrepare / handleCommit / handlePlan）
//
// 职责：协调 repository、commit_token、presigned_url 完成业务逻辑。
// 不直接访问 D1/R2，通过注入的依赖接口操作。

import type {
  SyncRepository,
  AssetHeadRow,
  CommitVersionInput,
  AppliedVersionResult,
  MutationResultRow,
  TieredCommitInput,
  TieredCommitMutation,
  UploadSessionRow,
  AssetDeleteInput,
  AssetDeleteResult,
} from "./repository";
import type { PresignedUrlConfig } from "./presigned_url";
import { generatePresignedUploadUrl, generatePresignedDownloadUrl } from "./presigned_url";
import {
  signCommitToken,
  verifyCommitToken,
  signCapabilityToken,
  verifyCapabilityToken,
  sha256Hex,
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
  StorageBackend,
  DeleteAssetResponse,
} from "./model";
import {
  DEFAULT_D1_RETURN_THRESHOLD_BYTES,
  DEFAULT_MAX_BATCH_D1_BLOB_BYTES,
  DEFAULT_MAX_R2_BLOB_BYTES,
  DEFAULT_R2_ENTER_THRESHOLD_BYTES,
  STORAGE_THRESHOLD_VERSION,
  deriveFixedR2Key,
  selectStorageBackend,
} from "./model";

// ============================================================================
// 依赖注入
// ============================================================================

interface HandlePrepareLegacyDeps {
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

// AI-CORRECTION 2026-08-08:
// 旧流程按 blobHash 生成可直接覆盖完成态对象的 URL，且没有 D1/R2 分层。
// 当前 HTTP 入口改用文件末尾的 handlePrepare；本函数只保留用于审计旧行为。
async function handlePrepareLegacy(
  spaceId: string,
  requestEpoch: string,
  clientBatchId: string,
  mutations: PrepareMutation[],
  deps: HandlePrepareLegacyDeps,
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
    console.log(`[prepare] space=${spaceId} asset=${m.assetType}/${m.assetId} baseRev=${m.baseRevision} baseHash=${(m.baseContentHash||'null').slice(0,12)} currentHead=${currentHead ? 'rev='+currentHead.revision : 'NONE'}`);

    // 3c. CAS 校验
    // baseRevision === null 表示客户端声明这是新建资产 — 直接通过 CAS
    // baseContentHash 单独存在时不触发 CAS（它只在 baseRevision !== null 时有意义）
    if (m.baseRevision !== null) {
      if (!currentHead) {
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
      if (m.baseRevision !== currentHead.revision) {
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
      // baseRevision 为 null 但资产已存在 → 冲突
      // 客户端以为新建，但远端已存在（可能来自之前 CAS_FAILED 的部分写入）
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
    const blobHash = m.blobHash ?? "";
    if (deps.localDevHost && blobHash.length >= 2) {
      // 本地开发：直接提供本地 blob 直传 URL
      const prefix = blobHash.substring(0, 2);
      uploadUrl = `${deps.localDevHost}/v1/sync/spaces/${encodeURIComponent(spaceId)}/blobs/${encodeURIComponent(currentEpoch)}/sha256/${prefix}/${encodeURIComponent(blobHash)}`;
    } else if (deps.presignedUrlConfig.accessKeyId) {
      try {
        uploadUrl = await generatePresignedUploadUrl(
          deps.presignedUrlConfig,
          spaceId,
          currentEpoch,
          blobHash,
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
      blobHash: m.blobHash,
      blobByteSize: m.blobByteSize,
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

interface HandleCommitLegacyDeps {
  repo: SyncRepository;
  commitTokenSecret: string;
  r2Bucket: R2Bucket;
  now: number;
  presentTime: string;
}

// AI-CORRECTION 2026-08-08:
// 旧流程先产生完成态 R2 对象、再事后检查 D1 CAS，无法保护固定 key。
// 当前 HTTP 入口改用文件末尾的 handleCommit；本函数只保留用于审计旧行为。
export async function handleCommitLegacyForAudit(
  spaceId: string,
  requestEpoch: string,
  rawToken: string,
  mutations: PrepareMutation[],
  deps: HandleCommitLegacyDeps,
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

  // 2a. 规范化 mutations：JSON 中缺失的字段在 JS 中是 undefined，
  //     但 CAS 比较需要 null 语义（undefined !== null → 新资产被误判为旧资产）
  const normalizedMutations = mutations.map((m) => ({
    ...m,
    baseRevision: m.baseRevision ?? null,
    baseContentHash: m.baseContentHash ?? null,
    blobHash: m.blobHash ?? "",
    blobByteSize: m.blobByteSize ?? 0,
    metadata: m.metadata ?? "{}",
    storageMode: m.storageMode ?? "full",
    schemaVersion: m.schemaVersion ?? 1,
    encoding: m.encoding ?? "identity",
    writerAppVersion: m.writerAppVersion ?? "0.0.0",
    writerBuildId: m.writerBuildId ?? "unknown",
  }));

  // 3. 幂等检查（全部 mutation 已提交 → already-committed）
  const mutationResults: Map<string, MutationResultRow> = new Map();
  for (const m of normalizedMutations) {
    const existing = await deps.repo.getMutationResult(
      spaceId,
      requestEpoch,
      m.clientMutationId,
    );
    if (existing) {
      mutationResults.set(m.clientMutationId, existing);
    }
  }
  if (mutationResults.size === normalizedMutations.length && normalizedMutations.length > 0) {
    const space = await deps.repo.getSpaceHead(spaceId);
    return {
      status: "already-committed",
      applied: normalizedMutations.map((m) => {
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

  // 3a. 构建 tokenMutation 索引：按 clientMutationId 查 token 中的 blobHash/blobByteSize
  const tokenMutMap = new Map<string, TokenMutation>();
  for (const tm of tokenPayload.mutations) {
    tokenMutMap.set(tm.clientMutationId, tm);
  }

  // 3b. 用 token 中的 blobHash/blobByteSize 补充客户端可能缺失的字段
  const resolvedMutations = normalizedMutations.map((m) => {
    const tm = tokenMutMap.get(m.clientMutationId);
    return tm ? { ...m, blobHash: tm.blobHash || m.blobHash, blobByteSize: tm.blobByteSize || m.blobByteSize } : m;
  });

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

  for (const m of resolvedMutations) {
    const currentAsset = await deps.repo.getAssetHead(
      spaceId,
      requestEpoch,
      m.assetType,
      m.assetId,
    );
    console.log(`[commit] space=${spaceId} asset=${m.assetType}/${m.assetId} baseRev=${m.baseRevision} baseHash=${(m.baseContentHash||'null').slice(0,12)} currentAsset=${currentAsset ? 'rev='+currentAsset.revision+' hash='+(currentAsset.contentHash||'null').slice(0,12) : 'NONE'}`);

    // CAS 校验（与 prepare 对称：baseRevision === null 即新建资产，不触发 CAS）
    if (m.baseRevision !== null) {
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
      if (m.baseRevision !== currentAsset.revision) {
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
      // baseRevision 为 null 但资产已存在 → 冲突
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

    // CAS 校验通过后：校验 blob 在 R2 中存在（blobHash 为空则跳过）
    let blobR2Key = "";
    if (m.blobHash && m.blobHash.length >= 2) {
      const blobPrefix = m.blobHash.substring(0, 2);
      blobR2Key = `sync/v1/${spaceId}/${requestEpoch}/blobs/sha256/${blobPrefix}/${m.blobHash}`;
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

interface HandlePlanLegacyDeps {
  repo: SyncRepository;
  presignedUrlConfig: PresignedUrlConfig;
  localDevHost?: string;
  /** 嵌入 plan 响应的能力声明 */
  capabilities: PlanCapabilities;
}

// AI-CORRECTION 2026-08-08:
// 旧 plan 直接签 R2 hash key；当前入口改用版本绑定的 Worker 下载票据。
async function handlePlanLegacy(
  spaceId: string,
  assetTypes: string[],
  deps: HandlePlanLegacyDeps,
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
  if (space.pendingCommitId) {
    throw new StorageProtocolError(503, "commit_in_progress", "空间正在恢复提交，请稍后重试");
  }

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
      backend: row.backend,
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
    ? `${match[1] ?? "epoch-"}${parseInt(match[2] ?? "0", 10) + 1}`
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

interface HandleDownloadsSignLegacyDeps {
  repo: SyncRepository;
  presignedUrlConfig: PresignedUrlConfig;
  localDevHost?: string;
}

// AI-CORRECTION 2026-08-08:
// 旧接口会为任意 blobHash 签名；当前入口只允许签当前资产内容。
async function handleDownloadsSignLegacy(
  spaceId: string,
  blobHashes: string[],
  deps: HandleDownloadsSignLegacyDeps,
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

// ============================================================================
// S1-RQ-007：有界最新态上传、提交与下载
// ============================================================================

export class StorageProtocolError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface TieredStorageConfig {
  r2EnterThresholdBytes: number;
  d1ReturnThresholdBytes: number;
  maxBatchD1BlobBytes: number;
  maxR2BlobBytes: number;
  retentionHeadWindow: number;
}

export const DEFAULT_TIERED_STORAGE_CONFIG: TieredStorageConfig = {
  r2EnterThresholdBytes: DEFAULT_R2_ENTER_THRESHOLD_BYTES,
  d1ReturnThresholdBytes: DEFAULT_D1_RETURN_THRESHOLD_BYTES,
  maxBatchD1BlobBytes: DEFAULT_MAX_BATCH_D1_BLOB_BYTES,
  maxR2BlobBytes: DEFAULT_MAX_R2_BLOB_BYTES,
  retentionHeadWindow: 1000,
};

export interface HandlePrepareDeps {
  repo: SyncRepository;
  commitTokenSecret: string;
  r2Bucket?: R2Bucket;
  publicBaseUrl?: string;
  /** 旧测试输入保留；RQ-007 不再生成 S3 PutObject URL。 */
  presignedUrlConfig?: PresignedUrlConfig;
  /** 旧测试输入保留；未显式传 publicBaseUrl 时作为能力 URL origin。 */
  localDevHost?: string;
  now: number;
  storageConfig?: Partial<TieredStorageConfig>;
}

export interface HandleCommitDeps {
  repo: SyncRepository;
  commitTokenSecret: string;
  r2Bucket: R2Bucket;
  now: number;
  presentTime: string;
  storageConfig?: Partial<TieredStorageConfig>;
}

export interface HandlePlanDeps {
  repo: SyncRepository;
  commitTokenSecret: string;
  publicBaseUrl: string;
  capabilities: PlanCapabilities;
}

export interface HandleDownloadsSignDeps {
  repo: SyncRepository;
  commitTokenSecret: string;
  publicBaseUrl: string;
}

export interface HandlePayloadUploadDeps {
  repo: SyncRepository;
  r2Bucket: R2Bucket;
  commitTokenSecret: string;
  now: number;
}

export interface HandlePayloadDownloadDeps {
  repo: SyncRepository;
  r2Bucket: R2Bucket;
  commitTokenSecret: string;
}

export interface HandleDeleteAssetDeps {
  repo: SyncRepository;
  r2Bucket: R2Bucket;
  now: number;
  storageConfig?: Partial<TieredStorageConfig>;
}

export interface DownloadPayloadResult {
  body: BodyInit;
  headers: Headers;
}

function resolveStorageConfig(
  overrides?: Partial<TieredStorageConfig>,
): TieredStorageConfig {
  return { ...DEFAULT_TIERED_STORAGE_CONFIG, ...overrides };
}

function normalizeMutation(mutation: PrepareMutation): PrepareMutation {
  return {
    ...mutation,
    baseRevision: mutation.baseRevision ?? null,
    baseContentHash: mutation.baseContentHash ?? null,
    metadata: mutation.metadata ?? "{}",
    storageMode: mutation.storageMode ?? "full",
    schemaVersion: mutation.schemaVersion ?? 1,
    encoding: mutation.encoding ?? "identity",
    writerAppVersion: mutation.writerAppVersion ?? "0.0.0",
    writerBuildId: mutation.writerBuildId ?? "unknown",
  };
}

async function mutationFingerprint(mutation: PrepareMutation): Promise<string> {
  return sha256Hex(JSON.stringify([
    mutation.clientMutationId,
    mutation.assetType,
    mutation.assetId,
    mutation.baseRevision,
    mutation.baseContentHash,
    mutation.metadata,
    mutation.blobHash,
    mutation.blobByteSize,
    mutation.storageMode,
    mutation.schemaVersion,
    mutation.encoding,
    mutation.writerAppVersion,
    mutation.writerBuildId,
  ]));
}

function conflictFor(
  mutation: PrepareMutation,
  reason: ConflictItem["reason"],
  currentAsset: AssetHeadRow | null,
): ConflictItem {
  return {
    assetType: mutation.assetType,
    assetId: mutation.assetId,
    reason,
    expectedRevision: mutation.baseRevision,
    actualRevision: currentAsset?.revision ?? 0,
    expectedHash: mutation.baseContentHash,
    actualHash: currentAsset?.contentHash ?? null,
  };
}

function validateAssetCas(
  mutation: PrepareMutation,
  currentAsset: AssetHeadRow | null,
): ConflictItem | null {
  if (mutation.baseRevision === null) {
    return currentAsset ? conflictFor(mutation, "revision-mismatch", currentAsset) : null;
  }
  if (!currentAsset || currentAsset.revision !== mutation.baseRevision) {
    return conflictFor(mutation, "revision-mismatch", currentAsset);
  }
  if (
    mutation.baseContentHash !== null &&
    currentAsset.contentHash !== mutation.baseContentHash
  ) {
    return conflictFor(mutation, "hash-mismatch", currentAsset);
  }
  return null;
}

function buildBlobCapabilityUrl(
  publicBaseUrl: string,
  spaceId: string,
  epoch: string,
  blobHash: string,
  ticket: string,
): string {
  const prefix = blobHash.substring(0, 2);
  return `${publicBaseUrl.replace(/\/$/, "")}/v1/sync/spaces/${encodeURIComponent(spaceId)}/blobs/${encodeURIComponent(epoch)}/sha256/${prefix}/${encodeURIComponent(blobHash)}?ticket=${encodeURIComponent(ticket)}`;
}

function uploadSessionMatches(
  session: UploadSessionRow,
  mutation: PrepareMutation,
  sourceBackend: StorageBackend,
  targetBackend: StorageBackend,
  fixedR2Key: string,
  epoch: string,
): boolean {
  return session.epoch === epoch &&
    session.assetType === mutation.assetType &&
    session.assetId === mutation.assetId &&
    session.sourceBackend === sourceBackend &&
    session.targetBackend === targetBackend &&
    session.objectKey === fixedR2Key &&
    session.blobHash === mutation.blobHash &&
    session.byteSize === mutation.blobByteSize &&
    session.encoding === mutation.encoding;
}

function storageCopyMatches(
  storage: Awaited<ReturnType<SyncRepository["getAssetStorage"]>>,
  targetBackend: StorageBackend,
  mutation: PrepareMutation,
): boolean {
  if (!storage) return false;
  if (targetBackend === "d1") {
    return storage.d1Content !== null &&
      storage.d1BlobHash === mutation.blobHash &&
      storage.d1ByteSize === mutation.blobByteSize &&
      storage.d1Encoding === mutation.encoding;
  }
  return storage.r2Present &&
    storage.r2BlobHash === mutation.blobHash &&
    storage.r2ByteSize === mutation.blobByteSize &&
    storage.r2Encoding === mutation.encoding;
}

async function discardExpiredUploadSession(
  session: UploadSessionRow,
  deps: HandlePrepareDeps,
): Promise<void> {
  if (session.r2MultipartUploadId) {
    try {
      if (!deps.r2Bucket) {
        throw new Error("缺少 R2 binding，无法 abort 过期 multipart");
      }
      await deps.r2Bucket
        .resumeMultipartUpload(session.objectKey, session.r2MultipartUploadId)
        .abort();
    } catch {
      // 过期 uploadId 可能已经被 R2 清理；删除 D1 session 仍然安全。
    }
  }
  await deps.repo.deleteUploadSession(session.sessionId);
}

function createIssuedUploadSession(input: {
  spaceId: string;
  epoch: string;
  mutation: PrepareMutation;
  sourceBackend: StorageBackend;
  targetBackend: StorageBackend;
  objectKey: string;
  now: number;
}): UploadSessionRow {
  const createdAt = new Date(input.now).toISOString();
  return {
    sessionId: crypto.randomUUID(),
    spaceId: input.spaceId,
    epoch: input.epoch,
    assetType: input.mutation.assetType,
    assetId: input.mutation.assetId,
    sourceBackend: input.sourceBackend,
    targetBackend: input.targetBackend,
    objectKey: input.objectKey,
    blobHash: input.mutation.blobHash,
    byteSize: input.mutation.blobByteSize,
    encoding: input.mutation.encoding,
    r2MultipartUploadId: null,
    partEtag: null,
    d1Content: null,
    state: "issued",
    leaseExpiresAt: null,
    expiresAt: new Date(input.now + 15 * 60_000).toISOString(),
    createdAt,
    updatedAt: createdAt,
  };
}

export async function handlePrepare(
  spaceId: string,
  requestEpoch: string,
  clientBatchId: string,
  rawMutations: PrepareMutation[],
  deps: HandlePrepareDeps,
): Promise<PrepareMutationsResponse> {
  const storageConfig = resolveStorageConfig(deps.storageConfig);
  const space = await deps.repo.getSpaceHead(spaceId);
  if (!space || space.activeEpoch !== requestEpoch) {
    return {
      status: "conflict",
      conflicts: [{
        assetType: "",
        assetId: "",
        reason: "space-epoch-changed",
        expectedRevision: null,
        actualRevision: 0,
        expectedHash: null,
        actualHash: null,
      }],
    };
  }
  if (space.pendingCommitId) {
    return {
      status: "conflict",
      conflicts: [{
        assetType: "",
        assetId: "",
        reason: "storage-busy",
        expectedRevision: null,
        actualRevision: 0,
        expectedHash: null,
        actualHash: null,
      }],
    };
  }

  const mutations = rawMutations.map(normalizeMutation);
  const uploads: MutationUpload[] = [];
  const alreadyApplied: AlreadyAppliedMutation[] = [];
  const conflicts: ConflictItem[] = [];
  const tokenMutations: TokenMutation[] = [];
  let d1UploadBytes = 0;

  for (const mutation of mutations) {
    if (mutation.blobByteSize > storageConfig.maxR2BlobBytes) {
      throw new StorageProtocolError(413, "blob_too_large", "payload 超过 R2 文件上限");
    }

    const previousResult = await deps.repo.getMutationResult(
      spaceId,
      requestEpoch,
      mutation.clientMutationId,
    );
    if (previousResult) {
      alreadyApplied.push({
        clientMutationId: mutation.clientMutationId,
        assetType: mutation.assetType,
        assetId: mutation.assetId,
        revision: previousResult.appliedRevision,
        contentHash: previousResult.contentHash ?? "",
      });
      continue;
    }

    const [currentAsset, storage] = await Promise.all([
      deps.repo.getAssetHead(spaceId, requestEpoch, mutation.assetType, mutation.assetId),
      deps.repo.getAssetStorage(spaceId, mutation.assetType, mutation.assetId),
    ]);
    const casConflict = validateAssetCas(mutation, currentAsset);
    if (casConflict) {
      conflicts.push(casConflict);
      continue;
    }
    if (storage && storage.storageState !== "stable") {
      conflicts.push(conflictFor(mutation, "storage-busy", currentAsset));
      continue;
    }

    const sourceBackend: StorageBackend = storage?.activeBackend ?? "d1";
    const targetBackend = selectStorageBackend(
      sourceBackend,
      mutation.blobByteSize,
      storageConfig.r2EnterThresholdBytes,
      storageConfig.d1ReturnThresholdBytes,
    );
    if (targetBackend === "d1") {
      d1UploadBytes += mutation.blobByteSize;
    }

    const fixedR2Key = storage?.r2Key ?? deriveFixedR2Key(
      spaceId,
      mutation.assetType,
      mutation.assetId,
    );
    let uploadSessionId: string | null = null;
    let uploadUrl: string | undefined;
    const reusable = storageCopyMatches(storage, targetBackend, mutation);

    if (!reusable) {
      let session = await deps.repo.getUploadSessionForAsset(
        spaceId,
        mutation.assetType,
        mutation.assetId,
      );
      if (session && Date.parse(session.expiresAt) <= deps.now) {
        await discardExpiredUploadSession(session, deps);
        session = null;
      }
      if (session && !uploadSessionMatches(
        session,
        mutation,
        sourceBackend,
        targetBackend,
        fixedR2Key,
        requestEpoch,
      )) {
        // AI-CORRECTION 2026-08-09: 尚未 claim、没有任何暂存数据的 issued session
        // 不代表正在上传。新 descriptor 通过 repository 条件 UPDATE 原子替换它；
        // 若旧 PUT 已抢先 claim，替换会失败并维持 upload-in-progress。
        const replacement = createIssuedUploadSession({
          spaceId,
          epoch: requestEpoch,
          mutation,
          sourceBackend,
          targetBackend,
          objectKey: fixedR2Key,
          now: deps.now,
        });
        const replaced = await deps.repo.replaceIssuedUploadSession(
          session.sessionId,
          replacement,
        );
        if (!replaced) {
          conflicts.push(conflictFor(mutation, "upload-in-progress", currentAsset));
          continue;
        }
        session = replacement;
      }
      if (session?.state === "reserved") {
        conflicts.push(conflictFor(mutation, "storage-busy", currentAsset));
        continue;
      }

      if (!session) {
        session = createIssuedUploadSession({
          spaceId,
          epoch: requestEpoch,
          mutation,
          sourceBackend,
          targetBackend,
          objectKey: fixedR2Key,
          now: deps.now,
        });
        await deps.repo.createUploadSession(session);
      }

      uploadSessionId = session.sessionId;
      const uploadTicket = await signCapabilityToken({
        kind: "upload",
        spaceId,
        epoch: requestEpoch,
        assetType: mutation.assetType,
        assetId: mutation.assetId,
        blobHash: mutation.blobHash,
        byteSize: mutation.blobByteSize,
        encoding: mutation.encoding,
        backend: targetBackend,
        sessionId: session.sessionId,
        expiresAt: deps.now + 5 * 60_000,
      }, deps.commitTokenSecret);
      uploadUrl = buildBlobCapabilityUrl(
        deps.publicBaseUrl ?? deps.localDevHost ?? "https://sync.invalid",
        spaceId,
        requestEpoch,
        mutation.blobHash,
        uploadTicket,
      );
    }

    uploads.push({
      assetType: mutation.assetType,
      assetId: mutation.assetId,
      required: !reusable,
      backend: targetBackend,
      sessionId: uploadSessionId ?? undefined,
      url: uploadUrl,
      headers: uploadUrl ? { "Content-Type": "application/octet-stream" } : undefined,
    });
    tokenMutations.push({
      clientMutationId: mutation.clientMutationId,
      assetType: mutation.assetType,
      assetId: mutation.assetId,
      baseRevision: mutation.baseRevision,
      baseContentHash: mutation.baseContentHash,
      blobHash: mutation.blobHash,
      blobByteSize: mutation.blobByteSize,
      sourceBackend,
      targetBackend,
      thresholdVersion: STORAGE_THRESHOLD_VERSION,
      fixedR2Key,
      uploadSessionId,
      mutationFingerprint: await mutationFingerprint(mutation),
    });
  }

  if (conflicts.length > 0) return { status: "conflict", conflicts };
  if (d1UploadBytes > storageConfig.maxBatchD1BlobBytes) {
    throw new StorageProtocolError(
      413,
      "d1_batch_too_large",
      "批次中路由到 D1 的 payload 总量超过上限",
    );
  }

  const commitToken = await signCommitToken({
    tokenVersion: 2,
    commitId: crypto.randomUUID(),
    spaceId,
    epoch: requestEpoch,
    clientBatchId,
    observedHead: space.head,
    mutations: tokenMutations,
    expiresAt: deps.now + 5 * 60_000,
  }, deps.commitTokenSecret);

  return {
    status: "ready",
    uploads,
    commitToken,
    alreadyApplied: alreadyApplied.length > 0 ? alreadyApplied : undefined,
  };
}

export async function handlePayloadUpload(
  path: { spaceId: string; epoch: string; prefix: string; blobHash: string },
  ticket: string,
  bytes: ArrayBuffer,
  deps: HandlePayloadUploadDeps,
): Promise<{ backend: StorageBackend; sessionId: string }> {
  const verified = await verifyCapabilityToken(ticket, deps.commitTokenSecret);
  if (!verified.ok || verified.payload.kind !== "upload") {
    throw new StorageProtocolError(401, verified.ok ? "token_invalid" : verified.code, "上传票据无效或已过期");
  }
  const payload = verified.payload;
  if (
    payload.spaceId !== path.spaceId ||
    payload.epoch !== path.epoch ||
    payload.blobHash !== path.blobHash ||
    path.prefix !== path.blobHash.substring(0, 2) ||
    !payload.sessionId
  ) {
    throw new StorageProtocolError(403, "token_scope_mismatch", "上传票据与请求路径不匹配");
  }
  if (bytes.byteLength !== payload.byteSize) {
    throw new StorageProtocolError(400, "blob_size_mismatch", "实际 payload 大小与 prepare 声明不一致");
  }
  if (await sha256Hex(bytes) !== payload.blobHash) {
    throw new StorageProtocolError(400, "blob_checksum_mismatch", "payload SHA-256 与 blobHash 不一致");
  }

  let session = await deps.repo.getUploadSession(payload.sessionId);
  if (!session || !uploadSessionMatches(
    session,
    {
      clientMutationId: "upload-ticket",
      assetType: payload.assetType,
      assetId: payload.assetId,
      baseRevision: null,
      baseContentHash: null,
      metadata: "{}",
      blobHash: payload.blobHash,
      blobByteSize: payload.byteSize,
      storageMode: "full",
      schemaVersion: 1,
      encoding: payload.encoding,
      writerAppVersion: "upload-ticket",
      writerBuildId: "upload-ticket",
    },
    session?.sourceBackend ?? "d1",
    payload.backend,
    session?.objectKey ?? "",
    payload.epoch,
  )) {
    throw new StorageProtocolError(409, "upload_session_mismatch", "上传 session 不存在或与票据不匹配");
  }
  if (session.state === "uploaded") {
    return { backend: session.targetBackend, sessionId: session.sessionId };
  }
  if (session.state === "reserved" || session.state === "aborted") {
    throw new StorageProtocolError(409, "upload_session_closed", "上传 session 已关闭");
  }

  const claimedAt = new Date(deps.now).toISOString();
  const claimed = await deps.repo.claimUploadSession(
    session.sessionId,
    claimedAt,
    new Date(deps.now + 60_000).toISOString(),
  );
  if (!claimed) {
    throw new StorageProtocolError(409, "upload_in_progress", "同一资产已有上传正在进行");
  }

  try {
    if (session.targetBackend === "d1") {
      await deps.repo.markD1UploadReady(session.sessionId, bytes, claimedAt);
    } else {
      let multipart: R2MultipartUpload;
      if (session.r2MultipartUploadId) {
        multipart = deps.r2Bucket.resumeMultipartUpload(
          session.objectKey,
          session.r2MultipartUploadId,
        );
      } else {
        multipart = await deps.r2Bucket.createMultipartUpload(session.objectKey, {
          httpMetadata: { contentType: "application/octet-stream" },
          customMetadata: {
            uploadSessionId: session.sessionId,
            sha256: session.blobHash,
            byteSize: String(session.byteSize),
          },
        });
        await deps.repo.setUploadMultipartId(
          session.sessionId,
          multipart.uploadId,
          claimedAt,
        );
      }
      const part = await multipart.uploadPart(1, bytes);
      await deps.repo.markR2UploadReady(session.sessionId, part.etag, claimedAt);
    }
  } catch (error) {
    await deps.repo.releaseUploadSession(session.sessionId, new Date().toISOString());
    throw error;
  }

  session = await deps.repo.getUploadSession(session.sessionId);
  if (!session || session.state !== "uploaded") {
    throw new StorageProtocolError(500, "upload_state_error", "payload 已写入但 session 状态未能确认");
  }
  return { backend: session.targetBackend, sessionId: session.sessionId };
}

function r2ObjectMatchesSession(
  object: R2Object | null,
  session: UploadSessionRow,
): object is R2Object {
  return object !== null &&
    object.size === session.byteSize &&
    object.customMetadata?.uploadSessionId === session.sessionId &&
    object.customMetadata?.sha256 === session.blobHash &&
    object.customMetadata?.byteSize === String(session.byteSize);
}

async function completeIntentR2Objects(
  input: TieredCommitInput,
  repo: SyncRepository,
  r2Bucket: R2Bucket,
): Promise<Record<string, string>> {
  const versions: Record<string, string> = {};
  for (const mutation of input.mutations) {
    if (mutation.targetBackend !== "r2" || !mutation.uploadSessionId) continue;
    const session = await repo.getUploadSession(mutation.uploadSessionId);
    if (
      !session ||
      session.state !== "reserved" ||
      !session.r2MultipartUploadId ||
      !session.partEtag
    ) {
      throw new Error(`R2 session ${mutation.uploadSessionId} 未达到可完成状态`);
    }

    let object = await r2Bucket.head(session.objectKey);
    if (!r2ObjectMatchesSession(object, session)) {
      try {
        object = await r2Bucket
          .resumeMultipartUpload(session.objectKey, session.r2MultipartUploadId)
          .complete([{ partNumber: 1, etag: session.partEtag }]);
        // AI-CORRECTION 2026-08-09: 正式 R2 的 complete 响应可能省略 customMetadata；
        // 完成态已成功覆盖时必须立刻 HEAD 校验，不能误报 500 后等待下一请求恢复。
        if (!r2ObjectMatchesSession(object, session)) {
          object = await r2Bucket.head(session.objectKey);
        }
      } catch (error) {
        object = await r2Bucket.head(session.objectKey);
        if (!r2ObjectMatchesSession(object, session)) throw error;
      }
    }
    if (!r2ObjectMatchesSession(object, session)) {
      throw new Error(`固定 R2 对象 ${session.objectKey} 完成后校验失败`);
    }
    versions[session.sessionId] = object.version;
  }
  return versions;
}

export async function recoverPendingCommit(
  spaceId: string,
  deps: Pick<HandleCommitDeps, "repo" | "r2Bucket">,
): Promise<AppliedVersionResult[] | null> {
  const intent = await deps.repo.getPendingCommitIntent(spaceId);
  if (!intent) {
    await recoverPendingDelete(spaceId, deps);
    return null;
  }
  const input = JSON.parse(intent.payloadJson) as TieredCommitInput;
  if (
    input.commitId !== intent.commitId ||
    input.spaceId !== intent.spaceId ||
    input.epoch !== intent.epoch ||
    !Array.isArray(input.mutations)
  ) {
    throw new Error(`commit intent ${intent.commitId} 内容损坏`);
  }

  try {
    await deps.repo.markCommitIntentState(
      intent.commitId,
      "r2_writing",
      new Date().toISOString(),
    );
    const versions = await completeIntentR2Objects(input, deps.repo, deps.r2Bucket);
    await deps.repo.markCommitIntentState(
      intent.commitId,
      "finalizing",
      new Date().toISOString(),
    );
    return await deps.repo.finalizeTieredCommit(input, versions);
  } catch (error) {
    if (isDatabaseConflict(error)) {
      const results: AppliedVersionResult[] = [];
      for (const mutation of input.mutations) {
        const existing = await deps.repo.getMutationResult(
          input.spaceId,
          input.epoch,
          mutation.clientMutationId,
        );
        if (!existing) break;
        results.push({
          clientMutationId: mutation.clientMutationId,
          assetType: mutation.assetType,
          assetId: mutation.assetId,
          revision: existing.appliedRevision,
          contentHash: existing.contentHash ?? mutation.contentHash,
        });
      }
      if (results.length === input.mutations.length) return results;
    }
    await deps.repo.markCommitIntentState(
      intent.commitId,
      intent.state,
      new Date().toISOString(),
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}

export async function recoverPendingDelete(
  spaceId: string,
  deps: Pick<HandleDeleteAssetDeps, "repo" | "r2Bucket">,
): Promise<AssetDeleteResult | null> {
  const intent = await deps.repo.getPendingDeleteIntent(spaceId);
  if (!intent) return null;
  const input = JSON.parse(intent.payloadJson) as AssetDeleteInput;
  if (
    input.deleteId !== intent.deleteId ||
    input.spaceId !== intent.spaceId ||
    input.epoch !== intent.epoch ||
    input.assetType !== intent.assetType ||
    input.assetId !== intent.assetId ||
    input.expectedHead !== intent.expectedHead ||
    input.expectedRevision !== intent.expectedRevision ||
    input.r2Key !== intent.r2Key
  ) {
    throw new Error(`delete intent ${intent.deleteId} 内容损坏`);
  }

  await deps.repo.markDeleteIntentState(
    intent.deleteId,
    "r2_deleting",
    new Date().toISOString(),
  );
  if (intent.multipartUploadId) {
    try {
      await deps.r2Bucket
        .resumeMultipartUpload(intent.r2Key, intent.multipartUploadId)
        .abort();
    } catch {
      // multipart 可能已被 R2 回收或在删除屏障前尚未创建完成；固定对象删除仍继续。
    }
  }
  await deps.r2Bucket.delete(intent.r2Key);
  try {
    return await deps.repo.finalizeAssetDelete(input);
  } catch (error) {
    if (isDatabaseConflict(error)) {
      const asset = await deps.repo.getAssetHead(
        input.spaceId,
        input.epoch,
        input.assetType,
        input.assetId,
      );
      if (
        asset?.deletedAt &&
        asset.revision === input.expectedRevision + 1 &&
        asset.currentHead === input.expectedHead + 1
      ) {
        return {
          revision: asset.revision,
          head: asset.currentHead,
          deletedAt: asset.deletedAt,
        };
      }
    }
    throw error;
  }
}

export async function handleDeleteAsset(
  spaceId: string,
  assetType: string,
  assetId: string,
  request: {
    spaceEpoch: string;
    expectedRevision: number;
    expectedContentHash: string | null;
  },
  deps: HandleDeleteAssetDeps,
): Promise<DeleteAssetResponse> {
  await recoverPendingCommit(spaceId, deps);
  const [space, asset, storage] = await Promise.all([
    deps.repo.getSpaceHead(spaceId),
    deps.repo.getAssetHead(spaceId, request.spaceEpoch, assetType, assetId),
    deps.repo.getAssetStorage(spaceId, assetType, assetId),
  ]);
  if (!space) {
    throw new StorageProtocolError(404, "space_not_found", "空间不存在");
  }
  if (space.activeEpoch !== request.spaceEpoch) {
    throw new StorageProtocolError(409, "space_epoch_changed", "空间 epoch 已变化");
  }
  if (!asset) {
    throw new StorageProtocolError(404, "asset_not_found", "资产不存在");
  }
  if (asset.deletedAt) {
    return {
      ok: true,
      deleted: false,
      spaceId,
      assetType,
      assetId,
      revision: asset.revision,
      head: asset.currentHead,
      deletedAt: asset.deletedAt,
    };
  }
  if (
    asset.revision !== request.expectedRevision ||
    (
      request.expectedContentHash !== null &&
      asset.contentHash !== request.expectedContentHash
    )
  ) {
    throw new StorageProtocolError(409, "revision_mismatch", "资产 revision/hash 已变化");
  }
  if (!storage || storage.activeEpoch !== request.spaceEpoch || storage.storageState !== "stable") {
    throw new StorageProtocolError(409, "storage_busy", "资产存储状态不可删除");
  }

  const deletedAt = new Date(deps.now).toISOString();
  const input: AssetDeleteInput = {
    deleteId: crypto.randomUUID(),
    spaceId,
    epoch: request.spaceEpoch,
    assetType,
    assetId,
    expectedHead: space.head,
    expectedRevision: request.expectedRevision,
    expectedContentHash: request.expectedContentHash,
    r2Key: storage.r2Key,
    deletedAt,
    retentionHeadWindow: resolveStorageConfig(deps.storageConfig).retentionHeadWindow,
  };

  try {
    await deps.repo.reserveAssetDelete(input);
    const result = await recoverPendingDelete(spaceId, deps);
    if (!result) throw new Error("删除 intent 建立后无法读取");
    return {
      ok: true,
      deleted: true,
      spaceId,
      assetType,
      assetId,
      revision: result.revision,
      head: result.head,
      deletedAt: result.deletedAt,
    };
  } catch (error) {
    if (!isDatabaseConflict(error)) throw error;
    throw new StorageProtocolError(409, "concurrent_delete_conflict", "资产在删除前已发生并发变化");
  }
}

function isDatabaseConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("CHECK constraint failed") ||
    message.includes("UNIQUE constraint failed") ||
    message.includes("constraint failed");
}

export async function handleCommit(
  spaceId: string,
  requestEpoch: string,
  rawToken: string,
  rawMutations: PrepareMutation[],
  deps: HandleCommitDeps,
): Promise<CommitMutationsResponse> {
  const tokenResult = await verifyCommitToken(rawToken, deps.commitTokenSecret);
  if (!tokenResult.ok || tokenResult.payload.tokenVersion !== 2 || !tokenResult.payload.commitId) {
    return {
      status: "conflict",
      conflicts: [{
        assetType: "",
        assetId: "",
        reason: tokenResult.ok ? "token-invalid" : tokenResult.code === "token_expired" ? "token-expired" : "token-invalid",
        expectedRevision: null,
        actualRevision: 0,
        expectedHash: null,
        actualHash: null,
      }],
    };
  }
  const token = tokenResult.payload;
  if (token.spaceId !== spaceId || token.epoch !== requestEpoch) {
    return {
      status: "conflict",
      conflicts: [{
        assetType: "",
        assetId: "",
        reason: "space-epoch-changed",
        expectedRevision: null,
        actualRevision: 0,
        expectedHash: null,
        actualHash: null,
      }],
    };
  }

  await recoverPendingCommit(spaceId, deps);
  const mutations = rawMutations.map(normalizeMutation);
  const existingResults = new Map<string, MutationResultRow>();
  for (const mutation of mutations) {
    const result = await deps.repo.getMutationResult(
      spaceId,
      requestEpoch,
      mutation.clientMutationId,
    );
    if (result) existingResults.set(mutation.clientMutationId, result);
  }
  if (mutations.length > 0 && existingResults.size === mutations.length) {
    const space = await deps.repo.getSpaceHead(spaceId);
    return {
      status: "already-committed",
      applied: mutations.map((mutation) => {
        const result = existingResults.get(mutation.clientMutationId)!;
        return {
          clientMutationId: mutation.clientMutationId,
          assetType: mutation.assetType,
          assetId: mutation.assetId,
          revision: result.appliedRevision,
          contentHash: result.contentHash ?? mutation.blobHash,
        };
      }),
      head: space?.head ?? 0,
      serverTime: deps.presentTime,
    };
  }
  if (existingResults.size > 0) {
    throw new StorageProtocolError(409, "partial_idempotency_state", "批次幂等记录不完整，拒绝继续提交");
  }

  const tokenByMutationId = new Map(
    token.mutations.map((mutation) => [mutation.clientMutationId, mutation]),
  );
  if (
    token.mutations.length !== mutations.length ||
    mutations.some((mutation) => !tokenByMutationId.has(mutation.clientMutationId))
  ) {
    return {
      status: "conflict",
      conflicts: mutations.map((mutation) => conflictFor(mutation, "token-invalid", null)),
    };
  }

  const space = await deps.repo.getSpaceHead(spaceId);
  if (!space || space.activeEpoch !== requestEpoch || space.head !== token.observedHead) {
    return {
      status: "conflict",
      conflicts: mutations.map((mutation) => conflictFor(mutation, "concurrent-commit-conflict", null)),
    };
  }

  const config = resolveStorageConfig(deps.storageConfig);
  const commitMutations: TieredCommitMutation[] = [];
  const conflicts: ConflictItem[] = [];
  for (const mutation of mutations) {
    const tokenMutation = tokenByMutationId.get(mutation.clientMutationId)!;
    if (
      tokenMutation.mutationFingerprint !== await mutationFingerprint(mutation) ||
      tokenMutation.baseRevision !== mutation.baseRevision ||
      tokenMutation.baseContentHash !== mutation.baseContentHash ||
      tokenMutation.blobHash !== mutation.blobHash ||
      tokenMutation.blobByteSize !== mutation.blobByteSize ||
      tokenMutation.thresholdVersion !== STORAGE_THRESHOLD_VERSION ||
      !tokenMutation.sourceBackend ||
      !tokenMutation.targetBackend ||
      !tokenMutation.fixedR2Key
    ) {
      conflicts.push(conflictFor(mutation, "token-invalid", null));
      continue;
    }

    const [currentAsset, storage] = await Promise.all([
      deps.repo.getAssetHead(spaceId, requestEpoch, mutation.assetType, mutation.assetId),
      deps.repo.getAssetStorage(spaceId, mutation.assetType, mutation.assetId),
    ]);
    const casConflict = validateAssetCas(mutation, currentAsset);
    if (casConflict) {
      conflicts.push(casConflict);
      continue;
    }
    const currentBackend: StorageBackend = storage?.activeBackend ?? "d1";
    const routedBackend = selectStorageBackend(
      tokenMutation.sourceBackend,
      mutation.blobByteSize,
      config.r2EnterThresholdBytes,
      config.d1ReturnThresholdBytes,
    );
    if (
      currentBackend !== tokenMutation.sourceBackend ||
      routedBackend !== tokenMutation.targetBackend ||
      tokenMutation.fixedR2Key !== deriveFixedR2Key(spaceId, mutation.assetType, mutation.assetId)
    ) {
      conflicts.push(conflictFor(mutation, "concurrent-commit-conflict", currentAsset));
      continue;
    }

    commitMutations.push({
      clientMutationId: mutation.clientMutationId,
      assetType: mutation.assetType,
      assetId: mutation.assetId,
      kind: "full",
      baseContentHash: mutation.baseContentHash,
      targetContentHash: mutation.blobHash,
      blobHash: mutation.blobHash,
      byteSize: mutation.blobByteSize,
      encoding: mutation.encoding,
      revision: (currentAsset?.revision ?? 0) + 1,
      schemaVersion: mutation.schemaVersion,
      minReadableSchemaVersion: mutation.schemaVersion,
      writerAppVersion: mutation.writerAppVersion,
      writerBuildId: mutation.writerBuildId,
      storageMode: mutation.storageMode,
      baseFullBlobHash: mutation.blobHash,
      deltaDepth: 0,
      contentHash: mutation.blobHash,
      sourceBackend: tokenMutation.sourceBackend,
      targetBackend: tokenMutation.targetBackend,
      fixedR2Key: tokenMutation.fixedR2Key,
      uploadSessionId: tokenMutation.uploadSessionId ?? null,
    });
  }
  if (conflicts.length > 0) return { status: "conflict", conflicts };

  const input: TieredCommitInput = {
    commitId: token.commitId!,
    spaceId,
    epoch: requestEpoch,
    expectedHead: token.observedHead,
    newHead: token.observedHead + 1,
    mutations: commitMutations,
    committedAt: deps.presentTime,
    retentionHeadWindow: config.retentionHeadWindow,
  };

  try {
    let applied: AppliedVersionResult[];
    if (!commitMutations.some((mutation) =>
      mutation.targetBackend === "r2" && mutation.uploadSessionId !== null
    )) {
      applied = await deps.repo.commitPureD1Batch(input);
    } else {
      await deps.repo.reserveTieredCommit(input);
      applied = await recoverPendingCommit(spaceId, deps) ?? [];
    }
    return {
      status: "committed",
      applied,
      head: input.newHead,
      serverTime: deps.presentTime,
    };
  } catch (error) {
    if (!isDatabaseConflict(error)) throw error;
    return {
      status: "conflict",
      conflicts: mutations.map((mutation) =>
        conflictFor(mutation, "concurrent-commit-conflict", null)
      ),
    };
  }
}

async function signCurrentAssetDownload(
  spaceId: string,
  epoch: string,
  asset: {
    assetType: string;
    assetId: string;
    revision: number;
    blobHash: string;
    byteSize: number;
    encoding: string;
    backend: StorageBackend;
  },
  secret: string,
  publicBaseUrl: string,
): Promise<string> {
  const ticket = await signCapabilityToken({
    kind: "download",
    spaceId,
    epoch,
    assetType: asset.assetType,
    assetId: asset.assetId,
    blobHash: asset.blobHash,
    byteSize: asset.byteSize,
    encoding: asset.encoding,
    backend: asset.backend,
    revision: asset.revision,
    expiresAt: Date.now() + 5 * 60_000,
  }, secret);
  return buildBlobCapabilityUrl(publicBaseUrl, spaceId, epoch, asset.blobHash, ticket);
}

export async function handlePlan(
  spaceId: string,
  assetTypes: string[],
  deps: HandlePlanDeps,
): Promise<PlanResponse | null> {
  const space = await deps.repo.getSpaceHead(spaceId);
  if (!space) return null;
  if (space.pendingCommitId) {
    throw new StorageProtocolError(503, "commit_in_progress", "空间正在恢复提交，请稍后重试");
  }
  const rows = await deps.repo.listAssetHeads(
    spaceId,
    space.activeEpoch,
    assetTypes.length > 0 ? assetTypes : undefined,
  );
  const moduleMap = new Map<string, AssetSummary[]>();
  for (const row of rows) {
    if (!row.blobHash) continue;
    const downloadUrl = await signCurrentAssetDownload(
      spaceId,
      space.activeEpoch,
      row,
      deps.commitTokenSecret,
      deps.publicBaseUrl,
    );
    const summary: AssetSummary = {
      assetType: row.assetType,
      assetId: row.assetId,
      revision: row.revision,
      contentHash: row.contentHash,
      schemaVersion: row.schemaVersion,
      storageMode: row.storageMode,
      blobHash: row.blobHash,
      byteSize: row.byteSize,
      encoding: row.encoding,
      backend: row.backend,
      downloadUrl,
      deletedAt: row.deletedAt,
    };
    const moduleAssets = moduleMap.get(row.assetType) ?? [];
    moduleAssets.push(summary);
    moduleMap.set(row.assetType, moduleAssets);
  }
  return {
    head: space.head,
    epoch: space.activeEpoch,
    snapshotHead: space.head,
    modules: Array.from(moduleMap, ([moduleType, assets]) => ({ moduleType, assets })),
    capabilities: deps.capabilities,
    nextPageToken: null,
    minRetainedHead: space.minRetainedHead,
    serverTime: new Date().toISOString(),
  };
}

export async function handleDownloadsSign(
  spaceId: string,
  blobHashes: string[],
  deps: HandleDownloadsSignDeps,
): Promise<DownloadsSignResponse | null> {
  const space = await deps.repo.getSpaceHead(spaceId);
  if (!space) return null;
  if (space.pendingCommitId) {
    throw new StorageProtocolError(503, "commit_in_progress", "空间正在恢复提交，请稍后重试");
  }
  const urls: DownloadsSignResponse["urls"] = [];
  for (const blobHash of blobHashes) {
    if (!/^[0-9a-f]{64}$/.test(blobHash)) {
      throw new StorageProtocolError(400, "bad_request", "blobHashes 必须是 64 字符小写 SHA-256");
    }
    const storage = await deps.repo.findAssetStorageByCurrentHash(
      spaceId,
      space.activeEpoch,
      blobHash,
    );
    if (!storage) {
      throw new StorageProtocolError(404, "stale_blob", `blobHash ${blobHash} 不是空间当前资产`);
    }
    const asset = await deps.repo.getAssetHead(
      spaceId,
      space.activeEpoch,
      storage.assetType,
      storage.assetId,
    );
    if (!asset || asset.contentHash !== blobHash) {
      throw new StorageProtocolError(410, "stale_blob", `blobHash ${blobHash} 已过期`);
    }
    urls.push({
      blobHash,
      assetType: storage.assetType,
      assetId: storage.assetId,
      revision: asset.revision,
      url: await signCurrentAssetDownload(
        spaceId,
        space.activeEpoch,
        {
          assetType: storage.assetType,
          assetId: storage.assetId,
          revision: asset.revision,
          blobHash,
          byteSize: storage.currentByteSize,
          encoding: storage.currentEncoding,
          backend: storage.activeBackend,
        },
        deps.commitTokenSecret,
        deps.publicBaseUrl,
      ),
    });
  }
  return { urls };
}

export async function handlePayloadDownload(
  path: { spaceId: string; epoch: string; prefix: string; blobHash: string },
  ticket: string,
  deps: HandlePayloadDownloadDeps,
): Promise<DownloadPayloadResult> {
  const verified = await verifyCapabilityToken(ticket, deps.commitTokenSecret);
  if (!verified.ok || verified.payload.kind !== "download") {
    throw new StorageProtocolError(401, verified.ok ? "token_invalid" : verified.code, "下载票据无效或已过期");
  }
  const payload = verified.payload;
  if (
    payload.spaceId !== path.spaceId ||
    payload.epoch !== path.epoch ||
    payload.blobHash !== path.blobHash ||
    path.prefix !== path.blobHash.substring(0, 2)
  ) {
    throw new StorageProtocolError(403, "token_scope_mismatch", "下载票据与请求路径不匹配");
  }

  const [space, asset, storage] = await Promise.all([
    deps.repo.getSpaceHead(path.spaceId),
    deps.repo.getAssetHead(path.spaceId, path.epoch, payload.assetType, payload.assetId),
    deps.repo.getAssetStorage(path.spaceId, payload.assetType, payload.assetId),
  ]);
  if (!space || space.activeEpoch !== path.epoch) {
    throw new StorageProtocolError(409, "space_epoch_changed", "同步空间 epoch 已变化");
  }
  if (space.pendingCommitId) {
    throw new StorageProtocolError(503, "commit_in_progress", "空间正在恢复提交，请稍后重试");
  }
  if (
    !asset ||
    !storage ||
    storage.storageState !== "stable" ||
    asset.revision !== payload.revision ||
    asset.contentHash !== payload.blobHash ||
    storage.currentBlobHash !== payload.blobHash ||
    storage.currentByteSize !== payload.byteSize ||
    storage.currentEncoding !== payload.encoding ||
    storage.activeBackend !== payload.backend
  ) {
    throw new StorageProtocolError(410, "stale_blob", "下载票据对应的资产版本已过期，请重新 plan");
  }

  let body: BodyInit;
  if (storage.activeBackend === "d1") {
    if (storage.d1Content === null) {
      throw new StorageProtocolError(500, "storage_invariant_broken", "D1 当前内容缺失");
    }
    body = storage.d1Content;
  } else {
    const object = await deps.r2Bucket.get(storage.r2Key);
    if (!object || object.size !== storage.currentByteSize) {
      throw new StorageProtocolError(503, "r2_object_unavailable", "R2 当前文件缺失或大小不一致");
    }
    body = object.body;
  }

  const headers = new Headers({
    "Content-Type": "application/octet-stream",
    "Content-Length": String(storage.currentByteSize),
    "Cache-Control": "private, no-store",
    "ETag": `"sha256-${storage.currentBlobHash}"`,
    "X-Content-SHA256": storage.currentBlobHash,
    "X-Storage-Backend": storage.activeBackend,
  });
  return { body, headers };
}

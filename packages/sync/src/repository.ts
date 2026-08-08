// D1 持久化层 — 数据库操作
//
// 职责：封装 D1 CRUD，不决定业务策略。

import type { RemoteAssetHead, StorageBackend, SyncSpace } from "./model";

// ============================================================================
// 数据库行类型（与 D1 表结构对应）
// ============================================================================

export interface SpaceRow {
  spaceId: string;
  activeEpoch: string;
  head: number;
  minRetainedHead: number;
  updatedAt: string;
  pendingCommitId?: string | null;
}

export interface AssetStorageRow {
  spaceId: string;
  assetType: string;
  assetId: string;
  activeEpoch: string;
  activeBackend: StorageBackend;
  storageState: "stable" | "committing" | "deleting";
  currentBlobHash: string;
  currentByteSize: number;
  currentEncoding: string;
  d1Content: ArrayBuffer | null;
  d1BlobHash: string | null;
  d1ByteSize: number | null;
  d1Encoding: string | null;
  r2Key: string;
  r2Present: boolean;
  r2BlobHash: string | null;
  r2ByteSize: number | null;
  r2Encoding: string | null;
  r2Version: string | null;
  pendingCommitId: string | null;
  updatedAt: string;
}

export interface UploadSessionRow {
  sessionId: string;
  spaceId: string;
  epoch: string;
  assetType: string;
  assetId: string;
  sourceBackend: StorageBackend;
  targetBackend: StorageBackend;
  objectKey: string;
  blobHash: string;
  byteSize: number;
  encoding: string;
  r2MultipartUploadId: string | null;
  partEtag: string | null;
  d1Content: ArrayBuffer | null;
  state: "issued" | "uploading" | "uploaded" | "reserved" | "aborted";
  leaseExpiresAt: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface CommitIntentRow {
  commitId: string;
  spaceId: string;
  epoch: string;
  expectedHead: number;
  newHead: number;
  payloadJson: string;
  state: "reserved" | "r2_writing" | "finalizing" | "complete";
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeleteIntentRow {
  deleteId: string;
  spaceId: string;
  epoch: string;
  assetType: string;
  assetId: string;
  expectedHead: number;
  expectedRevision: number;
  r2Key: string;
  multipartUploadId: string | null;
  payloadJson: string;
  state: "reserved" | "r2_deleting" | "complete";
  createdAt: string;
  updatedAt: string;
}

export interface AssetHeadRow {
  spaceId: string;
  epoch: string;
  assetType: string;
  assetId: string;
  revision: number;
  currentHead: number;
  contentHash: string | null;
  deletedAt: string | null;
  schemaVersion: number;
  minReadableSchemaVersion: number;
  writerAppVersion: string;
  writerBuildId: string;
  committedAt: string;
  storageMode: string | null;
  baseFullBlobHash: string | null;
  deltaDepth: number;
}

export interface MutationResultRow {
  spaceId: string;
  epoch: string;
  clientMutationId: string;
  assetType: string;
  assetId: string;
  appliedRevision: number;
  appliedHead: number;
  contentHash: string | null;
  createdAt: string;
}

// commitBatch 输入 — 每条 mutation 的版本和 blob 信息
export interface CommitVersionInput {
  clientMutationId: string;
  assetType: string;
  assetId: string;
  kind: string; // 'full' | 'delta'
  baseContentHash: string | null;
  targetContentHash: string;
  blobHash: string;
  byteSize: number;
  encoding: string;
  revision: number; // 新 revision（当前 revision + 1）
  schemaVersion: number;
  minReadableSchemaVersion: number;
  writerAppVersion: string;
  writerBuildId: string;
  storageMode: string | null;
  baseFullBlobHash: string | null;
  deltaDepth: number;
  contentHash: string;
}

// commitBatch 输出
export interface AppliedVersionResult {
  clientMutationId: string;
  assetType: string;
  assetId: string;
  revision: number;
  contentHash: string;
}

export interface TieredCommitMutation extends CommitVersionInput {
  sourceBackend: StorageBackend;
  targetBackend: StorageBackend;
  fixedR2Key: string;
  uploadSessionId: string | null;
}

export interface TieredCommitInput {
  commitId: string;
  spaceId: string;
  epoch: string;
  expectedHead: number;
  newHead: number;
  mutations: TieredCommitMutation[];
  committedAt: string;
  retentionHeadWindow: number;
}

export interface AssetDeleteInput {
  deleteId: string;
  spaceId: string;
  epoch: string;
  assetType: string;
  assetId: string;
  expectedHead: number;
  expectedRevision: number;
  expectedContentHash: string | null;
  r2Key: string;
  deletedAt: string;
  retentionHeadWindow: number;
}

export interface AssetDeleteResult {
  revision: number;
  head: number;
  deletedAt: string;
}

// listAssetHeads 返回 — 包含 blob 信息（JOIN sync_asset_versions）
export interface AssetHeadWithBlob {
  assetType: string;
  assetId: string;
  revision: number;
  contentHash: string | null;
  schemaVersion: number;
  storageMode: string | null;
  deletedAt: string | null;
  blobHash: string;
  byteSize: number;
  encoding: string;
  backend: StorageBackend;
}

// sync_module_heads 行类型
export interface ModuleHeadRow {
  spaceId: string;
  moduleType: string;
  head: number;
  updatedAt: string;
}

// sync_changes 行类型
export interface ChangeRow {
  spaceId: string;
  head: number;
  assetType: string;
  assetId: string;
  revision: number;
  kind: string;
  createdAt: string;
}

// ============================================================================
// Repository 接口
// ============================================================================

export interface SyncRepository {
  // Space
  insertSpace(space: SpaceRow): Promise<void>;
  getSpaceHead(spaceId: string): Promise<SpaceRow | null>;
  resetSpace(spaceId: string, newEpoch: string, previousEpoch: string): Promise<{ previousEpoch: string; newEpoch: string } | null>;

  // Asset
  upsertAssetHead(asset: AssetHeadRow): Promise<void>;
  getAssetHead(
    spaceId: string,
    epoch: string,
    assetType: string,
    assetId: string,
  ): Promise<AssetHeadRow | null>;
  getAssetStorage(
    spaceId: string,
    assetType: string,
    assetId: string,
  ): Promise<AssetStorageRow | null>;
  findAssetStorageByCurrentHash(
    spaceId: string,
    epoch: string,
    blobHash: string,
  ): Promise<AssetStorageRow | null>;
  listAssetHeads(
    spaceId: string,
    epoch: string,
    assetTypes?: string[],
  ): Promise<AssetHeadWithBlob[]>;

  /** 查询 current_head > sinceHead 的资产（check 用） */
  listChangedAssetHeads(
    spaceId: string,
    epoch: string,
    sinceHead: number,
  ): Promise<AssetHeadWithBlob[]>;

  // Idempotency
  getMutationResult(
    spaceId: string,
    epoch: string,
    clientMutationId: string,
  ): Promise<MutationResultRow | null>;
  insertMutationResult(result: MutationResultRow): Promise<void>;

  // Latest-state uploads
  getUploadSession(sessionId: string): Promise<UploadSessionRow | null>;
  getUploadSessionForAsset(
    spaceId: string,
    assetType: string,
    assetId: string,
  ): Promise<UploadSessionRow | null>;
  createUploadSession(session: UploadSessionRow): Promise<void>;
  deleteUploadSession(sessionId: string): Promise<void>;
  claimUploadSession(
    sessionId: string,
    claimedAt: string,
    leaseExpiresAt: string,
  ): Promise<boolean>;
  releaseUploadSession(sessionId: string, updatedAt: string): Promise<void>;
  setUploadMultipartId(
    sessionId: string,
    uploadId: string,
    updatedAt: string,
  ): Promise<void>;
  markD1UploadReady(
    sessionId: string,
    content: ArrayBuffer,
    updatedAt: string,
  ): Promise<void>;
  markR2UploadReady(
    sessionId: string,
    partEtag: string,
    updatedAt: string,
  ): Promise<void>;

  // Latest-state atomic commit and recovery
  commitPureD1Batch(input: TieredCommitInput): Promise<AppliedVersionResult[]>;
  reserveTieredCommit(input: TieredCommitInput): Promise<void>;
  getCommitIntent(commitId: string): Promise<CommitIntentRow | null>;
  getPendingCommitIntent(spaceId: string): Promise<CommitIntentRow | null>;
  markCommitIntentState(
    commitId: string,
    state: CommitIntentRow["state"],
    updatedAt: string,
    lastError?: string | null,
  ): Promise<void>;
  finalizeTieredCommit(
    input: TieredCommitInput,
    r2Versions: Record<string, string>,
  ): Promise<AppliedVersionResult[]>;

  // Latest-state asset deletion and recovery
  reserveAssetDelete(input: AssetDeleteInput): Promise<void>;
  getPendingDeleteIntent(spaceId: string): Promise<DeleteIntentRow | null>;
  markDeleteIntentState(
    deleteId: string,
    state: DeleteIntentRow["state"],
    updatedAt: string,
  ): Promise<void>;
  finalizeAssetDelete(input: AssetDeleteInput): Promise<AssetDeleteResult>;

  // Atomic batch commit
  commitBatch(
    spaceId: string,
    epoch: string,
    newHead: number,
    versions: CommitVersionInput[],
    blobHashes: string[],
    blobR2Keys: string[],
    committedAt: string,
  ): Promise<AppliedVersionResult[]>;

  // Module Heads
  getModuleHeads(spaceId: string): Promise<ModuleHeadRow[]>;

  // Changes
  listChanges(spaceId: string, sinceHead: number): Promise<ChangeRow[]>;

  // Health
  checkDbHealth(): Promise<{ ok: boolean }>;
}

// ============================================================================
// 实现
// ============================================================================

function rowToSpaceHead(row: Record<string, unknown>): SpaceRow {
  return {
    spaceId: row.space_id as string,
    activeEpoch: row.active_epoch as string,
    head: row.head as number,
    minRetainedHead: row.min_retained_head as number,
    updatedAt: row.updated_at as string,
    pendingCommitId: (row.pending_commit_id as string | null | undefined) ?? null,
  };
}

function rowToAssetStorage(row: Record<string, unknown>): AssetStorageRow {
  const rawD1Content = row.d1_content;
  const d1Content = rawD1Content === null || rawD1Content === undefined
    ? null
    : rawD1Content instanceof ArrayBuffer
      ? rawD1Content
      : ArrayBuffer.isView(rawD1Content)
        ? new Uint8Array(
          rawD1Content.buffer,
          rawD1Content.byteOffset,
          rawD1Content.byteLength,
        ).slice().buffer
        : Array.isArray(rawD1Content)
          ? Uint8Array.from(rawD1Content as number[]).buffer
          : null;
  return {
    spaceId: row.space_id as string,
    assetType: row.asset_type as string,
    assetId: row.asset_id as string,
    activeEpoch: row.active_epoch as string,
    activeBackend: row.active_backend as StorageBackend,
    storageState: row.storage_state as AssetStorageRow["storageState"],
    currentBlobHash: row.current_blob_hash as string,
    currentByteSize: row.current_byte_size as number,
    currentEncoding: row.current_encoding as string,
    d1Content,
    d1BlobHash: (row.d1_blob_hash as string | null) ?? null,
    d1ByteSize: (row.d1_byte_size as number | null) ?? null,
    d1Encoding: (row.d1_encoding as string | null) ?? null,
    r2Key: row.r2_key as string,
    r2Present: row.r2_present === 1 || row.r2_present === true,
    r2BlobHash: (row.r2_blob_hash as string | null) ?? null,
    r2ByteSize: (row.r2_byte_size as number | null) ?? null,
    r2Encoding: (row.r2_encoding as string | null) ?? null,
    r2Version: (row.r2_version as string | null) ?? null,
    pendingCommitId: (row.pending_commit_id as string | null) ?? null,
    updatedAt: row.updated_at as string,
  };
}

function rowToUploadSession(row: Record<string, unknown>): UploadSessionRow {
  const rawD1Content = row.d1_content;
  const d1Content = rawD1Content === null || rawD1Content === undefined
    ? null
    : rawD1Content instanceof ArrayBuffer
      ? rawD1Content
      : ArrayBuffer.isView(rawD1Content)
        ? new Uint8Array(
          rawD1Content.buffer,
          rawD1Content.byteOffset,
          rawD1Content.byteLength,
        ).slice().buffer
        : Array.isArray(rawD1Content)
          ? Uint8Array.from(rawD1Content as number[]).buffer
          : null;
  return {
    sessionId: row.session_id as string,
    spaceId: row.space_id as string,
    epoch: row.epoch as string,
    assetType: row.asset_type as string,
    assetId: row.asset_id as string,
    sourceBackend: row.source_backend as StorageBackend,
    targetBackend: row.target_backend as StorageBackend,
    objectKey: row.object_key as string,
    blobHash: row.blob_hash as string,
    byteSize: row.byte_size as number,
    encoding: row.encoding as string,
    r2MultipartUploadId: (row.r2_multipart_upload_id as string | null) ?? null,
    partEtag: (row.part_etag as string | null) ?? null,
    d1Content,
    state: row.state as UploadSessionRow["state"],
    leaseExpiresAt: (row.lease_expires_at as string | null) ?? null,
    expiresAt: row.expires_at as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function rowToCommitIntent(row: Record<string, unknown>): CommitIntentRow {
  return {
    commitId: row.commit_id as string,
    spaceId: row.space_id as string,
    epoch: row.epoch as string,
    expectedHead: row.expected_head as number,
    newHead: row.new_head as number,
    payloadJson: row.payload_json as string,
    state: row.state as CommitIntentRow["state"],
    lastError: (row.last_error as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function rowToDeleteIntent(row: Record<string, unknown>): DeleteIntentRow {
  return {
    deleteId: row.delete_id as string,
    spaceId: row.space_id as string,
    epoch: row.epoch as string,
    assetType: row.asset_type as string,
    assetId: row.asset_id as string,
    expectedHead: row.expected_head as number,
    expectedRevision: row.expected_revision as number,
    r2Key: row.r2_key as string,
    multipartUploadId: (row.multipart_upload_id as string | null) ?? null,
    payloadJson: row.payload_json as string,
    state: row.state as DeleteIntentRow["state"],
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function appendTieredCommitGuards(
  db: D1Database,
  statements: D1PreparedStatement[],
  input: TieredCommitInput,
): void {
  statements.push(
    db.prepare(
      `INSERT INTO sync_commit_guards (commit_id, guard_key, ok)
       SELECT ?1, 'space', CASE WHEN EXISTS (
         SELECT 1 FROM sync_spaces
         WHERE space_id = ?2 AND active_epoch = ?3 AND head = ?4
           AND pending_commit_id IS NULL
       ) THEN 1 ELSE 0 END`,
    ).bind(input.commitId, input.spaceId, input.epoch, input.expectedHead),
  );

  for (const mutation of input.mutations) {
    const guardKey = `asset:${mutation.assetType}:${mutation.assetId}`;
    if (mutation.baseContentHash === null && mutation.revision === 1) {
      statements.push(
        db.prepare(
          `INSERT INTO sync_commit_guards (commit_id, guard_key, ok)
           SELECT ?1, ?2, CASE WHEN
             NOT EXISTS (
               SELECT 1 FROM sync_assets
               WHERE space_id = ?3 AND epoch = ?4
                 AND asset_type = ?5 AND asset_id = ?6
             )
             AND NOT EXISTS (
               SELECT 1 FROM sync_asset_storage
               WHERE space_id = ?3 AND asset_type = ?5 AND asset_id = ?6
             )
           THEN 1 ELSE 0 END`,
        ).bind(
          input.commitId,
          guardKey,
          input.spaceId,
          input.epoch,
          mutation.assetType,
          mutation.assetId,
        ),
      );
    } else {
      statements.push(
        db.prepare(
          `INSERT INTO sync_commit_guards (commit_id, guard_key, ok)
           SELECT ?1, ?2, CASE WHEN EXISTS (
             SELECT 1
             FROM sync_assets a
             JOIN sync_asset_storage s
               ON s.space_id = a.space_id
              AND s.asset_type = a.asset_type
              AND s.asset_id = a.asset_id
             WHERE a.space_id = ?3 AND a.epoch = ?4
               AND a.asset_type = ?5 AND a.asset_id = ?6
               AND a.revision = ?7
               AND (?8 IS NULL OR a.content_hash = ?8)
               AND s.active_epoch = ?4
               AND s.active_backend = ?9
               AND s.storage_state = 'stable'
               AND s.r2_key = ?10
           ) THEN 1 ELSE 0 END`,
        ).bind(
          input.commitId,
          guardKey,
          input.spaceId,
          input.epoch,
          mutation.assetType,
          mutation.assetId,
          mutation.revision - 1,
          mutation.baseContentHash,
          mutation.sourceBackend,
          mutation.fixedR2Key,
        ),
      );
    }

    const payloadGuardKey = `payload:${mutation.assetType}:${mutation.assetId}`;
    if (mutation.uploadSessionId) {
      statements.push(
        db.prepare(
          `INSERT INTO sync_commit_guards (commit_id, guard_key, ok)
           SELECT ?1, ?2, CASE WHEN EXISTS (
             SELECT 1 FROM sync_upload_sessions
             WHERE session_id = ?3 AND space_id = ?4 AND epoch = ?5
               AND asset_type = ?6 AND asset_id = ?7
               AND source_backend = ?8 AND target_backend = ?9
               AND object_key = ?10 AND blob_hash = ?11
               AND byte_size = ?12 AND encoding = ?13 AND state = 'uploaded'
           ) THEN 1 ELSE 0 END`,
        ).bind(
          input.commitId,
          payloadGuardKey,
          mutation.uploadSessionId,
          input.spaceId,
          input.epoch,
          mutation.assetType,
          mutation.assetId,
          mutation.sourceBackend,
          mutation.targetBackend,
          mutation.fixedR2Key,
          mutation.blobHash,
          mutation.byteSize,
          mutation.encoding,
        ),
      );
    } else {
      const targetCondition = mutation.targetBackend === "d1"
        ? "d1_blob_hash = ?7 AND d1_byte_size = ?8 AND d1_encoding = ?9 AND d1_content IS NOT NULL"
        : "r2_present = 1 AND r2_blob_hash = ?7 AND r2_byte_size = ?8 AND r2_encoding = ?9";
      statements.push(
        db.prepare(
          `INSERT INTO sync_commit_guards (commit_id, guard_key, ok)
           SELECT ?1, ?2, CASE WHEN EXISTS (
             SELECT 1 FROM sync_asset_storage
             WHERE space_id = ?3 AND asset_type = ?4 AND asset_id = ?5
               AND r2_key = ?6 AND ${targetCondition}
           ) THEN 1 ELSE 0 END`,
        ).bind(
          input.commitId,
          payloadGuardKey,
          input.spaceId,
          mutation.assetType,
          mutation.assetId,
          mutation.fixedR2Key,
          mutation.blobHash,
          mutation.byteSize,
          mutation.encoding,
        ),
      );
    }
  }
}

function appendStoragePublishStatements(
  db: D1Database,
  statements: D1PreparedStatement[],
  input: TieredCommitInput,
  r2Versions: Record<string, string>,
): void {
  for (const mutation of input.mutations) {
    if (mutation.targetBackend === "d1" && mutation.uploadSessionId) {
      statements.push(
        db.prepare(
          `INSERT INTO sync_asset_storage
             (space_id, asset_type, asset_id, active_epoch, active_backend,
              storage_state, current_blob_hash, current_byte_size, current_encoding,
              d1_content, d1_blob_hash, d1_byte_size, d1_encoding,
              r2_key, r2_present, r2_blob_hash, r2_byte_size, r2_encoding,
              r2_version, pending_commit_id, updated_at)
           SELECT ?1, ?2, ?3, ?4, 'd1', 'stable', ?5, ?6, ?7,
                  d1_content, ?5, ?6, ?7, ?8, 0, NULL, NULL, NULL, NULL, NULL, ?9
           FROM sync_upload_sessions WHERE session_id = ?10
           ON CONFLICT(space_id, asset_type, asset_id) DO UPDATE SET
             active_epoch = excluded.active_epoch,
             active_backend = 'd1', storage_state = 'stable',
             current_blob_hash = excluded.current_blob_hash,
             current_byte_size = excluded.current_byte_size,
             current_encoding = excluded.current_encoding,
             d1_content = excluded.d1_content,
             d1_blob_hash = excluded.d1_blob_hash,
             d1_byte_size = excluded.d1_byte_size,
             d1_encoding = excluded.d1_encoding,
             pending_commit_id = NULL, updated_at = excluded.updated_at`,
        ).bind(
          input.spaceId,
          mutation.assetType,
          mutation.assetId,
          input.epoch,
          mutation.blobHash,
          mutation.byteSize,
          mutation.encoding,
          mutation.fixedR2Key,
          input.committedAt,
          mutation.uploadSessionId,
        ),
      );
    } else if (mutation.targetBackend === "d1") {
      statements.push(
        db.prepare(
          `UPDATE sync_asset_storage
           SET active_epoch = ?4, active_backend = 'd1', storage_state = 'stable',
               current_blob_hash = d1_blob_hash,
               current_byte_size = d1_byte_size,
               current_encoding = d1_encoding,
               pending_commit_id = NULL, updated_at = ?5
           WHERE space_id = ?1 AND asset_type = ?2 AND asset_id = ?3`,
        ).bind(
          input.spaceId,
          mutation.assetType,
          mutation.assetId,
          input.epoch,
          input.committedAt,
        ),
      );
    } else if (mutation.uploadSessionId) {
      statements.push(
        db.prepare(
          `INSERT INTO sync_asset_storage
             (space_id, asset_type, asset_id, active_epoch, active_backend,
              storage_state, current_blob_hash, current_byte_size, current_encoding,
              d1_content, d1_blob_hash, d1_byte_size, d1_encoding,
              r2_key, r2_present, r2_blob_hash, r2_byte_size, r2_encoding,
              r2_version, pending_commit_id, updated_at)
           VALUES (?1,?2,?3,?4,'r2','stable',?5,?6,?7,
                   NULL,NULL,NULL,NULL,?8,1,?5,?6,?7,?9,NULL,?10)
           ON CONFLICT(space_id, asset_type, asset_id) DO UPDATE SET
             active_epoch = excluded.active_epoch,
             active_backend = 'r2', storage_state = 'stable',
             current_blob_hash = excluded.current_blob_hash,
             current_byte_size = excluded.current_byte_size,
             current_encoding = excluded.current_encoding,
             r2_key = excluded.r2_key, r2_present = 1,
             r2_blob_hash = excluded.r2_blob_hash,
             r2_byte_size = excluded.r2_byte_size,
             r2_encoding = excluded.r2_encoding,
             r2_version = excluded.r2_version,
             pending_commit_id = NULL, updated_at = excluded.updated_at`,
        ).bind(
          input.spaceId,
          mutation.assetType,
          mutation.assetId,
          input.epoch,
          mutation.blobHash,
          mutation.byteSize,
          mutation.encoding,
          mutation.fixedR2Key,
          r2Versions[mutation.uploadSessionId] ?? "",
          input.committedAt,
        ),
      );
    } else {
      statements.push(
        db.prepare(
          `UPDATE sync_asset_storage
           SET active_epoch = ?4, active_backend = 'r2', storage_state = 'stable',
               current_blob_hash = r2_blob_hash,
               current_byte_size = r2_byte_size,
               current_encoding = r2_encoding,
               pending_commit_id = NULL, updated_at = ?5
           WHERE space_id = ?1 AND asset_type = ?2 AND asset_id = ?3`,
        ).bind(
          input.spaceId,
          mutation.assetType,
          mutation.assetId,
          input.epoch,
          input.committedAt,
        ),
      );
    }
  }
}

function appendMetadataPublishStatements(
  db: D1Database,
  statements: D1PreparedStatement[],
  input: TieredCommitInput,
): void {
  for (const mutation of input.mutations) {
    statements.push(
      db.prepare(
        `INSERT INTO sync_assets
           (space_id, epoch, asset_type, asset_id, revision, current_head,
            content_hash, deleted_at, schema_version, min_readable_schema_version,
            writer_app_version, writer_build_id, committed_at, storage_mode,
            base_full_blob_hash, delta_depth)
         VALUES (?1,?2,?3,?4,?5,?6,?7,NULL,?8,?9,?10,?11,?12,?13,?14,0)
         ON CONFLICT(space_id, epoch, asset_type, asset_id) DO UPDATE SET
           revision = excluded.revision, current_head = excluded.current_head,
           content_hash = excluded.content_hash, deleted_at = NULL,
           schema_version = excluded.schema_version,
           min_readable_schema_version = excluded.min_readable_schema_version,
           writer_app_version = excluded.writer_app_version,
           writer_build_id = excluded.writer_build_id,
           committed_at = excluded.committed_at,
           storage_mode = excluded.storage_mode,
           base_full_blob_hash = excluded.base_full_blob_hash,
           delta_depth = 0`,
      ).bind(
        input.spaceId,
        input.epoch,
        mutation.assetType,
        mutation.assetId,
        mutation.revision,
        input.newHead,
        mutation.contentHash,
        mutation.schemaVersion,
        mutation.minReadableSchemaVersion,
        mutation.writerAppVersion,
        mutation.writerBuildId,
        input.committedAt,
        mutation.storageMode,
        mutation.blobHash,
      ),
    );

    statements.push(
      db.prepare(
        `INSERT INTO sync_changes
           (space_id, head, asset_type, asset_id, revision, kind, created_at)
         VALUES (?1,?2,?3,?4,?5,'upsert',?6)`,
      ).bind(
        input.spaceId,
        input.newHead,
        mutation.assetType,
        mutation.assetId,
        mutation.revision,
        input.committedAt,
      ),
    );

    statements.push(
      db.prepare(
        `INSERT INTO sync_mutation_results
           (space_id, epoch, client_mutation_id, asset_type, asset_id,
            applied_revision, applied_head, content_hash, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
      ).bind(
        input.spaceId,
        input.epoch,
        mutation.clientMutationId,
        mutation.assetType,
        mutation.assetId,
        mutation.revision,
        input.newHead,
        mutation.contentHash,
        input.committedAt,
      ),
    );
  }

  const moduleTypes = new Set(input.mutations.map((mutation) => mutation.assetType));
  for (const moduleType of moduleTypes) {
    statements.push(
      db.prepare(
        `INSERT INTO sync_module_heads (space_id, module_type, head, updated_at)
         VALUES (?1,?2,?3,?4)
         ON CONFLICT(space_id, module_type) DO UPDATE SET
           head = excluded.head, updated_at = excluded.updated_at`,
      ).bind(input.spaceId, moduleType, input.newHead, input.committedAt),
    );
  }

  const minRetainedHead = Math.max(0, input.newHead - input.retentionHeadWindow);
  statements.push(
    db.prepare(
      `UPDATE sync_spaces SET min_retained_head = ?2
       WHERE space_id = ?1`,
    ).bind(input.spaceId, minRetainedHead),
    db.prepare(
      `DELETE FROM sync_changes WHERE space_id = ?1 AND head < ?2`,
    ).bind(input.spaceId, minRetainedHead),
    db.prepare(
      `DELETE FROM sync_mutation_results
       WHERE space_id = ?1 AND applied_head < ?2`,
    ).bind(input.spaceId, minRetainedHead),
  );

  for (const mutation of input.mutations) {
    if (mutation.uploadSessionId) {
      statements.push(
        db.prepare("DELETE FROM sync_upload_sessions WHERE session_id = ?1")
          .bind(mutation.uploadSessionId),
      );
    }
  }
}

function rowToAssetHead(row: Record<string, unknown>): AssetHeadRow {
  return {
    spaceId: row.space_id as string,
    epoch: row.epoch as string,
    assetType: row.asset_type as string,
    assetId: row.asset_id as string,
    revision: row.revision as number,
    currentHead: row.current_head as number,
    contentHash: row.content_hash as string | null,
    deletedAt: row.deleted_at as string | null,
    schemaVersion: row.schema_version as number,
    minReadableSchemaVersion: row.min_readable_schema_version as number,
    writerAppVersion: row.writer_app_version as string,
    writerBuildId: row.writer_build_id as string,
    committedAt: row.committed_at as string,
    storageMode: row.storage_mode as string | null,
    baseFullBlobHash: row.base_full_blob_hash as string | null,
    deltaDepth: (row.delta_depth as number) ?? 0,
  };
}

function rowToMutationResult(row: Record<string, unknown>): MutationResultRow {
  return {
    spaceId: row.space_id as string,
    epoch: row.epoch as string,
    clientMutationId: row.client_mutation_id as string,
    assetType: row.asset_type as string,
    assetId: row.asset_id as string,
    appliedRevision: row.applied_revision as number,
    appliedHead: row.applied_head as number,
    contentHash: row.content_hash as string | null,
    createdAt: row.created_at as string,
  };
}

export function createRepository(db: D1Database): SyncRepository {
  return {
    // Space
    async insertSpace(space: SpaceRow): Promise<void> {
      await db
        .prepare(
          `INSERT INTO sync_spaces (space_id, active_epoch, head, min_retained_head, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5)`,
        )
        .bind(
          space.spaceId,
          space.activeEpoch,
          space.head,
          space.minRetainedHead,
          space.updatedAt,
        )
        .run();
    },

    async getSpaceHead(spaceId: string): Promise<SpaceRow | null> {
      const result = await db
        .prepare(
          `SELECT space_id, active_epoch, head, min_retained_head, updated_at,
                  pending_commit_id
           FROM sync_spaces WHERE space_id = ?1`,
        )
        .bind(spaceId)
        .first<Record<string, unknown>>();

      if (!result) return null;
      return rowToSpaceHead(result);
    },

    async resetSpace(
      spaceId: string,
      newEpoch: string,
      previousEpoch: string,
    ): Promise<{ previousEpoch: string; newEpoch: string } | null> {
      // 使用 previousEpoch 做 CAS，防止并发重置
      const result = await db
        .prepare(
          `UPDATE sync_spaces
           SET active_epoch = ?1, head = 0, updated_at = ?2
           WHERE space_id = ?3 AND active_epoch = ?4 AND pending_commit_id IS NULL`,
        )
        .bind(newEpoch, new Date().toISOString(), spaceId, previousEpoch)
        .run();

      if (result.meta?.changes === 0) return null;
      return { previousEpoch, newEpoch };
    },

    // Asset
    async upsertAssetHead(asset: AssetHeadRow): Promise<void> {
      await db
        .prepare(
          `INSERT INTO sync_assets
             (space_id, epoch, asset_type, asset_id, revision, current_head,
              content_hash, deleted_at, schema_version, min_readable_schema_version,
              writer_app_version, writer_build_id, committed_at, storage_mode,
              base_full_blob_hash, delta_depth)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)
           ON CONFLICT(space_id, epoch, asset_type, asset_id) DO UPDATE SET
             revision = excluded.revision,
             current_head = excluded.current_head,
             content_hash = excluded.content_hash,
             deleted_at = excluded.deleted_at,
             schema_version = excluded.schema_version,
             min_readable_schema_version = excluded.min_readable_schema_version,
             writer_app_version = excluded.writer_app_version,
             writer_build_id = excluded.writer_build_id,
             committed_at = excluded.committed_at,
             storage_mode = excluded.storage_mode,
             base_full_blob_hash = excluded.base_full_blob_hash,
             delta_depth = excluded.delta_depth`,
        )
        .bind(
          asset.spaceId,
          asset.epoch,
          asset.assetType,
          asset.assetId,
          asset.revision,
          asset.currentHead,
          asset.contentHash,
          asset.deletedAt,
          asset.schemaVersion,
          asset.minReadableSchemaVersion,
          asset.writerAppVersion,
          asset.writerBuildId,
          asset.committedAt,
          asset.storageMode,
          asset.baseFullBlobHash,
          asset.deltaDepth,
        )
        .run();
    },

    async getAssetHead(
      spaceId: string,
      epoch: string,
      assetType: string,
      assetId: string,
    ): Promise<AssetHeadRow | null> {
      const result = await db
        .prepare(
          `SELECT space_id, epoch, asset_type, asset_id, revision, current_head,
                  content_hash, deleted_at, schema_version, min_readable_schema_version,
                  writer_app_version, writer_build_id, committed_at, storage_mode,
                  base_full_blob_hash, delta_depth
           FROM sync_assets
           WHERE space_id = ?1 AND epoch = ?2 AND asset_type = ?3 AND asset_id = ?4`,
        )
        .bind(spaceId, epoch, assetType, assetId)
        .first<Record<string, unknown>>();

      if (!result) return null;
      return rowToAssetHead(result);
    },

    async getAssetStorage(
      spaceId: string,
      assetType: string,
      assetId: string,
    ): Promise<AssetStorageRow | null> {
      const result = await db
        .prepare(
          `SELECT * FROM sync_asset_storage
           WHERE space_id = ?1 AND asset_type = ?2 AND asset_id = ?3`,
        )
        .bind(spaceId, assetType, assetId)
        .first<Record<string, unknown>>();
      return result ? rowToAssetStorage(result) : null;
    },

    async findAssetStorageByCurrentHash(
      spaceId: string,
      epoch: string,
      blobHash: string,
    ): Promise<AssetStorageRow | null> {
      const result = await db
        .prepare(
          `SELECT * FROM sync_asset_storage
           WHERE space_id = ?1 AND active_epoch = ?2
             AND current_blob_hash = ?3 AND storage_state = 'stable'
           ORDER BY asset_type, asset_id
           LIMIT 1`,
        )
        .bind(spaceId, epoch, blobHash)
        .first<Record<string, unknown>>();
      return result ? rowToAssetStorage(result) : null;
    },

    async listAssetHeads(
      spaceId: string,
      epoch: string,
      assetTypes?: string[],
    ): Promise<AssetHeadWithBlob[]> {
      let sql = `
        SELECT
          a.asset_type, a.asset_id, a.revision, a.content_hash,
          a.schema_version, a.storage_mode, a.deleted_at,
          COALESCE(s.current_blob_hash, '') AS blob_hash,
          COALESCE(s.current_byte_size, 0) AS byte_size,
          COALESCE(s.current_encoding, 'identity') AS encoding,
          COALESCE(s.active_backend, 'd1') AS backend
        FROM sync_assets a
        LEFT JOIN sync_asset_storage s
          ON s.space_id = a.space_id
          AND s.active_epoch = a.epoch
          AND s.asset_type = a.asset_type
          AND s.asset_id = a.asset_id
          AND s.storage_state = 'stable'
        WHERE a.space_id = ?1 AND a.epoch = ?2
      `;
      const params: unknown[] = [spaceId, epoch];

      if (assetTypes && assetTypes.length > 0) {
        const placeholders = assetTypes.map(() => "?").join(",");
        sql += ` AND a.asset_type IN (${placeholders})`;
        params.push(...assetTypes);
      }

      sql += " ORDER BY a.asset_type, a.asset_id";

      const result = await db
        .prepare(sql)
        .bind(...params)
        .all<Record<string, unknown>>();

      if (!result.results) return [];

      return result.results.map((row) => ({
        assetType: row.asset_type as string,
        assetId: row.asset_id as string,
        revision: row.revision as number,
        contentHash: row.content_hash as string | null,
        schemaVersion: row.schema_version as number,
        storageMode: row.storage_mode as string | null,
        deletedAt: row.deleted_at as string | null,
        blobHash: row.blob_hash as string,
        byteSize: row.byte_size as number,
        encoding: row.encoding as string,
        backend: row.backend as StorageBackend,
      }));
    },

    async listChangedAssetHeads(
      spaceId: string,
      epoch: string,
      sinceHead: number,
    ): Promise<AssetHeadWithBlob[]> {
      const sql = `
        SELECT
          a.asset_type, a.asset_id, a.revision, a.content_hash,
          a.schema_version, a.storage_mode, a.deleted_at,
          COALESCE(s.current_blob_hash, '') AS blob_hash,
          COALESCE(s.current_byte_size, 0) AS byte_size,
          COALESCE(s.current_encoding, 'identity') AS encoding,
          COALESCE(s.active_backend, 'd1') AS backend
        FROM sync_assets a
        LEFT JOIN sync_asset_storage s
          ON s.space_id = a.space_id
          AND s.active_epoch = a.epoch
          AND s.asset_type = a.asset_type
          AND s.asset_id = a.asset_id
          AND s.storage_state = 'stable'
        WHERE a.space_id = ?1 AND a.epoch = ?2 AND a.current_head > ?3
        ORDER BY a.asset_type, a.asset_id
      `;

      const result = await db
        .prepare(sql)
        .bind(spaceId, epoch, sinceHead)
        .all<Record<string, unknown>>();

      if (!result.results) return [];

      return result.results.map((row) => ({
        assetType: row.asset_type as string,
        assetId: row.asset_id as string,
        revision: row.revision as number,
        contentHash: row.content_hash as string | null,
        schemaVersion: row.schema_version as number,
        storageMode: row.storage_mode as string | null,
        deletedAt: row.deleted_at as string | null,
        blobHash: row.blob_hash as string,
        byteSize: row.byte_size as number,
        encoding: row.encoding as string,
        backend: row.backend as StorageBackend,
      }));
    },

    // Idempotency
    async getMutationResult(
      spaceId: string,
      epoch: string,
      clientMutationId: string,
    ): Promise<MutationResultRow | null> {
      const result = await db
        .prepare(
          `SELECT space_id, epoch, client_mutation_id, asset_type, asset_id,
                  applied_revision, applied_head, content_hash, created_at
           FROM sync_mutation_results
           WHERE space_id = ?1 AND epoch = ?2 AND client_mutation_id = ?3`,
        )
        .bind(spaceId, epoch, clientMutationId)
        .first<Record<string, unknown>>();

      if (!result) return null;
      return rowToMutationResult(result);
    },

    async insertMutationResult(mr: MutationResultRow): Promise<void> {
      await db
        .prepare(
          `INSERT INTO sync_mutation_results
             (space_id, epoch, client_mutation_id, asset_type, asset_id,
              applied_revision, applied_head, content_hash, created_at)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
           ON CONFLICT(space_id, epoch, client_mutation_id) DO NOTHING`,
        )
        .bind(
          mr.spaceId,
          mr.epoch,
          mr.clientMutationId,
          mr.assetType,
          mr.assetId,
          mr.appliedRevision,
          mr.appliedHead,
          mr.contentHash,
          mr.createdAt,
        )
        .run();
    },

    // Latest-state uploads
    async getUploadSession(sessionId: string): Promise<UploadSessionRow | null> {
      const row = await db
        .prepare("SELECT * FROM sync_upload_sessions WHERE session_id = ?1")
        .bind(sessionId)
        .first<Record<string, unknown>>();
      return row ? rowToUploadSession(row) : null;
    },

    async getUploadSessionForAsset(
      spaceId: string,
      assetType: string,
      assetId: string,
    ): Promise<UploadSessionRow | null> {
      const row = await db
        .prepare(
          `SELECT * FROM sync_upload_sessions
           WHERE space_id = ?1 AND asset_type = ?2 AND asset_id = ?3`,
        )
        .bind(spaceId, assetType, assetId)
        .first<Record<string, unknown>>();
      return row ? rowToUploadSession(row) : null;
    },

    async createUploadSession(session: UploadSessionRow): Promise<void> {
      await db
        .prepare(
          `INSERT INTO sync_upload_sessions
             (session_id, space_id, epoch, asset_type, asset_id,
              source_backend, target_backend, object_key, blob_hash, byte_size,
              encoding, r2_multipart_upload_id, part_etag, d1_content, state,
              lease_expires_at, expires_at, created_at, updated_at)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)`,
        )
        .bind(
          session.sessionId,
          session.spaceId,
          session.epoch,
          session.assetType,
          session.assetId,
          session.sourceBackend,
          session.targetBackend,
          session.objectKey,
          session.blobHash,
          session.byteSize,
          session.encoding,
          session.r2MultipartUploadId,
          session.partEtag,
          session.d1Content,
          session.state,
          session.leaseExpiresAt,
          session.expiresAt,
          session.createdAt,
          session.updatedAt,
        )
        .run();
    },

    async deleteUploadSession(sessionId: string): Promise<void> {
      await db
        .prepare(
          `DELETE FROM sync_upload_sessions
           WHERE session_id = ?1 AND state != 'reserved'`,
        )
        .bind(sessionId)
        .run();
    },

    async claimUploadSession(
      sessionId: string,
      claimedAt: string,
      leaseExpiresAt: string,
    ): Promise<boolean> {
      const result = await db
        .prepare(
          `UPDATE sync_upload_sessions
           SET state = 'uploading', lease_expires_at = ?2, updated_at = ?1
           WHERE session_id = ?3
             AND (
               state = 'issued'
               OR (state = 'uploading' AND lease_expires_at < ?1)
             )`,
        )
        .bind(claimedAt, leaseExpiresAt, sessionId)
        .run();
      return (result.meta?.changes ?? 0) === 1;
    },

    async releaseUploadSession(sessionId: string, updatedAt: string): Promise<void> {
      await db
        .prepare(
          `UPDATE sync_upload_sessions
           SET state = 'issued', lease_expires_at = NULL, updated_at = ?2
           WHERE session_id = ?1 AND state = 'uploading'`,
        )
        .bind(sessionId, updatedAt)
        .run();
    },

    async setUploadMultipartId(
      sessionId: string,
      uploadId: string,
      updatedAt: string,
    ): Promise<void> {
      await db
        .prepare(
          `UPDATE sync_upload_sessions
           SET r2_multipart_upload_id = ?2, updated_at = ?3
           WHERE session_id = ?1 AND state = 'uploading'
             AND (r2_multipart_upload_id IS NULL OR r2_multipart_upload_id = ?2)`,
        )
        .bind(sessionId, uploadId, updatedAt)
        .run();
    },

    async markD1UploadReady(
      sessionId: string,
      content: ArrayBuffer,
      updatedAt: string,
    ): Promise<void> {
      await db
        .prepare(
          `UPDATE sync_upload_sessions
           SET d1_content = ?2, state = 'uploaded', lease_expires_at = NULL,
               updated_at = ?3
           WHERE session_id = ?1 AND state = 'uploading' AND target_backend = 'd1'`,
        )
        .bind(sessionId, new Uint8Array(content), updatedAt)
        .run();
    },

    async markR2UploadReady(
      sessionId: string,
      partEtag: string,
      updatedAt: string,
    ): Promise<void> {
      await db
        .prepare(
          `UPDATE sync_upload_sessions
           SET part_etag = ?2, state = 'uploaded', lease_expires_at = NULL,
               updated_at = ?3
           WHERE session_id = ?1 AND state = 'uploading' AND target_backend = 'r2'
             AND r2_multipart_upload_id IS NOT NULL`,
        )
        .bind(sessionId, partEtag, updatedAt)
        .run();
    },

    // Module Heads
    async getModuleHeads(spaceId: string): Promise<ModuleHeadRow[]> {
      const result = await db
        .prepare(
          `SELECT space_id, module_type, head, updated_at
           FROM sync_module_heads WHERE space_id = ?1`,
        )
        .bind(spaceId)
        .all<Record<string, unknown>>();

      if (!result.results) return [];
      return result.results.map((row) => ({
        spaceId: row.space_id as string,
        moduleType: row.module_type as string,
        head: row.head as number,
        updatedAt: row.updated_at as string,
      }));
    },

    // Changes
    async listChanges(
      spaceId: string,
      sinceHead: number,
    ): Promise<ChangeRow[]> {
      const result = await db
        .prepare(
          `SELECT space_id, head, asset_type, asset_id, revision, kind, created_at
           FROM sync_changes
           WHERE space_id = ?1 AND head > ?2
           ORDER BY head, asset_type, asset_id`,
        )
        .bind(spaceId, sinceHead)
        .all<Record<string, unknown>>();

      if (!result.results) return [];
      return result.results.map((row) => ({
        spaceId: row.space_id as string,
        head: row.head as number,
        assetType: row.asset_type as string,
        assetId: row.asset_id as string,
        revision: row.revision as number,
        kind: row.kind as string,
        createdAt: row.created_at as string,
      }));
    },

    // Health
    async checkDbHealth(): Promise<{ ok: boolean }> {
      try {
        const result = await db
          .prepare("SELECT 1 AS ok")
          .first<{ ok: number }>();
        return { ok: result?.ok === 1 };
      } catch {
        return { ok: false };
      }
    },

    async commitPureD1Batch(
      input: TieredCommitInput,
    ): Promise<AppliedVersionResult[]> {
      const statements: D1PreparedStatement[] = [];
      appendTieredCommitGuards(db, statements, input);
      appendStoragePublishStatements(db, statements, input, {});
      appendMetadataPublishStatements(db, statements, input);
      statements.push(
        db.prepare(
          `UPDATE sync_spaces
           SET head = ?2, updated_at = ?3
           WHERE space_id = ?1 AND head = ?4 AND pending_commit_id IS NULL`,
        ).bind(input.spaceId, input.newHead, input.committedAt, input.expectedHead),
        db.prepare("DELETE FROM sync_commit_guards WHERE commit_id = ?1")
          .bind(input.commitId),
      );
      await db.batch(statements);
      return input.mutations.map((mutation) => ({
        clientMutationId: mutation.clientMutationId,
        assetType: mutation.assetType,
        assetId: mutation.assetId,
        revision: mutation.revision,
        contentHash: mutation.contentHash,
      }));
    },

    async reserveTieredCommit(input: TieredCommitInput): Promise<void> {
      const statements: D1PreparedStatement[] = [];
      appendTieredCommitGuards(db, statements, input);
      statements.push(
        db.prepare(
          `INSERT INTO sync_commit_intents
             (commit_id, space_id, epoch, expected_head, new_head, payload_json,
              state, last_error, created_at, updated_at)
           VALUES (?1,?2,?3,?4,?5,?6,'reserved',NULL,?7,?7)`,
        ).bind(
          input.commitId,
          input.spaceId,
          input.epoch,
          input.expectedHead,
          input.newHead,
          JSON.stringify(input),
          input.committedAt,
        ),
        db.prepare(
          `UPDATE sync_spaces SET pending_commit_id = ?2, updated_at = ?3
           WHERE space_id = ?1 AND head = ?4 AND pending_commit_id IS NULL`,
        ).bind(input.spaceId, input.commitId, input.committedAt, input.expectedHead),
      );

      for (const mutation of input.mutations) {
        statements.push(
          db.prepare(
            `UPDATE sync_asset_storage
             SET storage_state = 'committing', pending_commit_id = ?4, updated_at = ?5
             WHERE space_id = ?1 AND asset_type = ?2 AND asset_id = ?3`,
          ).bind(
            input.spaceId,
            mutation.assetType,
            mutation.assetId,
            input.commitId,
            input.committedAt,
          ),
        );
        if (mutation.uploadSessionId) {
          statements.push(
            db.prepare(
              `UPDATE sync_upload_sessions SET state = 'reserved', updated_at = ?2
               WHERE session_id = ?1 AND state = 'uploaded'`,
            ).bind(mutation.uploadSessionId, input.committedAt),
          );
        }
      }
      statements.push(
        db.prepare("DELETE FROM sync_commit_guards WHERE commit_id = ?1")
          .bind(input.commitId),
      );
      await db.batch(statements);
    },

    async getCommitIntent(commitId: string): Promise<CommitIntentRow | null> {
      const row = await db
        .prepare("SELECT * FROM sync_commit_intents WHERE commit_id = ?1")
        .bind(commitId)
        .first<Record<string, unknown>>();
      return row ? rowToCommitIntent(row) : null;
    },

    async getPendingCommitIntent(spaceId: string): Promise<CommitIntentRow | null> {
      const row = await db
        .prepare(
          `SELECT i.* FROM sync_commit_intents i
           JOIN sync_spaces s ON s.pending_commit_id = i.commit_id
           WHERE s.space_id = ?1 AND i.state != 'complete'`,
        )
        .bind(spaceId)
        .first<Record<string, unknown>>();
      return row ? rowToCommitIntent(row) : null;
    },

    async markCommitIntentState(
      commitId: string,
      state: CommitIntentRow["state"],
      updatedAt: string,
      lastError: string | null = null,
    ): Promise<void> {
      await db
        .prepare(
          `UPDATE sync_commit_intents
           SET state = ?2, updated_at = ?3, last_error = ?4
           WHERE commit_id = ?1 AND state != 'complete'`,
        )
        .bind(commitId, state, updatedAt, lastError)
        .run();
    },

    async finalizeTieredCommit(
      input: TieredCommitInput,
      r2Versions: Record<string, string>,
    ): Promise<AppliedVersionResult[]> {
      const finalizeGuardId = `${input.commitId}:finalize`;
      const statements: D1PreparedStatement[] = [
        db.prepare(
          `INSERT INTO sync_commit_guards (commit_id, guard_key, ok)
           SELECT ?1, 'space', CASE WHEN EXISTS (
             SELECT 1 FROM sync_spaces
             WHERE space_id = ?2 AND active_epoch = ?3 AND head = ?4
               AND pending_commit_id = ?5
           ) THEN 1 ELSE 0 END`,
        ).bind(
          finalizeGuardId,
          input.spaceId,
          input.epoch,
          input.expectedHead,
          input.commitId,
        ),
      ];
      appendStoragePublishStatements(db, statements, input, r2Versions);
      appendMetadataPublishStatements(db, statements, input);
      statements.push(
        db.prepare(
          `UPDATE sync_spaces
           SET head = ?2, pending_commit_id = NULL, updated_at = ?3
           WHERE space_id = ?1 AND head = ?4 AND pending_commit_id = ?5`,
        ).bind(
          input.spaceId,
          input.newHead,
          input.committedAt,
          input.expectedHead,
          input.commitId,
        ),
        db.prepare(
          `UPDATE sync_commit_intents
           SET state = 'complete', last_error = NULL, updated_at = ?2
           WHERE commit_id = ?1 AND state != 'complete'`,
        ).bind(input.commitId, input.committedAt),
        db.prepare("DELETE FROM sync_commit_guards WHERE commit_id = ?1")
          .bind(finalizeGuardId),
      );
      await db.batch(statements);
      return input.mutations.map((mutation) => ({
        clientMutationId: mutation.clientMutationId,
        assetType: mutation.assetType,
        assetId: mutation.assetId,
        revision: mutation.revision,
        contentHash: mutation.contentHash,
      }));
    },

    async reserveAssetDelete(input: AssetDeleteInput): Promise<void> {
      const guardId = `${input.deleteId}:reserve`;
      const statements: D1PreparedStatement[] = [
        db.prepare(
          `INSERT INTO sync_commit_guards (commit_id, guard_key, ok)
           SELECT ?1, 'space', CASE WHEN EXISTS (
             SELECT 1 FROM sync_spaces
             WHERE space_id = ?2 AND active_epoch = ?3 AND head = ?4
               AND pending_commit_id IS NULL
           ) THEN 1 ELSE 0 END`,
        ).bind(guardId, input.spaceId, input.epoch, input.expectedHead),
        db.prepare(
          `INSERT INTO sync_commit_guards (commit_id, guard_key, ok)
           SELECT ?1, 'asset', CASE WHEN EXISTS (
             SELECT 1
             FROM sync_assets a
             JOIN sync_asset_storage s
               ON s.space_id = a.space_id
              AND s.asset_type = a.asset_type
              AND s.asset_id = a.asset_id
             WHERE a.space_id = ?2 AND a.epoch = ?3
               AND a.asset_type = ?4 AND a.asset_id = ?5
               AND a.revision = ?6 AND a.deleted_at IS NULL
               AND (?7 IS NULL OR a.content_hash = ?7)
               AND s.active_epoch = ?3 AND s.storage_state = 'stable'
               AND s.r2_key = ?8
           ) THEN 1 ELSE 0 END`,
        ).bind(
          guardId,
          input.spaceId,
          input.epoch,
          input.assetType,
          input.assetId,
          input.expectedRevision,
          input.expectedContentHash,
          input.r2Key,
        ),
        db.prepare(
          `INSERT INTO sync_delete_intents
             (delete_id, space_id, epoch, asset_type, asset_id,
              expected_head, expected_revision, r2_key, multipart_upload_id,
              payload_json, state,
              created_at, updated_at)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
                  u.r2_multipart_upload_id, ?9, 'reserved', ?10, ?10
           FROM (SELECT 1) seed
           LEFT JOIN sync_upload_sessions u
             ON u.space_id = ?2 AND u.asset_type = ?4 AND u.asset_id = ?5`,
        ).bind(
          input.deleteId,
          input.spaceId,
          input.epoch,
          input.assetType,
          input.assetId,
          input.expectedHead,
          input.expectedRevision,
          input.r2Key,
          JSON.stringify(input),
          input.deletedAt,
        ),
        db.prepare(
          `UPDATE sync_spaces SET pending_commit_id = ?2, updated_at = ?3
           WHERE space_id = ?1 AND active_epoch = ?4 AND head = ?5
             AND pending_commit_id IS NULL`,
        ).bind(
          input.spaceId,
          input.deleteId,
          input.deletedAt,
          input.epoch,
          input.expectedHead,
        ),
        db.prepare(
          `UPDATE sync_asset_storage
           SET storage_state = 'deleting', pending_commit_id = ?4, updated_at = ?5
           WHERE space_id = ?1 AND asset_type = ?2 AND asset_id = ?3
             AND storage_state = 'stable'`,
        ).bind(
          input.spaceId,
          input.assetType,
          input.assetId,
          input.deleteId,
          input.deletedAt,
        ),
        db.prepare(
          `UPDATE sync_upload_sessions
           SET state = 'aborted', lease_expires_at = NULL, updated_at = ?4
           WHERE space_id = ?1 AND asset_type = ?2 AND asset_id = ?3
             AND state != 'reserved'`,
        ).bind(input.spaceId, input.assetType, input.assetId, input.deletedAt),
        db.prepare("DELETE FROM sync_commit_guards WHERE commit_id = ?1")
          .bind(guardId),
      ];
      await db.batch(statements);
    },

    async getPendingDeleteIntent(spaceId: string): Promise<DeleteIntentRow | null> {
      const row = await db
        .prepare(
          `SELECT i.* FROM sync_delete_intents i
           JOIN sync_spaces s ON s.pending_commit_id = i.delete_id
           WHERE s.space_id = ?1 AND i.state != 'complete'`,
        )
        .bind(spaceId)
        .first<Record<string, unknown>>();
      return row ? rowToDeleteIntent(row) : null;
    },

    async markDeleteIntentState(
      deleteId: string,
      state: DeleteIntentRow["state"],
      updatedAt: string,
    ): Promise<void> {
      await db
        .prepare(
          `UPDATE sync_delete_intents SET state = ?2, updated_at = ?3
           WHERE delete_id = ?1 AND state != 'complete'`,
        )
        .bind(deleteId, state, updatedAt)
        .run();
    },

    async finalizeAssetDelete(input: AssetDeleteInput): Promise<AssetDeleteResult> {
      const guardId = `${input.deleteId}:finalize`;
      const newRevision = input.expectedRevision + 1;
      const newHead = input.expectedHead + 1;
      const minRetainedHead = Math.max(0, newHead - input.retentionHeadWindow);
      const statements: D1PreparedStatement[] = [
        db.prepare(
          `INSERT INTO sync_commit_guards (commit_id, guard_key, ok)
           SELECT ?1, 'delete', CASE WHEN EXISTS (
             SELECT 1
             FROM sync_spaces p
             JOIN sync_delete_intents i ON i.delete_id = p.pending_commit_id
             JOIN sync_asset_storage s
               ON s.space_id = i.space_id
              AND s.asset_type = i.asset_type
              AND s.asset_id = i.asset_id
             JOIN sync_assets a
               ON a.space_id = i.space_id AND a.epoch = i.epoch
              AND a.asset_type = i.asset_type AND a.asset_id = i.asset_id
             WHERE p.space_id = ?2 AND p.active_epoch = ?3 AND p.head = ?4
               AND p.pending_commit_id = ?5
               AND i.state != 'complete'
               AND a.revision = ?6 AND a.deleted_at IS NULL
               AND s.storage_state = 'deleting' AND s.pending_commit_id = ?5
           ) THEN 1 ELSE 0 END`,
        ).bind(
          guardId,
          input.spaceId,
          input.epoch,
          input.expectedHead,
          input.deleteId,
          input.expectedRevision,
        ),
        db.prepare(
          `DELETE FROM sync_upload_sessions
           WHERE space_id = ?1 AND asset_type = ?2 AND asset_id = ?3`,
        ).bind(input.spaceId, input.assetType, input.assetId),
        db.prepare(
          `DELETE FROM sync_asset_storage
           WHERE space_id = ?1 AND asset_type = ?2 AND asset_id = ?3
             AND storage_state = 'deleting' AND pending_commit_id = ?4`,
        ).bind(input.spaceId, input.assetType, input.assetId, input.deleteId),
        db.prepare(
          `UPDATE sync_assets
           SET revision = ?5, current_head = ?6, content_hash = NULL,
               deleted_at = ?7, committed_at = ?7,
               base_full_blob_hash = NULL, delta_depth = 0
           WHERE space_id = ?1 AND epoch = ?2 AND asset_type = ?3 AND asset_id = ?4
             AND revision = ?8 AND deleted_at IS NULL`,
        ).bind(
          input.spaceId,
          input.epoch,
          input.assetType,
          input.assetId,
          newRevision,
          newHead,
          input.deletedAt,
          input.expectedRevision,
        ),
        db.prepare(
          `INSERT INTO sync_changes
             (space_id, head, asset_type, asset_id, revision, kind, created_at)
           VALUES (?1,?2,?3,?4,?5,'delete',?6)`,
        ).bind(
          input.spaceId,
          newHead,
          input.assetType,
          input.assetId,
          newRevision,
          input.deletedAt,
        ),
        db.prepare(
          `INSERT INTO sync_module_heads (space_id, module_type, head, updated_at)
           VALUES (?1,?2,?3,?4)
           ON CONFLICT(space_id, module_type) DO UPDATE SET
             head = excluded.head, updated_at = excluded.updated_at`,
        ).bind(input.spaceId, input.assetType, newHead, input.deletedAt),
        db.prepare(
          `UPDATE sync_spaces
           SET head = ?2, min_retained_head = ?3,
               pending_commit_id = NULL, updated_at = ?4
           WHERE space_id = ?1 AND active_epoch = ?5 AND head = ?6
             AND pending_commit_id = ?7`,
        ).bind(
          input.spaceId,
          newHead,
          minRetainedHead,
          input.deletedAt,
          input.epoch,
          input.expectedHead,
          input.deleteId,
        ),
        db.prepare("DELETE FROM sync_changes WHERE space_id = ?1 AND head < ?2")
          .bind(input.spaceId, minRetainedHead),
        db.prepare(
          `DELETE FROM sync_mutation_results
           WHERE space_id = ?1 AND applied_head < ?2`,
        ).bind(input.spaceId, minRetainedHead),
        db.prepare(
          `UPDATE sync_delete_intents
           SET state = 'complete', updated_at = ?2
           WHERE delete_id = ?1 AND state != 'complete'`,
        ).bind(input.deleteId, input.deletedAt),
        db.prepare("DELETE FROM sync_commit_guards WHERE commit_id = ?1")
          .bind(guardId),
      ];
      await db.batch(statements);
      return { revision: newRevision, head: newHead, deletedAt: input.deletedAt };
    },

    // Atomic batch commit
    async commitBatch(
      spaceId: string,
      epoch: string,
      newHead: number,
      versions: CommitVersionInput[],
      blobHashes: string[],
      blobR2Keys: string[],
      committedAt: string,
    ): Promise<AppliedVersionResult[]> {
      console.log(`[commitBatch] space=${spaceId} newHead=${newHead} versions=${versions.map(v => `${v.assetType}/${v.assetId}@r${v.revision}`).join(',')}`);
      const statements: D1PreparedStatement[] = [];

      // 1. INSERT sync_asset_versions
      for (const v of versions) {
        statements.push(
          db
            .prepare(
              `INSERT OR IGNORE INTO sync_asset_versions
                 (space_id, epoch, asset_type, asset_id, revision, kind,
                  base_content_hash, target_content_hash, blob_hash, byte_size,
                  encoding, committed_head, committed_at, client_mutation_id)
               VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)`,
            )
            .bind(
              spaceId,
              epoch,
              v.assetType,
              v.assetId,
              v.revision,
              v.kind,
              v.baseContentHash,
              v.targetContentHash,
              v.blobHash,
              v.byteSize,
              v.encoding,
              newHead,
              committedAt,
              v.clientMutationId,
            ),
        );
      }

      // 2. UPSERT sync_assets（新资产 INSERT，已有资产 UPDATE）
      for (const v of versions) {
        statements.push(
          db
            .prepare(
              `INSERT INTO sync_assets
                 (space_id, epoch, asset_type, asset_id, revision, current_head,
                  content_hash, deleted_at, schema_version, min_readable_schema_version,
                  writer_app_version, writer_build_id, committed_at, storage_mode,
                  base_full_blob_hash, delta_depth)
               VALUES (?1,?2,?3,?4,?5,?6,?7,NULL,?8,?9,?10,?11,?12,?13,?14,?15)
               ON CONFLICT(space_id, epoch, asset_type, asset_id) DO UPDATE SET
                 revision = excluded.revision,
                 current_head = excluded.current_head,
                 content_hash = excluded.content_hash,
                 deleted_at = NULL,
                 schema_version = excluded.schema_version,
                 writer_app_version = excluded.writer_app_version,
                 writer_build_id = excluded.writer_build_id,
                 committed_at = excluded.committed_at,
                 storage_mode = excluded.storage_mode,
                 base_full_blob_hash = excluded.base_full_blob_hash,
                 delta_depth = excluded.delta_depth`,
            )
            .bind(
              spaceId,
              epoch,
              v.assetType,
              v.assetId,
              v.revision,
              newHead,
              v.contentHash,
              v.schemaVersion,
              v.minReadableSchemaVersion ?? 1,
              v.writerAppVersion,
              v.writerBuildId,
              committedAt,
              v.storageMode,
              v.baseFullBlobHash,
              v.deltaDepth,
            ),
        );
      }

      // 3. UPDATE sync_spaces SET head = head + 1
      statements.push(
        db
          .prepare(
            `UPDATE sync_spaces
             SET head = ?1, updated_at = ?2
             WHERE space_id = ?3 AND head = ?4`,
          )
          .bind(newHead, committedAt, spaceId, newHead - 1),
      );

      // 4. INSERT OR IGNORE sync_blobs
      for (let i = 0; i < blobHashes.length; i++) {
        statements.push(
          db
            .prepare(
              `INSERT OR IGNORE INTO sync_blobs
                 (space_id, epoch, blob_hash, r2_key, byte_size, encoding,
                  created_at, last_referenced_at)
               VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`,
            )
            .bind(
              spaceId,
              epoch,
              blobHashes[i],
              blobR2Keys[i],
              versions[i]?.byteSize ?? 0,
              versions[i]?.encoding ?? "identity",
              committedAt,
              committedAt,
            ),
        );
      }

      // 4.5 UPSERT sync_module_heads（按 assetType 去重）
      const seenModuleTypes = new Set<string>();
      for (const v of versions) {
        if (seenModuleTypes.has(v.assetType)) continue;
        seenModuleTypes.add(v.assetType);
        statements.push(
          db
            .prepare(
              `INSERT INTO sync_module_heads (space_id, module_type, head, updated_at)
               VALUES (?1, ?2, ?3, ?4)
               ON CONFLICT(space_id, module_type) DO UPDATE SET
                 head = excluded.head,
                 updated_at = excluded.updated_at`,
            )
            .bind(spaceId, v.assetType, newHead, committedAt),
        );
      }

      // 4.6 INSERT sync_changes
      for (const v of versions) {
        statements.push(
          db
            .prepare(
              `INSERT INTO sync_changes
                 (space_id, head, asset_type, asset_id, revision, kind, created_at)
               VALUES (?1, ?2, ?3, ?4, ?5, 'upsert', ?6)`,
            )
            .bind(spaceId, newHead, v.assetType, v.assetId, v.revision, committedAt),
        );
      }

      // 5. INSERT sync_mutation_results
      for (const v of versions) {
        statements.push(
          db
            .prepare(
              `INSERT INTO sync_mutation_results
                 (space_id, epoch, client_mutation_id, asset_type, asset_id,
                  applied_revision, applied_head, content_hash, created_at)
               VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
            )
            .bind(
              spaceId,
              epoch,
              v.clientMutationId,
              v.assetType,
              v.assetId,
              v.revision,
              newHead,
              v.contentHash,
              committedAt,
            ),
        );
      }

      const results = await db.batch(statements);

      // CAS 校验：D1 batch() 不是事务，并发时 UPDATE sync_spaces 的
      // WHERE head = oldHead 可能静默失败（changes=0）。
      // 此时 sync_assets 已写入但 sync_spaces.head 未推进，导致资产对 check 不可见。
      const casResult = results[2 * versions.length]; // Step 3: UPDATE sync_spaces
      if (casResult?.meta?.changes === 0) {
        throw new Error('CAS_FAILED: sync_spaces head 并发冲突，当前批次资产已部分写入，需客户端重试');
      }

      // 返回 applied 结果
      return versions.map((v) => ({
        clientMutationId: v.clientMutationId,
        assetType: v.assetType,
        assetId: v.assetId,
        revision: v.revision,
        contentHash: v.contentHash,
      }));
    },
  };
}

// Space revision 协议 D1 持久化层。

import type {
  AssetRow,
  CommitResult,
  DeleteItemRow,
  R2Slot,
  SpaceRow,
  TransactionInfo,
  UploadBatchRow,
  UploadItemRow,
} from "./space_model";
import { deriveR2SlotKey } from "./space_model";

export interface ReserveUploadInput {
  batch: UploadBatchRow;
  items: UploadItemRow[];
  deletions: DeleteItemRow[];
  lockedAt: string;
}

export interface FinalizeUploadInput {
  batch: UploadBatchRow;
  items: UploadItemRow[];
  deletions: DeleteItemRow[];
  r2Completions: Record<string, { version: string; etag: string }>;
  result: CommitResult;
  committedAt: string;
}

export interface SpacePlanSnapshot {
  space: SpaceRow;
  assets: AssetRow[];
}

export interface SpaceAssetSnapshot {
  space: SpaceRow;
  asset: AssetRow | null;
}

export interface SpaceCleanupUploadItem {
  uploadId: string;
  assetType: string;
  assetId: string;
  objectKey: string;
  r2MultipartUploadId: string | null;
  state: UploadItemRow["state"];
  leaseExpiresAt: string | null;
}

export interface SpaceCleanupDeleteItem {
  uploadId: string;
  assetType: string;
  assetId: string;
  objectKey: string;
  objectKeyB: string;
}

export interface SpaceCleanupAsset {
  assetType: string;
  assetId: string;
  r2Key: string;
  r2KeyB: string;
}

export interface SpaceCleanupBatch {
  uploadId: string;
}

export interface SpaceRepository {
  createSpace(space: SpaceRow): Promise<boolean>;
  getOrCreateAccountSpace(accountId: string, spaceId: string, createdAt: string): Promise<SpaceRow>;
  getSpace(spaceId: string): Promise<SpaceRow | null>;
  listAssets(spaceId: string): Promise<AssetRow[]>;
  getAsset(spaceId: string, assetType: string, assetId: string): Promise<AssetRow | null>;
  getPlanSnapshot(spaceId: string): Promise<SpacePlanSnapshot | null>;
  getAssetSnapshot(spaceId: string, assetType: string, assetId: string): Promise<SpaceAssetSnapshot | null>;
  getBatch(uploadId: string): Promise<UploadBatchRow | null>;
  getBatchByClientId(spaceId: string, clientBatchId: string): Promise<UploadBatchRow | null>;
  getPendingBatch(spaceId: string): Promise<UploadBatchRow | null>;
  listRecoverableBatches(now: string, limit: number): Promise<UploadBatchRow[]>;
  listPendingDeleteCleanupBatches(limit: number): Promise<UploadBatchRow[]>;
  claimExpiredSpace(now: string, leaseExpiresAt: string): Promise<SpaceRow | null>;
  listSpaceCleanupUploadItems(spaceId: string, limit: number): Promise<SpaceCleanupUploadItem[]>;
  deleteSpaceCleanupUploadItems(spaceId: string, items: SpaceCleanupUploadItem[]): Promise<void>;
  listSpaceCleanupDeleteItems(spaceId: string, limit: number): Promise<SpaceCleanupDeleteItem[]>;
  deleteSpaceCleanupDeleteItems(spaceId: string, items: SpaceCleanupDeleteItem[]): Promise<void>;
  listSpaceCleanupAssets(spaceId: string, limit: number): Promise<SpaceCleanupAsset[]>;
  deleteSpaceCleanupAssets(spaceId: string, assets: SpaceCleanupAsset[]): Promise<void>;
  listSpaceCleanupBatches(spaceId: string, limit: number): Promise<SpaceCleanupBatch[]>;
  deleteSpaceCleanupBatches(spaceId: string, batches: SpaceCleanupBatch[]): Promise<void>;
  finishSpaceCleanup(spaceId: string, leaseExpiresAt: string): Promise<boolean>;
  releaseSpaceCleanupLease(spaceId: string, leaseExpiresAt: string): Promise<void>;
  listItems(uploadId: string): Promise<UploadItemRow[]>;
  listDeleteItems(uploadId: string): Promise<DeleteItemRow[]>;
  getItem(uploadId: string, assetType: string, assetId: string): Promise<UploadItemRow | null>;
  reserveUpload(input: ReserveUploadInput): Promise<void>;
  claimItem(uploadId: string, assetType: string, assetId: string, now: string, leaseExpiresAt: string): Promise<boolean>;
  releaseItem(uploadId: string, assetType: string, assetId: string, now: string): Promise<void>;
  setMultipartId(uploadId: string, assetType: string, assetId: string, multipartUploadId: string, now: string): Promise<void>;
  markD1ItemReady(uploadId: string, assetType: string, assetId: string, content: ArrayBuffer, now: string): Promise<boolean>;
  markR2ItemReady(uploadId: string, assetType: string, assetId: string, etag: string, now: string): Promise<boolean>;
  markDeleteItemDeleted(uploadId: string, assetType: string, assetId: string, now: string): Promise<boolean>;
  beginCommit(uploadId: string, now: string): Promise<void>;
  finalizeCommit(input: FinalizeUploadInput): Promise<void>;
  acquireRecoverGuard(uploadId: string, now: string): Promise<boolean>;
  releaseRecoverGuard(uploadId: string): Promise<void>;
  beginCancel(uploadId: string, now: string): Promise<boolean>;
  finishCancel(uploadId: string, now: string): Promise<void>;
  setBatchError(uploadId: string, error: string, now: string): Promise<void>;
  /** 获取当前活跃事务详情（含 item/deletion 计数） */
  getTransactionDetail(spaceId: string): Promise<TransactionInfo | null>;
  /** 强制丢弃：允许 prepared 或 committing → cancelling */
  /** AI-CORRECTION 2026-08-24: committing 已可能完成外部写入，只允许 prepared → cancelling。 */
  beginForceAbort(uploadId: string, now: string): Promise<boolean>;
  checkHealth(): Promise<boolean>;
}

function binary(value: unknown): ArrayBuffer | null {
  if (value === null || value === undefined) return null;
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  }
  // AI-CORRECTION 2026-08-09: 正式 Cloudflare D1 会把 BLOB 查询结果表示为 number[]；
  // 必须在 repository 边界统一成 ArrayBuffer，否则提交阶段会把已上传的 D1 payload 误判为空。
  if (Array.isArray(value) && value.every(
    (byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255,
  )) {
    return Uint8Array.from(value).buffer;
  }
  return null;
}

function mapSpace(row: Record<string, unknown>): SpaceRow {
  return {
    spaceId: row.space_id as string,
    ownerKind: row.owner_kind as SpaceRow["ownerKind"],
    ownerId: (row.owner_id as string | null) ?? null,
    lifecycleState: row.lifecycle_state as SpaceRow["lifecycleState"],
    expiresAt: (row.expires_at as string | null) ?? null,
    cleanupLeaseExpiresAt: (row.cleanup_lease_expires_at as string | null) ?? null,
    revision: String(row.revision),
    epoch: row.epoch as number,
    pendingUploadId: (row.pending_upload_id as string | null) ?? null,
    lockExpiresAt: (row.lock_expires_at as string | null) ?? null,
    updatedAt: row.updated_at as string,
  };
}

function mapAsset(row: Record<string, unknown>): AssetRow {
  return {
    spaceId: row.space_id as string,
    assetType: row.asset_type as string,
    assetId: row.asset_id as string,
    epoch: row.epoch as number,
    lastModifiedRevision: String(row.last_modified_revision),
    contentHash: row.content_hash as string,
    byteSize: row.byte_size as number,
    encoding: row.encoding as string,
    metadata: row.metadata as string,
    schemaVersion: row.schema_version as number,
    writerAppVersion: row.writer_app_version as string,
    writerBuildId: row.writer_build_id as string,
    storageMode: "full",
    activeBackend: row.active_backend as "d1" | "r2",
    d1Content: binary(row.d1_content),
    d1BlobHash: (row.d1_blob_hash as string | null) ?? null,
    d1ByteSize: (row.d1_byte_size as number | null) ?? null,
    d1Encoding: (row.d1_encoding as string | null) ?? null,
    r2Key: row.r2_key as string,
    r2Present: row.r2_present === 1,
    r2BlobHash: (row.r2_blob_hash as string | null) ?? null,
    r2ByteSize: (row.r2_byte_size as number | null) ?? null,
    r2Encoding: (row.r2_encoding as string | null) ?? null,
    r2Version: (row.r2_version as string | null) ?? null,
    r2Etag: (row.r2_etag as string | null) ?? null,
    r2ActiveSlot: ((row.r2_active_slot as R2Slot | null) ?? "a"),
    r2BPresent: row.r2_b_present === 1,
    r2BBlobHash: (row.r2_b_blob_hash as string | null) ?? null,
    r2BByteSize: (row.r2_b_byte_size as number | null) ?? null,
    r2BEncoding: (row.r2_b_encoding as string | null) ?? null,
    r2BVersion: (row.r2_b_version as string | null) ?? null,
    r2BEtag: (row.r2_b_etag as string | null) ?? null,
    committedAt: row.committed_at as string,
  };
}

function mapBatch(row: Record<string, unknown>): UploadBatchRow {
  return {
    uploadId: row.upload_id as string,
    spaceId: row.space_id as string,
    clientBatchId: row.client_batch_id as string,
    baseRevision: String(row.base_revision),
    targetRevision: String(row.target_revision),
    targetEpoch: row.target_epoch as number,
    descriptorHash: row.descriptor_hash as string,
    state: row.state as UploadBatchRow["state"],
    expiresAt: row.expires_at as string,
    resultJson: (row.result_json as string | null) ?? null,
    lastError: (row.last_error as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function mapItem(row: Record<string, unknown>): UploadItemRow {
  return {
    uploadId: row.upload_id as string,
    spaceId: row.space_id as string,
    clientMutationId: row.client_mutation_id as string,
    assetType: row.asset_type as string,
    assetId: row.asset_id as string,
    metadata: row.metadata as string,
    blobHash: row.blob_hash as string,
    blobByteSize: row.byte_size as number,
    storageMode: "full",
    schemaVersion: row.schema_version as number,
    encoding: "identity",
    writerAppVersion: row.writer_app_version as string,
    writerBuildId: row.writer_build_id as string,
    sourceBackend: row.source_backend as "d1" | "r2",
    targetBackend: row.target_backend as "d1" | "r2",
    r2PrimaryKey: (row.r2_primary_key as string | null) ?? row.object_key as string,
    targetR2Slot: (row.target_r2_slot as R2Slot | null) ??
      (row.target_backend === "r2" ? "a" : null),
    objectKey: row.object_key as string,
    r2MultipartUploadId: (row.r2_multipart_upload_id as string | null) ?? null,
    partEtag: (row.part_etag as string | null) ?? null,
    d1Content: binary(row.d1_content),
    state: row.state as UploadItemRow["state"],
    leaseExpiresAt: (row.lease_expires_at as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function mapDeleteItem(row: Record<string, unknown>): DeleteItemRow {
  return {
    uploadId: row.upload_id as string,
    spaceId: row.space_id as string,
    clientMutationId: row.client_mutation_id as string,
    assetType: row.asset_type as string,
    assetId: row.asset_id as string,
    objectKey: row.object_key as string,
    objectKeyB: (row.object_key_b as string | null) ?? deriveR2SlotKey(row.object_key as string, "b"),
    state: row.state as DeleteItemRow["state"],
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

const SNAPSHOT_SPACE_COLUMNS = `
  s.space_id AS snapshot_space_id,
  s.owner_kind AS snapshot_owner_kind,
  s.owner_id AS snapshot_owner_id,
  s.lifecycle_state AS snapshot_lifecycle_state,
  s.expires_at AS snapshot_expires_at,
  s.cleanup_lease_expires_at AS snapshot_cleanup_lease_expires_at,
  s.revision AS snapshot_revision,
  s.epoch AS snapshot_epoch,
  s.pending_upload_id AS snapshot_pending_upload_id,
  s.lock_expires_at AS snapshot_lock_expires_at,
  s.updated_at AS snapshot_updated_at`;

const PLAN_ASSET_COLUMNS = `
  a.space_id,a.asset_type,a.asset_id,a.epoch,a.last_modified_revision,
  a.content_hash,a.byte_size,a.encoding,a.metadata,a.schema_version,
  a.writer_app_version,a.writer_build_id,a.storage_mode,a.active_backend,
  NULL AS d1_content,a.d1_blob_hash,a.d1_byte_size,a.d1_encoding,
  a.r2_key,a.r2_present,a.r2_blob_hash,a.r2_byte_size,a.r2_encoding,a.r2_version,
  a.r2_etag,a.r2_active_slot,a.r2_b_present,a.r2_b_blob_hash,a.r2_b_byte_size,
  a.r2_b_encoding,a.r2_b_version,a.r2_b_etag,a.committed_at`;

function mapSnapshotSpace(row: Record<string, unknown>): SpaceRow {
  return mapSpace({
    space_id: row.snapshot_space_id,
    owner_kind: row.snapshot_owner_kind,
    owner_id: row.snapshot_owner_id,
    lifecycle_state: row.snapshot_lifecycle_state,
    expires_at: row.snapshot_expires_at,
    cleanup_lease_expires_at: row.snapshot_cleanup_lease_expires_at,
    revision: row.snapshot_revision,
    epoch: row.snapshot_epoch,
    pending_upload_id: row.snapshot_pending_upload_id,
    lock_expires_at: row.snapshot_lock_expires_at,
    updated_at: row.snapshot_updated_at,
  });
}

function assetUpsert(
  db: D1Database,
  batch: UploadBatchRow,
  item: UploadItemRow,
  r2Completion: { version: string; etag: string } | null,
  committedAt: string,
): D1PreparedStatement {
  const d1Content = item.targetBackend === "d1" && item.d1Content !== null
    ? new Uint8Array(item.d1Content)
    : null;
  const hasNewR2 = item.targetBackend === "r2" && item.r2MultipartUploadId !== null;
  return db.prepare(
    `INSERT INTO sync_assets
       (space_id, asset_type, asset_id, epoch, last_modified_revision,
        content_hash, byte_size, encoding, metadata, schema_version,
        writer_app_version, writer_build_id, storage_mode, active_backend,
        d1_content, d1_blob_hash, d1_byte_size, d1_encoding,
        r2_key, r2_present, r2_blob_hash, r2_byte_size, r2_encoding, r2_version,
        r2_etag, r2_active_slot, r2_b_present, r2_b_blob_hash, r2_b_byte_size,
        r2_b_encoding, r2_b_version, r2_b_etag, committed_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'full',?13,
             ?14,CASE WHEN ?13='d1' THEN ?6 ELSE NULL END,
             CASE WHEN ?13='d1' THEN ?7 ELSE NULL END,
             CASE WHEN ?13='d1' THEN ?8 ELSE NULL END,
             ?15,CASE WHEN ?16=1 AND ?17='a' THEN 1 ELSE 0 END,
             CASE WHEN ?16=1 AND ?17='a' THEN ?6 ELSE NULL END,
             CASE WHEN ?16=1 AND ?17='a' THEN ?7 ELSE NULL END,
             CASE WHEN ?16=1 AND ?17='a' THEN ?8 ELSE NULL END,
             CASE WHEN ?16=1 AND ?17='a' THEN ?18 ELSE NULL END,
             CASE WHEN ?16=1 AND ?17='a' THEN ?19 ELSE NULL END,
             CASE WHEN ?13='r2' THEN ?17 ELSE 'a' END,
             CASE WHEN ?16=1 AND ?17='b' THEN 1 ELSE 0 END,
             CASE WHEN ?16=1 AND ?17='b' THEN ?6 ELSE NULL END,
             CASE WHEN ?16=1 AND ?17='b' THEN ?7 ELSE NULL END,
             CASE WHEN ?16=1 AND ?17='b' THEN ?8 ELSE NULL END,
             CASE WHEN ?16=1 AND ?17='b' THEN ?18 ELSE NULL END,
             CASE WHEN ?16=1 AND ?17='b' THEN ?19 ELSE NULL END,?20)
     ON CONFLICT(space_id, asset_type, asset_id) DO UPDATE SET
       epoch=excluded.epoch,
       last_modified_revision=excluded.last_modified_revision,
       content_hash=excluded.content_hash,
       byte_size=excluded.byte_size,
       encoding=excluded.encoding,
       metadata=excluded.metadata,
       schema_version=excluded.schema_version,
       writer_app_version=excluded.writer_app_version,
       writer_build_id=excluded.writer_build_id,
       storage_mode='full',
       active_backend=excluded.active_backend,
       d1_content=CASE WHEN ?13='d1' AND ?14 IS NOT NULL THEN ?14 ELSE sync_assets.d1_content END,
       d1_blob_hash=CASE WHEN ?13='d1' THEN ?6 ELSE sync_assets.d1_blob_hash END,
       d1_byte_size=CASE WHEN ?13='d1' THEN ?7 ELSE sync_assets.d1_byte_size END,
       d1_encoding=CASE WHEN ?13='d1' THEN ?8 ELSE sync_assets.d1_encoding END,
       r2_key=?15,
       r2_present=CASE WHEN ?16=1 AND ?17='a' THEN 1 ELSE sync_assets.r2_present END,
       r2_blob_hash=CASE WHEN ?16=1 AND ?17='a' THEN ?6 ELSE sync_assets.r2_blob_hash END,
       r2_byte_size=CASE WHEN ?16=1 AND ?17='a' THEN ?7 ELSE sync_assets.r2_byte_size END,
       r2_encoding=CASE WHEN ?16=1 AND ?17='a' THEN ?8 ELSE sync_assets.r2_encoding END,
       r2_version=CASE WHEN ?16=1 AND ?17='a' THEN ?18 ELSE sync_assets.r2_version END,
       r2_etag=CASE WHEN ?16=1 AND ?17='a' THEN ?19 ELSE sync_assets.r2_etag END,
       r2_active_slot=CASE WHEN ?13='r2' THEN ?17 ELSE sync_assets.r2_active_slot END,
       r2_b_present=CASE WHEN ?16=1 AND ?17='b' THEN 1 ELSE sync_assets.r2_b_present END,
       r2_b_blob_hash=CASE WHEN ?16=1 AND ?17='b' THEN ?6 ELSE sync_assets.r2_b_blob_hash END,
       r2_b_byte_size=CASE WHEN ?16=1 AND ?17='b' THEN ?7 ELSE sync_assets.r2_b_byte_size END,
       r2_b_encoding=CASE WHEN ?16=1 AND ?17='b' THEN ?8 ELSE sync_assets.r2_b_encoding END,
       r2_b_version=CASE WHEN ?16=1 AND ?17='b' THEN ?18 ELSE sync_assets.r2_b_version END,
       r2_b_etag=CASE WHEN ?16=1 AND ?17='b' THEN ?19 ELSE sync_assets.r2_b_etag END,
       committed_at=?20`,
  ).bind(
    batch.spaceId,
    item.assetType,
    item.assetId,
    batch.targetEpoch,
    batch.targetRevision,
    item.blobHash,
    item.blobByteSize,
    item.encoding,
    item.metadata,
    item.schemaVersion,
    item.writerAppVersion,
    item.writerBuildId,
    item.targetBackend,
    d1Content,
    item.r2PrimaryKey,
    hasNewR2 ? 1 : 0,
    item.targetR2Slot,
    r2Completion?.version ?? null,
    r2Completion?.etag ?? null,
    committedAt,
  );
}

export function createSpaceRepository(db: D1Database): SpaceRepository {
  return {
    async createSpace(space) {
      const result = await db.prepare(
        `INSERT OR IGNORE INTO sync_spaces
           (space_id, owner_kind, owner_id, lifecycle_state, expires_at,
            cleanup_lease_expires_at, revision, epoch,
            pending_upload_id, lock_expires_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,NULL,?6,?7,NULL,NULL,?8)`,
      ).bind(
        space.spaceId,
        space.ownerKind,
        space.ownerId,
        space.lifecycleState,
        space.expiresAt,
        space.revision,
        space.epoch,
        space.updatedAt,
      ).run();
      return (result.meta?.changes ?? 0) === 1;
    },

    async getOrCreateAccountSpace(accountId, spaceId, createdAt) {
      await db.prepare(
        `INSERT OR IGNORE INTO sync_spaces
           (space_id, owner_kind, owner_id, lifecycle_state, expires_at,
            cleanup_lease_expires_at, revision, epoch,
            pending_upload_id, lock_expires_at, updated_at)
         VALUES (?1,'account',?2,'active',NULL,NULL,?3,0,NULL,NULL,?4)`,
      ).bind(spaceId, accountId, "0", createdAt).run();
      const row = await db.prepare(
        `SELECT * FROM sync_spaces
         WHERE owner_kind='account' AND owner_id=?1`,
      ).bind(accountId).first<Record<string, unknown>>();
      if (!row) throw new Error("账户空间创建后不存在");
      return mapSpace(row);
    },

    async getSpace(spaceId) {
      const row = await db.prepare("SELECT * FROM sync_spaces WHERE space_id=?1")
        .bind(spaceId).first<Record<string, unknown>>();
      return row ? mapSpace(row) : null;
    },

    async listAssets(spaceId) {
      const result = await db.prepare(
        "SELECT * FROM sync_assets WHERE space_id=?1 ORDER BY asset_type, asset_id",
      ).bind(spaceId).all<Record<string, unknown>>();
      return (result.results ?? []).map(mapAsset);
    },

    async getAsset(spaceId, assetType, assetId) {
      const row = await db.prepare(
        "SELECT * FROM sync_assets WHERE space_id=?1 AND asset_type=?2 AND asset_id=?3",
      ).bind(spaceId, assetType, assetId).first<Record<string, unknown>>();
      return row ? mapAsset(row) : null;
    },

    async getPlanSnapshot(spaceId) {
      const result = await db.prepare(
        `SELECT ${SNAPSHOT_SPACE_COLUMNS}, ${PLAN_ASSET_COLUMNS}
         FROM sync_spaces s
         LEFT JOIN sync_assets a ON a.space_id=s.space_id
         WHERE s.space_id=?1
         ORDER BY a.asset_type,a.asset_id`,
      ).bind(spaceId).all<Record<string, unknown>>();
      const rows = result.results ?? [];
      if (rows.length === 0) return null;
      return {
        space: mapSnapshotSpace(rows[0]!),
        assets: rows
          .filter((row) => row.asset_id !== null && row.asset_id !== undefined)
          .map(mapAsset),
      };
    },

    async getAssetSnapshot(spaceId, assetType, assetId) {
      const row = await db.prepare(
        `SELECT ${SNAPSHOT_SPACE_COLUMNS}, a.*
         FROM sync_spaces s
         LEFT JOIN sync_assets a
           ON a.space_id=s.space_id AND a.asset_type=?2 AND a.asset_id=?3
         WHERE s.space_id=?1`,
      ).bind(spaceId, assetType, assetId).first<Record<string, unknown>>();
      if (!row) return null;
      return {
        space: mapSnapshotSpace(row),
        asset: row.asset_id === null || row.asset_id === undefined ? null : mapAsset(row),
      };
    },

    async getBatch(uploadId) {
      const row = await db.prepare("SELECT * FROM sync_upload_batches WHERE upload_id=?1")
        .bind(uploadId).first<Record<string, unknown>>();
      return row ? mapBatch(row) : null;
    },

    async getBatchByClientId(spaceId, clientBatchId) {
      const row = await db.prepare(
        "SELECT * FROM sync_upload_batches WHERE space_id=?1 AND client_batch_id=?2",
      ).bind(spaceId, clientBatchId).first<Record<string, unknown>>();
      return row ? mapBatch(row) : null;
    },

    async getPendingBatch(spaceId) {
      const row = await db.prepare(
        `SELECT b.* FROM sync_upload_batches b
         JOIN sync_spaces s ON s.pending_upload_id=b.upload_id
         WHERE s.space_id=?1`,
      ).bind(spaceId).first<Record<string, unknown>>();
      return row ? mapBatch(row) : null;
    },

    async listRecoverableBatches(now, limit) {
      const result = await db.prepare(
        `SELECT b.* FROM sync_upload_batches b
         JOIN sync_spaces s ON s.pending_upload_id=b.upload_id
         WHERE s.lifecycle_state='active'
           AND (s.expires_at IS NULL OR s.expires_at>?1)
           AND (b.state IN ('committing','cancelling')
                OR (b.state='prepared' AND b.expires_at<=?1))
         ORDER BY b.updated_at LIMIT ?2`,
      ).bind(now, limit).all<Record<string, unknown>>();
      return (result.results ?? []).map(mapBatch);
    },

    async listPendingDeleteCleanupBatches(limit) {
      const result = await db.prepare(
        `SELECT DISTINCT b.*
         FROM sync_upload_batches b
         JOIN sync_delete_items d ON d.upload_id=b.upload_id
         WHERE b.state='committed' AND d.state='committed'
         ORDER BY b.updated_at,b.upload_id
         LIMIT ?1`,
      ).bind(limit).all<Record<string, unknown>>();
      return (result.results ?? []).map(mapBatch);
    },

    async claimExpiredSpace(now, leaseExpiresAt) {
      const candidate = await db.prepare(
        `SELECT s.space_id FROM sync_spaces s
         WHERE s.owner_kind='anonymous' AND s.expires_at IS NOT NULL
           AND (
             (s.lifecycle_state='active' AND s.expires_at<=?1)
             OR
             (s.lifecycle_state='deleting' AND (
               s.cleanup_lease_expires_at IS NULL OR s.cleanup_lease_expires_at<=?1
             ))
           )
           AND NOT EXISTS(
             SELECT 1 FROM sync_upload_batches b
             JOIN sync_operation_guards g
               ON g.operation_id=b.upload_id || ':recover' AND g.guard_key='recover'
             WHERE b.space_id=s.space_id
           )
         ORDER BY CASE s.lifecycle_state WHEN 'deleting' THEN 0 ELSE 1 END,
                  s.expires_at, s.space_id
         LIMIT 1`,
      ).bind(now).first<{ space_id: string }>();
      if (!candidate) return null;

      const claimed = await db.prepare(
        `UPDATE sync_spaces
         SET lifecycle_state='deleting',cleanup_lease_expires_at=?3,updated_at=?2
         WHERE space_id=?1 AND owner_kind='anonymous' AND expires_at IS NOT NULL
           AND (
             (lifecycle_state='active' AND expires_at<=?2)
             OR
             (lifecycle_state='deleting' AND (
               cleanup_lease_expires_at IS NULL OR cleanup_lease_expires_at<=?2
             ))
           )
           AND NOT EXISTS(
             SELECT 1 FROM sync_upload_batches b
             JOIN sync_operation_guards g
               ON g.operation_id=b.upload_id || ':recover' AND g.guard_key='recover'
             WHERE b.space_id=sync_spaces.space_id
           )`,
      ).bind(candidate.space_id, now, leaseExpiresAt).run();
      if ((claimed.meta?.changes ?? 0) !== 1) return null;
      return this.getSpace(candidate.space_id);
    },

    async listSpaceCleanupUploadItems(spaceId, limit) {
      const result = await db.prepare(
        `SELECT upload_id,asset_type,asset_id,object_key,r2_multipart_upload_id,
                state,lease_expires_at
         FROM sync_upload_items
         WHERE space_id=?1
         ORDER BY upload_id,asset_type,asset_id LIMIT ?2`,
      ).bind(spaceId, limit).all<Record<string, unknown>>();
      return (result.results ?? []).map((row) => ({
        uploadId: row.upload_id as string,
        assetType: row.asset_type as string,
        assetId: row.asset_id as string,
        objectKey: row.object_key as string,
        r2MultipartUploadId: (row.r2_multipart_upload_id as string | null) ?? null,
        state: row.state as UploadItemRow["state"],
        leaseExpiresAt: (row.lease_expires_at as string | null) ?? null,
      }));
    },

    async deleteSpaceCleanupUploadItems(spaceId, items) {
      await db.batch(items.map((item) => db.prepare(
        `DELETE FROM sync_upload_items
         WHERE space_id=?1 AND upload_id=?2 AND asset_type=?3 AND asset_id=?4`,
      ).bind(spaceId, item.uploadId, item.assetType, item.assetId)));
    },

    async listSpaceCleanupDeleteItems(spaceId, limit) {
      const result = await db.prepare(
        `SELECT upload_id,asset_type,asset_id,object_key,object_key_b
         FROM sync_delete_items
         WHERE space_id=?1
         ORDER BY upload_id,asset_type,asset_id LIMIT ?2`,
      ).bind(spaceId, limit).all<Record<string, unknown>>();
      return (result.results ?? []).map((row) => ({
        uploadId: row.upload_id as string,
        assetType: row.asset_type as string,
        assetId: row.asset_id as string,
        objectKey: row.object_key as string,
        objectKeyB: (row.object_key_b as string | null) ??
          deriveR2SlotKey(row.object_key as string, "b"),
      }));
    },

    async deleteSpaceCleanupDeleteItems(spaceId, items) {
      await db.batch(items.map((item) => db.prepare(
        `DELETE FROM sync_delete_items
         WHERE space_id=?1 AND upload_id=?2 AND asset_type=?3 AND asset_id=?4`,
      ).bind(spaceId, item.uploadId, item.assetType, item.assetId)));
    },

    async listSpaceCleanupAssets(spaceId, limit) {
      const result = await db.prepare(
        `SELECT asset_type,asset_id,r2_key
         FROM sync_assets
         WHERE space_id=?1
         ORDER BY asset_type,asset_id LIMIT ?2`,
      ).bind(spaceId, limit).all<Record<string, unknown>>();
      return (result.results ?? []).map((row) => ({
        assetType: row.asset_type as string,
        assetId: row.asset_id as string,
        r2Key: row.r2_key as string,
        r2KeyB: deriveR2SlotKey(row.r2_key as string, "b"),
      }));
    },

    async deleteSpaceCleanupAssets(spaceId, assets) {
      await db.batch(assets.map((asset) => db.prepare(
        `DELETE FROM sync_assets
         WHERE space_id=?1 AND asset_type=?2 AND asset_id=?3`,
      ).bind(spaceId, asset.assetType, asset.assetId)));
    },

    async listSpaceCleanupBatches(spaceId, limit) {
      const result = await db.prepare(
        `SELECT upload_id FROM sync_upload_batches
         WHERE space_id=?1 ORDER BY upload_id LIMIT ?2`,
      ).bind(spaceId, limit).all<{ upload_id: string }>();
      return (result.results ?? []).map((row) => ({ uploadId: row.upload_id }));
    },

    async deleteSpaceCleanupBatches(spaceId, batches) {
      const statements: D1PreparedStatement[] = [];
      for (const batch of batches) {
        statements.push(
          db.prepare(
            `DELETE FROM sync_operation_guards
             WHERE operation_id=?1 OR substr(operation_id,1,length(?1)+1)=?1 || ':'`,
          ).bind(batch.uploadId),
          db.prepare(
            "DELETE FROM sync_upload_batches WHERE space_id=?1 AND upload_id=?2",
          ).bind(spaceId, batch.uploadId),
        );
      }
      await db.batch(statements);
    },

    async finishSpaceCleanup(spaceId, leaseExpiresAt) {
      const result = await db.prepare(
        `DELETE FROM sync_spaces
         WHERE space_id=?1 AND lifecycle_state='deleting'
           AND cleanup_lease_expires_at=?2
           AND NOT EXISTS(SELECT 1 FROM sync_upload_items WHERE space_id=?1)
           AND NOT EXISTS(SELECT 1 FROM sync_delete_items WHERE space_id=?1)
           AND NOT EXISTS(SELECT 1 FROM sync_assets WHERE space_id=?1)
           AND NOT EXISTS(SELECT 1 FROM sync_upload_batches WHERE space_id=?1)`,
      ).bind(spaceId, leaseExpiresAt).run();
      return (result.meta?.changes ?? 0) === 1;
    },

    async releaseSpaceCleanupLease(spaceId, leaseExpiresAt) {
      await db.prepare(
        `UPDATE sync_spaces SET cleanup_lease_expires_at=NULL
         WHERE space_id=?1 AND lifecycle_state='deleting'
           AND cleanup_lease_expires_at=?2`,
      ).bind(spaceId, leaseExpiresAt).run();
    },

    async listItems(uploadId) {
      const result = await db.prepare(
        "SELECT * FROM sync_upload_items WHERE upload_id=?1 ORDER BY asset_type, asset_id",
      ).bind(uploadId).all<Record<string, unknown>>();
      return (result.results ?? []).map(mapItem);
    },

    async listDeleteItems(uploadId) {
      const result = await db.prepare(
        "SELECT * FROM sync_delete_items WHERE upload_id=?1 ORDER BY asset_type, asset_id",
      ).bind(uploadId).all<Record<string, unknown>>();
      return (result.results ?? []).map(mapDeleteItem);
    },

    async getItem(uploadId, assetType, assetId) {
      const row = await db.prepare(
        `SELECT * FROM sync_upload_items
         WHERE upload_id=?1 AND asset_type=?2 AND asset_id=?3`,
      ).bind(uploadId, assetType, assetId).first<Record<string, unknown>>();
      return row ? mapItem(row) : null;
    },

    async reserveUpload({ batch, items, deletions, lockedAt }) {
      const statements: D1PreparedStatement[] = [
        db.prepare(
          `INSERT INTO sync_operation_guards(operation_id, guard_key, ok)
           SELECT ?1,'space',CASE WHEN EXISTS(
             SELECT 1 FROM sync_spaces
             WHERE space_id=?2 AND revision=?3 AND pending_upload_id IS NULL
               AND lifecycle_state='active'
               AND (expires_at IS NULL OR expires_at>?4)
           ) THEN 1 ELSE 0 END`,
        ).bind(batch.uploadId, batch.spaceId, batch.baseRevision, lockedAt),
        db.prepare(
          `INSERT INTO sync_upload_batches
             (upload_id,space_id,client_batch_id,base_revision,target_revision,target_epoch,
              descriptor_hash,state,expires_at,result_json,last_error,created_at,updated_at)
           VALUES (?1,?2,?3,?4,?5,?6,?7,'prepared',?8,NULL,NULL,?9,?9)`,
        ).bind(
          batch.uploadId,
          batch.spaceId,
          batch.clientBatchId,
          batch.baseRevision,
          batch.targetRevision,
          batch.targetEpoch,
          batch.descriptorHash,
          batch.expiresAt,
          lockedAt,
        ),
        db.prepare(
          `UPDATE sync_spaces SET pending_upload_id=?2,lock_expires_at=?3,updated_at=?4
           WHERE space_id=?1 AND revision=?5 AND pending_upload_id IS NULL
             AND lifecycle_state='active'
             AND (expires_at IS NULL OR expires_at>?4)`,
        ).bind(batch.spaceId, batch.uploadId, batch.expiresAt, lockedAt, batch.baseRevision),
      ];
      for (const item of items) {
        statements.push(db.prepare(
          `INSERT INTO sync_upload_items
             (upload_id,space_id,client_mutation_id,asset_type,asset_id,metadata,
              blob_hash,byte_size,encoding,schema_version,writer_app_version,writer_build_id,
              storage_mode,source_backend,target_backend,object_key,r2_multipart_upload_id,
              part_etag,d1_content,state,lease_expires_at,created_at,updated_at,
              r2_primary_key,target_r2_slot)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'full',?13,?14,?15,
                   NULL,NULL,NULL,?16,NULL,?17,?17,?18,?19)`,
        ).bind(
          item.uploadId,
          item.spaceId,
          item.clientMutationId,
          item.assetType,
          item.assetId,
          item.metadata,
          item.blobHash,
          item.blobByteSize,
          item.encoding,
          item.schemaVersion,
          item.writerAppVersion,
          item.writerBuildId,
          item.sourceBackend,
          item.targetBackend,
          item.objectKey,
          item.state,
          item.createdAt,
          item.r2PrimaryKey,
          item.targetR2Slot,
        ));
      }
      for (const deletion of deletions) {
        statements.push(db.prepare(
          `INSERT INTO sync_delete_items
             (upload_id,space_id,client_mutation_id,asset_type,asset_id,object_key,
              state,created_at,updated_at,object_key_b)
           VALUES (?1,?2,?3,?4,?5,?6,'issued',?7,?7,?8)`,
        ).bind(
          deletion.uploadId,
          deletion.spaceId,
          deletion.clientMutationId,
          deletion.assetType,
          deletion.assetId,
          deletion.objectKey,
          deletion.createdAt,
          deletion.objectKeyB,
        ));
      }
      statements.push(
        db.prepare("DELETE FROM sync_operation_guards WHERE operation_id=?1").bind(batch.uploadId),
      );
      await db.batch(statements);
    },

    async claimItem(uploadId, assetType, assetId, now, leaseExpiresAt) {
      const result = await db.prepare(
        `UPDATE sync_upload_items SET state='uploading',lease_expires_at=?4,updated_at=?5
         WHERE upload_id=?1 AND asset_type=?2 AND asset_id=?3
           AND EXISTS(SELECT 1 FROM sync_upload_batches b
                      JOIN sync_spaces s ON s.space_id=b.space_id
                      WHERE b.upload_id=?1 AND b.state='prepared' AND b.expires_at>?5
                        AND s.lifecycle_state='active'
                        AND (s.expires_at IS NULL OR s.expires_at>?5))
           AND (state='issued' OR (state='uploading' AND lease_expires_at<?5))`,
      ).bind(uploadId, assetType, assetId, leaseExpiresAt, now).run();
      return (result.meta?.changes ?? 0) === 1;
    },

    async releaseItem(uploadId, assetType, assetId, now) {
      await db.prepare(
        `UPDATE sync_upload_items SET state='issued',lease_expires_at=NULL,updated_at=?4
         WHERE upload_id=?1 AND asset_type=?2 AND asset_id=?3 AND state='uploading'`,
      ).bind(uploadId, assetType, assetId, now).run();
    },

    async setMultipartId(uploadId, assetType, assetId, multipartUploadId, now) {
      await db.prepare(
        `UPDATE sync_upload_items SET r2_multipart_upload_id=?4,updated_at=?5
         WHERE upload_id=?1 AND asset_type=?2 AND asset_id=?3 AND state='uploading'
           AND EXISTS(SELECT 1 FROM sync_upload_batches b
                      WHERE b.upload_id=?1 AND b.state='prepared')
           AND (r2_multipart_upload_id IS NULL OR r2_multipart_upload_id=?4)`,
      ).bind(uploadId, assetType, assetId, multipartUploadId, now).run();
    },

    async markD1ItemReady(uploadId, assetType, assetId, content, now) {
      const result = await db.prepare(
        `UPDATE sync_upload_items
         SET d1_content=?4,state='ready',lease_expires_at=NULL,updated_at=?5
         WHERE upload_id=?1 AND asset_type=?2 AND asset_id=?3
           AND state='uploading' AND target_backend='d1'
           AND EXISTS(SELECT 1 FROM sync_upload_batches b
                      WHERE b.upload_id=?1 AND b.state='prepared')`,
      ).bind(uploadId, assetType, assetId, new Uint8Array(content), now).run();
      return (result.meta?.changes ?? 0) === 1;
    },

    async markR2ItemReady(uploadId, assetType, assetId, etag, now) {
      const result = await db.prepare(
        `UPDATE sync_upload_items
         SET part_etag=?4,state='ready',lease_expires_at=NULL,updated_at=?5
         WHERE upload_id=?1 AND asset_type=?2 AND asset_id=?3
           AND state='uploading' AND target_backend='r2'
           AND EXISTS(SELECT 1 FROM sync_upload_batches b
                      WHERE b.upload_id=?1 AND b.state='prepared')
           AND r2_multipart_upload_id IS NOT NULL`,
      ).bind(uploadId, assetType, assetId, etag, now).run();
      return (result.meta?.changes ?? 0) === 1;
    },

    async markDeleteItemDeleted(uploadId, assetType, assetId, now) {
      const result = await db.prepare(
        `UPDATE sync_delete_items SET state='deleted',updated_at=?4
         WHERE upload_id=?1 AND asset_type=?2 AND asset_id=?3 AND state='committed'
           AND EXISTS(SELECT 1 FROM sync_upload_batches b
                      WHERE b.upload_id=?1 AND b.state='committed')`,
      ).bind(uploadId, assetType, assetId, now).run();
      if ((result.meta?.changes ?? 0) === 1) return true;
      const current = await db.prepare(
        `SELECT state FROM sync_delete_items
         WHERE upload_id=?1 AND asset_type=?2 AND asset_id=?3`,
      ).bind(uploadId, assetType, assetId).first<{ state: string }>();
      return current?.state === "deleted";
    },

    async beginCommit(uploadId, now) {
      const guardId = `${uploadId}:commit`;
      await db.batch([
        db.prepare(
          `INSERT INTO sync_operation_guards(operation_id,guard_key,ok)
           SELECT ?1,'batch',CASE WHEN EXISTS(
             SELECT 1 FROM sync_upload_batches b
             JOIN sync_spaces s ON s.space_id=b.space_id AND s.pending_upload_id=b.upload_id
             WHERE b.upload_id=?2 AND b.state='prepared' AND b.expires_at>?3
               AND s.revision=b.base_revision
               AND s.lifecycle_state='active'
               AND (s.expires_at IS NULL OR s.expires_at>?3)
               AND NOT EXISTS(SELECT 1 FROM sync_upload_items i
                              WHERE i.upload_id=b.upload_id AND i.state!='ready')
           ) THEN 1 ELSE 0 END`,
        ).bind(guardId, uploadId, now),
        db.prepare(
          "UPDATE sync_upload_batches SET state='committing',updated_at=?2 WHERE upload_id=?1 AND state='prepared'",
        ).bind(uploadId, now),
        db.prepare(
          "UPDATE sync_upload_items SET state='reserved',updated_at=?2 WHERE upload_id=?1 AND state='ready'",
        ).bind(uploadId, now),
        db.prepare(
          "UPDATE sync_delete_items SET state='reserved',updated_at=?2 WHERE upload_id=?1 AND state='issued'",
        ).bind(uploadId, now),
        db.prepare("DELETE FROM sync_operation_guards WHERE operation_id=?1").bind(guardId),
      ]);
    },

    async acquireRecoverGuard(uploadId, now) {
      const guardId = `${uploadId}:recover`;
      try {
        await db.batch([
          db.prepare(
            `INSERT INTO sync_operation_guards(operation_id,guard_key,ok)
             SELECT ?1,'recover',CASE WHEN EXISTS(
               SELECT 1 FROM sync_upload_batches b
               JOIN sync_spaces s ON s.space_id=b.space_id
               WHERE b.upload_id=?2 AND b.state='committing'
                 AND s.lifecycle_state='active'
                 AND (s.expires_at IS NULL OR s.expires_at>?3)
             ) THEN 1 ELSE 0 END`,
          ).bind(guardId, uploadId, now),
        ]);
        return true;
      } catch (error) {
        if (!isConstraintConflict(error)) throw error;
        return false;
      }
    },

    async releaseRecoverGuard(uploadId) {
      const guardId = `${uploadId}:recover`;
      await db.prepare(
        "DELETE FROM sync_operation_guards WHERE operation_id=?1 AND guard_key='recover'",
      ).bind(guardId).run();
    },

    async finalizeCommit({ batch, items, deletions, r2Completions, result, committedAt }) {
      const guardId = `${batch.uploadId}:finalize`;
      const statements: D1PreparedStatement[] = [
        db.prepare(
          `INSERT INTO sync_operation_guards(operation_id,guard_key,ok)
           SELECT ?1,'batch',CASE WHEN EXISTS(
             SELECT 1 FROM sync_upload_batches b
             JOIN sync_spaces s ON s.space_id=b.space_id AND s.pending_upload_id=b.upload_id
             WHERE b.upload_id=?2 AND b.state='committing' AND s.revision=b.base_revision
               AND s.lifecycle_state='active'
               AND (s.expires_at IS NULL OR s.expires_at>?3)
           ) THEN 1 ELSE 0 END`,
        ).bind(guardId, batch.uploadId, committedAt),
      ];
      for (const item of items) {
        statements.push(assetUpsert(
          db,
          batch,
          item,
          r2Completions[`${item.assetType}\u0000${item.assetId}`] ?? null,
          committedAt,
        ));
      }
      for (const deletion of deletions) {
        statements.push(db.prepare(
          "DELETE FROM sync_assets WHERE space_id=?1 AND asset_type=?2 AND asset_id=?3",
        ).bind(batch.spaceId, deletion.assetType, deletion.assetId));
      }
      statements.push(
        db.prepare(
          `UPDATE sync_spaces
           SET revision=?2,epoch=?3,pending_upload_id=NULL,lock_expires_at=NULL,updated_at=?4
           WHERE space_id=?1 AND revision=?5 AND pending_upload_id=?6
             AND lifecycle_state='active'
             AND (expires_at IS NULL OR expires_at>?4)`,
        ).bind(
          batch.spaceId,
          batch.targetRevision,
          batch.targetEpoch,
          committedAt,
          batch.baseRevision,
          batch.uploadId,
        ),
        db.prepare(
          `UPDATE sync_upload_items
           SET state='committed',d1_content=NULL,lease_expires_at=NULL,updated_at=?2
           WHERE upload_id=?1 AND state='reserved'`,
        ).bind(batch.uploadId, committedAt),
        db.prepare(
          `UPDATE sync_delete_items SET state='committed',updated_at=?2
           WHERE upload_id=?1 AND state='reserved'`,
        ).bind(batch.uploadId, committedAt),
        db.prepare(
          `UPDATE sync_upload_batches
           SET state='committed',result_json=?2,last_error=NULL,updated_at=?3
           WHERE upload_id=?1 AND state='committing'`,
        ).bind(batch.uploadId, JSON.stringify(result), committedAt),
        db.prepare("DELETE FROM sync_operation_guards WHERE operation_id=?1").bind(guardId),
      );
      await db.batch(statements);
    },

    async beginCancel(uploadId, now) {
      const result = await db.prepare(
        `UPDATE sync_upload_batches SET state='cancelling',updated_at=?2
         WHERE upload_id=?1 AND state='prepared'
           AND NOT EXISTS(SELECT 1 FROM sync_upload_items i
                          WHERE i.upload_id=?1 AND i.state='uploading'
                            AND i.lease_expires_at>?2)`,
      ).bind(uploadId, now).run();
      if ((result.meta?.changes ?? 0) === 1) return true;
      const batch = await this.getBatch(uploadId);
      return batch?.state === "cancelling";
    },

    async finishCancel(uploadId, now) {
      await db.batch([
        db.prepare(
          `UPDATE sync_spaces SET pending_upload_id=NULL,lock_expires_at=NULL,updated_at=?2
           WHERE pending_upload_id=?1`,
        ).bind(uploadId, now),
        db.prepare(
          `UPDATE sync_upload_items
           SET state='cancelled',d1_content=NULL,lease_expires_at=NULL,updated_at=?2
           WHERE upload_id=?1 AND state NOT IN ('committed','cancelled')`,
        ).bind(uploadId, now),
        db.prepare(
          `UPDATE sync_delete_items SET state='cancelled',updated_at=?2
           WHERE upload_id=?1 AND state NOT IN ('committed','cancelled')`,
        ).bind(uploadId, now),
        db.prepare(
          `UPDATE sync_upload_batches SET state='cancelled',last_error=NULL,updated_at=?2
           WHERE upload_id=?1 AND state='cancelling'`,
        ).bind(uploadId, now),
      ]);
    },

    async setBatchError(uploadId, error, now) {
      await db.prepare(
        "UPDATE sync_upload_batches SET last_error=?2,updated_at=?3 WHERE upload_id=?1",
      ).bind(uploadId, error, now).run();
    },

    async getTransactionDetail(spaceId) {
      const space = await db.prepare(
        "SELECT pending_upload_id FROM sync_spaces WHERE space_id=?1",
      ).bind(spaceId).first<{ pending_upload_id: string | null }>();
      if (!space?.pending_upload_id) return null;
      const uploadId = space.pending_upload_id;

      const batch = await this.getBatch(uploadId);
      if (!batch) return null;

      const [itemCount, deletionCount] = await Promise.all([
        db.prepare(
          "SELECT COUNT(*) AS cnt FROM sync_upload_items WHERE upload_id=?1",
        ).bind(uploadId).first<{ cnt: number }>(),
        db.prepare(
          "SELECT COUNT(*) AS cnt FROM sync_delete_items WHERE upload_id=?1",
        ).bind(uploadId).first<{ cnt: number }>(),
      ]);

      return {
        uploadId: batch.uploadId,
        clientBatchId: batch.clientBatchId,
        state: batch.state,
        baseRevision: batch.baseRevision,
        targetRevision: batch.targetRevision,
        targetEpoch: batch.targetEpoch,
        expiresAt: batch.expiresAt,
        createdAt: batch.createdAt,
        objectCount: itemCount?.cnt ?? 0,
        deletionCount: deletionCount?.cnt ?? 0,
      };
    },

    async beginForceAbort(uploadId, now) {
      const result = await db.prepare(
        `UPDATE sync_upload_batches SET state='cancelling',last_error='force-aborted',updated_at=?2
         WHERE upload_id=?1 AND state='prepared'`,
      ).bind(uploadId, now).run();
      if ((result.meta?.changes ?? 0) === 1) return true;
      const batch = await this.getBatch(uploadId);
      return batch?.state === "cancelling";
    },

    async checkHealth() {
      const row = await db.prepare("SELECT 1 AS ok").first<{ ok: number }>();
      return row?.ok === 1;
    },
  };
}

export function isConstraintConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("constraint failed") || message.includes("UNIQUE constraint failed");
}

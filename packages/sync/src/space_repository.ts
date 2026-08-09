// Space revision 协议 D1 持久化层。

import type {
  AssetRow,
  CommitResult,
  DeleteItemRow,
  SpaceRow,
  TransactionInfo,
  UploadBatchRow,
  UploadItemRow,
} from "./space_model";

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
  r2Versions: Record<string, string>;
  result: CommitResult;
  committedAt: string;
}

export interface SpaceRepository {
  createSpace(space: SpaceRow): Promise<boolean>;
  getSpace(spaceId: string): Promise<SpaceRow | null>;
  listAssets(spaceId: string): Promise<AssetRow[]>;
  getAsset(spaceId: string, assetType: string, assetId: string): Promise<AssetRow | null>;
  getBatch(uploadId: string): Promise<UploadBatchRow | null>;
  getBatchByClientId(spaceId: string, clientBatchId: string): Promise<UploadBatchRow | null>;
  getPendingBatch(spaceId: string): Promise<UploadBatchRow | null>;
  listRecoverableBatches(now: string, limit: number): Promise<UploadBatchRow[]>;
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
  beginCancel(uploadId: string, now: string): Promise<boolean>;
  finishCancel(uploadId: string, now: string): Promise<void>;
  setBatchError(uploadId: string, error: string, now: string): Promise<void>;
  /** 获取当前活跃事务详情（含 item/deletion 计数） */
  getTransactionDetail(spaceId: string): Promise<TransactionInfo | null>;
  /** 强制丢弃：允许 prepared 或 committing → cancelling */
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
    revision: row.revision as number,
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
    lastModifiedRevision: row.last_modified_revision as number,
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
    committedAt: row.committed_at as string,
  };
}

function mapBatch(row: Record<string, unknown>): UploadBatchRow {
  return {
    uploadId: row.upload_id as string,
    spaceId: row.space_id as string,
    clientBatchId: row.client_batch_id as string,
    baseRevision: row.base_revision as number,
    targetRevision: row.target_revision as number,
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
    state: row.state as DeleteItemRow["state"],
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function assetUpsert(
  db: D1Database,
  batch: UploadBatchRow,
  item: UploadItemRow,
  r2Version: string | null,
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
        committed_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'full',?13,
             ?14,CASE WHEN ?13='d1' THEN ?6 ELSE NULL END,
             CASE WHEN ?13='d1' THEN ?7 ELSE NULL END,
             CASE WHEN ?13='d1' THEN ?8 ELSE NULL END,
             ?15,CASE WHEN ?16=1 THEN 1 ELSE 0 END,
             CASE WHEN ?16=1 THEN ?6 ELSE NULL END,
             CASE WHEN ?16=1 THEN ?7 ELSE NULL END,
             CASE WHEN ?16=1 THEN ?8 ELSE NULL END,?17,?18)
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
       r2_present=CASE WHEN ?16=1 THEN 1 ELSE sync_assets.r2_present END,
       r2_blob_hash=CASE WHEN ?16=1 THEN ?6 ELSE sync_assets.r2_blob_hash END,
       r2_byte_size=CASE WHEN ?16=1 THEN ?7 ELSE sync_assets.r2_byte_size END,
       r2_encoding=CASE WHEN ?16=1 THEN ?8 ELSE sync_assets.r2_encoding END,
       r2_version=CASE WHEN ?16=1 THEN ?17 ELSE sync_assets.r2_version END,
       committed_at=?18`,
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
    item.objectKey,
    hasNewR2 ? 1 : 0,
    r2Version,
    committedAt,
  );
}

export function createSpaceRepository(db: D1Database): SpaceRepository {
  return {
    async createSpace(space) {
      const result = await db.prepare(
        `INSERT OR IGNORE INTO sync_spaces
           (space_id, revision, epoch, pending_upload_id, lock_expires_at, updated_at)
         VALUES (?1,?2,?3,NULL,NULL,?4)`,
      ).bind(space.spaceId, space.revision, space.epoch, space.updatedAt).run();
      return (result.meta?.changes ?? 0) === 1;
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
         WHERE b.state IN ('committing','cancelling')
            OR (b.state='prepared' AND b.expires_at<=?1)
         ORDER BY b.updated_at LIMIT ?2`,
      ).bind(now, limit).all<Record<string, unknown>>();
      return (result.results ?? []).map(mapBatch);
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
           ) THEN 1 ELSE 0 END`,
        ).bind(batch.uploadId, batch.spaceId, batch.baseRevision),
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
           WHERE space_id=?1 AND revision=?5 AND pending_upload_id IS NULL`,
        ).bind(batch.spaceId, batch.uploadId, batch.expiresAt, lockedAt, batch.baseRevision),
      ];
      for (const item of items) {
        statements.push(db.prepare(
          `INSERT INTO sync_upload_items
             (upload_id,space_id,client_mutation_id,asset_type,asset_id,metadata,
              blob_hash,byte_size,encoding,schema_version,writer_app_version,writer_build_id,
              storage_mode,source_backend,target_backend,object_key,r2_multipart_upload_id,
              part_etag,d1_content,state,lease_expires_at,created_at,updated_at)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'full',?13,?14,?15,
                   NULL,NULL,NULL,?16,NULL,?17,?17)`,
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
        ));
      }
      for (const deletion of deletions) {
        statements.push(db.prepare(
          `INSERT INTO sync_delete_items
             (upload_id,space_id,client_mutation_id,asset_type,asset_id,object_key,
              state,created_at,updated_at)
           VALUES (?1,?2,?3,?4,?5,?6,'issued',?7,?7)`,
        ).bind(
          deletion.uploadId,
          deletion.spaceId,
          deletion.clientMutationId,
          deletion.assetType,
          deletion.assetId,
          deletion.objectKey,
          deletion.createdAt,
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
                      WHERE b.upload_id=?1 AND b.state='prepared' AND b.expires_at>?5)
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
         WHERE upload_id=?1 AND asset_type=?2 AND asset_id=?3 AND state='reserved'
           AND EXISTS(SELECT 1 FROM sync_upload_batches b
                      WHERE b.upload_id=?1 AND b.state='committing')`,
      ).bind(uploadId, assetType, assetId, now).run();
      return (result.meta?.changes ?? 0) === 1;
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

    async finalizeCommit({ batch, items, deletions, r2Versions, result, committedAt }) {
      const guardId = `${batch.uploadId}:finalize`;
      const statements: D1PreparedStatement[] = [
        db.prepare(
          `INSERT INTO sync_operation_guards(operation_id,guard_key,ok)
           SELECT ?1,'batch',CASE WHEN EXISTS(
             SELECT 1 FROM sync_upload_batches b
             JOIN sync_spaces s ON s.space_id=b.space_id AND s.pending_upload_id=b.upload_id
             WHERE b.upload_id=?2 AND b.state='committing' AND s.revision=b.base_revision
           ) THEN 1 ELSE 0 END`,
        ).bind(guardId, batch.uploadId),
      ];
      for (const item of items) {
        statements.push(assetUpsert(
          db,
          batch,
          item,
          r2Versions[`${item.assetType}\u0000${item.assetId}`] ?? null,
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
           WHERE space_id=?1 AND revision=?5 AND pending_upload_id=?6`,
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
           WHERE upload_id=?1 AND state='deleted'`,
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
         WHERE upload_id=?1 AND state IN ('prepared','committing')`,
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

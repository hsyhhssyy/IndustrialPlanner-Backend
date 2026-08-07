// D1 持久化层 — 数据库操作
//
// 职责：封装 D1 CRUD，不决定业务策略。

import type { RemoteAssetHead, SyncSpace } from "./model";

// ============================================================================
// 数据库行类型（与 D1 表结构对应）
// ============================================================================

export interface SpaceRow {
  spaceId: string;
  activeEpoch: string;
  head: number;
  minRetainedHead: number;
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
  };
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
          `SELECT space_id, active_epoch, head, min_retained_head, updated_at
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
           WHERE space_id = ?3 AND active_epoch = ?4`,
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

    async listAssetHeads(
      spaceId: string,
      epoch: string,
      assetTypes?: string[],
    ): Promise<AssetHeadWithBlob[]> {
      let sql = `
        SELECT
          a.asset_type, a.asset_id, a.revision, a.content_hash,
          a.schema_version, a.storage_mode, a.deleted_at,
          COALESCE(v.blob_hash, '') AS blob_hash,
          COALESCE(v.byte_size, 0) AS byte_size,
          COALESCE(v.encoding, 'identity') AS encoding
        FROM sync_assets a
        LEFT JOIN sync_asset_versions v
          ON v.space_id = a.space_id
          AND v.epoch = a.epoch
          AND v.asset_type = a.asset_type
          AND v.asset_id = a.asset_id
          AND v.revision = a.revision
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
          COALESCE(v.blob_hash, '') AS blob_hash,
          COALESCE(v.byte_size, 0) AS byte_size,
          COALESCE(v.encoding, 'identity') AS encoding
        FROM sync_assets a
        LEFT JOIN sync_asset_versions v
          ON v.space_id = a.space_id
          AND v.epoch = a.epoch
          AND v.asset_type = a.asset_type
          AND v.asset_id = a.asset_id
          AND v.revision = a.revision
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

-- Sync Worker Phase 1 DDL
-- 同步空间
CREATE TABLE IF NOT EXISTS sync_spaces (
  space_id TEXT NOT NULL PRIMARY KEY,
  active_epoch TEXT NOT NULL,
  head INTEGER NOT NULL DEFAULT 0,
  min_retained_head INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- 资产当前头
CREATE TABLE IF NOT EXISTS sync_assets (
  space_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  current_head INTEGER NOT NULL,
  content_hash TEXT,
  deleted_at TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  min_readable_schema_version INTEGER NOT NULL DEFAULT 1,
  writer_app_version TEXT NOT NULL,
  writer_build_id TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  storage_mode TEXT,
  base_full_blob_hash TEXT,
  delta_depth INTEGER DEFAULT 0,
  PRIMARY KEY (space_id, epoch, asset_type, asset_id)
);

-- 资产版本历史（full/delta 谱系）
CREATE TABLE IF NOT EXISTS sync_asset_versions (
  space_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  kind TEXT NOT NULL,
  base_content_hash TEXT,
  target_content_hash TEXT,
  blob_hash TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  encoding TEXT NOT NULL DEFAULT 'identity',
  committed_head INTEGER NOT NULL,
  committed_at TEXT NOT NULL,
  client_mutation_id TEXT NOT NULL,
  PRIMARY KEY (space_id, epoch, asset_type, asset_id, revision),
  UNIQUE (space_id, epoch, client_mutation_id)
);

-- Blob 引用
CREATE TABLE IF NOT EXISTS sync_blobs (
  space_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  blob_hash TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  encoding TEXT NOT NULL DEFAULT 'identity',
  created_at TEXT NOT NULL,
  last_referenced_at TEXT NOT NULL,
  PRIMARY KEY (space_id, epoch, blob_hash)
);

-- 幂等结果
CREATE TABLE IF NOT EXISTS sync_mutation_results (
  space_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  client_mutation_id TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  applied_revision INTEGER NOT NULL,
  applied_head INTEGER NOT NULL,
  content_hash TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (space_id, epoch, client_mutation_id)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_assets_space_epoch
  ON sync_assets(space_id, epoch);

CREATE INDEX IF NOT EXISTS idx_versions_mutation
  ON sync_asset_versions(space_id, epoch, client_mutation_id);

CREATE INDEX IF NOT EXISTS idx_blobs_space_epoch
  ON sync_blobs(space_id, epoch);

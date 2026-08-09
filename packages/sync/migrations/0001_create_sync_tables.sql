-- Sync Worker cf-sync-v2 DDL
-- AI-CORRECTION 2026-08-09: 未上线环境直接收敛为 space revision + space 独占上传事务。
-- revision 是每次完整 commit 的版本；epoch 是 full base / patch chain 世代。

CREATE TABLE sync_spaces (
  space_id TEXT NOT NULL PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  epoch INTEGER NOT NULL DEFAULT 0 CHECK (epoch >= 0),
  pending_upload_id TEXT,
  lock_expires_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK (
    (pending_upload_id IS NULL AND lock_expires_at IS NULL) OR
    (pending_upload_id IS NOT NULL AND lock_expires_at IS NOT NULL)
  )
);

CREATE TABLE sync_assets (
  space_id TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  last_modified_revision INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  encoding TEXT NOT NULL,
  metadata TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  writer_app_version TEXT NOT NULL,
  writer_build_id TEXT NOT NULL,
  storage_mode TEXT NOT NULL CHECK (storage_mode = 'full'),
  active_backend TEXT NOT NULL CHECK (active_backend IN ('d1', 'r2')),
  d1_content BLOB,
  d1_blob_hash TEXT,
  d1_byte_size INTEGER,
  d1_encoding TEXT,
  r2_key TEXT NOT NULL,
  r2_present INTEGER NOT NULL DEFAULT 0 CHECK (r2_present IN (0, 1)),
  r2_blob_hash TEXT,
  r2_byte_size INTEGER,
  r2_encoding TEXT,
  r2_version TEXT,
  committed_at TEXT NOT NULL,
  PRIMARY KEY (space_id, asset_type, asset_id),
  UNIQUE (r2_key)
);

CREATE INDEX idx_assets_space_revision
  ON sync_assets(space_id, last_modified_revision);

CREATE TABLE sync_upload_batches (
  upload_id TEXT NOT NULL PRIMARY KEY,
  space_id TEXT NOT NULL,
  client_batch_id TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  target_revision INTEGER NOT NULL,
  target_epoch INTEGER NOT NULL,
  descriptor_hash TEXT NOT NULL,
  state TEXT NOT NULL
    CHECK (state IN ('prepared', 'committing', 'committed', 'cancelling', 'cancelled')),
  expires_at TEXT NOT NULL,
  result_json TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (space_id, client_batch_id)
);

CREATE INDEX idx_upload_batches_recovery
  ON sync_upload_batches(state, expires_at, updated_at);

CREATE TABLE sync_upload_items (
  upload_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  client_mutation_id TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  metadata TEXT NOT NULL,
  blob_hash TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  encoding TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  writer_app_version TEXT NOT NULL,
  writer_build_id TEXT NOT NULL,
  storage_mode TEXT NOT NULL CHECK (storage_mode = 'full'),
  source_backend TEXT NOT NULL CHECK (source_backend IN ('d1', 'r2')),
  target_backend TEXT NOT NULL CHECK (target_backend IN ('d1', 'r2')),
  object_key TEXT NOT NULL,
  r2_multipart_upload_id TEXT,
  part_etag TEXT,
  d1_content BLOB,
  state TEXT NOT NULL
    CHECK (state IN ('issued', 'uploading', 'ready', 'reserved', 'committed', 'cancelled')),
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (upload_id, asset_type, asset_id),
  UNIQUE (upload_id, client_mutation_id)
);

CREATE INDEX idx_upload_items_upload_state
  ON sync_upload_items(upload_id, state);

-- D1 batch 内把 CAS 前置条件转换为可回滚的 CHECK 失败。
CREATE TABLE sync_operation_guards (
  operation_id TEXT NOT NULL,
  guard_key TEXT NOT NULL,
  ok INTEGER NOT NULL CHECK (ok = 1),
  PRIMARY KEY (operation_id, guard_key)
);

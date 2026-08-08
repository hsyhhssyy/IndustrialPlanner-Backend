-- Sync Worker Phase 3 DDL
-- S1-RQ-007：每资产最新态 D1/R2 分层、固定 R2 key 与可恢复提交屏障

ALTER TABLE sync_spaces ADD COLUMN pending_commit_id TEXT;

CREATE TABLE IF NOT EXISTS sync_asset_storage (
  space_id TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  active_epoch TEXT NOT NULL,
  active_backend TEXT NOT NULL CHECK (active_backend IN ('d1', 'r2')),
  storage_state TEXT NOT NULL DEFAULT 'stable'
    CHECK (storage_state IN ('stable', 'committing', 'deleting')),
  current_blob_hash TEXT NOT NULL,
  current_byte_size INTEGER NOT NULL,
  current_encoding TEXT NOT NULL,
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
  pending_commit_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (space_id, asset_type, asset_id),
  UNIQUE (r2_key)
);

CREATE INDEX IF NOT EXISTS idx_asset_storage_current_hash
  ON sync_asset_storage(space_id, active_epoch, current_blob_hash);

CREATE TABLE IF NOT EXISTS sync_upload_sessions (
  session_id TEXT NOT NULL PRIMARY KEY,
  space_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  source_backend TEXT NOT NULL CHECK (source_backend IN ('d1', 'r2')),
  target_backend TEXT NOT NULL CHECK (target_backend IN ('d1', 'r2')),
  object_key TEXT NOT NULL,
  blob_hash TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  encoding TEXT NOT NULL,
  r2_multipart_upload_id TEXT,
  part_etag TEXT,
  d1_content BLOB,
  state TEXT NOT NULL
    CHECK (state IN ('issued', 'uploading', 'uploaded', 'reserved', 'aborted')),
  lease_expires_at TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (space_id, asset_type, asset_id)
);

CREATE INDEX IF NOT EXISTS idx_upload_sessions_expiry
  ON sync_upload_sessions(expires_at);

CREATE TABLE IF NOT EXISTS sync_commit_intents (
  commit_id TEXT NOT NULL PRIMARY KEY,
  space_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  expected_head INTEGER NOT NULL,
  new_head INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL
    CHECK (state IN ('reserved', 'r2_writing', 'finalizing', 'complete')),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_commit_intents_active_space
  ON sync_commit_intents(space_id)
  WHERE state != 'complete';

CREATE TABLE IF NOT EXISTS sync_commit_guards (
  commit_id TEXT NOT NULL,
  guard_key TEXT NOT NULL,
  ok INTEGER NOT NULL CHECK (ok = 1),
  PRIMARY KEY (commit_id, guard_key)
);

CREATE TABLE IF NOT EXISTS sync_delete_intents (
  delete_id TEXT NOT NULL PRIMARY KEY,
  space_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  expected_revision INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'r2_deleting', 'complete')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_delete_intents_active_asset
  ON sync_delete_intents(space_id, asset_type, asset_id)
  WHERE state != 'complete';

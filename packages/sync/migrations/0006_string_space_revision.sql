-- AI-CORRECTION 2026-08-12: space revision 不再是递增整数，而是
-- prepare 原始 request content 的 SHA-256、横线与服务端 Unix 毫秒时间戳组成的字符串。
-- epoch 继续保留为数值顺序；revision、base_revision、target_revision 和
-- last_modified_revision 只承担身份、CAS 与来源标记。
-- 已有整数值原样 CAST 为十进制字符串，后续成功 commit 后自然切换为新格式。

ALTER TABLE sync_spaces RENAME TO sync_spaces_integer_revision;

CREATE TABLE sync_spaces (
  space_id TEXT NOT NULL PRIMARY KEY,
  revision TEXT NOT NULL DEFAULT '0'
    CHECK (typeof(revision) = 'text' AND length(revision) > 0),
  epoch INTEGER NOT NULL DEFAULT 0 CHECK (epoch >= 0),
  pending_upload_id TEXT,
  lock_expires_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK (
    (pending_upload_id IS NULL AND lock_expires_at IS NULL) OR
    (pending_upload_id IS NOT NULL AND lock_expires_at IS NOT NULL)
  )
);

INSERT INTO sync_spaces
  (space_id, revision, epoch, pending_upload_id, lock_expires_at, updated_at)
SELECT
  space_id, CAST(revision AS TEXT), epoch, pending_upload_id, lock_expires_at, updated_at
FROM sync_spaces_integer_revision;

DROP TABLE sync_spaces_integer_revision;

CREATE INDEX idx_spaces_pending_upload
  ON sync_spaces(pending_upload_id);

ALTER TABLE sync_assets RENAME TO sync_assets_integer_revision;

CREATE TABLE sync_assets (
  space_id TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  last_modified_revision TEXT NOT NULL
    CHECK (typeof(last_modified_revision) = 'text' AND length(last_modified_revision) > 0),
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

INSERT INTO sync_assets
  (space_id, asset_type, asset_id, epoch, last_modified_revision,
   content_hash, byte_size, encoding, metadata, schema_version,
   writer_app_version, writer_build_id, storage_mode, active_backend,
   d1_content, d1_blob_hash, d1_byte_size, d1_encoding,
   r2_key, r2_present, r2_blob_hash, r2_byte_size, r2_encoding, r2_version,
   committed_at)
SELECT
  space_id, asset_type, asset_id, epoch, CAST(last_modified_revision AS TEXT),
  content_hash, byte_size, encoding, metadata, schema_version,
  writer_app_version, writer_build_id, storage_mode, active_backend,
  d1_content, d1_blob_hash, d1_byte_size, d1_encoding,
  r2_key, r2_present, r2_blob_hash, r2_byte_size, r2_encoding, r2_version,
  committed_at
FROM sync_assets_integer_revision;

DROP TABLE sync_assets_integer_revision;

CREATE INDEX idx_assets_space_revision
  ON sync_assets(space_id, last_modified_revision);

ALTER TABLE sync_upload_batches RENAME TO sync_upload_batches_integer_revision;

CREATE TABLE sync_upload_batches (
  upload_id TEXT NOT NULL PRIMARY KEY,
  space_id TEXT NOT NULL,
  client_batch_id TEXT NOT NULL,
  base_revision TEXT NOT NULL
    CHECK (typeof(base_revision) = 'text' AND length(base_revision) > 0),
  target_revision TEXT NOT NULL
    CHECK (typeof(target_revision) = 'text' AND length(target_revision) > 0),
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

INSERT INTO sync_upload_batches
  (upload_id, space_id, client_batch_id, base_revision, target_revision,
   target_epoch, descriptor_hash, state, expires_at, result_json, last_error,
   created_at, updated_at)
SELECT
  upload_id, space_id, client_batch_id, CAST(base_revision AS TEXT),
  CAST(target_revision AS TEXT), target_epoch, descriptor_hash, state, expires_at,
  result_json, last_error, created_at, updated_at
FROM sync_upload_batches_integer_revision;

DROP TABLE sync_upload_batches_integer_revision;

CREATE INDEX idx_upload_batches_recovery
  ON sync_upload_batches(state, expires_at, updated_at);

CREATE INDEX idx_upload_batches_space_state
  ON sync_upload_batches(space_id, state);

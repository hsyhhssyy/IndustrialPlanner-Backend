-- AI-CORRECTION 2026-08-09: cf-sync-v2 必须承接 REQ-007 的资产删除生命周期。
-- 删除项属于同一个 space 独占批次；R2 固定对象删除后由 committing recovery 向前完成 D1 finalize。

CREATE TABLE sync_delete_items (
  upload_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  client_mutation_id TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  state TEXT NOT NULL
    CHECK (state IN ('issued', 'reserved', 'deleted', 'committed', 'cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (upload_id, asset_type, asset_id),
  UNIQUE (upload_id, client_mutation_id)
);

CREATE INDEX idx_delete_items_upload_state
  ON sync_delete_items(upload_id, state);

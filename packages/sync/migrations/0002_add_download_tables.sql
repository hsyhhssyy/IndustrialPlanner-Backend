-- Sync Worker Phase 2 DDL
-- 下载链路：模块级 head + 变更日志

-- 模块级 head（按 space + module_type 聚合，plan 用）
CREATE TABLE IF NOT EXISTS sync_module_heads (
  space_id TEXT NOT NULL,
  module_type TEXT NOT NULL,
  head INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (space_id, module_type)
);

-- 变更日志（增量下载用，check 查 sinceHead 之后的 delta）
CREATE TABLE IF NOT EXISTS sync_changes (
  space_id TEXT NOT NULL,
  head INTEGER NOT NULL,
  asset_type TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'upsert',
  created_at TEXT NOT NULL,
  PRIMARY KEY (space_id, head, asset_type, asset_id)
);

CREATE INDEX IF NOT EXISTS idx_changes_space_head
  ON sync_changes(space_id, head);

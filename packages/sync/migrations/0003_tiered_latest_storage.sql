-- AI-REMOVED 2026-08-09:
-- Reason: 分资产 session/commit intent 被 space 上传批次统一状态机替代。
-- Trigger: prepare 必须在第一步锁定整个 space，并持有 15 分钟租约。
-- Evidence: 新 schema 的 sync_upload_batches/sync_upload_items/pending_upload_id。
-- Replacement: 0001_create_sync_tables.sql
-- Risk: Low（项目未上线，Live/Beta 同步数据已清理）。
-- Human Review: Required
-- Original code: 旧 migration 完整内容由 Git 历史保留；D1 migration 执行器不接受块注释归档。

CREATE INDEX IF NOT EXISTS idx_upload_batches_space_state
  ON sync_upload_batches(space_id, state);

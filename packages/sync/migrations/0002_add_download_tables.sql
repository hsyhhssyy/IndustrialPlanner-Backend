-- AI-REMOVED 2026-08-09:
-- Reason: cf-sync-v2 使用 space revision，不再维护 head 变更流水。
-- Trigger: 用户确认整个 space 是唯一提交与并发边界。
-- Evidence: prepare 持有 space 独占租约，commit 每批只推进一次 revision。
-- Replacement: 0001_create_sync_tables.sql 的 sync_spaces.revision 与全量 plan。
-- Risk: Low（项目未上线，Live/Beta 同步数据已清理）。
-- Human Review: Required
-- Original code: 旧 migration 完整内容由 Git 历史保留；D1 migration 执行器不接受块注释归档。

CREATE INDEX IF NOT EXISTS idx_spaces_pending_upload
  ON sync_spaces(pending_upload_id);

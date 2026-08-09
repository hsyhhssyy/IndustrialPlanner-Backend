-- AI-REMOVED 2026-08-09:
-- Reason: active cf-sync-v2 不再使用旧 head/delete intent schema。
-- Trigger: space revision 与 space 独占上传事务替代旧并发模型。
-- Evidence: 0001_create_sync_tables.sql
-- Replacement: None（资产集合变更后续统一进入 space 批次协议）。
-- Risk: 资产删除接口暂不属于本次 full-only 上传切片。
-- AI-CORRECTION 2026-08-09: 资产删除现已由 0005_add_space_deletions.sql 纳入
-- cf-sync-v2 的 space 批次；本文件归档的是旧 head/delete-intent 实现，不代表删除仍在范围外。
-- Human Review: Required
-- Original code: 旧 migration 完整内容由 Git 历史保留；D1 migration 执行器不接受块注释归档。

CREATE INDEX IF NOT EXISTS idx_upload_items_lease
  ON sync_upload_items(state, lease_expires_at);

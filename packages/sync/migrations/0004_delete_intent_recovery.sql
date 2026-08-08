-- Sync Worker Phase 3.1 DDL
-- S1-RQ-007：资产删除 intent 保存完整恢复输入和待中止 multipart。

ALTER TABLE sync_delete_intents
  ADD COLUMN expected_head INTEGER NOT NULL DEFAULT 0;

ALTER TABLE sync_delete_intents
  ADD COLUMN multipart_upload_id TEXT;

ALTER TABLE sync_delete_intents
  ADD COLUMN payload_json TEXT NOT NULL DEFAULT '{}';

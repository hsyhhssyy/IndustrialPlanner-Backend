-- AI-CORRECTION 2026-08-24: R2 最新态存储恢复为每资产有界 A/B 双槽。
-- 现有 r2_key/r2_* 原地作为 A 槽；B 槽按需创建，不复制现有对象。
-- D1 payload 继续使用 upload item 暂存 + finalize 原子发布，不保留双份完成态 BLOB。

-- 旧版本的 pending R2 batch 仍会覆盖单一 active key，不能与解锁读取的新代码并存。
-- migration 因此要求部署前先由旧版本完成或取消所有活跃事务。
CREATE TABLE sync_migration_0009_guard (
  ok INTEGER NOT NULL CHECK (ok = 1)
);

INSERT INTO sync_migration_0009_guard(ok)
SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM sync_spaces WHERE pending_upload_id IS NOT NULL
) THEN 1 ELSE 0 END;

DROP TABLE sync_migration_0009_guard;

ALTER TABLE sync_assets
  ADD COLUMN r2_active_slot TEXT NOT NULL DEFAULT 'a'
    CHECK (r2_active_slot IN ('a', 'b'));

ALTER TABLE sync_assets ADD COLUMN r2_etag TEXT;

ALTER TABLE sync_assets
  ADD COLUMN r2_b_present INTEGER NOT NULL DEFAULT 0
    CHECK (r2_b_present IN (0, 1));

ALTER TABLE sync_assets ADD COLUMN r2_b_blob_hash TEXT;
ALTER TABLE sync_assets ADD COLUMN r2_b_byte_size INTEGER;
ALTER TABLE sync_assets ADD COLUMN r2_b_encoding TEXT;
ALTER TABLE sync_assets ADD COLUMN r2_b_version TEXT;
ALTER TABLE sync_assets ADD COLUMN r2_b_etag TEXT;

-- 旧批次可能在 migration 时仍存在，因此新增列保持 nullable；新写入由 trigger
-- 强制 R2 item 同时声明稳定 A key 与目标槽，D1 item 不得声明 R2 目标槽。
ALTER TABLE sync_upload_items ADD COLUMN r2_primary_key TEXT;
ALTER TABLE sync_upload_items
  ADD COLUMN target_r2_slot TEXT
    CHECK (target_r2_slot IS NULL OR target_r2_slot IN ('a', 'b'));

UPDATE sync_upload_items
SET r2_primary_key=object_key
WHERE r2_primary_key IS NULL;

UPDATE sync_upload_items
SET target_r2_slot='a'
WHERE target_backend='r2' AND target_r2_slot IS NULL;

CREATE TRIGGER validate_sync_upload_item_r2_slot_insert
BEFORE INSERT ON sync_upload_items
WHEN (
  NEW.target_backend = 'r2'
  AND (NEW.r2_primary_key IS NULL OR NEW.target_r2_slot IS NULL)
) OR (
  NEW.target_backend = 'd1'
  AND NEW.target_r2_slot IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'invalid sync upload item r2 slot');
END;

CREATE TRIGGER validate_sync_upload_item_r2_slot_update
BEFORE UPDATE OF target_backend, r2_primary_key, target_r2_slot ON sync_upload_items
WHEN (
  NEW.target_backend = 'r2'
  AND (NEW.r2_primary_key IS NULL OR NEW.target_r2_slot IS NULL)
) OR (
  NEW.target_backend = 'd1'
  AND NEW.target_r2_slot IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'invalid sync upload item r2 slot');
END;

-- 删除 revision 发布后异步清理 A/B 两个对象；旧行只含 A key 时由 repository
-- 从 object_key 派生 B key，避免 migration 访问或复制 R2。
ALTER TABLE sync_delete_items ADD COLUMN object_key_b TEXT;

-- 前端 E2E 匿名 Space 固定存活一小时；到期后先进入 deleting，再由 Cron 分步清理 D1/R2。
ALTER TABLE sync_spaces
  ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'active'
  CHECK (lifecycle_state IN ('active', 'deleting'));

ALTER TABLE sync_spaces
  ADD COLUMN expires_at TEXT;

ALTER TABLE sync_spaces
  ADD COLUMN cleanup_lease_expires_at TEXT;

-- 存量 E2E Space 无可靠 created_at，只能从 migration 应用时重新获得一小时清理窗口。
UPDATE sync_spaces
SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 hour')
WHERE owner_kind = 'anonymous'
  AND substr(space_id, 1, 7) = 'e2e-cf-';

CREATE INDEX idx_sync_spaces_ephemeral_cleanup
  ON sync_spaces(lifecycle_state, expires_at, cleanup_lease_expires_at)
  WHERE owner_kind = 'anonymous' AND expires_at IS NOT NULL;

CREATE INDEX idx_sync_upload_items_space_cleanup
  ON sync_upload_items(space_id, upload_id, asset_type, asset_id);

CREATE INDEX idx_sync_delete_items_space_cleanup
  ON sync_delete_items(space_id, upload_id, asset_type, asset_id);

CREATE TRIGGER trg_sync_spaces_lifecycle_insert
BEFORE INSERT ON sync_spaces
WHEN
  (NEW.owner_kind = 'account' AND (
    NEW.expires_at IS NOT NULL
    OR NEW.lifecycle_state != 'active'
    OR NEW.cleanup_lease_expires_at IS NOT NULL
  ))
  OR
  (NEW.owner_kind = 'anonymous' AND substr(NEW.space_id, 1, 7) = 'e2e-cf-'
    AND NEW.expires_at IS NULL)
  OR
  (NEW.expires_at IS NOT NULL AND NOT (
    NEW.owner_kind = 'anonymous' AND substr(NEW.space_id, 1, 7) = 'e2e-cf-'
  ))
  OR
  (NEW.lifecycle_state = 'active' AND NEW.cleanup_lease_expires_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'invalid sync space lifecycle');
END;

CREATE TRIGGER trg_sync_spaces_lifecycle_update
BEFORE UPDATE OF space_id, owner_kind, owner_id, lifecycle_state, expires_at, cleanup_lease_expires_at ON sync_spaces
WHEN
  (NEW.owner_kind = 'account' AND (
    NEW.expires_at IS NOT NULL
    OR NEW.lifecycle_state != 'active'
    OR NEW.cleanup_lease_expires_at IS NOT NULL
  ))
  OR
  (NEW.owner_kind = 'anonymous' AND substr(NEW.space_id, 1, 7) = 'e2e-cf-'
    AND NEW.expires_at IS NULL)
  OR
  (NEW.expires_at IS NOT NULL AND NOT (
    NEW.owner_kind = 'anonymous' AND substr(NEW.space_id, 1, 7) = 'e2e-cf-'
  ))
  OR
  (NEW.lifecycle_state = 'active' AND NEW.cleanup_lease_expires_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'invalid sync space lifecycle');
END;

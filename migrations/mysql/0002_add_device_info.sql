ALTER TABLE sync_shadow_telemetry
    ADD COLUMN device_type VARCHAR(16) NULL,
    ADD COLUMN screen_width INT UNSIGNED NULL,
    ADD COLUMN screen_height INT UNSIGNED NULL,
    ADD COLUMN device_pixel_ratio DOUBLE NULL,
    ADD CONSTRAINT sync_shadow_telemetry_device_type_check
        CHECK (device_type IS NULL OR device_type IN ('tablet', 'mobile', 'pc'));

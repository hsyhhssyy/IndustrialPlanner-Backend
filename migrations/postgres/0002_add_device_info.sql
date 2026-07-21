ALTER TABLE sync_shadow_telemetry
    ADD COLUMN device_type TEXT NULL,
    ADD COLUMN screen_width INTEGER NULL,
    ADD COLUMN screen_height INTEGER NULL,
    ADD COLUMN device_pixel_ratio DOUBLE PRECISION NULL,
    ADD CONSTRAINT sync_shadow_telemetry_device_type_check
        CHECK (device_type IS NULL OR device_type IN ('tablet', 'mobile', 'pc'));

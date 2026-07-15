# 数据库迁移目录

运行时代码根据 `DATABASE_URL` 选择且只加载以下其中一个目录：

- `postgres/`：PostgreSQL migration。
- `mysql/`：MySQL 8.0.16+ migration。

两个目录的 migration 版本号和逻辑约束必须保持同步，但 SQL 文本可以因方言不同而不同。

根目录的 `0001_create_sync_shadow_telemetry.sql` 是最初仅支持 PostgreSQL 时的历史副本。它被保留以兼容已经执行过该版本的 PostgreSQL 环境；`postgres/0001_create_sync_shadow_telemetry.sql` 与其内容相同，使 SQLx 可验证既有 checksum。新代码不得再从根目录加载 migration。

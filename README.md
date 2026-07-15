# Industrial Planner Backend

Rust 后端的首个可部署版本，当前仅实现供前端影子验证使用的匿名遥测接收：

- `GET /health`：前端可达性检查；已配置的 PostgreSQL 或 MySQL 可用时返回 `200`。
- `POST /v1/telemetry/sync-shadow`：接收已脱敏的同步摘要，成功返回 `204`。
- `GET /livez`：进程存活探针。
- `GET /readyz`：关系型数据库就绪探针。

服务不持有任何本地会话或文件。每个部署实例选择 PostgreSQL 或 MySQL 作为唯一持久化来源；Redis 仅做跨 Pod 限流。Redis 故障会记录告警并降级为可接收遥测，避免临时基础设施降低服务可用性。

## 业务模块骨架

当前已预留以下互相隔离的业务能力；尚未开放对应接口或创建业务表：

- `identity`：邮箱密码账户、邮箱验证、密码找回和会话。
- `oauth`：未来的 OAuth 登录关联与第三方授权连接；当前不接入 Provider。
- `assets`：蓝图、基地、配置项、工具箱工作内容及资产数量配额。
- `sync`：revision 条件写入与客户端冲突决策；服务端不自动合并。
- `telemetry`：现有匿名临时遥测，与正式账户和同步隔离。

详细边界与依赖方向见 `.docs/common/业务模块架构设计.md` 和 `.docs/common/项目模块隔离开原则发规范.md`。

## 本地运行

需要 Rust 1.85+、PostgreSQL 或 MySQL，以及可选的 Redis。复制并填写环境变量后运行：

```bash
cp .env.example .env
set -a; source .env; set +a
cargo run
```

服务启动时根据 `DATABASE_URL` 自动执行 `migrations/postgres/` 或 `migrations/mysql/` 中的数据库迁移。生产环境不要使用 `.env`，而应由 Kubernetes Secret 在**容器运行时**注入 `DATABASE_URL` 和 `REDIS_URL`。

支持 `postgres://`、`postgresql://` 和 `mysql://`。MySQL 需要 8.0.16+；单个部署实例只连接一种数据库，切换数据库类型需要独立的数据迁移计划。

## API 约定

`POST /v1/telemetry/sync-shadow` 只接受前端当前使用的 `schemaVersion: 1` JSON 合约。请求限制为 64 KiB，未知字段、非哈希标识、超过上限的事件/摘要或非法汇总数据均返回 `400`。相同 `installIdHash + createdAt + trigger` 的请求始终返回 `204` 而不重复落库；这个约束由已配置 PostgreSQL 或 MySQL 中的唯一索引保证，因此 Redis 故障或多 Pod 并发都不会丢失首次写入。

所有响应都允许跨域访问（`Access-Control-Allow-Origin: *`），符合当前前端的 `credentials: omit` 调用方式。接口是刻意开放的匿名遥测入口，不应视为身份认证边界。

## 限流与真实客户端 IP

若提供 `REDIS_URL`，服务会在所有 Pod 间统一实行固定窗口限流：每分钟总计 600 次、同一 `installIdHash` 30 次、同一客户端 IP 60 次；都可通过环境变量调整。

默认不相信 `X-Forwarded-For`。这防止公网客户端伪造 IP；代价是 Ingress 场景下可能只看到代理地址。确认入口到 Pod 的可信网段后，将它们填入 `TRUSTED_PROXY_CIDRS`（逗号分隔 CIDR）。服务仅在直连对端属于该名单时，从右向左分析 `X-Forwarded-For`，取最后一个非可信地址。`deploy/k8s/configmap.yaml` 保持安全空值，避免在不了解 k3s 网络拓扑时错误信任转发头。

## Kubernetes 部署

`deploy/k8s/` 包含 ConfigMap、Secret 示例、Deployment、Service 和 Ingress 示例。先创建不含真实凭据的 Secret 文件副本，再替换镜像与 TLS 配置：

```bash
kubectl apply -f deploy/k8s/configmap.yaml
kubectl apply -f deploy/k8s/secret.yaml
kubectl apply -f deploy/k8s/deployment.yaml
kubectl apply -f deploy/k8s/service.yaml
```

按实际域名、证书 Secret 和 Ingress Controller 修改 `ingress.example.yaml` 后才应用它。三个生产 API 域名可以在同一个 Ingress 的 `tls.hosts` 与 `rules` 中各追加一个条目，全部指向同一 Service。

## 数据保留

当前不部署自动清理设施。遥测仅为短期影子验证数据，开发者可按数据库类型手动清除，例如保留 60 天：

PostgreSQL：

```sql
DELETE FROM sync_shadow_telemetry
WHERE received_at < now() - INTERVAL '60 days';
```

MySQL：

```sql
DELETE FROM sync_shadow_telemetry
WHERE received_at < DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 60 DAY);
```

在确定保留策略前，不建议启用 CronJob，以免多个环境产生意外的数据删除任务。

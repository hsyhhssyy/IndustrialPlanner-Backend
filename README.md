# IndustrialPlanner Backend

> 下一代工业生产规划引擎的后端服务集群。基于 Cloudflare Workers 边缘计算，微秒级冷启动，全球就近响应。虽然你现在还用不上。

## 架构总览

```
                  ┌─────────┐
                  │ Gateway │  ← 统一入口 & 路由
                  └────┬────┘
       ┌───────────────┼───────────────┐
  ┌────┴────┐   ┌──────┴──────┐   ┌────┴─────┐
  │Identity │   │    Sync     │   │   OAuth   │
  │ 身份认证 │   │  数据同步    │   │  第三方登录 │
  └─────────┘   └──────┬──────┘   └──────────┘
                  ┌────┴────┐
             ┌────┴───┐ ┌───┴─────┐
             │  D1    │ │   R2    │
             │ SQLite │ │ 对象存储  │
             └────────┘ └─────────┘
```

## 模块说明

| 包 | 职责 |
|---|---|
| `gateway` | Hono 网关，请求路由、CORS、JWT 校验 |
| `identity` | 用户身份管理与认证 |
| `sync` | 核心同步引擎，D1 + R2 持久化，支持 Docker 部署 |
| `oauth` | 第三方 OAuth 登录集成 |
| `telemetry` | 遥测 & 限流 |
| `shared` | 公共工具库（JWT、CORS、错误处理等） |
| `assets` | 静态资源服务 |

## 技术栈

- **Runtime**: Cloudflare Workers
- **框架**: Hono v4
- **语言**: TypeScript 5.8
- **包管理**: pnpm 11 (monorepo)
- **数据库**: Cloudflare D1 (SQLite)
- **存储**: Cloudflare R2
- **测试**: Vitest + Miniflare
- **容器化**: Docker (sync 模块)

## 部署信息

| 环境 | 版本 | 状态 |
|---|---|---|
| Production | `v0.1.1.0` | 🟢 运行中 |
| Beta | `v0.1.1.1-beta1` | 🟡 测试中 |

## 开发

```bash
# 安装依赖
pnpm install

# 类型检查 + 测试
pnpm typecheck
pnpm test

# 单个 Worker 开发
pnpm --filter @industrial/gateway dev

# Docker 本地运行 sync
make build && make run
```

> 需要 Node.js >= 22，Cloudflare 账号，以及 wrangler 配置好 API Token。

## 版本

当前正式版: **v0.1.1.0**  
最新预发布: **v0.1.1.1-beta1**

---
*这个 README 大约 90% 是废话，剩下 10% 等产品上线才有用。*

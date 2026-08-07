# ---- build stage ----
FROM node:22-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN npm install -g pnpm

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY packages/sync/package.json packages/sync/tsconfig.json ./packages/sync/

RUN pnpm install --frozen-lockfile

# 在 install 之后复制源码和配置（避免缓存旧 wrangler.toml）
COPY packages/shared/src ./packages/shared/src
COPY packages/sync/src ./packages/sync/src
COPY packages/sync/migrations ./packages/sync/migrations
COPY packages/sync/wrangler.toml ./packages/sync/

# ---- runtime stage ----
FROM node:22-slim

WORKDIR /app

# 必需的系统依赖（better-sqlite3 / workerd 需要）
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# 从 build 阶段复制完整的 node_modules（含 wrangler + better-sqlite3）
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./

# .dev.vars 注入环境变量（LOCAL_DEV_HOST 运行时 -e 覆盖）
COPY packages/sync/.dev.vars.docker packages/sync/.dev.vars

# NODE_PATH 让 npx 在项目内找到 wrangler
ENV PATH="/app/node_modules/.bin:${PATH}"

EXPOSE 8080

CMD ["bash", "-c", "\
  cd packages/sync && \
  wrangler d1 migrations apply sync-db --local --persist-to /data && \
  exec wrangler dev --ip 0.0.0.0 --port 8080 --persist-to /data \
  "]

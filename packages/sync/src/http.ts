// HTTP 适配层 — 路由与请求/响应转换

import { Hono } from "hono";
import type { Context } from "hono";
import {
  handleCorsPreflight,
  withCors,
  ANONYMOUS_CORS_HEADERS,
  Errors,
} from "@industrial/shared";
import {
  validateProtocolVersion,
  validateMutationBatch,
  DEFAULT_MAX_MUTATIONS_PER_BATCH,
  DEFAULT_MAX_METADATA_SIZE,
  DEFAULT_R2_ENTER_THRESHOLD_BYTES,
  DEFAULT_D1_RETURN_THRESHOLD_BYTES,
  DEFAULT_MAX_BATCH_D1_BLOB_BYTES,
  DEFAULT_MAX_R2_BLOB_BYTES,
  type PrepareMutation,
  type CommitMutationsRequest,
  type DeleteAssetRequest,
} from "./model";
import {
  handlePrepare,
  handleCommit,
  handlePlan,
  handleCheck,
  handleReset,
  handleDownloadsSign,
  handlePayloadUpload,
  handlePayloadDownload,
  recoverPendingCommit,
  handleDeleteAsset,
  StorageProtocolError,
  type TieredStorageConfig,
} from "./service";
import { createRepository } from "./repository";

// Sync Worker 环境绑定类型
export interface SyncEnv {
  DB: D1Database;
  BLOB_STORE: R2Bucket;
  PROTOCOL_VERSION: string;
  MAX_MUTATIONS_PER_BATCH: string;
  MAX_METADATA_SIZE: string;
  R2_ENTER_THRESHOLD_BYTES?: string;
  D1_RETURN_THRESHOLD_BYTES?: string;
  MAX_BATCH_D1_BLOB_BYTES?: string;
  MAX_R2_BLOB_BYTES?: string;
  RETENTION_HEAD_WINDOW?: string;
  COMMIT_TOKEN_SECRET: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_ACCOUNT_ID: string;
  R2_BUCKET_NAME: string;
  /** 本地开发时直传 URL 的 base host（如 http://localhost:8792），空串表示使用 S3 预签名 */
  LOCAL_DEV_HOST: string;
  /** 对外能力 URL 的 origin；为空时使用当前请求 origin。 */
  PUBLIC_BASE_URL?: string;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function storageConfig(env: SyncEnv): TieredStorageConfig {
  return {
    r2EnterThresholdBytes: positiveInteger(
      env.R2_ENTER_THRESHOLD_BYTES,
      DEFAULT_R2_ENTER_THRESHOLD_BYTES,
    ),
    d1ReturnThresholdBytes: positiveInteger(
      env.D1_RETURN_THRESHOLD_BYTES,
      DEFAULT_D1_RETURN_THRESHOLD_BYTES,
    ),
    maxBatchD1BlobBytes: positiveInteger(
      env.MAX_BATCH_D1_BLOB_BYTES,
      DEFAULT_MAX_BATCH_D1_BLOB_BYTES,
    ),
    maxR2BlobBytes: positiveInteger(
      env.MAX_R2_BLOB_BYTES,
      DEFAULT_MAX_R2_BLOB_BYTES,
    ),
    retentionHeadWindow: positiveInteger(env.RETENTION_HEAD_WINDOW, 1000),
  };
}

function publicBaseUrl(c: Context<{ Bindings: SyncEnv }>): string {
  const configuredOrigin = c.env.PUBLIC_BASE_URL?.trim();
  if (configuredOrigin) return configuredOrigin.replace(/\/$/, "");

  const requestUrl = new URL(c.req.url);
  const forwardedProtocol = c.req.header("x-forwarded-proto")
    ?.split(",", 1)[0]
    ?.trim()
    .toLowerCase();
  // AI-CORRECTION 2026-08-09: Beta 的 Ingress 在 TLS 终止后以 http 调用 workerd；
  // 只允许可信代理信号把当前 origin 升级为 https，不接受 forwarded host，避免能力 URL 被 Host 注入。
  if (requestUrl.protocol === "http:" && forwardedProtocol === "https") {
    requestUrl.protocol = "https:";
  }
  return requestUrl.origin;
}

function requireCommitTokenSecret(env: SyncEnv): string {
  const secret = env.COMMIT_TOKEN_SECRET;
  if (typeof secret !== "string" || secret.length < 24) {
    throw new StorageProtocolError(
      503,
      "configuration_error",
      "COMMIT_TOKEN_SECRET 未配置或长度不足",
    );
  }
  return secret;
}

export function createApp() {
  const app = new Hono<{ Bindings: SyncEnv }>();

  app.onError((error, c) => {
    if (error instanceof StorageProtocolError) {
      return wrapWithCors(c.json({ error: error.code, message: error.message }, error.status as 400));
    }
    console.error("[sync] 未处理异常", error);
    return wrapWithCors(
      c.json({ error: "internal_error", message: "同步服务内部错误" }, 500),
    );
  });

  // CORS 预检 — 所有路径
  app.options("*", (c) => {
    return handleCorsPreflight(ANONYMOUS_CORS_HEADERS);
  });

  // 健康检查
  app.get("/health", (c) => {
    // D1 不存在时返回 503
    if (!c.env.DB) {
      return wrapWithCors(
        c.json(
          { error: "internal_error", message: "数据库不可用" },
          503,
        ),
      );
    }
    return wrapWithCors(
      c.json({ status: "ok", version: "0.1.0" }),
    );
  });

  // 能力声明
  app.get("/v1/sync/capabilities", (c) => {
    const tiering = storageConfig(c.env);
    return wrapWithCors(
      c.json({
        protocol: c.env.PROTOCOL_VERSION ?? "cf-sync-v1",
        maxMutationsPerBatch: parseInt(
          c.env.MAX_MUTATIONS_PER_BATCH ?? String(DEFAULT_MAX_MUTATIONS_PER_BATCH),
          10,
        ),
        maxMetadataSize: parseInt(
          c.env.MAX_METADATA_SIZE ?? String(DEFAULT_MAX_METADATA_SIZE),
          10,
        ),
        supportedStorageModes: ["full"],
        supportedEncodings: ["identity"],
        schemaVersions: [1],
        r2EnterThresholdBytes: tiering.r2EnterThresholdBytes,
        d1ReturnThresholdBytes: tiering.d1ReturnThresholdBytes,
        maxR2BlobBytes: tiering.maxR2BlobBytes,
      }),
    );
  });

  // 创建同步空间 — 管理端点，幂等
  app.post("/v1/sync/spaces", async (c) => {
    if (!c.env.DB) {
      return wrapWithCors(
        c.json({ error: "internal_error", message: "数据库不可用" }, 503),
      );
    }

    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return wrapWithCors(
        c.json({ error: "bad_request", message: "请求体不是合法 JSON" }, 400),
      );
    }

    const spaceId = body.spaceId as string | undefined;
    if (!spaceId || typeof spaceId !== "string" || spaceId.trim().length === 0) {
      return wrapWithCors(
        c.json({ error: "bad_request", message: "缺少 spaceId 字段" }, 400),
      );
    }

    const activeEpoch = (body.activeEpoch as string) || "epoch-001";
    const now = new Date().toISOString();

    const repo = createRepository(c.env.DB);

    // 防止覆盖已有空间：重复创建会变更 activeEpoch + 重置 head 为 0，
    // 导致旧 epoch 下已提交的资产在 plan 中不可见
    const existing = await repo.getSpaceHead(spaceId.trim());
    if (existing) {
      return wrapWithCors(
        c.json({ error: "conflict", message: "空间已存在" }, 409),
      );
    }

    await repo.insertSpace({
      spaceId: spaceId.trim(),
      activeEpoch,
      head: 0,
      minRetainedHead: 0,
      updatedAt: now,
    });

    return wrapWithCors(
      c.json({ ok: true, spaceId: spaceId.trim(), activeEpoch, createdAt: now }, 201),
    );
  });

  // check — 60s 小检查，返回 head 是否有变化
  app.get("/v1/sync/spaces/:spaceId/check", async (c) => {
    if (!c.env.DB) {
      return wrapWithCors(
        c.json({ error: "internal_error", message: "数据库不可用" }, 503),
      );
    }

    const spaceId = c.req.param("spaceId");
    const knownHeadParam = c.req.query("knownHead");
    const knownHead = knownHeadParam ? parseInt(knownHeadParam, 10) : null;
    if (knownHeadParam && (isNaN(knownHead!) || knownHead! < 0)) {
      return wrapWithCors(
        c.json({ error: "bad_request", message: "knownHead 必须是非负整数" }, 400),
      );
    }

    const repo = createRepository(c.env.DB);
    await recoverPendingCommit(spaceId, { repo, r2Bucket: c.env.BLOB_STORE });
    const result = await handleCheck(spaceId, knownHead, { repo });

    if (!result) {
      return wrapWithCors(
        c.json({ error: "not_found", message: "空间不存在" }, 404),
      );
    }

    // 无变更且客户端有已知 head → 204 No Content
    if (!result.changed && knownHead !== null) {
      return wrapWithCors(new Response(null, { status: 204 }));
    }

    return wrapWithCors(c.json(result, 200));
  });

  // ==================================================================
  // 本地 blob 直传 — PUT 写入 R2
  // AI-CORRECTION 2026-08-08: 当前端点同时承载 D1/R2 票据上传；裸路径不再可写。
  // ==================================================================
  app.put("/v1/sync/spaces/:spaceId/blobs/:epoch/sha256/:prefix/:blobHash", async (c) => {
    {
      const path = c.req.param();
      const ticket = c.req.query("ticket") ?? "";
      if (!ticket) {
        throw new StorageProtocolError(401, "token_invalid", "缺少上传票据");
      }
      if (!/^[0-9a-f]{64}$/.test(path.blobHash) || path.prefix !== path.blobHash.substring(0, 2)) {
        throw new StorageProtocolError(400, "bad_request", "非法 blobHash 或 prefix");
      }
      const contentLength = Number.parseInt(c.req.header("content-length") ?? "0", 10);
      const maximum = storageConfig(c.env).maxR2BlobBytes;
      if (Number.isFinite(contentLength) && contentLength > maximum) {
        throw new StorageProtocolError(413, "blob_too_large", "payload 超过文件上限");
      }
      const bytes = await c.req.arrayBuffer();
      if (bytes.byteLength > maximum) {
        throw new StorageProtocolError(413, "blob_too_large", "payload 超过文件上限");
      }
      const result = await handlePayloadUpload(path, ticket, bytes, {
        repo: createRepository(c.env.DB),
        r2Bucket: c.env.BLOB_STORE,
        commitTokenSecret: requireCommitTokenSecret(c.env),
        now: Date.now(),
      });
      return wrapWithCors(c.json({ ok: true, ...result }, 200));
    }

    const { spaceId, epoch, prefix, blobHash } = c.req.param();
    if (!spaceId || !epoch || !prefix || !blobHash) {
      return wrapWithCors(c.json({ error: "bad_request", message: "缺少路径参数" }, 400));
    }

    if (prefix.length !== 2 || blobHash.length !== 64) {
      return wrapWithCors(c.json({ error: "bad_request", message: "非法 blobHash" }, 400));
    }

    const key = `sync/v1/${spaceId}/${epoch}/blobs/sha256/${prefix}/${blobHash}`;
    try {
      const body = await c.req.arrayBuffer();
      await c.env.BLOB_STORE.put(key, body, {
        httpMetadata: { contentType: c.req.header("content-type") ?? "application/octet-stream" },
      });
      return wrapWithCors(c.json({ ok: true, key }, 200));
    } catch (e) {
      return wrapWithCors(
        c.json({ error: "internal_error", message: `R2 写入失败: ${(e as Error).message}` }, 500),
      );
    }
  });

  // ==================================================================
  // 本地 blob 下载 — GET 从 R2 读取
  // AI-CORRECTION 2026-08-08: 当前端点先验证版本绑定票据和 active_backend，再读取 D1/R2。
  // ==================================================================
  app.get("/v1/sync/spaces/:spaceId/blobs/:epoch/sha256/:prefix/:blobHash", async (c) => {
    {
      const path = c.req.param();
      const ticket = c.req.query("ticket") ?? "";
      if (!ticket) {
        throw new StorageProtocolError(401, "token_invalid", "缺少下载票据");
      }
      const repo = createRepository(c.env.DB);
      await recoverPendingCommit(path.spaceId, { repo, r2Bucket: c.env.BLOB_STORE });
      const result = await handlePayloadDownload(path, ticket, {
        repo,
        r2Bucket: c.env.BLOB_STORE,
        commitTokenSecret: requireCommitTokenSecret(c.env),
      });
      return wrapWithCors(new Response(result.body, { status: 200, headers: result.headers }));
    }

    const { spaceId, epoch, prefix, blobHash } = c.req.param();
    if (!spaceId || !epoch || !prefix || !blobHash) {
      return wrapWithCors(c.json({ error: "bad_request", message: "缺少路径参数" }, 400));
    }

    if (prefix.length !== 2 || blobHash.length !== 64) {
      return wrapWithCors(c.json({ error: "bad_request", message: "非法 blobHash" }, 400));
    }

    const key = `sync/v1/${spaceId}/${epoch}/blobs/sha256/${prefix}/${blobHash}`;
    try {
      const obj = await c.env.BLOB_STORE.get(key);
      if (!obj) {
        return wrapWithCors(c.json({ error: "not_found", message: "blob 不存在" }, 404));
      }
      const legacyObject = obj!;
      const headers = new Headers();
      headers.set("Content-Type", legacyObject.httpMetadata?.contentType ?? "application/octet-stream");
      const legacyCacheControl = legacyObject.httpMetadata?.cacheControl;
      if (legacyCacheControl) {
        headers.set("Cache-Control", String(legacyCacheControl));
      }
      return wrapWithCors(new Response(legacyObject.body, { headers, status: 200 }));
    } catch (e) {
      return wrapWithCors(
        c.json({ error: "internal_error", message: `R2 读取失败: ${(e as Error).message}` }, 500),
      );
    }
  });

  // plan — 启动/大检查入口，返回空间 head + 全量资产摘要
  app.get("/v1/sync/spaces/:spaceId/plan", async (c) => {
    if (!c.env.DB) {
      return wrapWithCors(
        c.json({ error: "internal_error", message: "数据库不可用" }, 503),
      );
    }

    const spaceId = c.req.param("spaceId");
    const assetTypesParam = c.req.query("assetTypes") ?? "";
    const assetTypes = assetTypesParam
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    const repo = createRepository(c.env.DB);
    const localDevHost = c.env.LOCAL_DEV_HOST ?? "";
    await recoverPendingCommit(spaceId, { repo, r2Bucket: c.env.BLOB_STORE });

    const maxMutationsPerBatch = parseInt(
      c.env.MAX_MUTATIONS_PER_BATCH ?? String(DEFAULT_MAX_MUTATIONS_PER_BATCH),
      10,
    );
    const maxMetadataSize = parseInt(
      c.env.MAX_METADATA_SIZE ?? String(DEFAULT_MAX_METADATA_SIZE),
      10,
    );

    const result = await handlePlan(spaceId, assetTypes, {
      repo,
      commitTokenSecret: requireCommitTokenSecret(c.env),
      publicBaseUrl: publicBaseUrl(c),
      capabilities: {
        protocol: c.env.PROTOCOL_VERSION ?? "cf-sync-v1",
        maxMutationsPerBatch,
        maxMetadataSize,
        supportedStorageModes: ["full"],
        supportedEncodings: ["identity"],
        schemaVersions: [1],
        r2EnterThresholdBytes: storageConfig(c.env).r2EnterThresholdBytes,
        d1ReturnThresholdBytes: storageConfig(c.env).d1ReturnThresholdBytes,
        maxR2BlobBytes: storageConfig(c.env).maxR2BlobBytes,
      },
    });

    if (!result) {
      return wrapWithCors(
        c.json({ error: "not_found", message: "空间不存在" }, 404),
      );
    }

    return wrapWithCors(c.json(result, 200));
  });

  // 批量操作：prepare + commit
  app.post("/v1/sync/spaces/:spaceId/mutations", async (c) => {
    // Content-Type 校验
    const contentType = c.req.header("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      return wrapWithCors(
        c.json(
          { error: "bad_request", message: "需要 Content-Type: application/json" },
          400,
        ),
      );
    }

    // JSON 解析
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return wrapWithCors(
        c.json(
          { error: "bad_request", message: "请求体不是合法 JSON" },
          400,
        ),
      );
    }

    const action = body.action as string | undefined;
    if (!action) {
      return wrapWithCors(
        c.json(
          { error: "bad_request", message: "缺少 action 字段" },
          400,
        ),
      );
    }

    // 协议版本校验
    const protocolVersion =
      c.env.PROTOCOL_VERSION ?? "cf-sync-v1";

    switch (action) {
      case "prepare": {
        const reqProtocol = body.protocol as string | undefined;
        if (!reqProtocol) {
          return wrapWithCors(
            c.json(
              { error: "bad_request", message: "缺少 protocol 字段" },
              400,
            ),
          );
        }

        const protoResult = validateProtocolVersion(reqProtocol);
        if (!protoResult.ok) {
          return wrapWithCors(
            c.json(
              {
                error: protoResult.code,
                message: protoResult.message,
              },
              422,
            ),
          );
        }

        const mutations = body.mutations as Array<unknown> | undefined;
        if (!Array.isArray(mutations)) {
          return wrapWithCors(
            c.json(
              { error: "bad_request", message: "mutations 必须是数组" },
              400,
            ),
          );
        }

        const maxBatch = parseInt(
          c.env.MAX_MUTATIONS_PER_BATCH ?? String(DEFAULT_MAX_MUTATIONS_PER_BATCH),
          10,
        );

        const batchResult = validateMutationBatch(
          mutations as Parameters<typeof validateMutationBatch>[0],
          maxBatch,
        );
        if (!batchResult.ok) {
          const status = batchResult.code === "batch_too_large" ? 413 : 400;
          return wrapWithCors(
            c.json(
              { error: batchResult.code, message: batchResult.message },
              status,
            ),
          );
        }

        // 调用 service 层
        const repo = createRepository(c.env.DB);
        const localDevHost = c.env.LOCAL_DEV_HOST ?? "";
        await recoverPendingCommit(c.req.param("spaceId"), {
          repo,
          r2Bucket: c.env.BLOB_STORE,
        });
        const result = await handlePrepare(
          c.req.param("spaceId"),
          (body.spaceEpoch as string) ?? (body.epoch as string) ?? "",
          (body.clientBatchId as string) ?? "",
          mutations as PrepareMutation[],
          {
            repo,
            // AI-CORRECTION 2026-08-08: active 协议不再使用可预测的 fallback HMAC secret。
            commitTokenSecret: requireCommitTokenSecret(c.env),
            r2Bucket: c.env.BLOB_STORE,
            publicBaseUrl: publicBaseUrl(c),
            now: Date.now(),
            storageConfig: storageConfig(c.env),
          },
        );

        if (result.status === "conflict") {
          return wrapWithCors(c.json(result, 409));
        }
        return wrapWithCors(c.json(result, 200));
      }

      case "commit": {
        const commitReq = body as unknown as CommitMutationsRequest;
        if (!commitReq.commitToken) {
          return wrapWithCors(
            c.json(
              { error: "bad_request", message: "缺少 commitToken 字段" },
              400,
            ),
          );
        }

        if (!Array.isArray(commitReq.mutations)) {
          return wrapWithCors(
            c.json(
              { error: "bad_request", message: "mutations 必须是数组" },
              400,
            ),
          );
        }

        const repo = createRepository(c.env.DB);
        const result = await handleCommit(
          c.req.param("spaceId"),
          (body.spaceEpoch as string) ?? (body.epoch as string) ?? "",
          commitReq.commitToken,
          commitReq.mutations,
          {
            repo,
            commitTokenSecret: requireCommitTokenSecret(c.env),
            r2Bucket: c.env.BLOB_STORE,
            now: Date.now(),
            presentTime: new Date().toISOString(),
            storageConfig: storageConfig(c.env),
          },
        );

        if (result.status === "conflict") {
          return wrapWithCors(c.json(result, 409));
        }
        return wrapWithCors(c.json(result, 200));
      }

      default:
        return wrapWithCors(
          c.json(
            { error: "bad_request", message: `未知 action: ${action}` },
            400,
          ),
        );
    }
  });

  // 批量签名下载 URL
  app.post("/v1/sync/spaces/:spaceId/downloads:sign", async (c) => {
    if (!c.env.DB) {
      return wrapWithCors(
        c.json({ error: "internal_error", message: "数据库不可用" }, 503),
      );
    }

    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return wrapWithCors(
        c.json({ error: "bad_request", message: "请求体不是合法 JSON" }, 400),
      );
    }

    const blobHashes = body.blobHashes as string[] | undefined;
    if (!Array.isArray(blobHashes)) {
      return wrapWithCors(
        c.json({ error: "bad_request", message: "缺少 blobHashes 数组字段" }, 400),
      );
    }

    const spaceId = c.req.param("spaceId");
    const repo = createRepository(c.env.DB);
    const localDevHost = c.env.LOCAL_DEV_HOST ?? "";
    await recoverPendingCommit(spaceId, { repo, r2Bucket: c.env.BLOB_STORE });

    const result = await handleDownloadsSign(spaceId, blobHashes, {
      repo,
      commitTokenSecret: requireCommitTokenSecret(c.env),
      publicBaseUrl: publicBaseUrl(c),
    });

    if (!result) {
      return wrapWithCors(
        c.json({ error: "not_found", message: "空间不存在" }, 404),
      );
    }

    return wrapWithCors(c.json(result, 200));
  });

  // 资产删除 — 建立 D1 屏障后删除固定 R2 key，并发布 tombstone/head
  app.delete("/v1/sync/spaces/:spaceId/assets/:assetType/:assetId", async (c) => {
    const contentType = c.req.header("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      throw new StorageProtocolError(400, "bad_request", "需要 Content-Type: application/json");
    }

    let body: DeleteAssetRequest;
    try {
      body = await c.req.json<DeleteAssetRequest>();
    } catch {
      throw new StorageProtocolError(400, "bad_request", "请求体不是合法 JSON");
    }
    if (!body.spaceEpoch || typeof body.spaceEpoch !== "string") {
      throw new StorageProtocolError(400, "bad_request", "缺少 spaceEpoch");
    }
    if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1) {
      throw new StorageProtocolError(400, "bad_request", "expectedRevision 必须是正整数");
    }
    const expectedContentHash = body.expectedContentHash ?? null;
    if (
      expectedContentHash !== null &&
      (typeof expectedContentHash !== "string" || !/^[0-9a-f]{64}$/.test(expectedContentHash))
    ) {
      throw new StorageProtocolError(400, "bad_request", "expectedContentHash 必须是小写 SHA-256");
    }

    const result = await handleDeleteAsset(
      c.req.param("spaceId"),
      c.req.param("assetType"),
      c.req.param("assetId"),
      {
        spaceEpoch: body.spaceEpoch,
        expectedRevision: body.expectedRevision,
        expectedContentHash,
      },
      {
        repo: createRepository(c.env.DB),
        r2Bucket: c.env.BLOB_STORE,
        now: Date.now(),
        storageConfig: storageConfig(c.env),
      },
    );
    return wrapWithCors(c.json(result, 200));
  });

  // 远端重置 — 递增 epoch + 重置 head
  app.post("/v1/sync/spaces/:spaceId/reset", async (c) => {
    if (!c.env.DB) {
      return wrapWithCors(
        c.json({ error: "internal_error", message: "数据库不可用" }, 503),
      );
    }

    const spaceId = c.req.param("spaceId");
    const repo = createRepository(c.env.DB);
    await recoverPendingCommit(spaceId, { repo, r2Bucket: c.env.BLOB_STORE });
    const result = await handleReset(spaceId, { repo });

    if (!result) {
      return wrapWithCors(
        c.json({ error: "not_found", message: "空间不存在" }, 404),
      );
    }

    return wrapWithCors(c.json(result, 200));
  });

  // 未匹配路由
  app.all("*", (c) => {
    const url = new URL(c.req.url);
    return wrapWithCors(
      c.json(
        { error: "not_found", message: `路径 ${url.pathname} 未实现` },
        404,
      ),
    );
  });

  return app;
}

// 为响应添加 CORS 头（应用层包装）
function wrapWithCors(response: Response): Response {
  return withCors(response, ANONYMOUS_CORS_HEADERS);
}

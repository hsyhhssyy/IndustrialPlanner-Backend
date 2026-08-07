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
  type PrepareMutation,
} from "./model";
import { handlePrepare, handleCommit, handlePlan, handleCheck, handleReset, handleDownloadsSign } from "./service";
import { createRepository } from "./repository";

// Sync Worker 环境绑定类型
export interface SyncEnv {
  DB: D1Database;
  BLOB_STORE: R2Bucket;
  PROTOCOL_VERSION: string;
  MAX_MUTATIONS_PER_BATCH: string;
  MAX_METADATA_SIZE: string;
  COMMIT_TOKEN_SECRET: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_ACCOUNT_ID: string;
  R2_BUCKET_NAME: string;
  /** 本地开发时直传 URL 的 base host（如 http://localhost:8792），空串表示使用 S3 预签名 */
  LOCAL_DEV_HOST: string;
}

export function createApp() {
  const app = new Hono<{ Bindings: SyncEnv }>();

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
  // ==================================================================
  app.put("/v1/sync/spaces/:spaceId/blobs/:epoch/sha256/:prefix/:blobHash", async (c) => {
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
      presignedUrlConfig: {
        accountId: c.env.R2_ACCOUNT_ID ?? "",
        accessKeyId: c.env.R2_ACCESS_KEY_ID ?? "",
        secretAccessKey: c.env.R2_SECRET_ACCESS_KEY ?? "",
        bucketName: c.env.R2_BUCKET_NAME ?? "industrial-sync-blobs",
      },
      localDevHost: localDevHost || undefined,
      capabilities: {
        protocol: c.env.PROTOCOL_VERSION ?? "cf-sync-v1",
        maxMutationsPerBatch,
        maxMetadataSize,
        supportedStorageModes: ["full"],
        supportedEncodings: ["identity"],
        schemaVersions: [1],
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
        const result = await handlePrepare(
          c.req.param("spaceId"),
          (body.spaceEpoch as string) ?? (body.epoch as string) ?? "",
          (body.clientBatchId as string) ?? "",
          mutations as PrepareMutation[],
          {
            repo,
            commitTokenSecret: c.env.COMMIT_TOKEN_SECRET ?? "dev-secret-key-32-bytes-long!!",
            presignedUrlConfig: {
              accountId: c.env.R2_ACCOUNT_ID ?? "",
              accessKeyId: c.env.R2_ACCESS_KEY_ID ?? "",
              secretAccessKey: c.env.R2_SECRET_ACCESS_KEY ?? "",
              bucketName: c.env.R2_BUCKET_NAME ?? "industrial-sync-blobs",
            },
            localDevHost: localDevHost || undefined,
            now: Date.now(),
          },
        );

        if (result.status === "conflict") {
          return wrapWithCors(c.json(result, 409));
        }
        return wrapWithCors(c.json(result, 200));
      }

      case "commit": {
        const commitToken = body.commitToken as string | undefined;
        if (!commitToken) {
          return wrapWithCors(
            c.json(
              { error: "bad_request", message: "缺少 commitToken 字段" },
              400,
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

        const repo = createRepository(c.env.DB);
        const result = await handleCommit(
          c.req.param("spaceId"),
          (body.spaceEpoch as string) ?? (body.epoch as string) ?? "",
          commitToken,
          mutations as PrepareMutation[],
          {
            repo,
            commitTokenSecret: c.env.COMMIT_TOKEN_SECRET ?? "dev-secret-key-32-bytes-long!!",
            r2Bucket: c.env.BLOB_STORE,
            now: Date.now(),
            presentTime: new Date().toISOString(),
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

    const result = await handleDownloadsSign(spaceId, blobHashes, {
      repo,
      presignedUrlConfig: {
        accountId: c.env.R2_ACCOUNT_ID ?? "",
        accessKeyId: c.env.R2_ACCESS_KEY_ID ?? "",
        secretAccessKey: c.env.R2_SECRET_ACCESS_KEY ?? "",
        bucketName: c.env.R2_BUCKET_NAME ?? "industrial-sync-blobs",
      },
      localDevHost: localDevHost || undefined,
    });

    if (!result) {
      return wrapWithCors(
        c.json({ error: "not_found", message: "空间不存在" }, 404),
      );
    }

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

// cf-sync-v2 HTTP 适配层。

import { Hono } from "hono";
import {
  ANONYMOUS_CORS_HEADERS,
  handleCorsPreflight,
  withCors,
  errorDebugInfo,
  verifyRequestJwt,
} from "@industrial/shared";
import {
  ANONYMOUS_SPACE_ID_PREFIX,
  ANONYMOUS_SPACE_TTL_MS,
  DEFAULT_D1_RETURN_THRESHOLD_BYTES,
  DEFAULT_MAX_BATCH_D1_BLOB_BYTES,
  DEFAULT_MAX_METADATA_SIZE,
  DEFAULT_MAX_MUTATIONS_PER_BATCH,
  DEFAULT_MAX_R2_BLOB_BYTES,
  DEFAULT_R2_ENTER_THRESHOLD_BYTES,
  DEFAULT_UPLOAD_TTL_SECONDS,
  INITIAL_SPACE_REVISION,
  SPACE_PROTOCOL_VERSION,
  isAnonymousSpaceId,
  isSpaceAvailableAt,
  isSpaceRevision,
  validatePrepareBatch,
  type StorageConfig,
} from "./space_model";
import { createSpaceRepository } from "./space_repository";
import {
  SpaceProtocolError,
  cancelSpaceUpload,
  checkSpaceRevision,
  cleanupExpiredSpaces,
  cleanupRecoverableBatches,
  commitSpaceUpload,
  downloadSpaceObject,
  planSpace,
  prepareSpaceUpload,
  uploadSpaceObject,
  getSpaceTransaction,
  abortSpaceTransaction,
} from "./space_service";

export interface SpaceSyncEnv {
  DB: D1Database;
  BLOB_STORE: R2Bucket;
  COMMIT_TOKEN_SECRET?: string;
  PROTOCOL_VERSION?: string;
  MAX_MUTATIONS_PER_BATCH?: string;
  MAX_METADATA_SIZE?: string;
  R2_ENTER_THRESHOLD_BYTES?: string;
  D1_RETURN_THRESHOLD_BYTES?: string;
  MAX_BATCH_D1_BLOB_BYTES?: string;
  MAX_R2_BLOB_BYTES?: string;
  UPLOAD_TTL_SECONDS?: string;
  LOCAL_DEV_HOST?: string;
  ALLOW_ANONYMOUS_SPACES?: string;
  JWT_SECRET?: string;
  /** wrangler.toml [vars] 注入的环境标识，用于控制错误调试信息输出 */
  ENVIRONMENT?: string;
}

type RequestIdentity =
  | { kind: "anonymous" }
  | { kind: "account"; accountId: string };

interface SpaceSyncVariables {
  identity: RequestIdentity;
}

const SCHEDULED_MAINTENANCE_SLOT_MS = 5 * 60_000;

function wrap(response: Response): Response {
  return withCors(response, ANONYMOUS_CORS_HEADERS);
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function storageConfig(env: SpaceSyncEnv): StorageConfig {
  return {
    r2EnterThresholdBytes: positiveInt(env.R2_ENTER_THRESHOLD_BYTES, DEFAULT_R2_ENTER_THRESHOLD_BYTES),
    d1ReturnThresholdBytes: positiveInt(env.D1_RETURN_THRESHOLD_BYTES, DEFAULT_D1_RETURN_THRESHOLD_BYTES),
    maxBatchD1BlobBytes: positiveInt(env.MAX_BATCH_D1_BLOB_BYTES, DEFAULT_MAX_BATCH_D1_BLOB_BYTES),
    maxR2BlobBytes: positiveInt(env.MAX_R2_BLOB_BYTES, DEFAULT_MAX_R2_BLOB_BYTES),
    uploadTtlSeconds: positiveInt(env.UPLOAD_TTL_SECONDS, DEFAULT_UPLOAD_TTL_SECONDS),
  };
}

function tokenSecret(env: SpaceSyncEnv): string {
  if (!env.COMMIT_TOKEN_SECRET) {
    throw new SpaceProtocolError(500, "configuration_error", "缺少 COMMIT_TOKEN_SECRET");
  }
  return env.COMMIT_TOKEN_SECRET;
}

function allowAnonymousSpaces(env: SpaceSyncEnv): boolean {
  if (env.ALLOW_ANONYMOUS_SPACES === "true") return true;
  if (env.ALLOW_ANONYMOUS_SPACES === "false") return false;
  throw new SpaceProtocolError(500, "configuration_error", "ALLOW_ANONYMOUS_SPACES 配置无效");
}

async function authenticateRequest(
  request: Request,
  env: SpaceSyncEnv,
  accountRequired: boolean,
): Promise<RequestIdentity> {
  const authorization = request.headers.get("authorization");
  if (authorization === null) {
    if (accountRequired || !allowAnonymousSpaces(env)) {
      throw new SpaceProtocolError(401, "token_missing", "需要 Bearer 会话");
    }
    return { kind: "anonymous" };
  }
  if (!env.JWT_SECRET) {
    throw new SpaceProtocolError(500, "configuration_error", "JWT_SECRET 配置无效");
  }
  let verification;
  try {
    verification = await verifyRequestJwt(request, env.JWT_SECRET);
  } catch {
    throw new SpaceProtocolError(500, "configuration_error", "JWT_SECRET 配置无效");
  }
  if (!verification.ok) {
    throw new SpaceProtocolError(401, verification.code, "Bearer 会话无效或已过期");
  }
  return { kind: "account", accountId: verification.accountId };
}

async function assertSpaceAccess(
  spaceId: string,
  identity: RequestIdentity,
  env: SpaceSyncEnv,
): Promise<void> {
  if (identity.kind === "anonymous" && !isAnonymousSpaceId(spaceId)) {
    throw new SpaceProtocolError(403, "space_forbidden", "该空间不允许匿名访问");
  }
  const space = await createSpaceRepository(env.DB).getSpace(spaceId);
  if (!space) throw new SpaceProtocolError(404, "space_not_found", "空间不存在");
  if (!isSpaceAvailableAt(space, Date.now())) {
    throw new SpaceProtocolError(410, "space_expired", "临时空间已经过期");
  }
  if (identity.kind === "anonymous") {
    if (space.ownerKind !== "anonymous") {
      throw new SpaceProtocolError(403, "space_forbidden", "无权访问账户空间");
    }
    return;
  }
  if (space.ownerKind !== "account" || space.ownerId !== identity.accountId) {
    throw new SpaceProtocolError(403, "space_forbidden", "无权访问该空间");
  }
}

function publicBaseUrl(request: Request, env: SpaceSyncEnv): string {
  if (env.LOCAL_DEV_HOST) return env.LOCAL_DEV_HOST.replace(/\/$/, "");
  const url = new URL(request.url);
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  return `${forwardedProto || url.protocol.replace(":", "")}://${forwardedHost || url.host}`;
}

function baseDeps(env: SpaceSyncEnv, now = Date.now()) {
  return {
    repo: createSpaceRepository(env.DB),
    r2Bucket: env.BLOB_STORE,
    tokenSecret: tokenSecret(env),
    now,
  };
}

async function jsonBody(c: { req: { header(name: string): string | undefined; json<T>(): Promise<T> } }): Promise<Record<string, unknown>> {
  if (!(c.req.header("content-type") ?? "").includes("application/json")) {
    throw new SpaceProtocolError(400, "bad_request", "需要 Content-Type: application/json");
  }
  try {
    return await c.req.json<Record<string, unknown>>();
  } catch {
    throw new SpaceProtocolError(400, "bad_request", "请求体不是合法 JSON");
  }
}

export function createSpaceSyncApp(): Hono<{
  Bindings: SpaceSyncEnv;
  Variables: SpaceSyncVariables;
}> {
  const app = new Hono<{
    Bindings: SpaceSyncEnv;
    Variables: SpaceSyncVariables;
  }>();

  app.onError((error, c) => {
    if (error instanceof SpaceProtocolError) {
      return wrap(c.json({ error: error.code, message: error.message, ...error.details }, error.status as 400));
    }
    console.error("[sync-v2] 未处理异常", error);
    return wrap(c.json({ error: "internal_error", message: "同步服务内部错误", ...errorDebugInfo(c.env, error) }, 500));
  });

  app.options("*", () => handleCorsPreflight(ANONYMOUS_CORS_HEADERS));

  app.use("*", async (c, next) => {
    if (c.req.method === "OPTIONS") return next();
    const pathname = new URL(c.req.url).pathname;
    const spacesRoot = "/v1/sync/spaces";
    if (pathname !== spacesRoot && !pathname.startsWith(`${spacesRoot}/`)) {
      return next();
    }

    const relativePath = pathname.slice(spacesRoot.length + 1);
    const accountRequired = relativePath === "mine" || relativePath.startsWith("mine/");
    const identity = await authenticateRequest(c.req.raw, c.env, accountRequired);
    c.set("identity", identity);

    const encodedSpaceId = relativePath.split("/")[0];
    if (encodedSpaceId && encodedSpaceId !== "mine") {
      let spaceId: string;
      try {
        spaceId = decodeURIComponent(encodedSpaceId);
      } catch {
        throw new SpaceProtocolError(400, "bad_request", "spaceId 编码无效");
      }
      await assertSpaceAccess(spaceId, identity, c.env);
    }
    return next();
  });

  app.get("/health", async (c) => {
    if (!c.env.DB || !await createSpaceRepository(c.env.DB).checkHealth()) {
      return wrap(c.json({ error: "database_unavailable" }, 503));
    }
    return wrap(c.json({ status: "ok", version: "0.2.0", protocol: SPACE_PROTOCOL_VERSION }));
  });

  app.get("/v1/sync/capabilities", (c) => {
    const storage = storageConfig(c.env);
    return wrap(c.json({
      protocol: c.env.PROTOCOL_VERSION ?? SPACE_PROTOCOL_VERSION,
      concurrency: "exclusive-space-upload",
      uploadTtlSeconds: storage.uploadTtlSeconds,
      anonymousSpaceTtlSeconds: ANONYMOUS_SPACE_TTL_MS / 1000,
      maxMutationsPerBatch: positiveInt(c.env.MAX_MUTATIONS_PER_BATCH, DEFAULT_MAX_MUTATIONS_PER_BATCH),
      maxMetadataSize: positiveInt(c.env.MAX_METADATA_SIZE, DEFAULT_MAX_METADATA_SIZE),
      supportedStorageModes: ["full"],
      supportedEncodings: ["identity"],
      schemaVersions: [1],
      r2EnterThresholdBytes: storage.r2EnterThresholdBytes,
      d1ReturnThresholdBytes: storage.d1ReturnThresholdBytes,
      maxR2BlobBytes: storage.maxR2BlobBytes,
    }));
  });

  app.post("/v1/sync/spaces", async (c) => {
    if (c.get("identity").kind !== "anonymous") {
      throw new SpaceProtocolError(403, "space_forbidden", "账户会话不能创建匿名空间");
    }
    const body = await jsonBody(c);
    const spaceId = typeof body.spaceId === "string" ? body.spaceId.trim() : "";
    if (!spaceId) throw new SpaceProtocolError(400, "bad_request", "spaceId 不能为空");
    if (!isAnonymousSpaceId(spaceId)) {
      throw new SpaceProtocolError(
        403,
        "space_forbidden",
        `匿名 Space ID 必须以 ${ANONYMOUS_SPACE_ID_PREFIX} 开头`,
      );
    }
    const createdAtMs = Date.now();
    const createdAt = new Date(createdAtMs).toISOString();
    const expiresAt = new Date(createdAtMs + ANONYMOUS_SPACE_TTL_MS).toISOString();
    const created = await createSpaceRepository(c.env.DB).createSpace({
      spaceId,
      ownerKind: "anonymous",
      ownerId: null,
      lifecycleState: "active",
      expiresAt,
      cleanupLeaseExpiresAt: null,
      revision: INITIAL_SPACE_REVISION,
      epoch: 0,
      pendingUploadId: null,
      lockExpiresAt: null,
      updatedAt: createdAt,
    });
    if (!created) throw new SpaceProtocolError(409, "space_exists", "空间已存在");
    return wrap(c.json({
      ok: true,
      spaceId,
      revision: INITIAL_SPACE_REVISION,
      epoch: 0,
      createdAt,
      expiresAt,
    }, 201));
  });

  app.get("/v1/sync/spaces/mine", async (c) => {
    const identity = c.get("identity");
    if (identity.kind !== "account") {
      throw new SpaceProtocolError(401, "token_missing", "需要 Bearer 会话");
    }
    const createdAt = new Date().toISOString();
    const space = await createSpaceRepository(c.env.DB).getOrCreateAccountSpace(
      identity.accountId,
      `space-${crypto.randomUUID()}`,
      createdAt,
    );
    return wrap(c.json({
      spaceId: space.spaceId,
      revision: space.revision,
      epoch: space.epoch,
    }));
  });

  app.get("/v1/sync/spaces/:spaceId/check", async (c) => {
    const raw = c.req.query("knownRevision");
    if (!isSpaceRevision(raw)) {
      throw new SpaceProtocolError(400, "bad_request", "knownRevision 必须是合法 revision 字符串");
    }
    const result = await checkSpaceRevision(c.req.param("spaceId"), raw, baseDeps(c.env));
    if (!result.changed) return wrap(new Response(null, { status: 204 }));
    return wrap(c.json(result));
  });

  app.get("/v1/sync/spaces/:spaceId/plan", async (c) => {
    const result = await planSpace(c.req.param("spaceId"), {
      ...baseDeps(c.env),
      publicBaseUrl: publicBaseUrl(c.req.raw, c.env),
    });
    return wrap(c.json(result));
  });

  app.post("/v1/sync/spaces/:spaceId/mutations", async (c) => {
    const requestContent = await c.req.raw.clone().text();
    const body = await jsonBody(c);
    if (body.protocol !== (c.env.PROTOCOL_VERSION ?? SPACE_PROTOCOL_VERSION)) {
      throw new SpaceProtocolError(422, "protocol_mismatch", `需要 ${SPACE_PROTOCOL_VERSION}`);
    }
    const action = body.action;
    const spaceId = c.req.param("spaceId");
    if (action === "prepare") {
      if (!isSpaceRevision(body.baseRevision)) {
        throw new SpaceProtocolError(400, "bad_request", "baseRevision 必须是合法 revision 字符串");
      }
      const validated = validatePrepareBatch(
        body.objects ?? [],
        body.deletions ?? [],
        positiveInt(c.env.MAX_MUTATIONS_PER_BATCH, DEFAULT_MAX_MUTATIONS_PER_BATCH),
      );
      if (!validated.ok) throw new SpaceProtocolError(400, "bad_request", validated.message);
      const metadataBytes = validated.objects.reduce(
        (total, object) => total + new TextEncoder().encode(object.metadata).byteLength,
        0,
      );
      if (metadataBytes > positiveInt(c.env.MAX_METADATA_SIZE, DEFAULT_MAX_METADATA_SIZE)) {
        throw new SpaceProtocolError(413, "metadata_too_large", "批次 metadata 总量超过上限");
      }
      const result = await prepareSpaceUpload(
        spaceId,
        body.baseRevision,
        typeof body.clientBatchId === "string" ? body.clientBatchId : "",
        validated.objects,
        validated.deletions,
        requestContent,
        {
          ...baseDeps(c.env),
          publicBaseUrl: publicBaseUrl(c.req.raw, c.env),
          storage: storageConfig(c.env),
        },
      );
      return wrap(c.json(result));
    }
    if (action === "commit" || action === "cancel") {
      const uploadId = typeof body.uploadId === "string" ? body.uploadId : "";
      const commitToken = typeof body.commitToken === "string" ? body.commitToken : "";
      if (!uploadId || !commitToken) {
        throw new SpaceProtocolError(400, "bad_request", "uploadId 和 commitToken 不能为空");
      }
      const result = action === "commit"
        ? await commitSpaceUpload(spaceId, uploadId, commitToken, baseDeps(c.env))
        : await cancelSpaceUpload(spaceId, uploadId, commitToken, baseDeps(c.env));
      return wrap(c.json(result));
    }
    throw new SpaceProtocolError(400, "bad_request", "action 必须是 prepare、commit 或 cancel");
  });

  app.put("/v1/sync/spaces/:spaceId/uploads/:uploadId/assets/:assetType/:assetId", async (c) => {
    const ticket = c.req.query("ticket") ?? "";
    if (!ticket) throw new SpaceProtocolError(401, "token_invalid", "缺少上传票据");
    const maximum = storageConfig(c.env).maxR2BlobBytes;
    const declared = Number.parseInt(c.req.header("content-length") ?? "0", 10);
    if (Number.isFinite(declared) && declared > maximum) {
      throw new SpaceProtocolError(413, "blob_too_large", "payload 超过文件上限");
    }
    const bytes = await c.req.arrayBuffer();
    if (bytes.byteLength > maximum) {
      throw new SpaceProtocolError(413, "blob_too_large", "payload 超过文件上限");
    }
    const result = await uploadSpaceObject(c.req.param(), ticket, bytes, baseDeps(c.env));
    return wrap(c.json({ ok: true, ...result }));
  });

  app.get("/v1/sync/spaces/:spaceId/assets/:assetType/:assetId/content", async (c) => {
    const ticket = c.req.query("ticket") ?? "";
    if (!ticket) throw new SpaceProtocolError(401, "token_invalid", "缺少下载票据");
    const result = await downloadSpaceObject(c.req.param(), ticket, baseDeps(c.env));
    return wrap(new Response(result.body, { status: 200, headers: result.headers }));
  });

  // 查询当前事务状态
  app.get("/v1/sync/spaces/:spaceId/transaction", async (c) => {
    const result = await getSpaceTransaction(c.req.param("spaceId"), baseDeps(c.env));
    return wrap(c.json(result, 200));
  });

  // 立即丢弃当前事务
  app.post("/v1/sync/spaces/:spaceId/transaction/abort", async (c) => {
    const result = await abortSpaceTransaction(c.req.param("spaceId"), baseDeps(c.env));
    return wrap(c.json(result, 200));
  });

  app.all("*", (c) => wrap(c.json({ error: "not_found", message: "路径未实现" }, 404)));
  return app;
}

export async function runScheduledCleanup(
  env: SpaceSyncEnv,
  scheduledTime = Date.now(),
): Promise<number> {
  const deps = baseDeps(env, scheduledTime);
  const cleanupExpiredFirst = Math.floor(scheduledTime / SCHEDULED_MAINTENANCE_SLOT_MS) % 2 === 0;
  if (cleanupExpiredFirst) {
    const cleaned = await cleanupExpiredSpaces(deps);
    return cleaned > 0 ? cleaned : cleanupRecoverableBatches(deps);
  }
  const recovered = await cleanupRecoverableBatches(deps);
  return recovered > 0 ? recovered : cleanupExpiredSpaces(deps);
}

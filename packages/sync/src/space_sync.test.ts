import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import fs from "node:fs";
import path from "node:path";
import worker from "./index";
import type { SpaceSyncEnv } from "./space_http";
import { runScheduledCleanup } from "./space_http";
import { createSpaceRepository, type SpaceRepository } from "./space_repository";
import { recoverBatch } from "./space_service";
import { sha256Hex } from "./space_token";

const SECRET = "space-revision-test-secret-with-32-bytes";
let proxy: PlatformProxy<{ DB: D1Database; BLOB_STORE: R2Bucket }>;
let env: SpaceSyncEnv;

async function applySchema(db: D1Database): Promise<void> {
  // AI-CORRECTION 2026-08-09: 集成测试必须应用完整 active migration 链，
  // 否则新增 schema 在 Miniflare 中不会被真实协议路径覆盖。
  const migrationDirectory = path.resolve(__dirname, "..", "migrations");
  for (const filename of fs.readdirSync(migrationDirectory).filter((name) => name.endsWith(".sql")).sort()) {
    const sql = fs.readFileSync(path.join(migrationDirectory, filename), "utf8");
    const executable = sql.split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    for (const statement of executable.split(";").map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }
}

async function request(pathname: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(new Request(`https://sync.test${pathname}`, init), env);
}

async function jsonRequest(pathname: string, body: Record<string, unknown>): Promise<Response> {
  return request(pathname, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function createSpace(spaceId: string): Promise<void> {
  const response = await jsonRequest("/v1/sync/spaces", { spaceId });
  expect(response.status).toBe(201);
}

async function objectFor(
  bytes: Uint8Array,
  assetType: string,
  assetId: string,
  clientMutationId: string,
) {
  return {
    clientMutationId,
    assetType,
    assetId,
    metadata: JSON.stringify({ assetId }),
    blobHash: await sha256Hex(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer),
    blobByteSize: bytes.byteLength,
    storageMode: "full",
    schemaVersion: 1,
    encoding: "identity",
    writerAppVersion: "test",
    writerBuildId: "test-build",
  } as const;
}

async function prepare(
  spaceId: string,
  baseRevision: string,
  clientBatchId: string,
  objects: Awaited<ReturnType<typeof objectFor>>[],
  deletions: Array<{ clientMutationId: string; assetType: string; assetId: string }> = [],
): Promise<Response> {
  return jsonRequest(
    `/v1/sync/spaces/${spaceId}/mutations`,
    prepareBody(baseRevision, clientBatchId, objects, deletions),
  );
}

function prepareBody(
  baseRevision: string,
  clientBatchId: string,
  objects: Awaited<ReturnType<typeof objectFor>>[],
  deletions: Array<{ clientMutationId: string; assetType: string; assetId: string }> = [],
): Record<string, unknown> {
  return {
    protocol: "cf-sync-v2",
    action: "prepare",
    baseRevision,
    clientBatchId,
    objects,
    deletions,
  };
}

async function uploadAll(
  prepared: Record<string, any>,
  bodies: Map<string, Uint8Array>,
): Promise<Response[]> {
  return Promise.all(prepared.uploads.map((upload: Record<string, any>) => {
    if (!upload.required) return Promise.resolve(new Response(null, { status: 200 }));
    return worker.fetch(new Request(upload.url as string, {
      method: "PUT",
      headers: upload.headers as Record<string, string>,
      body: bodies.get(`${upload.assetType}/${upload.assetId}`),
    }), env);
  }));
}

async function commit(spaceId: string, prepared: Record<string, any>): Promise<Response> {
  return jsonRequest(`/v1/sync/spaces/${spaceId}/mutations`, {
    protocol: "cf-sync-v2",
    action: "commit",
    uploadId: prepared.uploadId,
    commitToken: prepared.commitToken,
  });
}

beforeAll(async () => {
  proxy = await getPlatformProxy<{ DB: D1Database; BLOB_STORE: R2Bucket }>({
    configPath: path.resolve(__dirname, "..", "wrangler.toml"),
    persist: false,
    remoteBindings: false,
  });
  await applySchema(proxy.env.DB);
  env = {
    DB: proxy.env.DB,
    BLOB_STORE: proxy.env.BLOB_STORE,
    COMMIT_TOKEN_SECRET: SECRET,
    PROTOCOL_VERSION: "cf-sync-v2",
    MAX_MUTATIONS_PER_BATCH: "32",
    MAX_METADATA_SIZE: "262144",
    R2_ENTER_THRESHOLD_BYTES: "614400",
    D1_RETURN_THRESHOLD_BYTES: "552960",
    MAX_BATCH_D1_BLOB_BYTES: "8388608",
    MAX_R2_BLOB_BYTES: "26214400",
    UPLOAD_TTL_SECONDS: "900",
  };
});

afterAll(async () => {
  await proxy.dispose();
});

describe("cf-sync-v2 space revision 上传事务", () => {
  it("migration 将所有 space revision 相关列收敛为 TEXT", async () => {
    const expectations = [
      ["sync_spaces", "revision"],
      ["sync_assets", "last_modified_revision"],
      ["sync_upload_batches", "base_revision"],
      ["sync_upload_batches", "target_revision"],
    ] as const;
    for (const [table, column] of expectations) {
      const row = await env.DB.prepare(
        `SELECT type FROM pragma_table_info('${table}') WHERE name=?1`,
      ).bind(column).first<{ type: string }>();
      expect(row?.type).toBe("TEXT");
    }
  });

  it("迁移前幂等结果中的数值 revision 在读取边界归一化为字符串", async () => {
    const result = await recoverBatch({
      uploadId: "legacy-result",
      spaceId: "legacy-space",
      clientBatchId: "legacy-client-batch",
      baseRevision: "0",
      targetRevision: "1",
      targetEpoch: 1,
      descriptorHash: "legacy-descriptor",
      state: "committed",
      expiresAt: "2026-08-12T00:00:00.000Z",
      resultJson: JSON.stringify({
        status: "committed",
        uploadId: "legacy-result",
        revision: 1,
        epoch: 1,
        assets: [{
          assetType: "blueprint",
          assetId: "legacy-asset",
          contentHash: "legacy-hash",
          lastModifiedRevision: 1,
        }],
        deletedAssets: [],
        serverTime: "2026-08-12T00:00:00.000Z",
      }),
      lastError: null,
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
    }, {
      repo: {} as SpaceRepository,
      r2Bucket: env.BLOB_STORE,
      tokenSecret: SECRET,
      now: Date.now(),
    });
    expect(result).toMatchObject({
      revision: "1",
      assets: [{ lastModifiedRevision: "1" }],
    });
  });

  it("兼容正式 D1 将 BLOB 返回为 number[] 的读取形态", async () => {
    const productionLikeRow = {
      space_id: "production-d1-shape",
      asset_type: "blueprint",
      asset_id: "blob-array",
      epoch: 1,
      last_modified_revision: `${"a".repeat(64)}-1770000000000`,
      content_hash: "hash",
      byte_size: 4,
      encoding: "identity",
      metadata: "{}",
      schema_version: 1,
      writer_app_version: "test",
      writer_build_id: "test",
      storage_mode: "full",
      active_backend: "d1",
      d1_content: [0, 127, 128, 255],
      d1_blob_hash: "hash",
      d1_byte_size: 4,
      d1_encoding: "identity",
      r2_key: "fixed-key",
      r2_present: 0,
      r2_blob_hash: null,
      r2_byte_size: null,
      r2_encoding: null,
      r2_version: null,
      committed_at: "2026-08-09T00:00:00.000Z",
    };
    const statement = {
      bind: () => statement,
      first: async () => productionLikeRow,
    };
    const repository = createSpaceRepository({
      prepare: () => statement,
    } as unknown as D1Database);

    const asset = await repository.getAsset(
      productionLikeRow.space_id,
      productionLikeRow.asset_type,
      productionLikeRow.asset_id,
    );
    expect(Array.from(new Uint8Array(asset?.d1Content ?? new ArrayBuffer(0))))
      .toEqual([0, 127, 128, 255]);
  });

  it("能力声明 revision 协议和 15 分钟租约", async () => {
    const response = await request("/v1/sync/capabilities");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      protocol: "cf-sync-v2",
      concurrency: "exclusive-space-upload",
      uploadTtlSeconds: 900,
      supportedStorageModes: ["full"],
    });
  });

  it("revision HTTP 合约拒绝数值类型并接受迁移后的十进制字符串", async () => {
    const spaceId = `revision-contract-${crypto.randomUUID()}`;
    await createSpace(spaceId);
    const bytes = new TextEncoder().encode("string-revision");
    const object = await objectFor(bytes, "blueprint", "contract", "m-contract");
    const numericBaseRevision = await jsonRequest(`/v1/sync/spaces/${spaceId}/mutations`, {
      ...prepareBody("0", "numeric-revision", [object]),
      baseRevision: 0,
    });
    expect(numericBaseRevision.status).toBe(400);
    expect(await numericBaseRevision.json()).toMatchObject({ error: "bad_request" });

    const migratedKnownRevision = await request(
      `/v1/sync/spaces/${spaceId}/check?knownRevision=1`,
    );
    expect(migratedKnownRevision.status).toBe(200);
    expect(await migratedKnownRevision.json()).toMatchObject({ revision: "0", changed: true });
    expect((await request(`/v1/sync/spaces/${spaceId}/check?knownRevision=0`)).status).toBe(204);
  });

  it("同一 base revision 并发 prepare 只有一个取得整个 space 的锁", async () => {
    const spaceId = `concurrent-${crypto.randomUUID()}`;
    await createSpace(spaceId);
    const bytes = new TextEncoder().encode("concurrent");
    const object = await objectFor(bytes, "blueprint", "a", "m-a");
    const responses = await Promise.all([
      prepare(spaceId, "0", "client-a", [object]),
      prepare(spaceId, "0", "client-b", [{ ...object, clientMutationId: "m-b" }]),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const conflict = responses.find((response) => response.status === 409)!;
    expect(await conflict.json()).toMatchObject({ error: "space_locked" });
  });

  it("一个批次并行上传多个对象，commit 只推进一次 revision/epoch", async () => {
    const spaceId = `batch-${crypto.randomUUID()}`;
    await createSpace(spaceId);
    const firstBytes = new TextEncoder().encode("first-object");
    const secondBytes = new TextEncoder().encode("second-object");
    const objects = await Promise.all([
      objectFor(firstBytes, "blueprint", "first", "m-first"),
      objectFor(secondBytes, "planner-state", "second", "m-second"),
    ]);
    const prepareResponse = await prepare(spaceId, "0", "batch-1", objects);
    expect(prepareResponse.status).toBe(200);
    const prepared = await prepareResponse.json() as Record<string, any>;
    expect(prepared).toMatchObject({ baseRevision: "0", targetEpoch: 1 });
    const requestContent = JSON.stringify(prepareBody("0", "batch-1", objects));
    expect(prepared.targetRevision).toBe(
      `${await sha256Hex(requestContent)}-${Date.parse(prepared.serverTime)}`,
    );

    const lockedPlan = await request(`/v1/sync/spaces/${spaceId}/plan`);
    expect(lockedPlan.status).toBe(423);
    expect(await lockedPlan.json()).toMatchObject({ error: "space_locked" });

    const uploads = await uploadAll(prepared, new Map([
      ["blueprint/first", firstBytes],
      ["planner-state/second", secondBytes],
    ]));
    expect(uploads.map((response) => response.status)).toEqual([200, 200]);

    const commitResponse = await commit(spaceId, prepared);
    expect(commitResponse.status).toBe(200);
    expect(await commitResponse.json()).toMatchObject({
      status: "committed",
      revision: prepared.targetRevision,
      epoch: 1,
    });
    const plan = await (await request(`/v1/sync/spaces/${spaceId}/plan`)).json() as Record<string, any>;
    expect(plan.revision).toBe(prepared.targetRevision);
    expect(plan.epoch).toBe(1);
    expect(plan.assets).toHaveLength(2);
    expect(plan.assets.map((asset: Record<string, unknown>) => asset.lastModifiedRevision))
      .toEqual([prepared.targetRevision, prepared.targetRevision]);
    expect((await request(
      `/v1/sync/spaces/${spaceId}/check?knownRevision=${prepared.targetRevision}`,
    )).status).toBe(204);
    const changed = await request(`/v1/sync/spaces/${spaceId}/check?knownRevision=0`);
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({
      revision: prepared.targetRevision,
      changed: true,
      planRequired: true,
    });

    const repeatedCommit = await commit(spaceId, prepared);
    expect(await repeatedCommit.json()).toMatchObject({
      status: "already-committed",
      revision: prepared.targetRevision,
      epoch: 1,
    });
  });

  it("相同 clientBatchId 的 prepare 重试返回同一个 uploadId", async () => {
    const spaceId = `idempotent-${crypto.randomUUID()}`;
    await createSpace(spaceId);
    const bytes = new TextEncoder().encode("same-plan");
    const object = await objectFor(bytes, "blueprint", "same", "m-same");
    const first = await (await prepare(spaceId, "0", "stable-client-batch", [object])).json() as Record<string, any>;
    const second = await (await prepare(spaceId, "0", "stable-client-batch", [object])).json() as Record<string, any>;
    expect(second.uploadId).toBe(first.uploadId);
    expect(second.commitToken).toBe(first.commitToken);
  });

  it("commit 拒绝尚未全部完成的对象", async () => {
    const spaceId = `incomplete-${crypto.randomUUID()}`;
    await createSpace(spaceId);
    const bytes = new TextEncoder().encode("not-uploaded");
    const object = await objectFor(bytes, "blueprint", "missing", "m-missing");
    const prepared = await (await prepare(spaceId, "0", "incomplete", [object])).json() as Record<string, any>;
    const response = await commit(spaceId, prepared);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "uploads_incomplete" });
  });

  it("cancel 清理暂存并释放 space 锁，不推进 revision/epoch", async () => {
    const spaceId = `cancel-${crypto.randomUUID()}`;
    await createSpace(spaceId);
    const bytes = new TextEncoder().encode("cancel-me");
    const object = await objectFor(bytes, "blueprint", "cancelled", "m-cancel");
    const prepared = await (await prepare(spaceId, "0", "cancel-batch", [object])).json() as Record<string, any>;
    expect((await uploadAll(prepared, new Map([["blueprint/cancelled", bytes]])))[0]?.status).toBe(200);

    const cancelled = await jsonRequest(`/v1/sync/spaces/${spaceId}/mutations`, {
      protocol: "cf-sync-v2",
      action: "cancel",
      uploadId: prepared.uploadId,
      commitToken: prepared.commitToken,
    });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ status: "cancelled" });
    const plan = await (await request(`/v1/sync/spaces/${spaceId}/plan`)).json() as Record<string, any>;
    expect(plan).toMatchObject({ revision: "0", epoch: 0, assets: [] });
  });

  it("15 分钟过期批次由清理器释放，旧 base revision 可以重新 prepare", async () => {
    const spaceId = `expire-${crypto.randomUUID()}`;
    await createSpace(spaceId);
    const bytes = new TextEncoder().encode("expires");
    const object = await objectFor(bytes, "blueprint", "expired", "m-expired");
    const prepared = await (await prepare(spaceId, "0", "expires-batch", [object])).json() as Record<string, any>;
    await env.DB.prepare(
      "UPDATE sync_upload_batches SET expires_at='2000-01-01T00:00:00.000Z' WHERE upload_id=?1",
    ).bind(prepared.uploadId).run();
    await env.DB.prepare(
      "UPDATE sync_spaces SET lock_expires_at='2000-01-01T00:00:00.000Z' WHERE space_id=?1",
    ).bind(spaceId).run();
    expect(await runScheduledCleanup(env)).toBeGreaterThanOrEqual(1);

    const retry = await prepare(spaceId, "0", "after-expiry", [{ ...object, clientMutationId: "m-after" }]);
    expect(retry.status).toBe(200);
  });

  it("大对象通过 R2 固定 key 提交，full 模式连续提交由 epoch 表达顺序", async () => {
    const spaceId = `r2-${crypto.randomUUID()}`;
    await createSpace(spaceId);
    const firstBytes = new Uint8Array(614_400);
    firstBytes.fill(7);
    const firstObject = await objectFor(firstBytes, "blueprint", "large", "m-large-1");
    const first = await (await prepare(spaceId, "0", "large-1", [firstObject])).json() as Record<string, any>;
    expect(first.uploads[0]).toMatchObject({ required: true, backend: "r2" });
    expect((await uploadAll(first, new Map([["blueprint/large", firstBytes]])))[0]?.status).toBe(200);
    expect((await commit(spaceId, first)).status).toBe(200);

    const secondBytes = new Uint8Array(614_401);
    secondBytes.fill(9);
    const secondObject = await objectFor(secondBytes, "blueprint", "large", "m-large-2");
    const second = await (await prepare(spaceId, first.targetRevision, "large-2", [secondObject])).json() as Record<string, any>;
    expect((await uploadAll(second, new Map([["blueprint/large", secondBytes]])))[0]?.status).toBe(200);
    const committed = await (await commit(spaceId, second)).json() as Record<string, any>;
    expect(committed).toMatchObject({ revision: second.targetRevision, epoch: 2 });

    const rows = await env.DB.prepare(
      "SELECT r2_key FROM sync_assets WHERE space_id=?1 AND asset_type='blueprint' AND asset_id='large'",
    ).bind(spaceId).all<{ r2_key: string }>();
    expect(rows.results).toHaveLength(1);
    expect((await env.BLOB_STORE.list({ prefix: `sync/v3/spaces/${encodeURIComponent(spaceId)}/` })).objects)
      .toHaveLength(1);
  });

  it("资产切回 D1 后删除仍清除固定 R2 对象，并在同一 commit 发布新 revision", async () => {
    const spaceId = `delete-${crypto.randomUUID()}`;
    await createSpace(spaceId);
    const largeBytes = new Uint8Array(614_400).fill(0x31);
    const largeObject = await objectFor(largeBytes, "blueprint", "deleted", "m-large");
    const large = await (await prepare(spaceId, "0", "large", [largeObject])).json() as Record<string, any>;
    expect((await uploadAll(large, new Map([["blueprint/deleted", largeBytes]])))[0]?.status).toBe(200);
    expect((await commit(spaceId, large)).status).toBe(200);

    const smallBytes = new TextEncoder().encode("active-d1-but-r2-retained");
    const smallObject = await objectFor(smallBytes, "blueprint", "deleted", "m-small");
    const small = await (await prepare(spaceId, large.targetRevision, "small", [smallObject])).json() as Record<string, any>;
    expect(small.uploads[0]).toMatchObject({ backend: "d1" });
    expect((await uploadAll(small, new Map([["blueprint/deleted", smallBytes]])))[0]?.status).toBe(200);
    expect((await commit(spaceId, small)).status).toBe(200);

    const row = await env.DB.prepare(
      "SELECT active_backend,r2_present,r2_key FROM sync_assets WHERE space_id=?1 AND asset_type='blueprint' AND asset_id='deleted'",
    ).bind(spaceId).first<{ active_backend: string; r2_present: number; r2_key: string }>();
    expect(row).toMatchObject({ active_backend: "d1", r2_present: 1 });
    expect(await env.BLOB_STORE.head(row!.r2_key)).not.toBeNull();

    const deletion = await prepare(spaceId, small.targetRevision, "delete", [], [{
      clientMutationId: "m-delete",
      assetType: "blueprint",
      assetId: "deleted",
    }]);
    expect(deletion.status).toBe(200);
    const prepared = await deletion.json() as Record<string, any>;
    expect(prepared.uploads).toEqual([]);
    const deleted = await (await commit(spaceId, prepared)).json() as Record<string, any>;
    expect(deleted).toMatchObject({
      status: "committed",
      revision: prepared.targetRevision,
      epoch: 3,
      assets: [],
      deletedAssets: [{ assetType: "blueprint", assetId: "deleted" }],
    });

    expect(await env.BLOB_STORE.head(row!.r2_key)).toBeNull();
    expect(await env.DB.prepare(
      "SELECT 1 AS present FROM sync_assets WHERE space_id=?1 AND asset_type='blueprint' AND asset_id='deleted'",
    ).bind(spaceId).first()).toBeNull();
    expect(await (await request(`/v1/sync/spaces/${spaceId}/plan`)).json()).toMatchObject({
      revision: prepared.targetRevision,
      epoch: 3,
      assets: [],
    });
    expect(await (await commit(spaceId, prepared)).json()).toMatchObject({
      status: "already-committed",
      revision: prepared.targetRevision,
      deletedAssets: [{ assetType: "blueprint", assetId: "deleted" }],
    });
  });

  it("R2 删除后 D1 finalize 失败时保持 space 锁并由 recovery 向前完成", async () => {
    const spaceId = `delete-recovery-${crypto.randomUUID()}`;
    await createSpace(spaceId);
    const bytes = new Uint8Array(614_400).fill(0x52);
    const object = await objectFor(bytes, "blueprint", "recover-delete", "m-create");
    const created = await (await prepare(spaceId, "0", "create", [object])).json() as Record<string, any>;
    expect((await uploadAll(created, new Map([["blueprint/recover-delete", bytes]])))[0]?.status).toBe(200);
    expect((await commit(spaceId, created)).status).toBe(200);

    const prepared = await (await prepare(spaceId, created.targetRevision, "delete-recovery", [], [{
      clientMutationId: "m-delete-recovery",
      assetType: "blueprint",
      assetId: "recover-delete",
    }])).json() as Record<string, any>;
    const repository = createSpaceRepository(env.DB);
    await repository.beginCommit(prepared.uploadId, new Date().toISOString());
    const committing = await repository.getBatch(prepared.uploadId);
    const asset = await repository.getAsset(spaceId, "blueprint", "recover-delete");
    expect(committing?.state).toBe("committing");
    expect(asset).not.toBeNull();

    const failingRepository: SpaceRepository = {
      ...repository,
      finalizeCommit: async () => {
        throw new Error("injected D1 finalize failure");
      },
    };
    await expect(recoverBatch(committing!, {
      repo: failingRepository,
      r2Bucket: env.BLOB_STORE,
      tokenSecret: SECRET,
      now: Date.now(),
    })).rejects.toThrow("injected D1 finalize failure");
    expect(await env.BLOB_STORE.head(asset!.r2Key)).toBeNull();
    expect((await repository.getSpace(spaceId))?.pendingUploadId).toBe(prepared.uploadId);
    expect((await repository.listDeleteItems(prepared.uploadId))[0]?.state).toBe("deleted");

    const recovered = await recoverBatch((await repository.getBatch(prepared.uploadId))!, {
      repo: repository,
      r2Bucket: env.BLOB_STORE,
      tokenSecret: SECRET,
      now: Date.now(),
    });
    expect(recovered).toMatchObject({ revision: prepared.targetRevision, epoch: 2 });
    expect(await (await request(`/v1/sync/spaces/${spaceId}/plan`)).json()).toMatchObject({
      revision: prepared.targetRevision,
      epoch: 2,
      assets: [],
    });
  });

  it("prepare 拒绝空变更集、重复资产和不存在的删除目标", async () => {
    const spaceId = `delete-validation-${crypto.randomUUID()}`;
    await createSpace(spaceId);
    const empty = await prepare(spaceId, "0", "empty", []);
    expect(empty.status).toBe(400);
    expect(await empty.json()).toMatchObject({ error: "bad_request" });

    const bytes = new TextEncoder().encode("duplicate-target");
    const object = await objectFor(bytes, "blueprint", "same", "m-write");
    const duplicate = await prepare(spaceId, "0", "duplicate", [object], [{
      clientMutationId: "m-delete",
      assetType: "blueprint",
      assetId: "same",
    }]);
    expect(duplicate.status).toBe(400);
    expect(await duplicate.json()).toMatchObject({ error: "bad_request" });

    const missing = await prepare(spaceId, "0", "missing", [], [{
      clientMutationId: "m-missing",
      assetType: "blueprint",
      assetId: "missing",
    }]);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "asset_not_found" });
    expect(await (await request(`/v1/sync/spaces/${spaceId}/plan`)).json()).toMatchObject({
      revision: "0",
      epoch: 0,
      assets: [],
    });
  });
});

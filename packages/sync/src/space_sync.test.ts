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
import { signJwt } from "@industrial/shared";

const SECRET = "space-revision-test-secret-with-32-bytes";
const JWT_SECRET = "sync-test-jwt-secret-with-at-least-32-bytes";
const ANONYMOUS_SPACE_PREFIX = "e2e-cf-";
let proxy: PlatformProxy<{ DB: D1Database; BLOB_STORE: R2Bucket }>;
let env: SpaceSyncEnv;

function migrationStatements(sql: string): string[] {
  const statements: string[] = [];
  let current: string[] = [];
  let insideTrigger = false;

  for (const rawLine of sql.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("--")) continue;
    if (current.length === 0) insideTrigger = /^CREATE\s+TRIGGER\b/iu.test(line);
    current.push(rawLine);
    const complete = insideTrigger ? /^END;$/iu.test(line) : line.endsWith(";");
    if (!complete) continue;
    statements.push(current.join("\n"));
    current = [];
    insideTrigger = false;
  }

  if (current.length > 0) throw new Error("migration 包含未闭合的 SQL statement");
  return statements;
}

async function applySchema(db: D1Database): Promise<void> {
  // AI-CORRECTION 2026-08-09: 集成测试必须应用完整 active migration 链，
  // 否则新增 schema 在 Miniflare 中不会被真实协议路径覆盖。
  const migrationDirectory = path.resolve(__dirname, "..", "migrations");
  for (const filename of fs.readdirSync(migrationDirectory).filter((name) => name.endsWith(".sql")).sort()) {
    const sql = fs.readFileSync(path.join(migrationDirectory, filename), "utf8");
    const executable = sql.split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    // AI-REMOVED 2026-08-23:
    // Reason: 直接按分号拆分会截断 SQLite trigger 的 BEGIN/END body。
    // Trigger: owner migration 新增数据库级 insert/update 不变量。
    // Evidence: Miniflare 报 D1_ERROR incomplete input，完整 migration statement 解析后通过。
    // Replacement: migrationStatements
    // Risk: Low
    // Human Review: Required
    //
    // Original code:
    // for (const statement of executable.split(";").map((value) => value.trim()).filter(Boolean)) {
    //   await db.prepare(statement).run();
    // }
    for (const statement of migrationStatements(executable)) {
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

async function createSpace(spaceId: string): Promise<{ createdAt: string; expiresAt: string }> {
  const response = await jsonRequest("/v1/sync/spaces", { spaceId });
  expect(response.status).toBe(201);
  return response.json() as Promise<{ createdAt: string; expiresAt: string }>;
}

function nextEphemeralCleanupSlot(now = Date.now()): number {
  const slotMs = 5 * 60_000;
  const slot = Math.ceil(now / slotMs);
  return (slot % 2 === 0 ? slot : slot + 1) * slotMs;
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
    ALLOW_ANONYMOUS_SPACES: "true",
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

  it("migration 为现有 R2 key 原地建立 A/B 槽元数据与上传目标槽约束", async () => {
    const assetColumns = await env.DB.prepare(
      "SELECT name FROM pragma_table_info('sync_assets')",
    ).all<{ name: string }>();
    expect(assetColumns.results?.map((row) => row.name)).toEqual(expect.arrayContaining([
      "r2_active_slot",
      "r2_etag",
      "r2_b_present",
      "r2_b_blob_hash",
      "r2_b_version",
      "r2_b_etag",
    ]));
    const itemColumns = await env.DB.prepare(
      "SELECT name FROM pragma_table_info('sync_upload_items')",
    ).all<{ name: string }>();
    expect(itemColumns.results?.map((row) => row.name)).toEqual(expect.arrayContaining([
      "r2_primary_key",
      "target_r2_slot",
    ]));
  });

  it("migration 在数据库层拒绝不一致的 space owner", async () => {
    const now = new Date().toISOString();
    await expect(env.DB.prepare(
      "INSERT INTO sync_spaces (space_id, updated_at, owner_kind, owner_id) VALUES (?1, ?2, 'account', NULL)",
    ).bind(`invalid-account-${crypto.randomUUID()}`, now).run()).rejects.toThrow("invalid sync space owner");
    await expect(env.DB.prepare(
      "INSERT INTO sync_spaces (space_id, updated_at, owner_kind, owner_id) VALUES (?1, ?2, 'anonymous', ?3)",
    ).bind(`invalid-anonymous-${crypto.randomUUID()}`, now, "unexpected-owner").run()).rejects.toThrow(
      "invalid sync space owner",
    );
    await expect(env.DB.prepare(
      `INSERT INTO sync_spaces
         (space_id, updated_at, owner_kind, owner_id, expires_at)
       VALUES (?1, ?2, 'account', ?3, ?4)`,
    ).bind(
      `invalid-account-expiry-${crypto.randomUUID()}`,
      now,
      `account-${crypto.randomUUID()}`,
      new Date(Date.now() + 60_000).toISOString(),
    ).run()).rejects.toThrow("invalid sync space lifecycle");
    await expect(env.DB.prepare(
      "INSERT INTO sync_spaces (space_id, updated_at, owner_kind, owner_id) VALUES (?1, ?2, 'anonymous', NULL)",
    ).bind(`${ANONYMOUS_SPACE_PREFIX}missing-expiry-${crypto.randomUUID()}`, now).run()).rejects.toThrow(
      "invalid sync space lifecycle",
    );
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
      repo: { listDeleteItems: async () => [] } as unknown as SpaceRepository,
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
    const spaceId = `${ANONYMOUS_SPACE_PREFIX}revision-contract-${crypto.randomUUID()}`;
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
    const spaceId = `${ANONYMOUS_SPACE_PREFIX}concurrent-${crypto.randomUUID()}`;
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
    const spaceId = `${ANONYMOUS_SPACE_PREFIX}batch-${crypto.randomUUID()}`;
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
    expect(lockedPlan.status).toBe(200);
    expect(await lockedPlan.json()).toMatchObject({ revision: "0", epoch: 0, assets: [] });
    expect((await request(`/v1/sync/spaces/${spaceId}/check?knownRevision=0`)).status).toBe(204);

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
    const spaceId = `${ANONYMOUS_SPACE_PREFIX}idempotent-${crypto.randomUUID()}`;
    await createSpace(spaceId);
    const bytes = new TextEncoder().encode("same-plan");
    const object = await objectFor(bytes, "blueprint", "same", "m-same");
    const first = await (await prepare(spaceId, "0", "stable-client-batch", [object])).json() as Record<string, any>;
    const second = await (await prepare(spaceId, "0", "stable-client-batch", [object])).json() as Record<string, any>;
    expect(second.uploadId).toBe(first.uploadId);
    expect(second.commitToken).toBe(first.commitToken);
  });

  it("commit 拒绝尚未全部完成的对象", async () => {
    const spaceId = `${ANONYMOUS_SPACE_PREFIX}incomplete-${crypto.randomUUID()}`;
    await createSpace(spaceId);
    const bytes = new TextEncoder().encode("not-uploaded");
    const object = await objectFor(bytes, "blueprint", "missing", "m-missing");
    const prepared = await (await prepare(spaceId, "0", "incomplete", [object])).json() as Record<string, any>;
    const response = await commit(spaceId, prepared);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "uploads_incomplete" });
  });

  it("cancel 清理暂存并释放 space 锁，不推进 revision/epoch", async () => {
    const spaceId = `${ANONYMOUS_SPACE_PREFIX}cancel-${crypto.randomUUID()}`;
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
    const spaceId = `${ANONYMOUS_SPACE_PREFIX}expire-${crypto.randomUUID()}`;
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

  it("大对象在 R2 A/B 槽间交替，连续提交始终最多保留两个完成态对象", async () => {
    const spaceId = `${ANONYMOUS_SPACE_PREFIX}r2-${crypto.randomUUID()}`;
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
      .toHaveLength(2);

    const asset = await createSpaceRepository(env.DB).getAsset(spaceId, "blueprint", "large");
    expect(asset).toMatchObject({ activeBackend: "r2", r2ActiveSlot: "b", r2Present: true, r2BPresent: true });

    const thirdBytes = new Uint8Array(614_402).fill(11);
    const thirdObject = await objectFor(thirdBytes, "blueprint", "large", "m-large-3");
    const third = await (await prepare(spaceId, second.targetRevision, "large-3", [thirdObject])).json() as
      Record<string, any>;
    expect((await uploadAll(third, new Map([["blueprint/large", thirdBytes]])))[0]?.status).toBe(200);
    expect((await commit(spaceId, third)).status).toBe(200);
    expect((await createSpaceRepository(env.DB).getAsset(spaceId, "blueprint", "large"))?.r2ActiveSlot).toBe("a");
    expect((await env.BLOB_STORE.list({ prefix: `sync/v3/spaces/${encodeURIComponent(spaceId)}/` })).objects)
      .toHaveLength(2);
  }, 20_000);

  it("R2 inactive 槽完成但 finalize 失败时继续提供旧 revision，恢复后原子切换新槽", async () => {
    const spaceId = `${ANONYMOUS_SPACE_PREFIX}r2-readable-${crypto.randomUUID()}`;
    await createSpace(spaceId);
    const oldBytes = new Uint8Array(614_400).fill(0x21);
    const oldObject = await objectFor(oldBytes, "blueprint", "readable", "m-readable-old");
    const first = await (await prepare(spaceId, "0", "readable-old", [oldObject])).json() as Record<string, any>;
    expect((await uploadAll(first, new Map([["blueprint/readable", oldBytes]])))[0]?.status).toBe(200);
    expect((await commit(spaceId, first)).status).toBe(200);

    const newBytes = new Uint8Array(614_401).fill(0x42);
    const newObject = await objectFor(newBytes, "blueprint", "readable", "m-readable-new");
    const second = await (await prepare(
      spaceId,
      first.targetRevision,
      "readable-new",
      [newObject],
    )).json() as Record<string, any>;
    expect((await uploadAll(second, new Map([["blueprint/readable", newBytes]])))[0]?.status).toBe(200);

    const preparedPlan = await (await request(`/v1/sync/spaces/${spaceId}/plan`)).json() as Record<string, any>;
    expect(preparedPlan.revision).toBe(first.targetRevision);
    const preparedDownload = await worker.fetch(new Request(preparedPlan.assets[0].downloadUrl), env);
    expect(new Uint8Array(await preparedDownload.arrayBuffer())).toEqual(oldBytes);

    const repository = createSpaceRepository(env.DB);
    await repository.beginCommit(second.uploadId, new Date().toISOString());
    const committing = (await repository.getBatch(second.uploadId))!;
    const abortingCommit = await request(`/v1/sync/spaces/${spaceId}/transaction/abort`, { method: "POST" });
    expect(abortingCommit.status).toBe(409);
    expect(await abortingCommit.json()).toMatchObject({ error: "commit_in_progress" });
    expect((await repository.getBatch(second.uploadId))?.state).toBe("committing");
    const failingRepository: SpaceRepository = {
      ...repository,
      finalizeCommit: async () => {
        throw new Error("injected R2 finalize failure");
      },
    };
    await expect(recoverBatch(committing, {
      repo: failingRepository,
      r2Bucket: env.BLOB_STORE,
      tokenSecret: SECRET,
      now: Date.now(),
    })).rejects.toThrow("injected R2 finalize failure");

    const failedPlan = await (await request(`/v1/sync/spaces/${spaceId}/plan`)).json() as Record<string, any>;
    expect(failedPlan.revision).toBe(first.targetRevision);
    const failedDownload = await worker.fetch(new Request(failedPlan.assets[0].downloadUrl), env);
    expect(failedDownload.status).toBe(200);
    expect(new Uint8Array(await failedDownload.arrayBuffer())).toEqual(oldBytes);
    expect((await env.BLOB_STORE.list({ prefix: `sync/v3/spaces/${encodeURIComponent(spaceId)}/` })).objects)
      .toHaveLength(2);

    expect(await recoverBatch((await repository.getBatch(second.uploadId))!, {
      repo: repository,
      r2Bucket: env.BLOB_STORE,
      tokenSecret: SECRET,
      now: Date.now(),
    })).toMatchObject({ revision: second.targetRevision, epoch: 2 });
    const committedPlan = await (await request(`/v1/sync/spaces/${spaceId}/plan`)).json() as Record<string, any>;
    expect(committedPlan.revision).toBe(second.targetRevision);
    const committedDownload = await worker.fetch(new Request(committedPlan.assets[0].downloadUrl), env);
    expect(new Uint8Array(await committedDownload.arrayBuffer())).toEqual(newBytes);
    expect((await repository.getAsset(spaceId, "blueprint", "readable"))?.r2ActiveSlot).toBe("b");
  }, 20_000);

  it("资产切回 D1 后删除仍清除 R2 双槽，并在同一 commit 发布新 revision", async () => {
    const spaceId = `${ANONYMOUS_SPACE_PREFIX}delete-${crypto.randomUUID()}`;
    await createSpace(spaceId);
    const largeBytes = new Uint8Array(614_400).fill(0x31);
    const largeObject = await objectFor(largeBytes, "blueprint", "deleted", "m-large");
    const large = await (await prepare(spaceId, "0", "large", [largeObject])).json() as Record<string, any>;
    expect((await uploadAll(large, new Map([["blueprint/deleted", largeBytes]])))[0]?.status).toBe(200);
    expect((await commit(spaceId, large)).status).toBe(200);

    const secondLargeBytes = new Uint8Array(614_401).fill(0x32);
    const secondLargeObject = await objectFor(secondLargeBytes, "blueprint", "deleted", "m-large-2");
    const secondLarge = await (await prepare(
      spaceId,
      large.targetRevision,
      "large-2",
      [secondLargeObject],
    )).json() as Record<string, any>;
    expect((await uploadAll(secondLarge, new Map([["blueprint/deleted", secondLargeBytes]])))[0]?.status).toBe(200);
    expect((await commit(spaceId, secondLarge)).status).toBe(200);

    const smallBytes = new TextEncoder().encode("active-d1-but-r2-retained");
    const smallObject = await objectFor(smallBytes, "blueprint", "deleted", "m-small");
    const small = await (await prepare(
      spaceId,
      secondLarge.targetRevision,
      "small",
      [smallObject],
    )).json() as Record<string, any>;
    expect(small.uploads[0]).toMatchObject({ backend: "d1" });
    expect((await uploadAll(small, new Map([["blueprint/deleted", smallBytes]])))[0]?.status).toBe(200);
    expect((await commit(spaceId, small)).status).toBe(200);

    const row = await env.DB.prepare(
      `SELECT active_backend,r2_present,r2_key,r2_b_present
       FROM sync_assets
       WHERE space_id=?1 AND asset_type='blueprint' AND asset_id='deleted'`,
    ).bind(spaceId).first<{
      active_backend: string;
      r2_present: number;
      r2_key: string;
      r2_b_present: number;
    }>();
    expect(row).toMatchObject({ active_backend: "d1", r2_present: 1, r2_b_present: 1 });
    expect(await env.BLOB_STORE.head(row!.r2_key)).not.toBeNull();
    expect(await env.BLOB_STORE.head(`${row!.r2_key}.b`)).not.toBeNull();

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
      epoch: 4,
      assets: [],
      deletedAssets: [{ assetType: "blueprint", assetId: "deleted" }],
    });

    expect(await env.BLOB_STORE.head(row!.r2_key)).toBeNull();
    expect(await env.BLOB_STORE.head(`${row!.r2_key}.b`)).toBeNull();
    expect(await env.DB.prepare(
      "SELECT 1 AS present FROM sync_assets WHERE space_id=?1 AND asset_type='blueprint' AND asset_id='deleted'",
    ).bind(spaceId).first()).toBeNull();
    expect(await (await request(`/v1/sync/spaces/${spaceId}/plan`)).json()).toMatchObject({
      revision: prepared.targetRevision,
      epoch: 4,
      assets: [],
    });
    expect(await (await commit(spaceId, prepared)).json()).toMatchObject({
      status: "already-committed",
      revision: prepared.targetRevision,
      deletedAssets: [{ assetType: "blueprint", assetId: "deleted" }],
    });
  }, 20_000);

  it("删除 finalize 失败时旧 revision 与 R2 对象仍可读，recovery 发布后再清理", async () => {
    const spaceId = `${ANONYMOUS_SPACE_PREFIX}delete-recovery-${crypto.randomUUID()}`;
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
    expect(await env.BLOB_STORE.head(asset!.r2Key)).not.toBeNull();
    expect((await repository.getSpace(spaceId))?.pendingUploadId).toBe(prepared.uploadId);
    expect((await repository.listDeleteItems(prepared.uploadId))[0]?.state).toBe("reserved");
    const readablePlan = await (await request(`/v1/sync/spaces/${spaceId}/plan`)).json() as Record<string, any>;
    expect(readablePlan).toMatchObject({ revision: created.targetRevision, epoch: 1 });
    expect(readablePlan.assets).toHaveLength(1);
    const oldDownload = await worker.fetch(new Request(readablePlan.assets[0].downloadUrl), env);
    expect(oldDownload.status).toBe(200);
    expect(new Uint8Array(await oldDownload.arrayBuffer())).toEqual(bytes);

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
    expect(await env.BLOB_STORE.head(asset!.r2Key)).toBeNull();
  }, 20_000);

  it("删除 revision 已发布但 R2 清理失败时保留清理任务，重试后回收对象", async () => {
    const spaceId = `${ANONYMOUS_SPACE_PREFIX}delete-cleanup-${crypto.randomUUID()}`;
    await createSpace(spaceId);
    const bytes = new Uint8Array(614_400).fill(0x61);
    const object = await objectFor(bytes, "blueprint", "cleanup", "m-cleanup-create");
    const created = await (await prepare(spaceId, "0", "cleanup-create", [object])).json() as Record<string, any>;
    expect((await uploadAll(created, new Map([["blueprint/cleanup", bytes]])))[0]?.status).toBe(200);
    expect((await commit(spaceId, created)).status).toBe(200);

    const prepared = await (await prepare(spaceId, created.targetRevision, "cleanup-delete", [], [{
      clientMutationId: "m-cleanup-delete",
      assetType: "blueprint",
      assetId: "cleanup",
    }])).json() as Record<string, any>;
    const repository = createSpaceRepository(env.DB);
    const asset = (await repository.getAsset(spaceId, "blueprint", "cleanup"))!;
    await repository.beginCommit(prepared.uploadId, new Date().toISOString());
    const deleteFailingBucket = new Proxy(env.BLOB_STORE, {
      get(target, property) {
        if (property === "delete") {
          return async () => {
            throw new Error("injected R2 delete failure");
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as R2Bucket;

    expect(await recoverBatch((await repository.getBatch(prepared.uploadId))!, {
      repo: repository,
      r2Bucket: deleteFailingBucket,
      tokenSecret: SECRET,
      now: Date.now(),
    })).toMatchObject({ revision: prepared.targetRevision, epoch: 2 });
    expect(await (await request(`/v1/sync/spaces/${spaceId}/plan`)).json()).toMatchObject({
      revision: prepared.targetRevision,
      epoch: 2,
      assets: [],
    });
    expect(await env.BLOB_STORE.head(asset.r2Key)).not.toBeNull();
    expect((await repository.listDeleteItems(prepared.uploadId))[0]?.state).toBe("committed");
    expect(await repository.listPendingDeleteCleanupBatches(8)).toEqual(expect.arrayContaining([
      expect.objectContaining({ uploadId: prepared.uploadId }),
    ]));

    expect(await recoverBatch((await repository.getBatch(prepared.uploadId))!, {
      repo: repository,
      r2Bucket: env.BLOB_STORE,
      tokenSecret: SECRET,
      now: Date.now(),
    })).toMatchObject({ revision: prepared.targetRevision, epoch: 2 });
    expect(await env.BLOB_STORE.head(asset.r2Key)).toBeNull();
    expect((await repository.listDeleteItems(prepared.uploadId))[0]?.state).toBe("deleted");
  }, 20_000);

  it("prepare 拒绝空变更集、重复资产和不存在的删除目标", async () => {
    const spaceId = `${ANONYMOUS_SPACE_PREFIX}delete-validation-${crypto.randomUUID()}`;
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

describe("sync 双环境空间归属与防绕过门禁", () => {
  async function accountToken(accountId: string): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return signJwt({ sub: accountId, iat: now, exp: now + 300 }, JWT_SECRET);
  }

  function authenticatedRequest(pathname: string, token: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    return request(pathname, { ...init, headers });
  }

  it("beta 只允许 e2e-cf- 空间匿名创建和访问，并与账户空间严格分离", async () => {
    const previousFlag = env.ALLOW_ANONYMOUS_SPACES;
    const previousSecret = env.JWT_SECRET;
    env.ALLOW_ANONYMOUS_SPACES = "true";
    env.JWT_SECRET = JWT_SECRET;
    try {
      const forbiddenAnonymousSpaceId = `anonymous-owner-${crypto.randomUUID()}`;
      const forbiddenCreate = await jsonRequest("/v1/sync/spaces", {
        spaceId: forbiddenAnonymousSpaceId,
      });
      expect(forbiddenCreate.status).toBe(403);
      expect(await forbiddenCreate.json()).toMatchObject({ error: "space_forbidden" });
      expect(await createSpaceRepository(env.DB).getSpace(forbiddenAnonymousSpaceId)).toBeNull();

      const legacyAnonymousSpaceId = `legacy-anonymous-${crypto.randomUUID()}`;
      expect(await createSpaceRepository(env.DB).createSpace({
        spaceId: legacyAnonymousSpaceId,
        ownerKind: "anonymous",
        ownerId: null,
        lifecycleState: "active",
        expiresAt: null,
        cleanupLeaseExpiresAt: null,
        revision: "0",
        epoch: 0,
        pendingUploadId: null,
        lockExpiresAt: null,
        updatedAt: new Date().toISOString(),
      })).toBe(true);
      expect((await request(`/v1/sync/spaces/${legacyAnonymousSpaceId}/plan`)).status).toBe(403);

      const anonymousSpaceId = `${ANONYMOUS_SPACE_PREFIX}anonymous-owner-${crypto.randomUUID()}`;
      const created = await createSpace(anonymousSpaceId);
      expect(Date.parse(created.expiresAt) - Date.parse(created.createdAt)).toBe(60 * 60_000);
      expect((await request(`/v1/sync/spaces/${anonymousSpaceId}/plan`)).status).toBe(200);

      const ownerToken = await accountToken("owner-account");
      const firstMine = await authenticatedRequest("/v1/sync/spaces/mine", ownerToken);
      const secondMine = await authenticatedRequest("/v1/sync/spaces/mine", ownerToken);
      expect(firstMine.status).toBe(200);
      expect(secondMine.status).toBe(200);
      const firstSpace = await firstMine.json() as { spaceId: string };
      const secondSpace = await secondMine.json() as { spaceId: string };
      expect(secondSpace.spaceId).toBe(firstSpace.spaceId);

      expect((await authenticatedRequest(
        `/v1/sync/spaces/${firstSpace.spaceId}/plan`,
        ownerToken,
      )).status).toBe(200);
      expect((await request(`/v1/sync/spaces/${firstSpace.spaceId}/plan`)).status).toBe(403);
      expect((await authenticatedRequest(
        `/v1/sync/spaces/${anonymousSpaceId}/plan`,
        ownerToken,
      )).status).toBe(403);

      const otherToken = await accountToken("other-account");
      expect((await authenticatedRequest(
        `/v1/sync/spaces/${firstSpace.spaceId}/plan`,
        otherToken,
      )).status).toBe(403);

      const invalid = await authenticatedRequest(
        `/v1/sync/spaces/${anonymousSpaceId}/plan`,
        "invalid",
      );
      expect(invalid.status).toBe(401);
      expect(await invalid.json()).toMatchObject({ error: "token_invalid" });

      const accountCreatingAnonymous = await authenticatedRequest(
        "/v1/sync/spaces",
        ownerToken,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ spaceId: `forbidden-${crypto.randomUUID()}` }),
        },
      );
      expect(accountCreatingAnonymous.status).toBe(403);
    } finally {
      env.ALLOW_ANONYMOUS_SPACES = previousFlag;
      env.JWT_SECRET = previousSecret;
    }
  });

  it("e2e-cf- 空间一小时后立即不可访问，Cron 每轮至多清理八条并最终删除 D1/R2", async () => {
    const spaceId = `${ANONYMOUS_SPACE_PREFIX}expiry-${crypto.randomUUID()}`;
    await createSpace(spaceId);

    const bodies = new Map<string, Uint8Array>();
    const objects: Awaited<ReturnType<typeof objectFor>>[] = [];
    for (let index = 0; index < 9; index += 1) {
      const assetId = `asset-${String(index).padStart(2, "0")}`;
      const bytes = index === 8
        ? new Uint8Array(700 * 1024).fill(8)
        : new TextEncoder().encode(`temporary-${index}`);
      bodies.set(`blueprint/${assetId}`, bytes);
      objects.push(await objectFor(bytes, "blueprint", assetId, `m-${index}`));
    }

    const prepared = await (await prepare(spaceId, "0", "expiry-batch", objects)).json() as Record<string, any>;
    const uploads = await uploadAll(prepared, bodies);
    expect(uploads.every((response) => response.status === 200)).toBe(true);
    expect((await commit(spaceId, prepared)).status).toBe(200);
    const r2Asset = await createSpaceRepository(env.DB).getAsset(spaceId, "blueprint", "asset-08");
    expect(r2Asset?.activeBackend).toBe("r2");
    expect(await env.BLOB_STORE.head(r2Asset!.r2Key)).not.toBeNull();

    await env.DB.prepare(
      "UPDATE sync_spaces SET expires_at=?2 WHERE space_id=?1",
    ).bind(spaceId, new Date(Date.now() - 1).toISOString()).run();
    const expired = await request(`/v1/sync/spaces/${spaceId}/plan`);
    expect(expired.status).toBe(410);
    expect(await expired.json()).toMatchObject({ error: "space_expired" });

    const scheduledTime = nextEphemeralCleanupSlot();
    expect(await runScheduledCleanup(env, scheduledTime)).toBe(1);
    expect((await env.DB.prepare(
      "SELECT COUNT(*) AS cnt FROM sync_upload_items WHERE space_id=?1",
    ).bind(spaceId).first<{ cnt: number }>())?.cnt).toBe(1);
    expect((await createSpaceRepository(env.DB).getSpace(spaceId))?.lifecycleState).toBe("deleting");

    for (let iteration = 0; iteration < 8; iteration += 1) {
      if (!await createSpaceRepository(env.DB).getSpace(spaceId)) break;
      await runScheduledCleanup(env, scheduledTime);
    }
    expect(await createSpaceRepository(env.DB).getSpace(spaceId)).toBeNull();
    expect(await env.BLOB_STORE.head(r2Asset!.r2Key)).toBeNull();
    for (const table of ["sync_upload_items", "sync_delete_items", "sync_assets", "sync_upload_batches"]) {
      expect((await env.DB.prepare(
        `SELECT COUNT(*) AS cnt FROM ${table} WHERE space_id=?1`,
      ).bind(spaceId).first<{ cnt: number }>())?.cnt).toBe(0);
    }
  });

  it("到期清理等待仍在 PUT lease 内的上传项，lease 结束后可以重试", async () => {
    const spaceId = `${ANONYMOUS_SPACE_PREFIX}live-upload-${crypto.randomUUID()}`;
    await createSpace(spaceId);
    const bytes = new TextEncoder().encode("live-upload");
    const object = await objectFor(bytes, "blueprint", "live", "m-live");
    const prepared = await (await prepare(spaceId, "0", "live-upload", [object])).json() as Record<string, any>;
    const now = Date.now();
    const firstCleanupTime = nextEphemeralCleanupSlot(now);
    const leaseExpiresAt = new Date(firstCleanupTime + 60_000).toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE sync_upload_items
         SET state='uploading',lease_expires_at=?2
         WHERE upload_id=?1`,
      ).bind(prepared.uploadId, leaseExpiresAt),
      env.DB.prepare(
        "UPDATE sync_spaces SET expires_at=?2 WHERE space_id=?1",
      ).bind(spaceId, new Date(firstCleanupTime - 1).toISOString()),
    ]);

    expect(await runScheduledCleanup(env, firstCleanupTime)).toBe(1);
    expect((await env.DB.prepare(
      "SELECT COUNT(*) AS cnt FROM sync_upload_items WHERE space_id=?1",
    ).bind(spaceId).first<{ cnt: number }>())?.cnt).toBe(1);

    const afterLease = firstCleanupTime + 10 * 60_000;
    for (let iteration = 0; iteration < 6; iteration += 1) {
      if (!await createSpaceRepository(env.DB).getSpace(spaceId)) break;
      await runScheduledCleanup(env, afterLease);
    }
    expect(await createSpaceRepository(env.DB).getSpace(spaceId)).toBeNull();
  });

  it("stable 仅保留匿名 capabilities，账户空间持合法会话可用", async () => {
    const previousFlag = env.ALLOW_ANONYMOUS_SPACES;
    const previousSecret = env.JWT_SECRET;
    env.ALLOW_ANONYMOUS_SPACES = "false";
    env.JWT_SECRET = JWT_SECRET;
    try {
      expect((await request("/v1/sync/capabilities")).status).toBe(200);
      const anonymousCreate = await jsonRequest("/v1/sync/spaces", {
        spaceId: `${ANONYMOUS_SPACE_PREFIX}stable-anonymous-${crypto.randomUUID()}`,
      });
      expect(anonymousCreate.status).toBe(401);

      const token = await accountToken("stable-account");
      const mine = await authenticatedRequest("/v1/sync/spaces/mine", token);
      expect(mine.status).toBe(200);
      const { spaceId } = await mine.json() as { spaceId: string };
      expect((await authenticatedRequest(
        `/v1/sync/spaces/${spaceId}/check?knownRevision=0`,
        token,
      )).status).toBe(204);
      expect((await request(`/v1/sync/spaces/${spaceId}/plan`)).status).toBe(401);
    } finally {
      env.ALLOW_ANONYMOUS_SPACES = previousFlag;
      env.JWT_SECRET = previousSecret;
    }
  });

  it("sync 直连遇到缺失配置时 fail-closed", async () => {
    const previousFlag = env.ALLOW_ANONYMOUS_SPACES;
    const previousSecret = env.JWT_SECRET;
    env.ALLOW_ANONYMOUS_SPACES = undefined;
    env.JWT_SECRET = undefined;
    try {
      const noFlag = await request(`/v1/sync/spaces/missing-${crypto.randomUUID()}/plan`);
      expect(noFlag.status).toBe(500);
      env.ALLOW_ANONYMOUS_SPACES = "true";
      const noSecret = await request(`/v1/sync/spaces/missing-${crypto.randomUUID()}/plan`, {
        headers: { authorization: "Bearer invalid" },
      });
      expect(noSecret.status).toBe(500);
    } finally {
      env.ALLOW_ANONYMOUS_SPACES = previousFlag;
      env.JWT_SECRET = previousSecret;
    }
  });
});

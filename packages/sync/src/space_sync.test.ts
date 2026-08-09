import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import fs from "node:fs";
import path from "node:path";
import worker from "./index";
import type { SpaceSyncEnv } from "./space_http";
import { runScheduledCleanup } from "./space_http";
import { sha256Hex } from "./space_token";

const SECRET = "space-revision-test-secret-with-32-bytes";
let proxy: PlatformProxy<{ DB: D1Database; BLOB_STORE: R2Bucket }>;
let env: SpaceSyncEnv;

async function applySchema(db: D1Database): Promise<void> {
  const sql = fs.readFileSync(
    path.resolve(__dirname, "..", "migrations", "0001_create_sync_tables.sql"),
    "utf8",
  );
  const executable = sql.split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  for (const statement of executable.split(";").map((value) => value.trim()).filter(Boolean)) {
    await db.prepare(statement).run();
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
  baseRevision: number,
  clientBatchId: string,
  objects: Awaited<ReturnType<typeof objectFor>>[],
): Promise<Response> {
  return jsonRequest(`/v1/sync/spaces/${spaceId}/mutations`, {
    protocol: "cf-sync-v2",
    action: "prepare",
    baseRevision,
    clientBatchId,
    objects,
  });
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

  it("同一 base revision 并发 prepare 只有一个取得整个 space 的锁", async () => {
    const spaceId = `concurrent-${crypto.randomUUID()}`;
    await createSpace(spaceId);
    const bytes = new TextEncoder().encode("concurrent");
    const object = await objectFor(bytes, "blueprint", "a", "m-a");
    const responses = await Promise.all([
      prepare(spaceId, 0, "client-a", [object]),
      prepare(spaceId, 0, "client-b", [{ ...object, clientMutationId: "m-b" }]),
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
    const prepareResponse = await prepare(spaceId, 0, "batch-1", objects);
    expect(prepareResponse.status).toBe(200);
    const prepared = await prepareResponse.json() as Record<string, any>;
    expect(prepared).toMatchObject({ baseRevision: 0, targetRevision: 1, targetEpoch: 1 });

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
      revision: 1,
      epoch: 1,
    });
    const plan = await (await request(`/v1/sync/spaces/${spaceId}/plan`)).json() as Record<string, any>;
    expect(plan.revision).toBe(1);
    expect(plan.epoch).toBe(1);
    expect(plan.assets).toHaveLength(2);
    expect(plan.assets.map((asset: Record<string, unknown>) => asset.lastModifiedRevision))
      .toEqual([1, 1]);

    const repeatedCommit = await commit(spaceId, prepared);
    expect(await repeatedCommit.json()).toMatchObject({
      status: "already-committed",
      revision: 1,
      epoch: 1,
    });
  });

  it("相同 clientBatchId 的 prepare 重试返回同一个 uploadId", async () => {
    const spaceId = `idempotent-${crypto.randomUUID()}`;
    await createSpace(spaceId);
    const bytes = new TextEncoder().encode("same-plan");
    const object = await objectFor(bytes, "blueprint", "same", "m-same");
    const first = await (await prepare(spaceId, 0, "stable-client-batch", [object])).json() as Record<string, any>;
    const second = await (await prepare(spaceId, 0, "stable-client-batch", [object])).json() as Record<string, any>;
    expect(second.uploadId).toBe(first.uploadId);
    expect(second.commitToken).toBe(first.commitToken);
  });

  it("commit 拒绝尚未全部完成的对象", async () => {
    const spaceId = `incomplete-${crypto.randomUUID()}`;
    await createSpace(spaceId);
    const bytes = new TextEncoder().encode("not-uploaded");
    const object = await objectFor(bytes, "blueprint", "missing", "m-missing");
    const prepared = await (await prepare(spaceId, 0, "incomplete", [object])).json() as Record<string, any>;
    const response = await commit(spaceId, prepared);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "uploads_incomplete" });
  });

  it("cancel 清理暂存并释放 space 锁，不推进 revision/epoch", async () => {
    const spaceId = `cancel-${crypto.randomUUID()}`;
    await createSpace(spaceId);
    const bytes = new TextEncoder().encode("cancel-me");
    const object = await objectFor(bytes, "blueprint", "cancelled", "m-cancel");
    const prepared = await (await prepare(spaceId, 0, "cancel-batch", [object])).json() as Record<string, any>;
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
    expect(plan).toMatchObject({ revision: 0, epoch: 0, assets: [] });
  });

  it("15 分钟过期批次由清理器释放，旧 base revision 可以重新 prepare", async () => {
    const spaceId = `expire-${crypto.randomUUID()}`;
    await createSpace(spaceId);
    const bytes = new TextEncoder().encode("expires");
    const object = await objectFor(bytes, "blueprint", "expired", "m-expired");
    const prepared = await (await prepare(spaceId, 0, "expires-batch", [object])).json() as Record<string, any>;
    await env.DB.prepare(
      "UPDATE sync_upload_batches SET expires_at='2000-01-01T00:00:00.000Z' WHERE upload_id=?1",
    ).bind(prepared.uploadId).run();
    await env.DB.prepare(
      "UPDATE sync_spaces SET lock_expires_at='2000-01-01T00:00:00.000Z' WHERE space_id=?1",
    ).bind(spaceId).run();
    expect(await runScheduledCleanup(env)).toBeGreaterThanOrEqual(1);

    const retry = await prepare(spaceId, 0, "after-expiry", [{ ...object, clientMutationId: "m-after" }]);
    expect(retry.status).toBe(200);
  });

  it("大对象通过 R2 固定 key 提交，full 模式连续提交保持 epoch=revision", async () => {
    const spaceId = `r2-${crypto.randomUUID()}`;
    await createSpace(spaceId);
    const firstBytes = new Uint8Array(614_400);
    firstBytes.fill(7);
    const firstObject = await objectFor(firstBytes, "blueprint", "large", "m-large-1");
    const first = await (await prepare(spaceId, 0, "large-1", [firstObject])).json() as Record<string, any>;
    expect(first.uploads[0]).toMatchObject({ required: true, backend: "r2" });
    expect((await uploadAll(first, new Map([["blueprint/large", firstBytes]])))[0]?.status).toBe(200);
    expect((await commit(spaceId, first)).status).toBe(200);

    const secondBytes = new Uint8Array(614_401);
    secondBytes.fill(9);
    const secondObject = await objectFor(secondBytes, "blueprint", "large", "m-large-2");
    const second = await (await prepare(spaceId, 1, "large-2", [secondObject])).json() as Record<string, any>;
    expect((await uploadAll(second, new Map([["blueprint/large", secondBytes]])))[0]?.status).toBe(200);
    const committed = await (await commit(spaceId, second)).json() as Record<string, any>;
    expect(committed).toMatchObject({ revision: 2, epoch: 2 });

    const rows = await env.DB.prepare(
      "SELECT r2_key FROM sync_assets WHERE space_id=?1 AND asset_type='blueprint' AND asset_id='large'",
    ).bind(spaceId).all<{ r2_key: string }>();
    expect(rows.results).toHaveLength(1);
    expect((await env.BLOB_STORE.list({ prefix: `sync/v3/spaces/${encodeURIComponent(spaceId)}/` })).objects)
      .toHaveLength(1);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPlatformProxy } from "wrangler";
import fs from "node:fs";
import path from "node:path";
import { sha256Hex } from "./commit_token";
import { deriveFixedR2Key, type PrepareMutation } from "./model";
import type { SyncEnv } from "./http";
import { createRepository, type SyncRepository } from "./repository";
import { handleCommit, recoverPendingCommit } from "./service";

async function applyMigration(db: D1Database, filename: string): Promise<void> {
  const sql = fs.readFileSync(path.resolve(__dirname, "..", "migrations", filename), "utf8");
  const statements = sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) {
    try {
      await db.prepare(statement).run();
    } catch (error) {
      if (!String(error).includes("duplicate column name:")) throw error;
    }
  }
}

const SECRET = "latest-storage-test-secret-32-bytes";
const EPOCH = "epoch-001";
const SPACE_ID = `latest-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const ASSET_TYPE = "blueprint";
const ASSET_ID = "asset-1";

let db: D1Database;
let r2: R2Bucket;
let worker: typeof import("./index").default;

function env(): SyncEnv {
  return {
    DB: db,
    BLOB_STORE: r2,
    PROTOCOL_VERSION: "cf-sync-v1",
    MAX_MUTATIONS_PER_BATCH: "32",
    MAX_METADATA_SIZE: "262144",
    COMMIT_TOKEN_SECRET: SECRET,
    R2_ACCESS_KEY_ID: "",
    R2_SECRET_ACCESS_KEY: "",
    R2_ACCOUNT_ID: "",
    R2_BUCKET_NAME: "industrial-sync-blobs",
    LOCAL_DEV_HOST: "",
    PUBLIC_BASE_URL: "https://sync.test",
    R2_ENTER_THRESHOLD_BYTES: "614400",
    D1_RETURN_THRESHOLD_BYTES: "552960",
    MAX_BATCH_D1_BLOB_BYTES: "8388608",
    MAX_R2_BLOB_BYTES: "26214400",
    RETENTION_HEAD_WINDOW: "1000",
  };
}

async function request(pathname: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(new Request(`https://sync.test${pathname}`, init), env());
}

async function mutationFor(
  bytes: Uint8Array,
  clientMutationId: string,
  baseRevision: number | null,
  baseContentHash: string | null,
): Promise<PrepareMutation> {
  return {
    clientMutationId,
    assetType: ASSET_TYPE,
    assetId: ASSET_ID,
    baseRevision,
    baseContentHash,
    metadata: "{}",
    blobHash: await sha256Hex(bytes),
    blobByteSize: bytes.byteLength,
    storageMode: "full",
    schemaVersion: 1,
    encoding: "identity",
    writerAppVersion: "test",
    writerBuildId: "test",
  };
}

async function prepareUploadCommit(
  mutation: PrepareMutation,
  bytes: Uint8Array,
): Promise<{ prepare: Record<string, any>; commit: Record<string, any> }> {
  const prepareResponse = await request(`/v1/sync/spaces/${SPACE_ID}/mutations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      protocol: "cf-sync-v1",
      action: "prepare",
      spaceEpoch: EPOCH,
      clientBatchId: `batch-${mutation.clientMutationId}`,
      mutations: [mutation],
    }),
  });
  expect(prepareResponse.status).toBe(200);
  const prepare = await prepareResponse.json() as Record<string, any>;
  expect(prepare.status).toBe("ready");
  if (prepare.uploads[0].required) {
    const uploadResponse = await worker.fetch(
      new Request(prepare.uploads[0].url, {
        method: "PUT",
        headers: prepare.uploads[0].headers,
        body: bytes,
      }),
      env(),
    );
    expect(uploadResponse.status).toBe(200);
  }

  const commitResponse = await request(`/v1/sync/spaces/${SPACE_ID}/mutations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      protocol: "cf-sync-v1",
      action: "commit",
      spaceEpoch: EPOCH,
      commitToken: prepare.commitToken,
      mutations: [mutation],
    }),
  });
  expect(commitResponse.status).toBe(200);
  const commit = await commitResponse.json() as Record<string, any>;
  expect(commit.status).toBe("committed");
  return { prepare, commit };
}

async function prepareAndUpload(
  mutation: PrepareMutation,
  bytes: Uint8Array,
): Promise<Record<string, any>> {
  const prepareResponse = await request(`/v1/sync/spaces/${SPACE_ID}/mutations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      protocol: "cf-sync-v1",
      action: "prepare",
      spaceEpoch: EPOCH,
      clientBatchId: `batch-${mutation.clientMutationId}`,
      mutations: [mutation],
    }),
  });
  expect(prepareResponse.status).toBe(200);
  const prepare = await prepareResponse.json() as Record<string, any>;
  expect(prepare.status).toBe("ready");
  if (prepare.uploads[0].required) {
    const uploadResponse = await worker.fetch(
      new Request(prepare.uploads[0].url, {
        method: "PUT",
        headers: prepare.uploads[0].headers,
        body: bytes,
      }),
      env(),
    );
    expect(uploadResponse.status).toBe(200);
  }
  return prepare;
}

beforeAll(async () => {
  const proxy = await getPlatformProxy<{ DB: D1Database; BLOB_STORE: R2Bucket }>({
    configPath: path.resolve(__dirname, "..", "wrangler.toml"),
  });
  db = proxy.env.DB;
  r2 = proxy.env.BLOB_STORE;
  for (const migration of [
    "0001_create_sync_tables.sql",
    "0002_add_download_tables.sql",
    "0003_tiered_latest_storage.sql",
    "0004_delete_intent_recovery.sql",
  ]) {
    await applyMigration(db, migration);
  }
  worker = (await import("./index")).default;
  const response = await request("/v1/sync/spaces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ spaceId: SPACE_ID, activeEpoch: EPOCH }),
  });
  expect(response.status).toBe(201);
});

afterAll(async () => {
  await r2.delete(deriveFixedR2Key(SPACE_ID, ASSET_TYPE, ASSET_ID));
  await db.prepare("DELETE FROM sync_delete_intents WHERE space_id = ?1").bind(SPACE_ID).run();
  await db.prepare("DELETE FROM sync_commit_guards WHERE commit_id LIKE ?1").bind(`${SPACE_ID}%`).run();
  await db.prepare("DELETE FROM sync_commit_intents WHERE space_id = ?1").bind(SPACE_ID).run();
  await db.prepare("DELETE FROM sync_upload_sessions WHERE space_id = ?1").bind(SPACE_ID).run();
  await db.prepare("DELETE FROM sync_asset_storage WHERE space_id = ?1").bind(SPACE_ID).run();
  await db.prepare("DELETE FROM sync_mutation_results WHERE space_id = ?1").bind(SPACE_ID).run();
  await db.prepare("DELETE FROM sync_changes WHERE space_id = ?1").bind(SPACE_ID).run();
  await db.prepare("DELETE FROM sync_module_heads WHERE space_id = ?1").bind(SPACE_ID).run();
  await db.prepare("DELETE FROM sync_assets WHERE space_id = ?1").bind(SPACE_ID).run();
  await db.prepare("DELETE FROM sync_spaces WHERE space_id = ?1").bind(SPACE_ID).run();
});

describe("RQ-007 最新态 D1/R2 与下载链路", () => {
  it("小文件走 D1，下载必须持有当前版本票据", async () => {
    const bytes = new TextEncoder().encode("d1-current-payload");
    const mutation = await mutationFor(bytes, "m-d1-1", null, null);
    const { prepare } = await prepareUploadCommit(mutation, bytes);
    expect(prepare.uploads[0].backend).toBe("d1");

    const row = await db.prepare(
      "SELECT active_backend, d1_blob_hash, r2_present FROM sync_asset_storage WHERE space_id = ?1",
    ).bind(SPACE_ID).first<Record<string, unknown>>();
    expect(row?.active_backend).toBe("d1");
    expect(row?.d1_blob_hash).toBe(mutation.blobHash);
    expect(row?.r2_present).toBe(0);

    const planResponse = await request(`/v1/sync/spaces/${SPACE_ID}/plan`);
    expect(planResponse.status).toBe(200);
    const plan = await planResponse.json() as Record<string, any>;
    const asset = plan.modules[0].assets[0];
    expect(asset.backend).toBe("d1");
    const download = await worker.fetch(new Request(asset.downloadUrl), env());
    expect(download.status).toBe(200);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);
    expect(download.headers.get("X-Storage-Backend")).toBe("d1");

    const naked = await request(
      `/v1/sync/spaces/${SPACE_ID}/blobs/${EPOCH}/sha256/${mutation.blobHash.slice(0, 2)}/${mutation.blobHash}`,
    );
    expect(naked.status).toBe(401);
  });

  it("达到 600 KiB 后覆盖唯一固定 R2 key，并能干净下载", async () => {
    const previous = await db.prepare(
      "SELECT revision, content_hash FROM sync_assets WHERE space_id = ?1 AND epoch = ?2",
    ).bind(SPACE_ID, EPOCH).first<Record<string, unknown>>();
    const bytes = new Uint8Array(614400).fill(0x52);
    const mutation = await mutationFor(
      bytes,
      "m-r2-1",
      previous?.revision as number,
      previous?.content_hash as string,
    );
    const { prepare } = await prepareUploadCommit(mutation, bytes);
    expect(prepare.uploads[0].backend).toBe("r2");

    const key = deriveFixedR2Key(SPACE_ID, ASSET_TYPE, ASSET_ID);
    const object = await r2.head(key);
    expect(object?.size).toBe(bytes.byteLength);
    expect(object?.customMetadata?.sha256).toBe(mutation.blobHash);
    const listing = await r2.list({ prefix: key });
    expect(listing.objects.map((item) => item.key)).toEqual([key]);

    const storage = await db.prepare(
      "SELECT active_backend, d1_blob_hash, r2_blob_hash, r2_key FROM sync_asset_storage WHERE space_id = ?1",
    ).bind(SPACE_ID).first<Record<string, unknown>>();
    expect(storage?.active_backend).toBe("r2");
    expect(storage?.d1_blob_hash).not.toBeNull();
    expect(storage?.r2_blob_hash).toBe(mutation.blobHash);
    expect(storage?.r2_key).toBe(key);

    const plan = await (await request(`/v1/sync/spaces/${SPACE_ID}/plan`)).json() as Record<string, any>;
    const download = await worker.fetch(new Request(plan.modules[0].assets[0].downloadUrl), env());
    expect(download.status).toBe(200);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);
    expect(download.headers.get("X-Storage-Backend")).toBe("r2");
  });

  it("当前 R2 在 90% 与主阈值之间继续使用同一个 R2 key", async () => {
    const asset = await db.prepare(
      "SELECT revision, content_hash FROM sync_assets WHERE space_id = ?1 AND epoch = ?2",
    ).bind(SPACE_ID, EPOCH).first<Record<string, unknown>>();
    const bytes = new Uint8Array(552961).fill(0x48);
    const mutation = await mutationFor(
      bytes,
      "m-r2-hysteresis",
      asset?.revision as number,
      asset?.content_hash as string,
    );
    const { prepare } = await prepareUploadCommit(mutation, bytes);
    expect(prepare.uploads[0].backend).toBe("r2");
    const key = deriveFixedR2Key(SPACE_ID, ASSET_TYPE, ASSET_ID);
    const listing = await r2.list({ prefix: key });
    expect(listing.objects.map((item) => item.key)).toEqual([key]);
    expect((await r2.head(key))?.customMetadata?.sha256).toBe(mutation.blobHash);
  });

  it("R2 缩小到 90% 阈值后回 D1，但保留原固定 R2 文件", async () => {
    const asset = await db.prepare(
      "SELECT revision, content_hash FROM sync_assets WHERE space_id = ?1 AND epoch = ?2",
    ).bind(SPACE_ID, EPOCH).first<Record<string, unknown>>();
    const oldStorage = await db.prepare(
      "SELECT r2_blob_hash, r2_version FROM sync_asset_storage WHERE space_id = ?1",
    ).bind(SPACE_ID).first<Record<string, unknown>>();
    const bytes = new TextEncoder().encode("back-to-d1");
    const mutation = await mutationFor(
      bytes,
      "m-d1-2",
      asset?.revision as number,
      asset?.content_hash as string,
    );
    const { prepare } = await prepareUploadCommit(mutation, bytes);
    expect(prepare.uploads[0].backend).toBe("d1");

    const storage = await db.prepare(
      "SELECT active_backend, d1_blob_hash, r2_present, r2_blob_hash, r2_version FROM sync_asset_storage WHERE space_id = ?1",
    ).bind(SPACE_ID).first<Record<string, unknown>>();
    expect(storage?.active_backend).toBe("d1");
    expect(storage?.d1_blob_hash).toBe(mutation.blobHash);
    expect(storage?.r2_present).toBe(1);
    expect(storage?.r2_blob_hash).toBe(oldStorage?.r2_blob_hash);
    expect(storage?.r2_version).toBe(oldStorage?.r2_version);

    const key = deriveFixedR2Key(SPACE_ID, ASSET_TYPE, ASSET_ID);
    expect(await r2.head(key)).not.toBeNull();
  });

  it("downloads:sign 拒绝非当前 hash，旧下载 URL 变为 stale", async () => {
    const plan = await (await request(`/v1/sync/spaces/${SPACE_ID}/plan`)).json() as Record<string, any>;
    const currentAsset = plan.modules[0].assets[0];
    const currentDownloadUrl = currentAsset.downloadUrl as string;

    const unknownHash = "0".repeat(64);
    const unknownResponse = await request(`/v1/sync/spaces/${SPACE_ID}/downloads:sign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blobHashes: [unknownHash] }),
    });
    expect(unknownResponse.status).toBe(404);

    const signedResponse = await request(`/v1/sync/spaces/${SPACE_ID}/downloads:sign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blobHashes: [currentAsset.blobHash] }),
    });
    expect(signedResponse.status).toBe(200);
    const signed = await signedResponse.json() as Record<string, any>;
    expect(signed.urls[0].assetId).toBe(ASSET_ID);

    const bytes = new TextEncoder().encode("newer-d1-content");
    const mutation = await mutationFor(
      bytes,
      "m-d1-3",
      currentAsset.revision,
      currentAsset.contentHash,
    );
    await prepareUploadCommit(mutation, bytes);
    const staleResponse = await worker.fetch(new Request(currentDownloadUrl), env());
    expect(staleResponse.status).toBe(410);
  });

  it("R2 覆盖完成后 D1 finalize 中断，下一请求只向前恢复且不新增 key", async () => {
    const asset = await db.prepare(
      "SELECT revision, content_hash FROM sync_assets WHERE space_id = ?1 AND epoch = ?2",
    ).bind(SPACE_ID, EPOCH).first<Record<string, unknown>>();
    const bytes = new Uint8Array(614400).fill(0x43);
    const mutation = await mutationFor(
      bytes,
      "m-r2-recovery",
      asset?.revision as number,
      asset?.content_hash as string,
    );
    const prepare = await prepareAndUpload(mutation, bytes);
    const repository = createRepository(db);
    const faultRepository: SyncRepository = {
      ...repository,
      finalizeTieredCommit: async () => {
        throw new Error("injected-finalize-failure");
      },
    };

    await expect(handleCommit(
      SPACE_ID,
      EPOCH,
      prepare.commitToken,
      [mutation],
      {
        repo: faultRepository,
        r2Bucket: r2,
        commitTokenSecret: SECRET,
        now: Date.now(),
        presentTime: new Date().toISOString(),
      },
    )).rejects.toThrow("injected-finalize-failure");

    const pending = await repository.getSpaceHead(SPACE_ID);
    expect(pending?.pendingCommitId).toBeTruthy();
    const key = deriveFixedR2Key(SPACE_ID, ASSET_TYPE, ASSET_ID);
    expect((await r2.head(key))?.customMetadata?.sha256).toBe(mutation.blobHash);

    const recovered = await recoverPendingCommit(SPACE_ID, {
      repo: repository,
      r2Bucket: r2,
    });
    expect(recovered?.[0]).toMatchObject({ contentHash: mutation.blobHash });
    expect((await repository.getSpaceHead(SPACE_ID))?.pendingCommitId).toBeNull();
    expect(await db.prepare(
      "SELECT 1 FROM sync_commit_intents WHERE space_id = ?1",
    ).bind(SPACE_ID).first()).toBeNull();
    expect((await r2.list({ prefix: key })).objects.map((object) => object.key)).toEqual([key]);

    const committed = await repository.getAssetHead(SPACE_ID, EPOCH, ASSET_TYPE, ASSET_ID);
    const smallBytes = new TextEncoder().encode("d1-after-r2-recovery");
    const smallMutation = await mutationFor(
      smallBytes,
      "m-d1-after-recovery",
      committed?.revision as number,
      committed?.contentHash as string,
    );
    await prepareUploadCommit(smallMutation, smallBytes);
    expect((await repository.getAssetStorage(SPACE_ID, ASSET_TYPE, ASSET_ID))?.activeBackend).toBe("d1");
    expect(await r2.head(key)).not.toBeNull();
  });

  it("两个基于同一 head 的 D1 提交并发时只有一个能原子推进", async () => {
    const repository = createRepository(db);
    const asset = await repository.getAssetHead(SPACE_ID, EPOCH, ASSET_TYPE, ASSET_ID);
    const storage = await repository.getAssetStorage(SPACE_ID, ASSET_TYPE, ASSET_ID);
    expect(storage?.activeBackend).toBe("d1");
    const bytes = new Uint8Array(storage?.d1Content ?? new ArrayBuffer(0));
    const first = await mutationFor(
      bytes,
      "m-concurrent-first",
      asset?.revision as number,
      asset?.contentHash as string,
    );
    const second = { ...first, clientMutationId: "m-concurrent-second" };
    const [firstPrepare, secondPrepare] = await Promise.all([
      prepareAndUpload(first, bytes),
      prepareAndUpload(second, bytes),
    ]);
    expect(firstPrepare.uploads[0].required).toBe(false);
    expect(secondPrepare.uploads[0].required).toBe(false);

    const commitRequest = (mutation: PrepareMutation, commitToken: string) => request(
      `/v1/sync/spaces/${SPACE_ID}/mutations`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          protocol: "cf-sync-v1",
          action: "commit",
          spaceEpoch: EPOCH,
          commitToken,
          mutations: [mutation],
        }),
      },
    );
    const beforeHead = (await repository.getSpaceHead(SPACE_ID))?.head as number;
    const responses = await Promise.all([
      commitRequest(first, firstPrepare.commitToken),
      commitRequest(second, secondPrepare.commitToken),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect((await repository.getSpaceHead(SPACE_ID))?.head).toBe(beforeHead + 1);
    expect((await repository.getAssetHead(SPACE_ID, EPOCH, ASSET_TYPE, ASSET_ID))?.revision)
      .toBe((asset?.revision as number) + 1);
  });

  it("资产删除即使当前走 D1，也删除保留的固定 R2 文件并发布 tombstone", async () => {
    const plan = await (await request(`/v1/sync/spaces/${SPACE_ID}/plan`)).json() as Record<string, any>;
    const currentAsset = plan.modules[0].assets[0];
    const currentDownloadUrl = currentAsset.downloadUrl as string;
    const key = deriveFixedR2Key(SPACE_ID, ASSET_TYPE, ASSET_ID);
    expect(await r2.head(key)).not.toBeNull();

    const staleDelete = await request(
      `/v1/sync/spaces/${SPACE_ID}/assets/${ASSET_TYPE}/${ASSET_ID}`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          spaceEpoch: EPOCH,
          expectedRevision: currentAsset.revision - 1,
          expectedContentHash: currentAsset.contentHash,
        }),
      },
    );
    expect(staleDelete.status).toBe(409);
    expect(await r2.head(key)).not.toBeNull();

    const deleteBody = JSON.stringify({
      spaceEpoch: EPOCH,
      expectedRevision: currentAsset.revision,
      expectedContentHash: currentAsset.contentHash,
    });
    let injected = false;
    const failingR2 = new Proxy(r2, {
      get(target, property) {
        if (property === "delete") {
          return async (keys: string | string[]) => {
            await target.delete(keys);
            if (!injected) {
              injected = true;
              throw new Error("injected-after-r2-delete");
            }
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const interruptedDelete = await worker.fetch(
      new Request(
        `https://sync.test/v1/sync/spaces/${SPACE_ID}/assets/${ASSET_TYPE}/${ASSET_ID}`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: deleteBody,
        },
      ),
      { ...env(), BLOB_STORE: failingR2 },
    );
    expect(interruptedDelete.status).toBe(500);
    expect(await r2.head(key)).toBeNull();
    expect((await createRepository(db).getSpaceHead(SPACE_ID))?.pendingCommitId).toBeTruthy();

    const recoveredDelete = await request(
      `/v1/sync/spaces/${SPACE_ID}/assets/${ASSET_TYPE}/${ASSET_ID}`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: deleteBody,
      },
    );
    expect(recoveredDelete.status).toBe(200);
    expect(recoveredDelete.headers.get("access-control-allow-methods")).toContain("DELETE");
    const deleted = await recoveredDelete.json() as Record<string, any>;
    expect(deleted).toMatchObject({
      ok: true,
      deleted: false,
      revision: currentAsset.revision + 1,
    });

    expect(await r2.head(key)).toBeNull();
    expect(await db.prepare(
      "SELECT 1 FROM sync_asset_storage WHERE space_id = ?1 AND asset_type = ?2 AND asset_id = ?3",
    ).bind(SPACE_ID, ASSET_TYPE, ASSET_ID).first()).toBeNull();
    const tombstone = await db.prepare(
      "SELECT revision, current_head, content_hash, deleted_at FROM sync_assets WHERE space_id = ?1 AND epoch = ?2 AND asset_type = ?3 AND asset_id = ?4",
    ).bind(SPACE_ID, EPOCH, ASSET_TYPE, ASSET_ID).first<Record<string, unknown>>();
    expect(tombstone?.revision).toBe(currentAsset.revision + 1);
    expect(tombstone?.content_hash).toBeNull();
    expect(tombstone?.deleted_at).toBe(deleted.deletedAt);
    expect(await db.prepare(
      "SELECT 1 FROM sync_delete_intents WHERE space_id = ?1",
    ).bind(SPACE_ID).first()).toBeNull();

    const staleDownload = await worker.fetch(new Request(currentDownloadUrl), env());
    expect(staleDownload.status).toBe(410);

    const retry = await request(
      `/v1/sync/spaces/${SPACE_ID}/assets/${ASSET_TYPE}/${ASSET_ID}`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          spaceEpoch: EPOCH,
          expectedRevision: currentAsset.revision,
          expectedContentHash: currentAsset.contentHash,
        }),
      },
    );
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ ok: true, deleted: false });
  });
});

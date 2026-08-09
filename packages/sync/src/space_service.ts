// Space revision 上传事务用例编排。

import type {
  AbortResponse,
  AssetRow,
  CommitResult,
  DeleteItemRow,
  PlanResponse,
  PrepareDeletion,
  PrepareObject,
  PrepareResponse,
  SpaceRow,
  StorageConfig,
  TransactionStatusResponse,
  UploadBatchRow,
  UploadInstruction,
  UploadItemRow,
} from "./space_model";
import {
  deriveFixedR2Key,
  selectStorageBackend,
} from "./space_model";
import type { SpaceRepository } from "./space_repository";
import { isConstraintConflict } from "./space_repository";
import {
  sha256Hex,
  signSpaceToken,
  verifySpaceToken,
  type BatchTokenPayload,
  type DownloadTokenPayload,
  type UploadTokenPayload,
} from "./space_token";

export class SpaceProtocolError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

interface BaseDeps {
  repo: SpaceRepository;
  r2Bucket: R2Bucket;
  tokenSecret: string;
  now: number;
}

interface PrepareDeps extends BaseDeps {
  publicBaseUrl: string;
  storage: StorageConfig;
}

function iso(now: number): string {
  return new Date(now).toISOString();
}

function itemKey(item: Pick<UploadItemRow, "assetType" | "assetId">): string {
  return `${item.assetType}\u0000${item.assetId}`;
}

function canonicalObjects(objects: PrepareObject[]): PrepareObject[] {
  return [...objects].sort((left, right) =>
    left.assetType.localeCompare(right.assetType) || left.assetId.localeCompare(right.assetId)
  );
}

function canonicalDeletions(deletions: PrepareDeletion[]): PrepareDeletion[] {
  return [...deletions].sort((left, right) =>
    left.assetType.localeCompare(right.assetType) || left.assetId.localeCompare(right.assetId)
  );
}

async function descriptorHash(
  objects: PrepareObject[],
  deletions: PrepareDeletion[],
): Promise<string> {
  // AI-CORRECTION 2026-08-09: 不含删除的既有 v2 批次保留原 descriptor hash，
  // 新删除集合进入同一个幂等描述符，避免跨部署重试漂移。
  if (deletions.length === 0) return sha256Hex(JSON.stringify(canonicalObjects(objects)));
  return sha256Hex(JSON.stringify({
    objects: canonicalObjects(objects),
    deletions: canonicalDeletions(deletions),
  }));
}

function batchTokenPayload(batch: UploadBatchRow): BatchTokenPayload {
  return {
    kind: "batch",
    uploadId: batch.uploadId,
    spaceId: batch.spaceId,
    clientBatchId: batch.clientBatchId,
    baseRevision: batch.baseRevision,
    descriptorHash: batch.descriptorHash,
    expiresAt: Date.parse(batch.expiresAt),
  };
}

function reusableCopy(asset: AssetRow | null, target: "d1" | "r2", object: PrepareObject): boolean {
  if (!asset) return false;
  if (target === "d1") {
    return asset.d1Content !== null &&
      asset.d1BlobHash === object.blobHash &&
      asset.d1ByteSize === object.blobByteSize &&
      asset.d1Encoding === object.encoding;
  }
  return asset.r2Present &&
    asset.r2BlobHash === object.blobHash &&
    asset.r2ByteSize === object.blobByteSize &&
    asset.r2Encoding === object.encoding;
}

function buildUploadUrl(
  base: string,
  spaceId: string,
  uploadId: string,
  item: UploadItemRow,
  ticket: string,
): string {
  return `${base.replace(/\/$/, "")}/v1/sync/spaces/${encodeURIComponent(spaceId)}` +
    `/uploads/${encodeURIComponent(uploadId)}/assets/${encodeURIComponent(item.assetType)}` +
    `/${encodeURIComponent(item.assetId)}?ticket=${encodeURIComponent(ticket)}`;
}

async function instructionsForBatch(
  batch: UploadBatchRow,
  items: UploadItemRow[],
  tokenSecret: string,
  publicBaseUrl: string,
): Promise<UploadInstruction[]> {
  return Promise.all(items.map(async (item) => {
    if (item.state === "ready") {
      return {
        assetType: item.assetType,
        assetId: item.assetId,
        required: false,
        backend: item.targetBackend,
      };
    }
    const ticket = await signSpaceToken({
      kind: "upload",
      uploadId: batch.uploadId,
      spaceId: batch.spaceId,
      assetType: item.assetType,
      assetId: item.assetId,
      blobHash: item.blobHash,
      byteSize: item.blobByteSize,
      backend: item.targetBackend,
      expiresAt: Date.parse(batch.expiresAt),
    }, tokenSecret);
    return {
      assetType: item.assetType,
      assetId: item.assetId,
      required: true,
      backend: item.targetBackend,
      url: buildUploadUrl(publicBaseUrl, batch.spaceId, batch.uploadId, item, ticket),
      headers: { "Content-Type": "application/octet-stream" },
    };
  }));
}

async function responseForBatch(
  batch: UploadBatchRow,
  items: UploadItemRow[],
  tokenSecret: string,
  publicBaseUrl: string,
): Promise<PrepareResponse> {
  return {
    status: "ready",
    uploadId: batch.uploadId,
    commitToken: await signSpaceToken(batchTokenPayload(batch), tokenSecret),
    baseRevision: batch.baseRevision,
    targetRevision: batch.targetRevision,
    targetEpoch: batch.targetEpoch,
    expiresAt: batch.expiresAt,
    uploads: await instructionsForBatch(batch, items, tokenSecret, publicBaseUrl),
  };
}

function assertBatchToken(
  payload: BatchTokenPayload,
  batch: UploadBatchRow,
  spaceId: string,
): void {
  if (
    payload.uploadId !== batch.uploadId ||
    payload.spaceId !== spaceId ||
    payload.clientBatchId !== batch.clientBatchId ||
    payload.baseRevision !== batch.baseRevision ||
    payload.descriptorHash !== batch.descriptorHash
  ) {
    throw new SpaceProtocolError(403, "token_scope_mismatch", "批次票据与上传事务不匹配");
  }
}

function objectMatchesCompletedR2(object: R2Object | null, item: UploadItemRow): object is R2Object {
  return object !== null &&
    object.size === item.blobByteSize &&
    object.customMetadata?.uploadId === item.uploadId &&
    object.customMetadata?.assetType === item.assetType &&
    object.customMetadata?.assetId === item.assetId &&
    object.customMetadata?.sha256 === item.blobHash;
}

async function completeR2Items(
  items: UploadItemRow[],
  r2Bucket: R2Bucket,
): Promise<Record<string, string>> {
  const versions: Record<string, string> = {};
  for (const item of items) {
    if (item.targetBackend !== "r2" || !item.r2MultipartUploadId) continue;
    if (!item.partEtag || item.state !== "reserved") {
      throw new Error(`上传项 ${item.assetType}/${item.assetId} 未达到 R2 complete 条件`);
    }
    let object = await r2Bucket.head(item.objectKey);
    if (!objectMatchesCompletedR2(object, item)) {
      try {
        object = await r2Bucket
          .resumeMultipartUpload(item.objectKey, item.r2MultipartUploadId)
          .complete([{ partNumber: 1, etag: item.partEtag }]);
        if (!objectMatchesCompletedR2(object, item)) {
          object = await r2Bucket.head(item.objectKey);
        }
      } catch (error) {
        object = await r2Bucket.head(item.objectKey);
        if (!objectMatchesCompletedR2(object, item)) throw error;
      }
    }
    if (!objectMatchesCompletedR2(object, item)) {
      throw new Error(`R2 对象 ${item.objectKey} 完成后校验失败`);
    }
    versions[itemKey(item)] = object.version;
  }
  return versions;
}

function resultForBatch(
  batch: UploadBatchRow,
  items: UploadItemRow[],
  deletions: DeleteItemRow[],
  now: string,
): CommitResult {
  return {
    status: "committed",
    uploadId: batch.uploadId,
    revision: batch.targetRevision,
    epoch: batch.targetEpoch,
    assets: items.map((item) => ({
      assetType: item.assetType,
      assetId: item.assetId,
      contentHash: item.blobHash,
      lastModifiedRevision: batch.targetRevision,
    })),
    deletedAssets: deletions.map((deletion) => ({
      assetType: deletion.assetType,
      assetId: deletion.assetId,
    })),
    serverTime: now,
  };
}

async function deleteR2Items(
  deletions: DeleteItemRow[],
  deps: BaseDeps,
): Promise<void> {
  for (const deletion of deletions) {
    if (deletion.state === "deleted") continue;
    if (deletion.state !== "reserved") {
      throw new Error(`删除项 ${deletion.assetType}/${deletion.assetId} 未达到 reserved 状态`);
    }
    await deps.r2Bucket.delete(deletion.objectKey);
    if (!await deps.repo.markDeleteItemDeleted(
      deletion.uploadId,
      deletion.assetType,
      deletion.assetId,
      iso(deps.now),
    )) {
      throw new Error(`固定 R2 对象 ${deletion.objectKey} 删除后状态未能推进`);
    }
  }
}

async function cancelInternal(batch: UploadBatchRow, deps: BaseDeps): Promise<boolean> {
  if (batch.state === "cancelled") return true;
  if (batch.state === "committed" || batch.state === "committing") return false;
  const now = iso(deps.now);
  if (!await deps.repo.beginCancel(batch.uploadId, now)) return false;
  const items = await deps.repo.listItems(batch.uploadId);
  for (const item of items) {
    if (!item.r2MultipartUploadId) continue;
    try {
      await deps.r2Bucket.resumeMultipartUpload(item.objectKey, item.r2MultipartUploadId).abort();
    } catch {
      // multipart 可能已经由 R2 回收；取消仍可继续释放 D1 租约。
    }
  }
  await deps.repo.finishCancel(batch.uploadId, now);
  return true;
}

export async function recoverBatch(batch: UploadBatchRow, deps: BaseDeps): Promise<CommitResult | null> {
  if (batch.state === "committed") {
    return batch.resultJson ? JSON.parse(batch.resultJson) as CommitResult : null;
  }
  if (batch.state === "cancelling") {
    await cancelInternal(batch, deps);
    return null;
  }
  if (batch.state === "prepared") {
    if (Date.parse(batch.expiresAt) <= deps.now) await cancelInternal(batch, deps);
    return null;
  }
  if (batch.state !== "committing") return null;

  const items = await deps.repo.listItems(batch.uploadId);
  const deletions = await deps.repo.listDeleteItems(batch.uploadId);
  try {
    const versions = await completeR2Items(items, deps.r2Bucket);
    await deleteR2Items(deletions, deps);
    const committedAt = iso(deps.now);
    const result = resultForBatch(batch, items, deletions, committedAt);
    await deps.repo.finalizeCommit({
      batch,
      items,
      deletions,
      r2Versions: versions,
      result,
      committedAt,
    });
    return result;
  } catch (error) {
    await deps.repo.setBatchError(
      batch.uploadId,
      error instanceof Error ? error.message : String(error),
      iso(deps.now),
    );
    throw error;
  }
}

export async function recoverSpace(spaceId: string, deps: BaseDeps): Promise<void> {
  const pending = await deps.repo.getPendingBatch(spaceId);
  if (pending) await recoverBatch(pending, deps);
}

export async function prepareSpaceUpload(
  spaceId: string,
  baseRevision: number,
  clientBatchId: string,
  objects: PrepareObject[],
  deletions: PrepareDeletion[],
  deps: PrepareDeps,
): Promise<PrepareResponse> {
  if (!clientBatchId) {
    throw new SpaceProtocolError(400, "bad_request", "clientBatchId 不能为空");
  }
  const digest = await descriptorHash(objects, deletions);
  const existing = await deps.repo.getBatchByClientId(spaceId, clientBatchId);
  if (existing) {
    if (existing.baseRevision !== baseRevision || existing.descriptorHash !== digest) {
      throw new SpaceProtocolError(409, "idempotency_conflict", "clientBatchId 已绑定另一份上传计划");
    }
    if (existing.state === "committed") {
      throw new SpaceProtocolError(409, "batch_already_committed", "上传批次已经提交");
    }
    if (existing.state === "prepared" && Date.parse(existing.expiresAt) <= deps.now) {
      await cancelInternal(existing, deps);
      throw new SpaceProtocolError(410, "batch_expired", "上传批次已经过期");
    }
    if (existing.state === "committing") {
      await recoverBatch(existing, deps);
      throw new SpaceProtocolError(409, "batch_already_committed", "上传批次已经提交");
    }
    if (existing.state === "cancelled" || existing.state === "cancelling") {
      throw new SpaceProtocolError(409, "batch_cancelled", "上传批次已经取消");
    }
    return responseForBatch(
      existing,
      await deps.repo.listItems(existing.uploadId),
      deps.tokenSecret,
      deps.publicBaseUrl,
    );
  }

  await recoverSpace(spaceId, deps);
  const space = await deps.repo.getSpace(spaceId);
  if (!space) throw new SpaceProtocolError(404, "space_not_found", "空间不存在");
  if (space.pendingUploadId) {
    throw new SpaceProtocolError(409, "space_locked", "空间已有上传事务", {
      uploadId: space.pendingUploadId,
      expiresAt: space.lockExpiresAt,
    });
  }
  if (space.revision !== baseRevision) {
    throw new SpaceProtocolError(409, "revision_mismatch", "space revision 已变化", {
      expectedRevision: baseRevision,
      actualRevision: space.revision,
    });
  }

  const now = iso(deps.now);
  const expiresAt = iso(deps.now + deps.storage.uploadTtlSeconds * 1000);
  const uploadId = crypto.randomUUID();
  const batch: UploadBatchRow = {
    uploadId,
    spaceId,
    clientBatchId,
    baseRevision,
    targetRevision: baseRevision + 1,
    targetEpoch: space.epoch + 1,
    descriptorHash: digest,
    state: "prepared",
    expiresAt,
    resultJson: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };

  let d1Bytes = 0;
  const items: UploadItemRow[] = [];
  for (const object of canonicalObjects(objects)) {
    if (object.blobByteSize > deps.storage.maxR2BlobBytes) {
      throw new SpaceProtocolError(413, "blob_too_large", "payload 超过文件上限");
    }
    const asset = await deps.repo.getAsset(spaceId, object.assetType, object.assetId);
    const sourceBackend = asset?.activeBackend ?? "d1";
    const targetBackend = selectStorageBackend(sourceBackend, object.blobByteSize, deps.storage);
    const reusable = reusableCopy(asset, targetBackend, object);
    if (targetBackend === "d1" && !reusable) d1Bytes += object.blobByteSize;
    items.push({
      ...object,
      uploadId,
      spaceId,
      sourceBackend,
      targetBackend,
      objectKey: asset?.r2Key ?? deriveFixedR2Key(spaceId, object.assetType, object.assetId),
      r2MultipartUploadId: null,
      partEtag: null,
      d1Content: null,
      state: reusable ? "ready" : "issued",
      leaseExpiresAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }
  const deleteItems: DeleteItemRow[] = [];
  for (const deletion of canonicalDeletions(deletions)) {
    const asset = await deps.repo.getAsset(spaceId, deletion.assetType, deletion.assetId);
    if (!asset) {
      throw new SpaceProtocolError(404, "asset_not_found", "待删除资产不存在", {
        assetType: deletion.assetType,
        assetId: deletion.assetId,
      });
    }
    deleteItems.push({
      ...deletion,
      uploadId,
      spaceId,
      objectKey: asset.r2Key,
      state: "issued",
      createdAt: now,
      updatedAt: now,
    });
  }
  if (d1Bytes > deps.storage.maxBatchD1BlobBytes) {
    throw new SpaceProtocolError(413, "d1_batch_too_large", "批次 D1 暂存总量超过上限");
  }

  try {
    await deps.repo.reserveUpload({ batch, items, deletions: deleteItems, lockedAt: now });
  } catch (error) {
    if (!isConstraintConflict(error)) throw error;
    const current = await deps.repo.getSpace(spaceId);
    if (current?.pendingUploadId) {
      throw new SpaceProtocolError(409, "space_locked", "空间已有上传事务", {
        uploadId: current.pendingUploadId,
        expiresAt: current.lockExpiresAt,
      });
    }
    throw new SpaceProtocolError(409, "revision_mismatch", "space revision 已变化", {
      expectedRevision: baseRevision,
      actualRevision: current?.revision,
    });
  }
  return responseForBatch(batch, items, deps.tokenSecret, deps.publicBaseUrl);
}

export async function uploadSpaceObject(
  path: { spaceId: string; uploadId: string; assetType: string; assetId: string },
  ticket: string,
  body: ArrayBuffer,
  deps: BaseDeps,
): Promise<{ uploadId: string; assetType: string; assetId: string; backend: "d1" | "r2" }> {
  const verified = await verifySpaceToken(ticket, deps.tokenSecret, deps.now);
  if (!verified.ok || verified.payload.kind !== "upload") {
    throw new SpaceProtocolError(401, verified.ok ? "token_invalid" : verified.code, "上传票据无效或过期");
  }
  const payload = verified.payload as UploadTokenPayload;
  if (
    payload.spaceId !== path.spaceId ||
    payload.uploadId !== path.uploadId ||
    payload.assetType !== path.assetType ||
    payload.assetId !== path.assetId
  ) {
    throw new SpaceProtocolError(403, "token_scope_mismatch", "上传票据与路径不匹配");
  }
  if (body.byteLength !== payload.byteSize) {
    throw new SpaceProtocolError(400, "blob_size_mismatch", "实际大小与 prepare 声明不一致");
  }
  if (await sha256Hex(body) !== payload.blobHash) {
    throw new SpaceProtocolError(400, "blob_checksum_mismatch", "payload SHA-256 不匹配");
  }

  const [space, batch, item] = await Promise.all([
    deps.repo.getSpace(path.spaceId),
    deps.repo.getBatch(path.uploadId),
    deps.repo.getItem(path.uploadId, path.assetType, path.assetId),
  ]);
  if (
    !space || !batch || !item ||
    space.pendingUploadId !== batch.uploadId ||
    batch.state !== "prepared" ||
    Date.parse(batch.expiresAt) <= deps.now ||
    item.blobHash !== payload.blobHash ||
    item.blobByteSize !== payload.byteSize ||
    item.targetBackend !== payload.backend
  ) {
    throw new SpaceProtocolError(409, "upload_not_active", "上传事务不存在、已过期或状态不匹配");
  }
  if (item.state === "ready") {
    return { uploadId: path.uploadId, assetType: path.assetType, assetId: path.assetId, backend: item.targetBackend };
  }

  const now = iso(deps.now);
  const claimed = await deps.repo.claimItem(
    path.uploadId,
    path.assetType,
    path.assetId,
    now,
    iso(deps.now + 60_000),
  );
  if (!claimed) throw new SpaceProtocolError(409, "upload_in_progress", "对象正在上传或批次已经关闭");

  try {
    if (item.targetBackend === "d1") {
      if (!await deps.repo.markD1ItemReady(path.uploadId, path.assetType, path.assetId, body, now)) {
        throw new Error("D1 payload 已写入但状态未能推进");
      }
    } else {
      let multipart: R2MultipartUpload;
      if (item.r2MultipartUploadId) {
        multipart = deps.r2Bucket.resumeMultipartUpload(item.objectKey, item.r2MultipartUploadId);
      } else {
        multipart = await deps.r2Bucket.createMultipartUpload(item.objectKey, {
          httpMetadata: { contentType: "application/octet-stream" },
          customMetadata: {
            uploadId: item.uploadId,
            assetType: item.assetType,
            assetId: item.assetId,
            sha256: item.blobHash,
          },
        });
        await deps.repo.setMultipartId(item.uploadId, item.assetType, item.assetId, multipart.uploadId, now);
      }
      const part = await multipart.uploadPart(1, body);
      if (!await deps.repo.markR2ItemReady(item.uploadId, item.assetType, item.assetId, part.etag, now)) {
        throw new Error("R2 part 已上传但状态未能推进");
      }
    }
  } catch (error) {
    await deps.repo.releaseItem(path.uploadId, path.assetType, path.assetId, iso(Date.now()));
    throw error;
  }
  return { uploadId: path.uploadId, assetType: path.assetType, assetId: path.assetId, backend: item.targetBackend };
}

export async function commitSpaceUpload(
  spaceId: string,
  uploadId: string,
  token: string,
  deps: BaseDeps,
): Promise<CommitResult> {
  const verified = await verifySpaceToken(token, deps.tokenSecret, deps.now);
  if (!verified.ok || verified.payload.kind !== "batch") {
    throw new SpaceProtocolError(401, verified.ok ? "token_invalid" : verified.code, "批次票据无效或过期");
  }
  let batch = await deps.repo.getBatch(uploadId);
  if (!batch || batch.spaceId !== spaceId) {
    throw new SpaceProtocolError(404, "upload_not_found", "上传批次不存在");
  }
  assertBatchToken(verified.payload as BatchTokenPayload, batch, spaceId);
  if (batch.state === "committed") {
    if (!batch.resultJson) throw new Error("已提交批次缺少幂等结果");
    return { ...(JSON.parse(batch.resultJson) as CommitResult), status: "already-committed" };
  }
  if (batch.state === "cancelled" || batch.state === "cancelling") {
    throw new SpaceProtocolError(409, "batch_cancelled", "上传批次已经取消");
  }
  if (batch.state === "prepared" && Date.parse(batch.expiresAt) <= deps.now) {
    await cancelInternal(batch, deps);
    throw new SpaceProtocolError(410, "batch_expired", "上传批次已经过期");
  }
  if (batch.state === "prepared") {
    try {
      await deps.repo.beginCommit(uploadId, iso(deps.now));
    } catch (error) {
      if (!isConstraintConflict(error)) throw error;
      const items = await deps.repo.listItems(uploadId);
      if (items.some((item) => item.state !== "ready")) {
        throw new SpaceProtocolError(409, "uploads_incomplete", "仍有对象尚未上传完成");
      }
      throw new SpaceProtocolError(409, "commit_precondition_failed", "提交前置条件已经变化");
    }
    batch = (await deps.repo.getBatch(uploadId))!;
  }
  const result = await recoverBatch(batch, deps);
  if (!result) throw new Error("提交状态无法恢复");
  return result;
}

export async function cancelSpaceUpload(
  spaceId: string,
  uploadId: string,
  token: string,
  deps: BaseDeps,
): Promise<{ status: "cancelled" | "already-cancelled"; uploadId: string }> {
  const verified = await verifySpaceToken(token, deps.tokenSecret, deps.now);
  if (!verified.ok || verified.payload.kind !== "batch") {
    throw new SpaceProtocolError(401, verified.ok ? "token_invalid" : verified.code, "批次票据无效或过期");
  }
  const batch = await deps.repo.getBatch(uploadId);
  if (!batch || batch.spaceId !== spaceId) {
    throw new SpaceProtocolError(404, "upload_not_found", "上传批次不存在");
  }
  assertBatchToken(verified.payload as BatchTokenPayload, batch, spaceId);
  if (batch.state === "cancelled") return { status: "already-cancelled", uploadId };
  if (batch.state === "committed" || batch.state === "committing") {
    throw new SpaceProtocolError(409, "commit_in_progress", "commit 开始后只能向前恢复，不能取消");
  }
  if (!await cancelInternal(batch, deps)) {
    throw new SpaceProtocolError(409, "upload_in_progress", "仍有 PUT 正在执行，请稍后重试取消");
  }
  return { status: "cancelled", uploadId };
}

async function assertReadableSpace(spaceId: string, deps: BaseDeps): Promise<SpaceRow> {
  await recoverSpace(spaceId, deps);
  const space = await deps.repo.getSpace(spaceId);
  if (!space) throw new SpaceProtocolError(404, "space_not_found", "空间不存在");
  if (space.pendingUploadId) {
    throw new SpaceProtocolError(423, "space_locked", "空间存在未完成上传事务", {
      uploadId: space.pendingUploadId,
      expiresAt: space.lockExpiresAt,
    });
  }
  return space;
}

export async function planSpace(
  spaceId: string,
  deps: BaseDeps & { publicBaseUrl: string },
): Promise<PlanResponse> {
  const space = await assertReadableSpace(spaceId, deps);
  const assets = await deps.repo.listAssets(spaceId);
  return {
    spaceId,
    revision: space.revision,
    epoch: space.epoch,
    assets: await Promise.all(assets.map(async (asset) => {
      const ticket = await signSpaceToken({
        kind: "download",
        spaceId,
        assetType: asset.assetType,
        assetId: asset.assetId,
        revision: space.revision,
        blobHash: asset.contentHash,
        expiresAt: deps.now + 5 * 60_000,
      }, deps.tokenSecret);
      return {
        assetType: asset.assetType,
        assetId: asset.assetId,
        contentHash: asset.contentHash,
        byteSize: asset.byteSize,
        encoding: asset.encoding,
        metadata: asset.metadata,
        schemaVersion: asset.schemaVersion,
        storageMode: asset.storageMode,
        backend: asset.activeBackend,
        lastModifiedRevision: asset.lastModifiedRevision,
        downloadUrl: `${deps.publicBaseUrl.replace(/\/$/, "")}/v1/sync/spaces/${encodeURIComponent(spaceId)}` +
          `/assets/${encodeURIComponent(asset.assetType)}/${encodeURIComponent(asset.assetId)}/content` +
          `?ticket=${encodeURIComponent(ticket)}`,
      };
    })),
    serverTime: iso(deps.now),
  };
}

export async function checkSpaceRevision(
  spaceId: string,
  knownRevision: number,
  deps: BaseDeps,
): Promise<{ revision: number; epoch: number; changed: boolean; planRequired: boolean; serverTime: string }> {
  const space = await assertReadableSpace(spaceId, deps);
  return {
    revision: space.revision,
    epoch: space.epoch,
    changed: knownRevision !== space.revision,
    planRequired: knownRevision !== space.revision,
    serverTime: iso(deps.now),
  };
}

export async function downloadSpaceObject(
  path: { spaceId: string; assetType: string; assetId: string },
  ticket: string,
  deps: BaseDeps,
): Promise<{ body: ReadableStream | ArrayBuffer; headers: Headers }> {
  const verified = await verifySpaceToken(ticket, deps.tokenSecret, deps.now);
  if (!verified.ok || verified.payload.kind !== "download") {
    throw new SpaceProtocolError(401, verified.ok ? "token_invalid" : verified.code, "下载票据无效或过期");
  }
  const payload = verified.payload as DownloadTokenPayload;
  if (
    payload.spaceId !== path.spaceId ||
    payload.assetType !== path.assetType ||
    payload.assetId !== path.assetId
  ) {
    throw new SpaceProtocolError(403, "token_scope_mismatch", "下载票据与路径不匹配");
  }
  const space = await assertReadableSpace(path.spaceId, deps);
  const asset = await deps.repo.getAsset(path.spaceId, path.assetType, path.assetId);
  if (!asset || payload.revision !== space.revision || payload.blobHash !== asset.contentHash) {
    throw new SpaceProtocolError(409, "download_stale", "下载票据对应的 space revision 已经过期");
  }
  const headers = new Headers({
    "content-type": "application/octet-stream",
    "content-length": String(asset.byteSize),
    "x-content-sha256": asset.contentHash,
    "x-space-revision": String(space.revision),
  });
  if (asset.activeBackend === "d1") {
    if (!asset.d1Content) throw new Error("当前 D1 payload 缺失");
    return { body: asset.d1Content, headers };
  }
  const object = await deps.r2Bucket.get(asset.r2Key);
  if (!object) throw new Error("当前 R2 payload 缺失");
  return { body: object.body, headers };
}

export async function cleanupRecoverableBatches(deps: BaseDeps, limit = 50): Promise<number> {
  const batches = await deps.repo.listRecoverableBatches(iso(deps.now), limit);
  for (const batch of batches) await recoverBatch(batch, deps);
  return batches.length;
}

// ============================================================================
// 事务查询 & 强制丢弃
// ============================================================================

async function forceCancelInternal(batch: UploadBatchRow, deps: BaseDeps): Promise<boolean> {
  if (batch.state === "cancelled") return true;
  if (batch.state === "committed") return false;
  const now = iso(deps.now);
  if (!await deps.repo.beginForceAbort(batch.uploadId, now)) return false;
  const items = await deps.repo.listItems(batch.uploadId);
  for (const item of items) {
    if (!item.r2MultipartUploadId) continue;
    try {
      await deps.r2Bucket.resumeMultipartUpload(item.objectKey, item.r2MultipartUploadId).abort();
    } catch {
      // multipart 可能已经由 R2 回收；取消仍可继续释放 D1 租约。
    }
  }
  await deps.repo.finishCancel(batch.uploadId, now);
  return true;
}

export async function getSpaceTransaction(
  spaceId: string,
  deps: BaseDeps,
): Promise<TransactionStatusResponse> {
  const space = await deps.repo.getSpace(spaceId);
  if (!space) throw new SpaceProtocolError(404, "space_not_found", "空间不存在");

  const detail = await deps.repo.getTransactionDetail(spaceId);
  if (!detail) return { hasActiveTransaction: false };

  return { hasActiveTransaction: true, transaction: detail };
}

export async function abortSpaceTransaction(
  spaceId: string,
  deps: BaseDeps,
): Promise<AbortResponse> {
  const space = await deps.repo.getSpace(spaceId);
  if (!space) throw new SpaceProtocolError(404, "space_not_found", "空间不存在");

  if (!space.pendingUploadId) return { status: "no-transaction" };

  const uploadId = space.pendingUploadId;
  const batch = await deps.repo.getBatch(uploadId);
  if (!batch) {
    // pending_upload_id 指向一个不存在的 batch —— 脏数据，直接清理锁
    const now = iso(deps.now);
    await deps.repo.beginForceAbort(uploadId, now);
    await deps.repo.finishCancel(uploadId, now);
    return { status: "aborted", uploadId };
  }

  if (batch.state === "committed") {
    return { status: "already-committed", uploadId, revision: batch.targetRevision };
  }
  if (batch.state === "cancelled") {
    return { status: "already-cancelled", uploadId };
  }
  if (batch.state === "cancelling") {
    await cancelInternal(batch, deps);
    return { status: "already-cancelled", uploadId };
  }

  // prepared 或 committing → 强制丢弃
  if (!await forceCancelInternal(batch, deps)) {
    throw new SpaceProtocolError(409, "abort_failed", "事务丢弃失败，可能已经提交");
  }
  return { status: "aborted", uploadId };
}

// Space revision 同步协议领域模型。
//
// 一个 space 同时只允许一个上传批次。revision 表示已提交的完整空间版本；
// epoch 表示 full base / patch chain 的世代。当前只实现 full，因此每次提交两者都递增。
// AI-CORRECTION 2026-08-12: revision 改为 prepare 原始请求内容哈希与服务端时间戳组成的字符串，
// 仅用于版本身份与 CAS；数值递增和前后顺序只由 epoch 表达。

export const SPACE_PROTOCOL_VERSION = "cf-sync-v2";
export const INITIAL_SPACE_REVISION = "0";
export const ANONYMOUS_SPACE_ID_PREFIX = "e2e-cf-";
export const ANONYMOUS_SPACE_TTL_MS = 60 * 60 * 1000;
export const DEFAULT_UPLOAD_TTL_SECONDS = 15 * 60;
export const DEFAULT_MAX_MUTATIONS_PER_BATCH = 32;
export const DEFAULT_MAX_METADATA_SIZE = 256 * 1024;
export const DEFAULT_R2_ENTER_THRESHOLD_BYTES = 600 * 1024;
export const DEFAULT_D1_RETURN_THRESHOLD_BYTES = Math.floor(
  DEFAULT_R2_ENTER_THRESHOLD_BYTES * 0.9,
);
export const DEFAULT_MAX_BATCH_D1_BLOB_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_R2_BLOB_BYTES = 25 * 1024 * 1024;

export type StorageBackend = "d1" | "r2";
export type R2Slot = "a" | "b";
export type SpaceOwnerKind = "anonymous" | "account";
export type SpaceLifecycleState = "active" | "deleting";
export type SpaceRevision = string;
export type UploadBatchState =
  | "prepared"
  | "committing"
  | "committed"
  | "cancelling"
  | "cancelled";
export type UploadItemState =
  | "issued"
  | "uploading"
  | "ready"
  | "reserved"
  | "committed"
  | "cancelled";

// Beta 只为无需登录的前端 E2E 测试保留匿名 Space 命名空间。
export function isAnonymousSpaceId(spaceId: string): boolean {
  return spaceId.startsWith(ANONYMOUS_SPACE_ID_PREFIX);
}

export function isSpaceAvailableAt(space: SpaceRow, now: number): boolean {
  if (space.lifecycleState !== "active") return false;
  if (space.expiresAt === null) return true;
  const expiresAt = Date.parse(space.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

export interface SpaceRow {
  spaceId: string;
  ownerKind: SpaceOwnerKind;
  ownerId: string | null;
  lifecycleState: SpaceLifecycleState;
  expiresAt: string | null;
  cleanupLeaseExpiresAt: string | null;
  revision: SpaceRevision;
  epoch: number;
  pendingUploadId: string | null;
  lockExpiresAt: string | null;
  updatedAt: string;
}

export interface AssetRow {
  spaceId: string;
  assetType: string;
  assetId: string;
  epoch: number;
  lastModifiedRevision: SpaceRevision;
  contentHash: string;
  byteSize: number;
  encoding: string;
  metadata: string;
  schemaVersion: number;
  writerAppVersion: string;
  writerBuildId: string;
  storageMode: "full";
  activeBackend: StorageBackend;
  d1Content: ArrayBuffer | null;
  d1BlobHash: string | null;
  d1ByteSize: number | null;
  d1Encoding: string | null;
  r2Key: string;
  r2Present: boolean;
  r2BlobHash: string | null;
  r2ByteSize: number | null;
  r2Encoding: string | null;
  r2Version: string | null;
  r2Etag: string | null;
  r2ActiveSlot: R2Slot;
  r2BPresent: boolean;
  r2BBlobHash: string | null;
  r2BByteSize: number | null;
  r2BEncoding: string | null;
  r2BVersion: string | null;
  r2BEtag: string | null;
  committedAt: string;
}

export interface PrepareObject {
  clientMutationId: string;
  assetType: string;
  assetId: string;
  metadata: string;
  blobHash: string;
  blobByteSize: number;
  storageMode: "full";
  schemaVersion: number;
  encoding: "identity";
  writerAppVersion: string;
  writerBuildId: string;
}

export interface PrepareDeletion {
  clientMutationId: string;
  assetType: string;
  assetId: string;
}

export interface DeleteItemRow extends PrepareDeletion {
  uploadId: string;
  spaceId: string;
  objectKey: string;
  objectKeyB: string;
  state: "issued" | "reserved" | "deleted" | "committed" | "cancelled";
  createdAt: string;
  updatedAt: string;
}

export interface UploadBatchRow {
  uploadId: string;
  spaceId: string;
  clientBatchId: string;
  baseRevision: SpaceRevision;
  targetRevision: SpaceRevision;
  targetEpoch: number;
  descriptorHash: string;
  state: UploadBatchState;
  expiresAt: string;
  resultJson: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UploadItemRow extends PrepareObject {
  uploadId: string;
  spaceId: string;
  sourceBackend: StorageBackend;
  targetBackend: StorageBackend;
  r2PrimaryKey: string;
  targetR2Slot: R2Slot | null;
  objectKey: string;
  r2MultipartUploadId: string | null;
  partEtag: string | null;
  d1Content: ArrayBuffer | null;
  state: UploadItemState;
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UploadInstruction {
  assetType: string;
  assetId: string;
  required: boolean;
  backend: StorageBackend;
  url?: string;
  headers?: Record<string, string>;
}

export interface PrepareResponse {
  status: "ready";
  uploadId: string;
  commitToken: string;
  baseRevision: SpaceRevision;
  targetRevision: SpaceRevision;
  targetEpoch: number;
  expiresAt: string;
  serverTime: string;
  uploads: UploadInstruction[];
}

export interface CommitResult {
  status: "committed" | "already-committed";
  uploadId: string;
  revision: SpaceRevision;
  epoch: number;
  assets: Array<{
    assetType: string;
    assetId: string;
    contentHash: string;
    lastModifiedRevision: SpaceRevision;
  }>;
  deletedAssets: Array<{
    assetType: string;
    assetId: string;
  }>;
  serverTime: string;
}

export interface PlanResponse {
  spaceId: string;
  revision: SpaceRevision;
  epoch: number;
  assets: Array<{
    assetType: string;
    assetId: string;
    contentHash: string;
    byteSize: number;
    encoding: string;
    metadata: string;
    schemaVersion: number;
    storageMode: "full";
    backend: StorageBackend;
    lastModifiedRevision: SpaceRevision;
    downloadUrl: string;
  }>;
  serverTime: string;
}

// ============================================================================
// 事务查询 & 强制丢弃
// ============================================================================

export interface TransactionInfo {
  uploadId: string;
  clientBatchId: string;
  state: UploadBatchState;
  baseRevision: SpaceRevision;
  targetRevision: SpaceRevision;
  targetEpoch: number;
  expiresAt: string;
  createdAt: string;
  objectCount: number;
  deletionCount: number;
}

export interface TransactionStatusResponse {
  hasActiveTransaction: boolean;
  transaction?: TransactionInfo;
}

export type AbortStatus =
  | "aborted"
  | "already-cancelled"
  | "already-committed"
  | "no-transaction";

export interface AbortResponse {
  status: AbortStatus;
  uploadId?: string;
  revision?: SpaceRevision;
}

export interface StorageConfig {
  r2EnterThresholdBytes: number;
  d1ReturnThresholdBytes: number;
  maxBatchD1BlobBytes: number;
  maxR2BlobBytes: number;
  uploadTtlSeconds: number;
}

export function isSpaceRevision(value: unknown): value is SpaceRevision {
  return typeof value === "string" && value.length <= 128 && (
    /^\d+$/.test(value) || /^[0-9a-f]{64}-\d+$/.test(value)
  );
}

export function buildSpaceRevision(
  requestContentHash: string,
  serverTimestamp: number,
): SpaceRevision {
  if (
    !/^[0-9a-f]{64}$/.test(requestContentHash) ||
    !Number.isSafeInteger(serverTimestamp) ||
    serverTimestamp < 0
  ) {
    throw new Error("无法由非法 request content hash 或服务端时间戳构造 revision");
  }
  return `${requestContentHash}-${serverTimestamp}`;
}

export function selectStorageBackend(
  currentBackend: StorageBackend,
  byteSize: number,
  config: Pick<StorageConfig, "r2EnterThresholdBytes" | "d1ReturnThresholdBytes">,
): StorageBackend {
  if (currentBackend === "r2") {
    return byteSize <= config.d1ReturnThresholdBytes ? "d1" : "r2";
  }
  return byteSize < config.r2EnterThresholdBytes ? "d1" : "r2";
}

export function deriveFixedR2Key(
  spaceId: string,
  assetType: string,
  assetId: string,
): string {
  return `sync/v3/spaces/${encodeURIComponent(spaceId)}/assets/${encodeURIComponent(assetType)}/${encodeURIComponent(assetId)}/payload`;
}

export function deriveR2SlotKey(primaryKey: string, slot: R2Slot): string {
  return slot === "a" ? primaryKey : `${primaryKey}.b`;
}

export function inactiveR2Slot(activeSlot: R2Slot): R2Slot {
  return activeSlot === "a" ? "b" : "a";
}

export function validatePrepareObjects(
  value: unknown,
  maxBatchSize: number,
): { ok: true; objects: PrepareObject[] } | { ok: false; message: string } {
  // AI-CORRECTION 2026-08-09: cf-sync-v2 批次允许只包含资产删除；非空约束改由
  // validatePrepareBatch 对 objects + deletions 的完整 mutation 集合统一校验。
  if (!Array.isArray(value)) {
    return { ok: false, message: "objects 必须是数组" };
  }
  if (value.length > maxBatchSize) {
    return { ok: false, message: `objects 数量超过上限 ${maxBatchSize}` };
  }

  const seenAssets = new Set<string>();
  const seenMutations = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object") {
      return { ok: false, message: "objects 包含非法对象" };
    }
    const object = raw as Record<string, unknown>;
    const requiredStrings = [
      "clientMutationId",
      "assetType",
      "assetId",
      "metadata",
      "blobHash",
      "storageMode",
      "encoding",
      "writerAppVersion",
      "writerBuildId",
    ];
    if (requiredStrings.some((key) => typeof object[key] !== "string" || object[key] === "")) {
      return { ok: false, message: "object 缺少必填字符串字段" };
    }
    if (!Number.isSafeInteger(object.blobByteSize) || (object.blobByteSize as number) < 0) {
      return { ok: false, message: "blobByteSize 必须是非负整数" };
    }
    if (!Number.isSafeInteger(object.schemaVersion) || (object.schemaVersion as number) < 1) {
      return { ok: false, message: "schemaVersion 必须是正整数" };
    }
    if (!/^[0-9a-f]{64}$/.test(object.blobHash as string)) {
      return { ok: false, message: "blobHash 必须是小写 SHA-256" };
    }
    if (object.storageMode !== "full") {
      return { ok: false, message: "当前仅支持 full storageMode" };
    }
    if (object.encoding !== "identity") {
      return { ok: false, message: "当前仅支持 identity encoding" };
    }
    const assetKey = `${object.assetType as string}\u0000${object.assetId as string}`;
    if (seenAssets.has(assetKey)) {
      return { ok: false, message: "同一批次不能重复声明资产" };
    }
    if (seenMutations.has(object.clientMutationId as string)) {
      return { ok: false, message: "同一批次不能重复 clientMutationId" };
    }
    seenAssets.add(assetKey);
    seenMutations.add(object.clientMutationId as string);
  }
  return { ok: true, objects: value as PrepareObject[] };
}

export function validatePrepareBatch(
  objectValue: unknown,
  deletionValue: unknown,
  maxBatchSize: number,
):
  | { ok: true; objects: PrepareObject[]; deletions: PrepareDeletion[] }
  | { ok: false; message: string } {
  const objects = validatePrepareObjects(objectValue, maxBatchSize);
  if (!objects.ok) return objects;
  if (!Array.isArray(deletionValue)) {
    return { ok: false, message: "deletions 必须是数组" };
  }
  if (objects.objects.length + deletionValue.length === 0) {
    return { ok: false, message: "objects 和 deletions 不能同时为空" };
  }
  if (objects.objects.length + deletionValue.length > maxBatchSize) {
    return { ok: false, message: `mutation 数量超过上限 ${maxBatchSize}` };
  }

  const assetKeys = new Set(objects.objects.map(
    (object) => `${object.assetType}\u0000${object.assetId}`,
  ));
  const mutationIds = new Set(objects.objects.map((object) => object.clientMutationId));
  for (const raw of deletionValue) {
    if (!raw || typeof raw !== "object") {
      return { ok: false, message: "deletions 包含非法对象" };
    }
    const deletion = raw as Record<string, unknown>;
    if (
      typeof deletion.clientMutationId !== "string" || deletion.clientMutationId === "" ||
      typeof deletion.assetType !== "string" || deletion.assetType === "" ||
      typeof deletion.assetId !== "string" || deletion.assetId === ""
    ) {
      return { ok: false, message: "deletion 缺少必填字符串字段" };
    }
    const assetKey = `${deletion.assetType}\u0000${deletion.assetId}`;
    if (assetKeys.has(assetKey)) {
      return { ok: false, message: "同一批次不能重复变更资产" };
    }
    if (mutationIds.has(deletion.clientMutationId)) {
      return { ok: false, message: "同一批次不能重复 clientMutationId" };
    }
    assetKeys.add(assetKey);
    mutationIds.add(deletion.clientMutationId);
  }
  return { ok: true, objects: objects.objects, deletions: deletionValue as PrepareDeletion[] };
}

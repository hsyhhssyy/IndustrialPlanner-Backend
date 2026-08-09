// Space revision 同步协议领域模型。
//
// 一个 space 同时只允许一个上传批次。revision 表示已提交的完整空间版本；
// epoch 表示 full base / patch chain 的世代。当前只实现 full，因此每次提交两者都递增。

export const SPACE_PROTOCOL_VERSION = "cf-sync-v2";
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

export interface SpaceRow {
  spaceId: string;
  revision: number;
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
  lastModifiedRevision: number;
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

export interface UploadBatchRow {
  uploadId: string;
  spaceId: string;
  clientBatchId: string;
  baseRevision: number;
  targetRevision: number;
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
  baseRevision: number;
  targetRevision: number;
  targetEpoch: number;
  expiresAt: string;
  uploads: UploadInstruction[];
}

export interface CommitResult {
  status: "committed" | "already-committed";
  uploadId: string;
  revision: number;
  epoch: number;
  assets: Array<{
    assetType: string;
    assetId: string;
    contentHash: string;
    lastModifiedRevision: number;
  }>;
  serverTime: string;
}

export interface PlanResponse {
  spaceId: string;
  revision: number;
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
    lastModifiedRevision: number;
    downloadUrl: string;
  }>;
  serverTime: string;
}

export interface StorageConfig {
  r2EnterThresholdBytes: number;
  d1ReturnThresholdBytes: number;
  maxBatchD1BlobBytes: number;
  maxR2BlobBytes: number;
  uploadTtlSeconds: number;
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

export function validatePrepareObjects(
  value: unknown,
  maxBatchSize: number,
): { ok: true; objects: PrepareObject[] } | { ok: false; message: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, message: "objects 必须是非空数组" };
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

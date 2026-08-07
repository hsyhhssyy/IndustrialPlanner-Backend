// Sync Worker 领域模型

// ============================================================================
// 常量
// ============================================================================

export const PROTOCOL_VERSION = "cf-sync-v1";
export const DEFAULT_MAX_MUTATIONS_PER_BATCH = 32;
export const DEFAULT_MAX_METADATA_SIZE = 262144; // 256KB

// ============================================================================
// 核心领域类型
// ============================================================================

// 同步空间
export interface SyncSpace {
  spaceId: string;
  activeEpoch: string;
  head: number;
  minRetainedHead: number;
  updatedAt: string;
}

// 远端资产头（sync_assets 表映射）
export interface RemoteAssetHead {
  spaceId: string;
  epoch: string;
  assetType: string;
  assetId: string;
  revision: number;
  currentHead: number;
  contentHash: string | null;
  deletedAt: string | null;
  schemaVersion: number;
  minReadableSchemaVersion: number;
  writerAppVersion: string;
  writerBuildId: string;
  committedAt: string;
  storageMode: string | null;
  baseFullBlobHash: string | null;
  deltaDepth: number;
}

// ============================================================================
// 请求/响应类型
// ============================================================================

// prepare 请求中的单个 mutation
export interface PrepareMutation {
  clientMutationId: string;
  assetType: string;
  assetId: string;
  baseRevision: number | null;
  baseContentHash: string | null;
  metadata: string;
  blobHash: string;
  blobByteSize: number;
  storageMode: string;
  schemaVersion: number;
  encoding: string;
  writerAppVersion: string;
  writerBuildId: string;
}

// prepare 请求体
export interface PrepareMutationsRequest {
  protocol: string;
  spaceEpoch: string;
  clientBatchId: string;
  mutations: PrepareMutation[];
}

// 上传指令
export interface MutationUpload {
  assetType: string;
  assetId: string;
  required: boolean;
  url?: string;
  headers?: Record<string, string>;
}

// 已应用的幂等结果
export interface AlreadyAppliedMutation {
  clientMutationId: string;
  assetType: string;
  assetId: string;
  revision: number;
  contentHash: string;
}

// 冲突条目
export interface ConflictItem {
  assetType: string;
  assetId: string;
  reason: "revision-mismatch" | "hash-mismatch" | "space-epoch-changed";
  expectedRevision: number | null;
  actualRevision: number;
  expectedHash: string | null;
  actualHash: string | null;
}

// prepare 响应体
export interface PrepareMutationsResponse {
  status: "ready" | "conflict";
  uploads?: MutationUpload[];
  commitToken?: string;
  alreadyApplied?: AlreadyAppliedMutation[];
  conflicts?: ConflictItem[];
}

// commit 请求体
export interface CommitMutationsRequest {
  protocol: string;
  action: "commit";
  commitToken: string;
}

// 已应用的资产版本
export interface AppliedVersion {
  clientMutationId: string;
  assetType: string;
  assetId: string;
  revision: number;
  contentHash: string;
}

// commit 响应体
export interface CommitMutationsResponse {
  status: "committed" | "already-committed" | "conflict";
  applied?: AppliedVersion[];
  head?: number;
  serverTime?: string;
  conflicts?: ConflictItem[];
}

// ============================================================================
// 校验函数
// ============================================================================

export interface ValidationOk {
  ok: true;
}

export interface ValidationError {
  ok: false;
  code: string;
  message: string;
}

export type ValidationResult = ValidationOk | ValidationError;

// 协议版本校验
export function validateProtocolVersion(protocol: string): ValidationResult {
  if (protocol !== PROTOCOL_VERSION) {
    return {
      ok: false,
      code: "protocol_mismatch",
      message: `不支持的协议版本: ${protocol}，需要 ${PROTOCOL_VERSION}`,
    };
  }
  return { ok: true };
}

// storageMode 合法值
const VALID_STORAGE_MODES = new Set(["full", "patch-chain"]);

export function isValidStorageMode(mode: string | null | undefined): boolean {
  if (mode === null || mode === undefined) return true;
  return VALID_STORAGE_MODES.has(mode);
}

// 批次校验（数量 + 无重复 + storageMode 合法）
export function validateMutationBatch(
  mutations: PrepareMutation[],
  maxBatchSize: number,
): ValidationResult {
  // 数量
  if (mutations.length > maxBatchSize) {
    return {
      ok: false,
      code: "batch_too_large",
      message: `批次中 mutations 数量 ${mutations.length} 超过上限 ${maxBatchSize}`,
    };
  }

  // 空批次允许（仅幂等查询场景）
  if (mutations.length === 0) {
    return { ok: true };
  }

  // 无重复 assetType+assetId
  const seen = new Set<string>();
  for (const m of mutations) {
    const key = `${m.assetType}:${m.assetId}`;
    if (seen.has(key)) {
      return {
        ok: false,
        code: "bad_request",
        message: `批次内重复资产: ${key}`,
      };
    }
    seen.add(key);
  }

  // storageMode 合法
  for (const m of mutations) {
    if (!isValidStorageMode(m.storageMode)) {
      return {
        ok: false,
        code: "bad_request",
        message: `非法的 storageMode: ${m.storageMode}`,
      };
    }
  }

  return { ok: true };
}

// ============================================================================
// plan 端点类型
// ============================================================================

// 资产摘要（plan 响应中的每个 asset）
export interface AssetSummary {
  assetType: string;
  assetId: string;
  revision: number;
  contentHash: string | null;
  schemaVersion: number;
  storageMode: string | null;
  blobHash: string;
  byteSize: number;
  encoding: string;
  downloadUrl?: string;
  deletedAt?: string | null;
}

// plan 响应体
export interface PlanResponse {
  head: number;
  epoch: string;
  assets: AssetSummary[];
  serverTime: string;
}

// ============================================================================
// check 端点类型
// ============================================================================

// check 响应体
export interface CheckResponse {
  head: number;
  epoch: string;
  changed: boolean;
  updates?: AssetSummary[];
  serverTime: string;
}

// ============================================================================
// reset 端点类型
// ============================================================================

// reset 响应体
export interface ResetResponse {
  ok: boolean;
  spaceId: string;
  previousEpoch: string;
  newEpoch: string;
}

// ============================================================================
// downloads:sign 端点类型
// ============================================================================

// downloads:sign 请求体
export interface DownloadsSignRequest {
  blobHashes: string[];
}

// 单个签名 URL
export interface SignedUrl {
  blobHash: string;
  url: string;
}

// downloads:sign 响应体
export interface DownloadsSignResponse {
  urls: SignedUrl[];
}

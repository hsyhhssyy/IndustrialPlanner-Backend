// Commit Token — HMAC-SHA256 自包含 token 签发/验证
//
// token = base64url(JSON(payload)) + "." + base64url(HMAC-SHA256(secret, payloadJSON))
// secret 来自 Worker 环境变量 COMMIT_TOKEN_SECRET

export interface TokenMutation {
  clientMutationId: string;
  assetType: string;
  assetId: string;
  baseRevision: number | null;
  /** blobHash，用于 commit 阶段不需要客户端重复提交 */
  blobHash?: string;
  /** blobByteSize，用于 commit 阶段不需要客户端重复提交 */
  blobByteSize?: number;
  baseContentHash?: string | null;
  sourceBackend?: "d1" | "r2";
  targetBackend?: "d1" | "r2";
  thresholdVersion?: number;
  fixedR2Key?: string;
  uploadSessionId?: string | null;
  mutationFingerprint?: string;
}

export interface CommitTokenPayload {
  tokenVersion?: number;
  commitId?: string;
  spaceId: string;
  epoch: string;
  clientBatchId: string;
  observedHead: number;
  mutations: TokenMutation[];
  expiresAt: number;
}

export interface CapabilityTokenPayload {
  kind: "upload" | "download";
  spaceId: string;
  epoch: string;
  assetType: string;
  assetId: string;
  blobHash: string;
  byteSize: number;
  encoding: string;
  backend: "d1" | "r2";
  sessionId?: string;
  revision?: number;
  expiresAt: number;
}

export type CapabilityVerifyResult =
  | { ok: true; payload: CapabilityTokenPayload }
  | TokenVerifyError;

export interface TokenVerifyOk {
  ok: true;
  payload: CommitTokenPayload;
}

export interface TokenVerifyError {
  ok: false;
  code: "token_invalid" | "token_expired";
  message: string;
}

export type TokenVerifyResult = TokenVerifyOk | TokenVerifyError;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64urlEncode(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64urlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

async function hmacSha256(
  keyBytes: Uint8Array,
  data: Uint8Array,
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, data);
  return new Uint8Array(sig);
}

async function verifyHmacSha256(
  keyBytes: Uint8Array,
  data: Uint8Array,
  encodedSignature: string,
): Promise<boolean> {
  let signature: Uint8Array;
  try {
    signature = base64urlDecode(encodedSignature);
  } catch {
    return false;
  }
  if (signature.byteLength !== 32) return false;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", cryptoKey, signature, data);
}

export async function signCommitToken(
  payload: CommitTokenPayload,
  secret: string,
): Promise<string> {
  const payloadJson = JSON.stringify(payload);
  const payloadBytes = encoder.encode(payloadJson);
  const payloadB64 = base64urlEncode(payloadBytes);

  const secretBytes = encoder.encode(secret);
  const sig = await hmacSha256(secretBytes, payloadBytes);
  const sigB64 = base64urlEncode(sig);

  return `${payloadB64}.${sigB64}`;
}

export async function signCapabilityToken(
  payload: CapabilityTokenPayload,
  secret: string,
): Promise<string> {
  const payloadJson = JSON.stringify(payload);
  const payloadBytes = encoder.encode(payloadJson);
  const signature = await hmacSha256(encoder.encode(secret), payloadBytes);
  return `${base64urlEncode(payloadBytes)}.${base64urlEncode(signature)}`;
}

export async function verifyCommitToken(
  token: string,
  secret: string,
): Promise<TokenVerifyResult> {
  if (!token || !token.includes(".")) {
    return { ok: false, code: "token_invalid", message: "无效的 token 格式" };
  }

  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, code: "token_invalid", message: "无效的 token 格式" };
  }

  let payloadJson: string;
  try {
    const jsonBytes = base64urlDecode(parts[0]);
    payloadJson = decoder.decode(jsonBytes);
  } catch {
    return { ok: false, code: "token_invalid", message: "payload 解析失败" };
  }

  let payload: CommitTokenPayload;
  try {
    payload = JSON.parse(payloadJson) as CommitTokenPayload;
  } catch {
    return { ok: false, code: "token_invalid", message: "payload 解析失败" };
  }

  if (
    !payload.spaceId ||
    !payload.epoch ||
    typeof payload.observedHead !== "number" ||
    !Array.isArray(payload.mutations) ||
    typeof payload.expiresAt !== "number"
  ) {
    return { ok: false, code: "token_invalid", message: "payload 缺少必填字段" };
  }

  const payloadBytes = encoder.encode(payloadJson);
  const secretBytes = encoder.encode(secret);
  // AI-CORRECTION 2026-08-08: 使用 WebCrypto verify，避免以普通字符串比较 HMAC。
  if (!await verifyHmacSha256(secretBytes, payloadBytes, parts[1])) {
    return { ok: false, code: "token_invalid", message: "签名验证失败" };
  }

  if (payload.expiresAt < Date.now()) {
    return { ok: false, code: "token_expired", message: "token 已过期" };
  }

  return { ok: true, payload };
}

export async function verifyCapabilityToken(
  token: string,
  secret: string,
): Promise<CapabilityVerifyResult> {
  if (!token || !token.includes(".")) {
    return { ok: false, code: "token_invalid", message: "无效的 token 格式" };
  }

  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, code: "token_invalid", message: "无效的 token 格式" };
  }

  let payloadJson: string;
  let payload: CapabilityTokenPayload;
  try {
    payloadJson = decoder.decode(base64urlDecode(parts[0]));
    payload = JSON.parse(payloadJson) as CapabilityTokenPayload;
  } catch {
    return { ok: false, code: "token_invalid", message: "payload 解析失败" };
  }

  if (
    (payload.kind !== "upload" && payload.kind !== "download") ||
    !payload.spaceId ||
    !payload.epoch ||
    !payload.assetType ||
    !payload.assetId ||
    !/^[0-9a-f]{64}$/.test(payload.blobHash) ||
    !Number.isSafeInteger(payload.byteSize) ||
    payload.byteSize < 0 ||
    (payload.backend !== "d1" && payload.backend !== "r2") ||
    typeof payload.expiresAt !== "number"
  ) {
    return { ok: false, code: "token_invalid", message: "payload 缺少必填字段" };
  }

  const payloadBytes = encoder.encode(payloadJson);
  // AI-CORRECTION 2026-08-08: capability ticket 与 commit token 使用同一恒定时间验证路径。
  if (!await verifyHmacSha256(encoder.encode(secret), payloadBytes, parts[1])) {
    return { ok: false, code: "token_invalid", message: "签名验证失败" };
  }

  if (payload.expiresAt < Date.now()) {
    return { ok: false, code: "token_expired", message: "token 已过期" };
  }

  return { ok: true, payload };
}

export async function sha256Hex(bytes: ArrayBuffer | Uint8Array | string): Promise<string> {
  const value = typeof bytes === "string"
    ? encoder.encode(bytes)
    : bytes instanceof Uint8Array
      ? bytes
      : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", value);
  return Array.from(new Uint8Array(digest), (item) => item.toString(16).padStart(2, "0")).join("");
}

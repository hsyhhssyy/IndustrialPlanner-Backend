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
  blobHash: string;
  /** blobByteSize，用于 commit 阶段不需要客户端重复提交 */
  blobByteSize: number;
}

export interface CommitTokenPayload {
  spaceId: string;
  epoch: string;
  clientBatchId: string;
  observedHead: number;
  mutations: TokenMutation[];
  expiresAt: number;
}

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
    const jsonBytes = new Uint8Array(
      atob(parts[0].replace(/-/g, "+").replace(/_/g, "/"))
        .split("")
        .map((c) => c.charCodeAt(0)),
    );
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
  const expectedSig = await hmacSha256(secretBytes, payloadBytes);
  const expectedSigB64 = base64urlEncode(expectedSig);

  if (parts[1] !== expectedSigB64) {
    return { ok: false, code: "token_invalid", message: "签名验证失败" };
  }

  if (payload.expiresAt < Date.now()) {
    return { ok: false, code: "token_expired", message: "token 已过期" };
  }

  return { ok: true, payload };
}

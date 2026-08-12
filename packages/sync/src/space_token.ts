// Space 上传批次与 payload 能力票据。

import type { SpaceRevision } from "./space_model";

export interface BatchTokenPayload {
  kind: "batch";
  uploadId: string;
  spaceId: string;
  clientBatchId: string;
  baseRevision: SpaceRevision;
  descriptorHash: string;
  expiresAt: number;
}

export interface UploadTokenPayload {
  kind: "upload";
  uploadId: string;
  spaceId: string;
  assetType: string;
  assetId: string;
  blobHash: string;
  byteSize: number;
  backend: "d1" | "r2";
  expiresAt: number;
}

export interface DownloadTokenPayload {
  kind: "download";
  spaceId: string;
  assetType: string;
  assetId: string;
  revision: SpaceRevision;
  blobHash: string;
  expiresAt: number;
}

export type SpaceTokenPayload = BatchTokenPayload | UploadTokenPayload | DownloadTokenPayload;
export type VerifyResult =
  | { ok: true; payload: SpaceTokenPayload }
  | { ok: false; code: "token_invalid" | "token_expired" };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encodeBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signSpaceToken(
  payload: SpaceTokenPayload,
  secret: string,
): Promise<string> {
  const payloadBytes = encoder.encode(JSON.stringify(payload));
  const signature = await crypto.subtle.sign("HMAC", await importKey(secret), payloadBytes);
  return `${encodeBase64Url(payloadBytes)}.${encodeBase64Url(new Uint8Array(signature))}`;
}

export async function verifySpaceToken(
  token: string,
  secret: string,
  now: number,
): Promise<VerifyResult> {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, code: "token_invalid" };
  }
  try {
    const payloadBytes = decodeBase64Url(parts[0]);
    const signature = decodeBase64Url(parts[1]);
    const valid = await crypto.subtle.verify(
      "HMAC",
      await importKey(secret),
      signature,
      payloadBytes,
    );
    if (!valid) return { ok: false, code: "token_invalid" };
    const payload = JSON.parse(decoder.decode(payloadBytes)) as SpaceTokenPayload;
    if (
      !payload ||
      !["batch", "upload", "download"].includes(payload.kind) ||
      typeof payload.spaceId !== "string" ||
      typeof payload.expiresAt !== "number"
    ) {
      return { ok: false, code: "token_invalid" };
    }
    if (payload.expiresAt <= now) return { ok: false, code: "token_expired" };
    return { ok: true, payload };
  } catch {
    return { ok: false, code: "token_invalid" };
  }
}

export async function sha256Hex(value: ArrayBuffer | string): Promise<string> {
  const bytes = typeof value === "string" ? encoder.encode(value) : new Uint8Array(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

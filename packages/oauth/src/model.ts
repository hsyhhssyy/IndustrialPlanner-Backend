import type { AccountId } from "@industrial/shared";

export interface OAuthLoginTransaction {
  stateHash: string;
  stateValue: string;
  codeVerifier: string;
  nonce: string;
  frontendRedirectUri: string;
  oauthChannel: string;
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
}

export function normalizeFrontendRedirectUri(value: string): string | null {
  if (value.length === 0 || value.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const usesSecureTransport = url.protocol === "https:";
  const usesLoopbackHttp = url.protocol === "http:" && (
    url.hostname === "localhost"
    || url.hostname === "127.0.0.1"
    || url.hostname === "[::1]"
  );
  if (
    (!usesSecureTransport && !usesLoopbackHttp)
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    return null;
  }
  return url.href;
}

export function isValidOAuthChannel(value: string): boolean {
  return /^[A-Za-z0-9_-]{22,128}$/u.test(value);
}

export interface OAuthMapping {
  issuer: string;
  subject: string;
  accountId: AccountId;
  createdAt: string;
}

export interface OAuthCallbackCode {
  codeHash: string;
  accountId: AccountId;
  username: string;
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
}

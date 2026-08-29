import type { AccountId } from "@industrial/shared";
import type { LoginProviderType } from "./provider";

export interface OAuthLoginTransaction {
  stateHash: string;
  stateValue: string;
  codeVerifier: string;
  providerType: LoginProviderType;
  providerContext: string;
  frontendRedirectUri: string;
  oauthChannel: string;
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
}

const FRONTEND_REDIRECT_SHA_PLACEHOLDER = "{sha}";
const FRONTEND_REDIRECT_SHA_SAMPLE = "0".repeat(40);
const FRONTEND_REDIRECT_SHA_PATTERN = /^[0-9a-f]{40}$/u;

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

export function normalizeFrontendRedirectUriTemplate(value: string): string | null {
  if (
    value.indexOf(FRONTEND_REDIRECT_SHA_PLACEHOLDER) === -1
    || value.indexOf(FRONTEND_REDIRECT_SHA_PLACEHOLDER)
      !== value.lastIndexOf(FRONTEND_REDIRECT_SHA_PLACEHOLDER)
  ) {
    return null;
  }
  const expanded = normalizeFrontendRedirectUri(
    value.replace(FRONTEND_REDIRECT_SHA_PLACEHOLDER, FRONTEND_REDIRECT_SHA_SAMPLE),
  );
  if (!expanded) return null;
  const url = new URL(expanded);
  if (url.protocol !== "https:") return null;

  const pathSegments = url.pathname.split("/");
  const shaSegmentIndexes = pathSegments.flatMap((segment, index) => (
    segment === FRONTEND_REDIRECT_SHA_SAMPLE ? [index] : []
  ));
  const shaSegmentIndex = shaSegmentIndexes[0];
  if (shaSegmentIndexes.length !== 1 || shaSegmentIndex === undefined) return null;
  pathSegments[shaSegmentIndex] = FRONTEND_REDIRECT_SHA_PLACEHOLDER;
  return `${url.origin}${pathSegments.join("/")}`;
}

export function matchesFrontendRedirectUriTemplate(
  frontendRedirectUri: string,
  template: string,
): boolean {
  const parts = template.split(FRONTEND_REDIRECT_SHA_PLACEHOLDER);
  if (parts.length !== 2) return false;
  const prefix = parts[0] ?? "";
  const suffix = parts[1] ?? "";
  if (!frontendRedirectUri.startsWith(prefix) || !frontendRedirectUri.endsWith(suffix)) {
    return false;
  }
  const shaEnd = frontendRedirectUri.length - suffix.length;
  if (shaEnd < prefix.length) return false;
  return FRONTEND_REDIRECT_SHA_PATTERN.test(frontendRedirectUri.slice(prefix.length, shaEnd));
}

export function isValidOAuthChannel(value: string): boolean {
  return /^[A-Za-z0-9_-]{22,128}$/u.test(value);
}

export interface OAuthMapping {
  providerKey: string;
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

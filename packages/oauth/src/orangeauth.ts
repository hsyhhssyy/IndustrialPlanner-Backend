import type {
  LoginIdentityProvider,
  LoginProviderFetch,
  LoginProviderIdentity,
} from "./provider";
import {
  LoginProviderConfigurationError,
  LoginProviderProtocolError,
} from "./provider";

const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024;
const MAX_TOKEN_LENGTH = 8 * 1024;
const MAX_IDENTITY_FIELD_LENGTH = 256;
const PROVIDER_REQUEST_TIMEOUT_MS = 10_000;
const REVOKE_REQUEST_TIMEOUT_MS = 2_000;
const CONFIGURATION_CODES = new Set([90001, 90002, 90003, 90006, 90007]);
const CALLBACK_CODES = new Set([90004, 90005, 90008, 90009]);

export interface OrangeAuthSettings {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scope: string;
}

interface OrangeAuthResult {
  code: number;
  data?: Record<string, unknown>;
}

function parseHttpsRoot(value: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LoginProviderConfigurationError(`${name} 不是合法 URL`);
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.search
    || url.hash
    || url.pathname !== "/"
  ) {
    throw new LoginProviderConfigurationError(`${name} 必须是固定 HTTPS 根地址`);
  }
  return url;
}

function parseHttpsUrl(value: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LoginProviderConfigurationError(`${name} 不是合法 URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new LoginProviderConfigurationError(`${name} 必须是固定 HTTPS URL`);
  }
  return url;
}

function required(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new LoginProviderConfigurationError(`${name} 不能为空`);
  return normalized;
}

function validateSettings(settings: OrangeAuthSettings): {
  baseUrl: URL;
  clientId: string;
  clientSecret: string;
  redirectUri: URL;
} {
  const baseUrl = parseHttpsRoot(settings.baseUrl, "ORANGEAUTH_BASE_URL");
  const clientId = required(settings.clientId, "ORANGEAUTH_CLIENT_ID");
  const clientSecret = required(settings.clientSecret, "ORANGEAUTH_CLIENT_SECRET");
  const redirectUri = parseHttpsUrl(settings.redirectUri, "OAUTH_REDIRECT_URI");
  if (settings.scope !== "user.read") {
    throw new LoginProviderConfigurationError("ORANGEAUTH_SCOPE 必须精确为 user.read");
  }
  return { baseUrl, clientId, clientSecret, redirectUri };
}

function randomBase64Url(byteLength = 64): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function providerError(code: number): LoginProviderProtocolError {
  if (CONFIGURATION_CODES.has(code)) {
    return new LoginProviderProtocolError("configuration");
  }
  if (CALLBACK_CODES.has(code)) {
    return new LoginProviderProtocolError("callback_invalid");
  }
  return new LoginProviderProtocolError("unavailable");
}

async function parseResult(response: Response): Promise<OrangeAuthResult> {
  if (!response.ok || response.redirected) {
    throw new LoginProviderProtocolError("unavailable");
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new LoginProviderProtocolError("unavailable");
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new LoginProviderProtocolError("unavailable");
  }
  if (new TextEncoder().encode(text).byteLength > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new LoginProviderProtocolError("unavailable");
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new LoginProviderProtocolError("unavailable");
  }
  if (
    typeof body !== "object"
    || body === null
    || Array.isArray(body)
    || typeof (body as { code?: unknown }).code !== "number"
  ) {
    throw new LoginProviderProtocolError("unavailable");
  }
  const result = body as OrangeAuthResult;
  if (result.code !== 200) throw providerError(result.code);
  if (
    result.data !== undefined
    && (typeof result.data !== "object" || result.data === null || Array.isArray(result.data))
  ) {
    throw new LoginProviderProtocolError("unavailable");
  }
  return result;
}

function token(value: unknown): string | null {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_TOKEN_LENGTH
    || value.trim() !== value
    || /[\u0000-\u001F\u007F]/u.test(value)
  ) {
    return null;
  }
  return value;
}

function identityField(value: unknown): string | null {
  const normalized = typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? String(value)
    : typeof value === "string"
      ? value.trim()
      : "";
  if (
    normalized.length === 0
    || normalized.length > MAX_IDENTITY_FIELD_LENGTH
    || /[\u0000-\u001F\u007F]/u.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

async function providerFetch(
  fetchImpl: LoginProviderFetch,
  input: URL,
  init: RequestInit,
  timeoutMs = PROVIDER_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(input, {
      ...init,
      redirect: "manual",
      signal: controller.signal,
    });
  } catch {
    throw new LoginProviderProtocolError("unavailable");
  } finally {
    clearTimeout(timeout);
  }
}

export function createOrangeAuthProvider(
  settings: OrangeAuthSettings,
  fetchImpl: LoginProviderFetch = fetch,
): LoginIdentityProvider {
  const validated = validateSettings(settings);
  const authorizationEndpoint = new URL("/oauth2/authorize", validated.baseUrl);
  const tokenEndpoint = new URL("/oauth2/token", validated.baseUrl);
  const userinfoEndpoint = new URL("/oauth2/userinfo", validated.baseUrl);
  const revokeEndpoint = new URL("/oauth2/revoke", validated.baseUrl);
  const providerKey = `orangeauth:${validated.baseUrl.origin}`;

  async function revoke(providerToken: string): Promise<void> {
    const body = new URLSearchParams({
      client_id: validated.clientId,
      client_secret: validated.clientSecret,
      token: providerToken,
    });
    const response = await providerFetch(fetchImpl, revokeEndpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    }, REVOKE_REQUEST_TIMEOUT_MS);
    await parseResult(response);
  }

  async function bestEffortRevoke(providerToken: string): Promise<void> {
    try {
      await revoke(providerToken);
    } catch {
      // OrangeAuth token 只用于本次身份解析；吊销失败不能扩大其生命周期或改变登录结果。
    }
  }

  return {
    type: "orangeauth",

    async createAuthorizationRequest() {
      const state = randomBase64Url(32);
      const codeVerifier = randomBase64Url();
      const authorizationUrl = new URL(authorizationEndpoint);
      authorizationUrl.search = new URLSearchParams({
        response_type: "code",
        client_id: validated.clientId,
        redirect_uri: validated.redirectUri.href,
        scope: settings.scope,
        state,
        code_challenge: await pkceChallenge(codeVerifier),
        code_challenge_method: "S256",
      }).toString();
      return { authorizationUrl, state, codeVerifier, validationContext: "" };
    },

    async exchangeCallback(callbackUrl, expected): Promise<LoginProviderIdentity> {
      if (
        callbackUrl.searchParams.getAll("state").length !== 1
        || callbackUrl.searchParams.get("state") !== expected.state
        || callbackUrl.searchParams.getAll("code").length !== 1
      ) {
        throw new LoginProviderProtocolError("callback_invalid");
      }
      const code = callbackUrl.searchParams.get("code");
      if (
        !code
        || code.length > 2048
        || /[\u0000-\u001F\u007F]/u.test(code)
        || expected.validationContext !== ""
      ) {
        throw new LoginProviderProtocolError("callback_invalid");
      }

      const tokenResponse = await providerFetch(fetchImpl, tokenEndpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: validated.clientId,
          client_secret: validated.clientSecret,
          code,
          redirect_uri: validated.redirectUri.href,
          code_verifier: expected.codeVerifier,
        }),
      });
      const tokenResult = await parseResult(tokenResponse);
      const accessToken = token(tokenResult.data?.access_token);
      const refreshToken = tokenResult.data?.refresh_token === undefined
        ? null
        : token(tokenResult.data.refresh_token);
      if (!accessToken) {
        throw new LoginProviderProtocolError("unavailable");
      }
      if (tokenResult.data?.refresh_token !== undefined && !refreshToken) {
        await bestEffortRevoke(accessToken);
        throw new LoginProviderProtocolError("unavailable");
      }

      try {
        const userinfoResponse = await providerFetch(fetchImpl, userinfoEndpoint, {
          method: "GET",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${accessToken}`,
          },
        });
        const userinfoResult = await parseResult(userinfoResponse);
        if (!userinfoResult.data) {
          throw new LoginProviderProtocolError("unavailable");
        }
        const subject = identityField(userinfoResult.data?.uid);
        const username = identityField(userinfoResult.data?.userName);
        if (!subject || !username) {
          throw new LoginProviderProtocolError("callback_invalid");
        }
        return { providerKey, subject, username };
      } finally {
        await bestEffortRevoke(refreshToken ?? accessToken);
      }
    },
  };
}

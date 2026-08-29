import type { OAuthSessionResponse } from "@industrial/shared";
import type { IdentityClient } from "./identity-client";
import {
  isValidOAuthChannel,
  normalizeFrontendRedirectUri,
  type OAuthLoginTransaction,
} from "./model";
import type { LoginIdentityProvider } from "./provider";
import { LoginProviderProtocolError } from "./provider";
import type { OAuthRepository } from "./repository";

const DEFAULT_LOGIN_TTL_SECONDS = 10 * 60;
const DEFAULT_CALLBACK_CODE_TTL_SECONDS = 60;

export interface OAuthServiceDependencies {
  repository: OAuthRepository;
  provider: LoginIdentityProvider;
  identity: IdentityClient;
  frontendRedirectUris: readonly string[];
  loginTtlSeconds?: number;
  callbackCodeTtlSeconds?: number;
  now?: () => number;
  createCallbackCode?: () => string;
}

export interface OAuthCallbackResult {
  code: string;
  accountId: string;
  frontendRedirectUri: string;
  oauthChannel: string;
}

export interface OAuthAuthorizationInput {
  frontendRedirectUri: string | null;
  oauthChannel: string | null;
}

export interface OAuthFrontendTarget {
  frontendRedirectUri: string;
  oauthChannel: string;
}

export class OAuthServiceError extends Error {
  public constructor(
    public readonly status: 400 | 500 | 502,
    public readonly code:
      | "oauth_state_invalid"
      | "oauth_callback_invalid"
      | "oauth_code_invalid"
      | "oauth_frontend_invalid"
      | "oauth_channel_invalid"
      | "configuration_error"
      | "identity_unavailable"
      | "oauth_provider_unavailable"
      | "oauth_access_denied",
    message: string,
    public readonly frontendTarget?: OAuthFrontendTarget,
  ) {
    super(message);
    this.name = "OAuthServiceError";
  }
}

function assertTtl(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new OAuthServiceError(500, "configuration_error", `${name} 配置无效`);
  }
  return value;
}

function timestamp(now: number): string {
  return new Date(now).toISOString();
}

function randomBase64Url(byteLength = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function beginAuthorization(
  input: OAuthAuthorizationInput,
  dependencies: OAuthServiceDependencies,
): Promise<URL> {
  const frontendTarget = resolveFrontendTarget(input, dependencies.frontendRedirectUris);
  const loginTtl = assertTtl(
    dependencies.loginTtlSeconds ?? DEFAULT_LOGIN_TTL_SECONDS,
    "OAUTH_LOGIN_TTL_SECONDS",
  );
  let request;
  try {
    request = await dependencies.provider.createAuthorizationRequest();
  } catch (error) {
    if (error instanceof OAuthServiceError) throw error;
    if (error instanceof LoginProviderProtocolError && error.kind === "configuration") {
      throw new OAuthServiceError(500, "configuration_error", "登录身份 Provider 配置无效");
    }
    throw new OAuthServiceError(
      502,
      "oauth_provider_unavailable",
      "登录身份 Provider 不可用",
    );
  }
  if (
    !/^[A-Za-z0-9_-]{22,512}$/u.test(request.state)
    || !/^[A-Za-z0-9._~-]{43,128}$/u.test(request.codeVerifier)
    || request.validationContext.length > 2048
    || /[\u0000-\u001F\u007F]/u.test(request.validationContext)
  ) {
    throw new OAuthServiceError(
      500,
      "configuration_error",
      "登录身份 Provider 校验上下文无效",
    );
  }

  const now = (dependencies.now ?? Date.now)();
  await dependencies.repository.createLoginTransaction({
    stateHash: await sha256Hex(request.state),
    stateValue: request.state,
    codeVerifier: request.codeVerifier,
    providerType: dependencies.provider.type,
    providerContext: request.validationContext,
    frontendRedirectUri: frontendTarget.frontendRedirectUri,
    oauthChannel: frontendTarget.oauthChannel,
    createdAt: timestamp(now),
    expiresAt: timestamp(now + loginTtl * 1000),
    consumedAt: null,
  });
  return request.authorizationUrl;
}

function resolveFrontendTarget(
  input: OAuthAuthorizationInput,
  allowedUris: readonly string[],
): OAuthFrontendTarget {
  const normalized = input.frontendRedirectUri === null
    ? null
    : normalizeFrontendRedirectUri(input.frontendRedirectUri);
  if (!normalized || !allowedUris.includes(normalized)) {
    throw new OAuthServiceError(
      400,
      "oauth_frontend_invalid",
      "OAuth 前端回调地址无效",
    );
  }
  if (input.oauthChannel === null || !isValidOAuthChannel(input.oauthChannel)) {
    throw new OAuthServiceError(
      400,
      "oauth_channel_invalid",
      "OAuth 登录频道无效",
    );
  }
  return { frontendRedirectUri: normalized, oauthChannel: input.oauthChannel };
}

function targetFromTransaction(
  transaction: OAuthLoginTransaction,
  allowedUris: readonly string[],
): OAuthFrontendTarget | null {
  const normalized = normalizeFrontendRedirectUri(transaction.frontendRedirectUri);
  if (
    !normalized
    || normalized !== transaction.frontendRedirectUri
    || !allowedUris.includes(normalized)
    || !isValidOAuthChannel(transaction.oauthChannel)
  ) {
    return null;
  }
  return { frontendRedirectUri: normalized, oauthChannel: transaction.oauthChannel };
}

export async function completeCallback(
  callbackUrl: URL,
  state: string | null,
  dependencies: OAuthServiceDependencies,
): Promise<OAuthCallbackResult> {
  if (!state) {
    throw new OAuthServiceError(400, "oauth_state_invalid", "OAuth state 无效或已过期");
  }
  const now = (dependencies.now ?? Date.now)();
  const consumedAt = timestamp(now);
  const transaction = await dependencies.repository.consumeLoginTransaction(
    await sha256Hex(state),
    consumedAt,
  );
  if (!transaction || transaction.stateValue !== state) {
    throw new OAuthServiceError(400, "oauth_state_invalid", "OAuth state 无效或已过期");
  }
  const frontendTarget = targetFromTransaction(
    transaction,
    dependencies.frontendRedirectUris,
  );
  if (!frontendTarget) {
    throw new OAuthServiceError(400, "oauth_state_invalid", "OAuth state 无效或已过期");
  }

  if (transaction.providerType !== dependencies.provider.type) {
    throw new OAuthServiceError(
      400,
      "oauth_callback_invalid",
      "OAuth 回调验证失败",
      frontendTarget,
    );
  }
  if (callbackUrl.searchParams.get("error") === "access_denied") {
    throw new OAuthServiceError(
      400,
      "oauth_access_denied",
      "用户取消 OAuth 授权",
      frontendTarget,
    );
  }

  let providerIdentity;
  try {
    providerIdentity = await dependencies.provider.exchangeCallback(callbackUrl, {
      state: transaction.stateValue,
      codeVerifier: transaction.codeVerifier,
      validationContext: transaction.providerContext,
    });
  } catch (error) {
    if (error instanceof LoginProviderProtocolError) {
      if (error.kind === "configuration") {
        throw new OAuthServiceError(
          500,
          "configuration_error",
          "登录身份 Provider 配置无效",
          frontendTarget,
        );
      }
      if (error.kind === "unavailable") {
        throw new OAuthServiceError(
          502,
          "oauth_provider_unavailable",
          "登录身份 Provider 不可用",
          frontendTarget,
        );
      }
    }
    throw new OAuthServiceError(
      400,
      "oauth_callback_invalid",
      "OAuth 回调验证失败",
      frontendTarget,
    );
  }

  let mapping = await dependencies.repository.findMapping(
    providerIdentity.providerKey,
    providerIdentity.subject,
  );
  if (!mapping) {
    let created;
    try {
      created = await dependencies.identity.createAccount();
    } catch {
      throw new OAuthServiceError(
        502,
        "identity_unavailable",
        "账户服务不可用",
        frontendTarget,
      );
    }
    mapping = await dependencies.repository.createMappingIfAbsent({
      providerKey: providerIdentity.providerKey,
      subject: providerIdentity.subject,
      accountId: created.accountId,
      createdAt: consumedAt,
    });
  }

  const callbackTtl = assertTtl(
    dependencies.callbackCodeTtlSeconds ?? DEFAULT_CALLBACK_CODE_TTL_SECONDS,
    "OAUTH_CALLBACK_CODE_TTL_SECONDS",
  );
  const code = dependencies.createCallbackCode?.() ?? randomBase64Url();
  await dependencies.repository.createCallbackCode({
    codeHash: await sha256Hex(code),
    accountId: mapping.accountId,
    username: providerIdentity.username,
    expiresAt: timestamp(now + callbackTtl * 1000),
    consumedAt: null,
    createdAt: consumedAt,
  });
  return {
    code,
    accountId: mapping.accountId,
    frontendRedirectUri: frontendTarget.frontendRedirectUri,
    oauthChannel: frontendTarget.oauthChannel,
  };
}

export async function exchangeCallbackCode(
  code: string,
  dependencies: OAuthServiceDependencies,
): Promise<OAuthSessionResponse> {
  if (!code || code.length > 512) {
    throw new OAuthServiceError(400, "oauth_code_invalid", "OAuth callback code 无效");
  }
  const consumedAt = timestamp((dependencies.now ?? Date.now)());
  const callbackIdentity = await dependencies.repository.consumeCallbackCode(
    await sha256Hex(code),
    consumedAt,
  );
  if (!callbackIdentity) {
    throw new OAuthServiceError(400, "oauth_code_invalid", "OAuth callback code 无效");
  }
  try {
    const session = await dependencies.identity.createSession(callbackIdentity.accountId);
    return {
      ...session,
      account: callbackIdentity,
    };
  } catch {
    throw new OAuthServiceError(502, "identity_unavailable", "账户服务不可用");
  }
}

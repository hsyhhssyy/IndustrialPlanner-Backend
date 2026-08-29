import { Hono } from "hono";
import type { IdentityBinding } from "./identity-client";
import { createIdentityClient, IdentityClientError } from "./identity-client";
import {
  createOidcClient,
  type OidcSettings,
} from "./oidc";
import { createOrangeAuthProvider, type OrangeAuthSettings } from "./orangeauth";
import type {
  LoginIdentityProvider,
  LoginProviderFetch,
  LoginProviderType,
} from "./provider";
import { LoginProviderConfigurationError } from "./provider";
import {
  normalizeFrontendRedirectUri,
  normalizeFrontendRedirectUriTemplate,
} from "./model";
import { createOAuthRepository } from "./repository";
import {
  OAuthServiceError,
  beginAuthorization,
  completeCallback,
  exchangeCallbackCode,
  type OAuthServiceDependencies,
} from "./service";

export interface OAuthEnv {
  DB: D1Database;
  IDENTITY: IdentityBinding;
  ENVIRONMENT?: string;
  OAUTH_ENABLED?: string;
  OAUTH_PROVIDER_TYPE?: string;
  OIDC_DISCOVERY_URL?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_CLIENT_SECRET?: string;
  ORANGEAUTH_BASE_URL?: string;
  ORANGEAUTH_CLIENT_ID?: string;
  ORANGEAUTH_CLIENT_SECRET?: string;
  ORANGEAUTH_SCOPE?: string;
  OAUTH_REDIRECT_URI?: string;
  // AI-REMOVED 2026-08-24:
  // Reason: Beta 后端需要服务 dev、pre、beta 三个精确前端 callback，单一地址无法表达真实拓扑。
  // Trigger: 用户明确要求前端携带完整 URL 并由后端执行 allowlist，不保留 Beta 旧协议兼容。
  // Evidence: .docs/common/OAuth登录流程.md 的环境拓扑与目标 HTTP 合约。
  // Replacement: OAUTH_FRONTEND_REDIRECT_URIS
  // Risk: Low
  // Human Review: Required
  //
  // Original code:
  // OAUTH_FRONTEND_REDIRECT_URI?: string;
  OAUTH_FRONTEND_REDIRECT_URIS?: string;
  OAUTH_FRONTEND_REDIRECT_URI_TEMPLATES?: string;
  INTERNAL_SERVICE_SECRET?: string;
  OAUTH_LOGIN_TTL_SECONDS?: string;
  OAUTH_CALLBACK_CODE_TTL_SECONDS?: string;
}

export interface OAuthAppOptions {
  providerFetch?: LoginProviderFetch;
  createProvider?: (
    type: LoginProviderType,
    settings: OidcSettings | OrangeAuthSettings,
  ) => LoginIdentityProvider;
  now?: () => number;
  createCallbackCode?: () => string;
}

function optionalPositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : Number.NaN;
}

function oauthEnabled(value: string | undefined): boolean | null {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new LoginProviderConfigurationError(`${name} 不能为空`);
  return value;
}

function oidcSettings(env: OAuthEnv): OidcSettings {
  return {
    discoveryUrl: required(env.OIDC_DISCOVERY_URL, "OIDC_DISCOVERY_URL"),
    clientId: required(env.OIDC_CLIENT_ID, "OIDC_CLIENT_ID"),
    clientSecret: required(env.OIDC_CLIENT_SECRET, "OIDC_CLIENT_SECRET"),
    redirectUri: required(env.OAUTH_REDIRECT_URI, "OAUTH_REDIRECT_URI"),
  };
}

function orangeAuthSettings(env: OAuthEnv): OrangeAuthSettings {
  return {
    baseUrl: required(env.ORANGEAUTH_BASE_URL, "ORANGEAUTH_BASE_URL"),
    clientId: required(env.ORANGEAUTH_CLIENT_ID, "ORANGEAUTH_CLIENT_ID"),
    clientSecret: required(env.ORANGEAUTH_CLIENT_SECRET, "ORANGEAUTH_CLIENT_SECRET"),
    redirectUri: required(env.OAUTH_REDIRECT_URI, "OAUTH_REDIRECT_URI"),
    scope: required(env.ORANGEAUTH_SCOPE, "ORANGEAUTH_SCOPE"),
  };
}

function hasDefinedValue(values: Array<string | undefined>): boolean {
  return values.some((value) => value !== undefined);
}

function configuredProvider(env: OAuthEnv, options: OAuthAppOptions): LoginIdentityProvider {
  const type = required(env.OAUTH_PROVIDER_TYPE, "OAUTH_PROVIDER_TYPE");
  if (type === "oidc") {
    if (hasDefinedValue([
      env.ORANGEAUTH_BASE_URL,
      env.ORANGEAUTH_CLIENT_ID,
      env.ORANGEAUTH_CLIENT_SECRET,
      env.ORANGEAUTH_SCOPE,
    ])) {
      throw new LoginProviderConfigurationError("不能同时配置 OIDC 与 OrangeAuth");
    }
    const settings = oidcSettings(env);
    return options.createProvider?.("oidc", settings)
      ?? createOidcClient(settings, options.providerFetch);
  }
  if (type === "orangeauth") {
    if (hasDefinedValue([
      env.OIDC_DISCOVERY_URL,
      env.OIDC_CLIENT_ID,
      env.OIDC_CLIENT_SECRET,
    ])) {
      throw new LoginProviderConfigurationError("不能同时配置 OIDC 与 OrangeAuth");
    }
    const settings = orangeAuthSettings(env);
    return options.createProvider?.("orangeauth", settings)
      ?? createOrangeAuthProvider(settings, options.providerFetch);
  }
  throw new LoginProviderConfigurationError("OAUTH_PROVIDER_TYPE 仅支持 oidc 或 orangeauth");
}

function configuredFrontendRedirectUris(value: string | undefined): string[] {
  const serialized = required(value, "OAUTH_FRONTEND_REDIRECT_URIS");
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new LoginProviderConfigurationError("OAUTH_FRONTEND_REDIRECT_URIS 不是合法 JSON");
  }
  if (
    !Array.isArray(parsed)
    || parsed.length === 0
    || parsed.length > 32
    || !parsed.every((item) => typeof item === "string")
  ) {
    throw new LoginProviderConfigurationError("OAUTH_FRONTEND_REDIRECT_URIS 必须是非空字符串数组");
  }
  const normalized = parsed.map((item) => normalizeFrontendRedirectUri(item));
  if (normalized.some((item) => item === null)) {
    throw new LoginProviderConfigurationError("OAUTH_FRONTEND_REDIRECT_URIS 包含不安全 URL");
  }
  const uris = normalized as string[];
  if (new Set(uris).size !== uris.length) {
    throw new LoginProviderConfigurationError("OAUTH_FRONTEND_REDIRECT_URIS 包含重复 URL");
  }
  return uris;
}

function configuredFrontendRedirectUriTemplates(value: string | undefined): string[] {
  if (value === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new LoginProviderConfigurationError(
      "OAUTH_FRONTEND_REDIRECT_URI_TEMPLATES 不是合法 JSON",
    );
  }
  if (
    !Array.isArray(parsed)
    || parsed.length > 32
    || !parsed.every((item) => typeof item === "string")
  ) {
    throw new LoginProviderConfigurationError(
      "OAUTH_FRONTEND_REDIRECT_URI_TEMPLATES 必须是字符串数组",
    );
  }
  const normalized = parsed.map((item) => normalizeFrontendRedirectUriTemplate(item));
  if (normalized.some((item) => item === null)) {
    throw new LoginProviderConfigurationError(
      "OAUTH_FRONTEND_REDIRECT_URI_TEMPLATES 包含不安全模板",
    );
  }
  const templates = normalized as string[];
  if (new Set(templates).size !== templates.length) {
    throw new LoginProviderConfigurationError(
      "OAUTH_FRONTEND_REDIRECT_URI_TEMPLATES 包含重复模板",
    );
  }
  return templates;
}

// AI-REMOVED 2026-08-24:
// Reason: 单一前端 query redirect 被多前端精确 allowlist 与 fragment 完成协议替代。
// Trigger: 用户明确要求 dev、pre、beta 共用 Beta 后端，且不保留旧 Beta callback 兼容。
// Evidence: OAuth D1 登录事务保存已验证前端 URL 和 oauth_channel；callback 不再读取全局单一地址。
// Replacement: frontendFragmentRedirect
// Risk: Low
// Human Review: Required
//
// Original code:
// function frontendRedirect(value: string | undefined, parameters: Record<string, string>): URL {
//   const uri = required(value, "OAUTH_FRONTEND_REDIRECT_URI");
//   let url: URL;
//   try {
//     url = new URL(uri);
//   } catch {
//     throw new OidcConfigurationError("OAUTH_FRONTEND_REDIRECT_URI 不是合法 URL");
//   }
//   if (url.protocol !== "https:") {
//     throw new OidcConfigurationError("OAUTH_FRONTEND_REDIRECT_URI 必须使用 HTTPS");
//   }
//   for (const [name, parameter] of Object.entries(parameters)) {
//     url.searchParams.set(name, parameter);
//   }
//   return url;
// }
function frontendFragmentRedirect(uri: string, parameters: Record<string, string>): URL {
  const url = new URL(uri);
  const fragment = new URLSearchParams();
  for (const [name, parameter] of Object.entries(parameters)) {
    fragment.set(name, parameter);
  }
  url.hash = fragment.toString();
  return url;
}

function dependencies(env: OAuthEnv, options: OAuthAppOptions): OAuthServiceDependencies {
  return {
    repository: createOAuthRepository(env.DB),
    provider: configuredProvider(env, options),
    identity: createIdentityClient(
      env.IDENTITY,
      required(env.INTERNAL_SERVICE_SECRET, "INTERNAL_SERVICE_SECRET"),
    ),
    frontendRedirectUris: configuredFrontendRedirectUris(env.OAUTH_FRONTEND_REDIRECT_URIS),
    frontendRedirectUriTemplates: configuredFrontendRedirectUriTemplates(
      env.OAUTH_FRONTEND_REDIRECT_URI_TEMPLATES,
    ),
    loginTtlSeconds: optionalPositiveInteger(env.OAUTH_LOGIN_TTL_SECONDS),
    callbackCodeTtlSeconds: optionalPositiveInteger(env.OAUTH_CALLBACK_CODE_TTL_SECONDS),
    now: options.now,
    createCallbackCode: options.createCallbackCode,
  };
}

function configurationResponse(c: { json(body: unknown, status: 500): Response }): Response {
  return c.json({ error: "configuration_error", message: "OAuth 服务配置无效" }, 500);
}

export function createOAuthApp(options: OAuthAppOptions = {}): Hono<{ Bindings: OAuthEnv }> {
  const app = new Hono<{ Bindings: OAuthEnv }>();

  app.onError((error, c) => {
    if (error instanceof OAuthServiceError) {
      return c.json({ error: error.code, message: error.message }, error.status);
    }
    if (error instanceof LoginProviderConfigurationError || error instanceof IdentityClientError) {
      return configurationResponse(c);
    }
    return c.json({ error: "internal_error", message: "OAuth 服务内部错误" }, 500);
  });

  app.use("/v1/oauth/*", async (c, next) => {
    const enabled = oauthEnabled(c.env.OAUTH_ENABLED);
    if (enabled === null) return configurationResponse(c);
    if (!enabled) {
      c.header("cache-control", "no-store");
      return c.json({ error: "service_unavailable", message: "OAuth 登录未启用" }, 503);
    }
    return next();
  });

  app.get("/health", async (c) => {
    const healthy = await createOAuthRepository(c.env.DB).checkHealth();
    return healthy
      ? c.json({ status: "ok", version: "0.2.0" })
      : c.json({ error: "database_unavailable", message: "数据库不可用" }, 503);
  });

  app.get("/v1/oauth/authorize", async (c) => {
    const redirect = await beginAuthorization(
      {
        frontendRedirectUri: c.req.query("frontend_redirect_uri") ?? null,
        oauthChannel: c.req.query("oauth_channel") ?? null,
      },
      dependencies(c.env, options),
    );
    return c.redirect(redirect.href, 302);
  });

  app.get("/v1/oauth/callback", async (c) => {
    c.header("cache-control", "no-store");
    try {
      const result = await completeCallback(
        new URL(c.req.url),
        c.req.query("state") ?? null,
        dependencies(c.env, options),
      );
      const redirect = frontendFragmentRedirect(result.frontendRedirectUri, {
        code: result.code,
        oauth_channel: result.oauthChannel,
      });
      return c.redirect(redirect.href, 303);
    } catch (error) {
      if (error instanceof LoginProviderConfigurationError || error instanceof IdentityClientError) {
        return configurationResponse(c);
      }
      if (error instanceof OAuthServiceError) {
        if (error.frontendTarget) {
          const redirect = frontendFragmentRedirect(error.frontendTarget.frontendRedirectUri, {
            error: error.code,
            oauth_channel: error.frontendTarget.oauthChannel,
          });
          return c.redirect(redirect.href, 303);
        }
        return c.json({ error: error.code, message: error.message }, error.status);
      }
      return c.json({ error: "internal_error", message: "OAuth 服务内部错误" }, 500);
    }
  });

  app.post("/v1/oauth/session", async (c) => {
    let body: { code?: unknown };
    try {
      body = await c.req.json<{ code?: unknown }>();
    } catch {
      return c.json({ error: "oauth_code_invalid", message: "OAuth callback code 无效" }, 400);
    }
    if (typeof body.code !== "string") {
      return c.json({ error: "oauth_code_invalid", message: "OAuth callback code 无效" }, 400);
    }
    const response = await exchangeCallbackCode(body.code, dependencies(c.env, options));
    c.header("cache-control", "no-store");
    return c.json(response);
  });

  app.all("*", (c) => c.json({ error: "not_found", message: "路径未实现" }, 404));
  return app;
}

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import fs from "node:fs";
import path from "node:path";
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
  type JWK,
} from "jose";
import { createOAuthApp, type OAuthEnv } from "./http";
import type { IdentityBinding } from "./identity-client";

const ISSUER = "https://provider.test/application/o/industrial-planner/";
const DISCOVERY_URL = `${ISSUER}.well-known/openid-configuration`;
const CLIENT_ID = "test-client";
const CLIENT_SECRET = "test-client-secret";
const REDIRECT_URI = "https://backend.test/v1/oauth/callback";
const FRONTEND_REDIRECT_URI = "https://frontend.test/oauth/callback";
const SECOND_FRONTEND_REDIRECT_URI = "https://preview.test/oauth/callback";
const LOOPBACK_FRONTEND_REDIRECT_URIS = [
  "http://localhost:4174/auth/callback",
  "http://127.0.0.1:4174/auth/callback",
] as const;
const OAUTH_CHANNEL = "oauth-channel-0123456789abcdef";
const INTERNAL_SECRET = "oauth-test-internal-secret-with-at-least-32-bytes";

interface ProviderState {
  expectedNonce: string;
  expectedCodeChallenge: string;
  invalidNonce: boolean;
  missingUsername: boolean;
  tokenRequests: number;
  requests: string[];
}

let miniflare: Miniflare;
let env: OAuthEnv;
let privateKey: CryptoKey;
let publicJwk: JWK;
let provider: ProviderState;
let accountCount = 0;
let sessionCount = 0;

async function applySchema(db: D1Database): Promise<void> {
  const migrationsDirectory = path.resolve(__dirname, "..", "migrations");
  const migrations = fs.readdirSync(migrationsDirectory)
    .filter((filename) => filename.endsWith(".sql"))
    .sort();
  for (const migration of migrations) {
    const sql = fs.readFileSync(path.join(migrationsDirectory, migration), "utf8");
    for (const statement of sql.split(";").map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function providerFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  provider.requests.push(`${request.method} ${url.href}`);

  if (url.href === DISCOVERY_URL) {
    return json({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}authorize/`,
      token_endpoint: `${ISSUER}token/`,
      jwks_uri: `${ISSUER}jwks/`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      scopes_supported: ["openid", "profile"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post"],
    });
  }

  if (url.href === `${ISSUER}jwks/`) {
    return json({ keys: [publicJwk] });
  }

  if (url.href === `${ISSUER}token/` && request.method === "POST") {
    provider.tokenRequests += 1;
    const form = new URLSearchParams(await request.text());
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("provider-code");
    expect(form.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(form.get("client_id")).toBe(CLIENT_ID);
    expect(form.get("client_secret")).toBe(CLIENT_SECRET);
    expect(await codeChallenge(form.get("code_verifier") ?? "")).toBe(
      provider.expectedCodeChallenge,
    );

    const now = Math.floor(Date.now() / 1000);
    const idToken = await new SignJWT({
      nonce: provider.invalidNonce ? "wrong-nonce" : provider.expectedNonce,
      ...(provider.missingUsername ? {} : { preferred_username: "planner-user" }),
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(ISSUER)
      .setAudience(CLIENT_ID)
      .setSubject("provider-user-1")
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(privateKey);
    return json({
      access_token: "provider-access-token-not-persisted",
      token_type: "Bearer",
      expires_in: 300,
      id_token: idToken,
    });
  }

  return json({ error: "not_found" }, 404);
}

const identityBinding: IdentityBinding = {
  async fetch(input, init) {
    const request = new Request(input, init);
    expect(request.headers.get("x-industrial-internal-auth")).toBe(INTERNAL_SECRET);
    const pathname = new URL(request.url).pathname;
    if (pathname === "/internal/accounts" && request.method === "POST") {
      accountCount += 1;
      return json({ accountId: `account-${accountCount}` }, 201);
    }
    if (pathname === "/internal/sessions" && request.method === "POST") {
      sessionCount += 1;
      const body = await request.json() as { accountId: string };
      return json({
        accessToken: `session-for-${body.accountId}`,
        tokenType: "Bearer",
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
    }
    return json({ error: "not_found" }, 404);
  },
};

async function request(pathname: string, init?: RequestInit): Promise<Response> {
  const app = createOAuthApp({ oidcFetch: providerFetch });
  return await app.fetch(new Request(`https://backend.test${pathname}`, init), env);
}

async function authorize(
  frontendRedirectUri = FRONTEND_REDIRECT_URI,
  oauthChannel = OAUTH_CHANNEL,
): Promise<{ state: string; nonce: string }> {
  const parameters = new URLSearchParams({
    frontend_redirect_uri: frontendRedirectUri,
    oauth_channel: oauthChannel,
  });
  const response = await request(`/v1/oauth/authorize?${parameters.toString()}`);
  expect(
    response.status,
    `${await response.clone().text()} ${JSON.stringify(provider.requests)}`,
  ).toBe(302);
  const url = new URL(response.headers.get("location") ?? "");
  expect(url.origin).toBe("https://provider.test");
  expect(url.searchParams.get("response_type")).toBe("code");
  expect(url.searchParams.get("scope")).toBe("openid profile");
  expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  const state = url.searchParams.get("state") ?? "";
  const nonce = url.searchParams.get("nonce") ?? "";
  provider.expectedNonce = nonce;
  provider.expectedCodeChallenge = url.searchParams.get("code_challenge") ?? "";
  return { state, nonce };
}

async function callback(state: string): Promise<Response> {
  return request(`/v1/oauth/callback?code=provider-code&state=${encodeURIComponent(state)}`);
}

function callbackParameters(response: Response): URLSearchParams {
  expect(response.status).toBe(303);
  const redirect = new URL(response.headers.get("location") ?? "");
  expect(`${redirect.origin}${redirect.pathname}`).toBe(FRONTEND_REDIRECT_URI);
  expect(redirect.search).toBe("");
  return new URLSearchParams(redirect.hash.slice(1));
}

function callbackCode(response: Response): string {
  const parameters = callbackParameters(response);
  expect(parameters.get("oauth_channel")).toBe(OAUTH_CHANNEL);
  return parameters.get("code") ?? "";
}

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2025-08-06",
    d1Databases: ["DB"],
  });
  const db = await miniflare.getD1Database("DB") as unknown as D1Database;
  await applySchema(db);
  const keyPair = await generateKeyPair("RS256");
  privateKey = keyPair.privateKey;
  publicJwk = {
    ...await exportJWK(keyPair.publicKey),
    kid: "test-key",
    alg: "RS256",
    use: "sig",
  };
  env = {
    DB: db,
    IDENTITY: identityBinding,
    OIDC_DISCOVERY_URL: DISCOVERY_URL,
    OIDC_CLIENT_ID: CLIENT_ID,
    OIDC_CLIENT_SECRET: CLIENT_SECRET,
    OIDC_REDIRECT_URI: REDIRECT_URI,
    OAUTH_FRONTEND_REDIRECT_URIS: JSON.stringify([
      FRONTEND_REDIRECT_URI,
      SECOND_FRONTEND_REDIRECT_URI,
      ...LOOPBACK_FRONTEND_REDIRECT_URIS,
    ]),
    INTERNAL_SERVICE_SECRET: INTERNAL_SECRET,
    OAUTH_CALLBACK_CODE_TTL_SECONDS: "60",
  };
});

beforeEach(() => {
  provider = {
    expectedNonce: "",
    expectedCodeChallenge: "",
    invalidNonce: false,
    missingUsername: false,
    tokenRequests: 0,
    requests: [],
  };
});

afterAll(async () => {
  await miniflare.dispose();
});

describe("OIDC 登录闭环", () => {
  it("首次登录创建映射并只允许兑换一次后端会话", async () => {
    const { state } = await authorize();
    const callbackResponse = await callback(state);
    const code = callbackCode(callbackResponse);
    expect(code).not.toBe("");
    expect(accountCount).toBe(1);
    expect(provider.tokenRequests).toBe(1);

    const exchange = await request("/v1/oauth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(exchange.status, await exchange.clone().text()).toBe(200);
    expect(exchange.headers.get("cache-control")).toBe("no-store");
    expect(await exchange.json()).toMatchObject({
      accessToken: "session-for-account-1",
      tokenType: "Bearer",
      account: {
        accountId: "account-1",
        username: "planner-user",
      },
    });

    const replay = await request("/v1/oauth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: "oauth_code_invalid" });
  });

  it("同一 OIDC 身份重复登录复用同一账户", async () => {
    const accountsBefore = accountCount;
    const { state } = await authorize();
    const code = callbackCode(await callback(state));
    const exchange = await request("/v1/oauth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(await exchange.json()).toMatchObject({ accessToken: "session-for-account-1" });
    expect(accountCount).toBe(accountsBefore);
  });

  it("按精确 allowlist 将 callback 返回发起登录的前端", async () => {
    const secondChannel = "oauth-channel-fedcba9876543210";
    const { state } = await authorize(SECOND_FRONTEND_REDIRECT_URI, secondChannel);
    const response = await callback(state);
    expect(response.status).toBe(303);
    const redirect = new URL(response.headers.get("location") ?? "");
    expect(`${redirect.origin}${redirect.pathname}`).toBe(SECOND_FRONTEND_REDIRECT_URI);
    expect(redirect.search).toBe("");
    const fragment = new URLSearchParams(redirect.hash.slice(1));
    expect(fragment.get("oauth_channel")).toBe(secondChannel);
    expect(fragment.get("code")).not.toBe("");
  });

  it.each(LOOPBACK_FRONTEND_REDIRECT_URIS)(
    "允许 Beta E2E 使用精确登记的 loopback HTTP callback：%s",
    async (frontendRedirectUri) => {
      const { state } = await authorize(frontendRedirectUri);
      const response = await callback(state);
      expect(response.status).toBe(303);
      const redirect = new URL(response.headers.get("location") ?? "");
      expect(`${redirect.origin}${redirect.pathname}`).toBe(frontendRedirectUri);
      expect(redirect.search).toBe("");
      expect(new URLSearchParams(redirect.hash.slice(1)).get("code")).not.toBe("");
    },
  );

  it("不在 allowlist 的前端地址在访问 Provider 前被拒绝", async () => {
    const invalidUris = [
      "https://attacker.test/oauth/callback",
      `${FRONTEND_REDIRECT_URI}?next=https://attacker.test`,
      `${FRONTEND_REDIRECT_URI}#fragment`,
      "https://user@frontend.test/oauth/callback",
      "https://frontend.test.attacker.test/oauth/callback",
      "http://frontend.test/oauth/callback",
      "http://localhost.attacker.test:4174/auth/callback",
    ];
    for (const frontendRedirectUri of invalidUris) {
      const parameters = new URLSearchParams({
        frontend_redirect_uri: frontendRedirectUri,
        oauth_channel: OAUTH_CHANNEL,
      });
      const response = await request(`/v1/oauth/authorize?${parameters.toString()}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "oauth_frontend_invalid" });
    }
    expect(provider.requests).toEqual([]);
  });

  it("allowlist 配置无效时 fail-closed", async () => {
    const saved = env.OAUTH_FRONTEND_REDIRECT_URIS;
    env.OAUTH_FRONTEND_REDIRECT_URIS = JSON.stringify([
      FRONTEND_REDIRECT_URI,
      FRONTEND_REDIRECT_URI,
    ]);
    const parameters = new URLSearchParams({
      frontend_redirect_uri: FRONTEND_REDIRECT_URI,
      oauth_channel: OAUTH_CHANNEL,
    });
    const response = await request(`/v1/oauth/authorize?${parameters.toString()}`);
    env.OAUTH_FRONTEND_REDIRECT_URIS = saved;
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "configuration_error" });
    expect(provider.requests).toEqual([]);
  });

  it("登录期间从 allowlist 撤销目标后不再跳转", async () => {
    const { state } = await authorize(SECOND_FRONTEND_REDIRECT_URI);
    const saved = env.OAUTH_FRONTEND_REDIRECT_URIS;
    env.OAUTH_FRONTEND_REDIRECT_URIS = JSON.stringify([FRONTEND_REDIRECT_URI]);
    const response = await callback(state);
    env.OAUTH_FRONTEND_REDIRECT_URIS = saved;
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "oauth_state_invalid" });
    expect(provider.tokenRequests).toBe(0);
  });

  it("拒绝缺失或格式不合法的 oauth_channel", async () => {
    const missing = new URLSearchParams({ frontend_redirect_uri: FRONTEND_REDIRECT_URI });
    const missingResponse = await request(`/v1/oauth/authorize?${missing.toString()}`);
    expect(missingResponse.status).toBe(400);
    expect(await missingResponse.json()).toMatchObject({ error: "oauth_channel_invalid" });

    const invalid = new URLSearchParams({
      frontend_redirect_uri: FRONTEND_REDIRECT_URI,
      oauth_channel: "short",
    });
    const invalidResponse = await request(`/v1/oauth/authorize?${invalid.toString()}`);
    expect(invalidResponse.status).toBe(400);
    expect(await invalidResponse.json()).toMatchObject({ error: "oauth_channel_invalid" });
    expect(provider.requests).toEqual([]);
  });

  it("state 只能使用一次", async () => {
    const { state } = await authorize();
    callbackCode(await callback(state));
    const replay = await callback(state);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: "oauth_state_invalid" });
  });

  it("nonce 不匹配时拒绝创建映射", async () => {
    const accountsBefore = accountCount;
    const { state } = await authorize();
    provider.invalidNonce = true;
    const response = await callback(state);
    expect(callbackParameters(response).get("error")).toBe("oauth_callback_invalid");
    expect(accountCount).toBe(accountsBefore);
  });

  it("缺少 preferred_username 时拒绝创建映射", async () => {
    const accountsBefore = accountCount;
    const { state } = await authorize();
    provider.missingUsername = true;
    const response = await callback(state);
    expect(callbackParameters(response).get("error")).toBe("oauth_callback_invalid");
    expect(accountCount).toBe(accountsBefore);
  });

  it("并发兑换 callback code 最多一次成功", async () => {
    const { state } = await authorize();
    const code = callbackCode(await callback(state));
    const exchange = () => request("/v1/oauth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const responses = await Promise.all([exchange(), exchange()]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
  });

  it("缺失配置时 fail-closed 且不泄露字段值", async () => {
    const saved = env.OIDC_CLIENT_SECRET;
    env.OIDC_CLIENT_SECRET = undefined;
    const response = await request("/v1/oauth/authorize");
    env.OIDC_CLIENT_SECRET = saved;
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "configuration_error",
      message: "OAuth 服务配置无效",
    });
  });
});

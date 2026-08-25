import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare, type MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWK } from "jose";

const REPOSITORY_ROOT = path.resolve(__dirname, "../../..");
const JWT_SECRET = "multiworker-jwt-secret-with-at-least-32-bytes";
const INTERNAL_SECRET = "multiworker-internal-secret-with-at-least-32-bytes";
const COMMIT_SECRET = "multiworker-commit-secret-with-at-least-32-bytes";
const ISSUER = "https://provider.test/application/o/industrial-planner/";
const DISCOVERY_URL = `${ISSUER}.well-known/openid-configuration`;
const CLIENT_ID = "multiworker-client";
const CLIENT_SECRET = "multiworker-client-secret";
const REDIRECT_URI = "https://gateway.test/v1/oauth/callback";
const FRONTEND_REDIRECT_URI = "https://frontend.test/oauth/callback";
const OAUTH_CHANNEL = "multiworker-oauth-channel-0123456789";

interface ProviderState {
  nonce: string;
  codeChallenge: string;
  requests: string[];
  tokenForm: Record<string, string>;
}

interface Harness {
  miniflare: Miniflare;
  provider: ProviderState;
}

let bundles: Record<string, string>;
let privateKey: CryptoKey;
let publicJwk: JWK;
const activeHarnesses: Miniflare[] = [];

async function bundleWorker(workerName: string): Promise<string> {
  const result = await build({
    entryPoints: [path.join(REPOSITORY_ROOT, "packages", workerName, "src", "index.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    sourcemap: false,
  });
  const output = result.outputFiles[0];
  if (!output) throw new Error(`${workerName} bundle 为空`);
  return output.text;
}

function migrationStatements(sql: string): string[] {
  const statements: string[] = [];
  let current: string[] = [];
  let insideTrigger = false;

  for (const rawLine of sql.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("--")) continue;
    if (current.length === 0) insideTrigger = /^CREATE\s+TRIGGER\b/iu.test(line);
    current.push(rawLine);
    const complete = insideTrigger ? /^END;$/iu.test(line) : line.endsWith(";");
    if (!complete) continue;
    statements.push(current.join("\n"));
    current = [];
    insideTrigger = false;
  }

  if (current.length > 0) throw new Error("migration 包含未闭合的 SQL statement");
  return statements;
}

async function applyMigrations(db: D1Database, workerName: string): Promise<void> {
  const migrationDirectory = path.join(REPOSITORY_ROOT, "packages", workerName, "migrations");
  for (const filename of fs.readdirSync(migrationDirectory).filter((name) => name.endsWith(".sql")).sort()) {
    const sql = fs.readFileSync(path.join(migrationDirectory, filename), "utf8");
    const executable = sql.split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    // AI-REMOVED 2026-08-23:
    // Reason: 直接按分号拆分会截断 SQLite trigger 的 BEGIN/END body。
    // Trigger: owner migration 新增数据库级 insert/update 不变量。
    // Evidence: Miniflare 报 D1_ERROR incomplete input，完整 migration statement 解析后通过。
    // Replacement: migrationStatements
    // Risk: Low
    // Human Review: Required
    //
    // Original code:
    // for (const statement of executable.split(";").map((value) => value.trim()).filter(Boolean)) {
    //   await db.prepare(statement).run();
    // }
    for (const statement of migrationStatements(executable)) {
      await db.prepare(statement).run();
    }
  }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function providerHandler(provider: ProviderState) {
  return async (request: Request): Promise<Response> => {
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
    if (url.href === `${ISSUER}jwks/`) return json({ keys: [publicJwk] });
    if (url.href === `${ISSUER}token/` && request.method === "POST") {
      const form = new URLSearchParams(await request.text());
      provider.tokenForm = Object.fromEntries(form.entries());
      expect(form.get("code")).toBe("provider-code");
      expect(form.get("redirect_uri")).toBe(REDIRECT_URI);
      expect(form.get("client_id")).toBe(CLIENT_ID);
      expect(form.get("client_secret")).toBe(CLIENT_SECRET);
      expect(await pkceChallenge(form.get("code_verifier") ?? "")).toBe(provider.codeChallenge);
      const now = Math.floor(Date.now() / 1000);
      const idToken = await new SignJWT({
        nonce: provider.nonce,
        preferred_username: "multiworker-user",
      })
        .setProtectedHeader({ alg: "RS256", kid: "multiworker-key" })
        .setIssuer(ISSUER)
        .setAudience(CLIENT_ID)
        .setSubject("multiworker-provider-user")
        .setIssuedAt(now)
        .setExpirationTime(now + 300)
        .sign(privateKey);
      return json({
        access_token: "provider-access-token",
        token_type: "Bearer",
        expires_in: 300,
        id_token: idToken,
      });
    }
    return json({ error: "not_found" }, 404);
  };
}

async function createHarness(
  allowAnonymousSpaces: boolean,
  oauthEnabled = true,
): Promise<Harness> {
  const provider: ProviderState = { nonce: "", codeChallenge: "", requests: [], tokenForm: {} };
  const allow = String(allowAnonymousSpaces);
  const workers: NonNullable<Extract<MiniflareOptions, { workers: unknown }> ["workers"]> = [
    {
      name: "gateway",
      modules: true,
      script: bundles.gateway!,
      serviceBindings: {
        OAUTH: "oauth",
        SYNC: "sync",
        TELEMETRY: async () => new Response(null, { status: 204 }),
      },
      bindings: {
        JWT_SECRET,
        ALLOW_ANONYMOUS_SPACES: allow,
        ENVIRONMENT: "test",
      },
    },
    {
      name: "oauth",
      modules: true,
      script: bundles.oauth!,
      d1Databases: { DB: "oauth-e2e-db" },
      serviceBindings: { IDENTITY: "identity" },
      outboundService: providerHandler(provider),
      bindings: {
        OAUTH_ENABLED: String(oauthEnabled),
        ...(oauthEnabled ? {
          OIDC_DISCOVERY_URL: DISCOVERY_URL,
          OIDC_CLIENT_ID: CLIENT_ID,
          OIDC_CLIENT_SECRET: CLIENT_SECRET,
          OIDC_REDIRECT_URI: REDIRECT_URI,
          OAUTH_FRONTEND_REDIRECT_URIS: JSON.stringify([FRONTEND_REDIRECT_URI]),
        } : {}),
        INTERNAL_SERVICE_SECRET: INTERNAL_SECRET,
      },
    },
    {
      name: "identity",
      modules: true,
      script: bundles.identity!,
      d1Databases: { DB: "identity-e2e-db" },
      bindings: {
        JWT_SECRET,
        INTERNAL_SERVICE_SECRET: INTERNAL_SECRET,
        SESSION_TTL_SECONDS: "3600",
      },
    },
    {
      name: "sync",
      modules: true,
      script: bundles.sync!,
      d1Databases: { DB: "sync-e2e-db" },
      r2Buckets: { BLOB_STORE: "sync-e2e-bucket" },
      bindings: {
        JWT_SECRET,
        COMMIT_TOKEN_SECRET: COMMIT_SECRET,
        ALLOW_ANONYMOUS_SPACES: allow,
        PROTOCOL_VERSION: "cf-sync-v2",
      },
    },
  ];
  const miniflare = new Miniflare({
    compatibilityDate: "2025-08-06",
    workers,
  });
  activeHarnesses.push(miniflare);
  await applyMigrations(
    await miniflare.getD1Database("DB", "identity") as unknown as D1Database,
    "identity",
  );
  await applyMigrations(
    await miniflare.getD1Database("DB", "oauth") as unknown as D1Database,
    "oauth",
  );
  await applyMigrations(
    await miniflare.getD1Database("DB", "sync") as unknown as D1Database,
    "sync",
  );
  return { miniflare, provider };
}

async function authorize(harness: Harness): Promise<string> {
  const parameters = new URLSearchParams({
    frontend_redirect_uri: FRONTEND_REDIRECT_URI,
    oauth_channel: OAUTH_CHANNEL,
  });
  const response = await harness.miniflare.dispatchFetch(`https://gateway.test/v1/oauth/authorize?${parameters.toString()}`, {
    redirect: "manual",
  });
  expect(response.status, await response.clone().text()).toBe(302);
  const redirect = new URL(response.headers.get("location") ?? "");
  expect(redirect.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
  expect(redirect.searchParams.get("scope")).toBe("openid profile");
  harness.provider.nonce = redirect.searchParams.get("nonce") ?? "";
  harness.provider.codeChallenge = redirect.searchParams.get("code_challenge") ?? "";
  return redirect.searchParams.get("state") ?? "";
}

async function login(harness: Harness): Promise<string> {
  const state = await authorize(harness);
  const callback = await harness.miniflare.dispatchFetch(
    `https://gateway.test/v1/oauth/callback?code=provider-code&state=${encodeURIComponent(state)}`,
    { redirect: "manual" },
  );
  expect(callback.status, await callback.clone().text()).toBe(303);
  const frontend = new URL(callback.headers.get("location") ?? "");
  expect(`${frontend.origin}${frontend.pathname}`).toBe(FRONTEND_REDIRECT_URI);
  expect(frontend.search).toBe("");
  const fragment = new URLSearchParams(frontend.hash.slice(1));
  expect(fragment.get("oauth_channel")).toBe(OAUTH_CHANNEL);
  const code = fragment.get("code") ?? "";
  expect(
    code,
    `${frontend.href} ${JSON.stringify(harness.provider.requests)} ${JSON.stringify(harness.provider.tokenForm)}`,
  ).not.toBe("");
  const session = await harness.miniflare.dispatchFetch("https://gateway.test/v1/oauth/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  expect(session.status, await session.clone().text()).toBe(200);
  const body = await session.json() as {
    accessToken: string;
    account: { accountId: string; username: string };
  };
  expect(body.account.username).toBe("multiworker-user");
  return body.accessToken;
}

async function mine(harness: Harness, token: string): Promise<{ spaceId: string }> {
  const response = await harness.miniflare.dispatchFetch("https://gateway.test/v1/sync/spaces/mine", {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json() as Promise<{ spaceId: string }>;
}

beforeAll(async () => {
  const keyPair = await generateKeyPair("RS256");
  privateKey = keyPair.privateKey;
  publicJwk = {
    ...await exportJWK(keyPair.publicKey),
    kid: "multiworker-key",
    alg: "RS256",
    use: "sig",
  };
  const names = ["gateway", "oauth", "identity", "sync"];
  bundles = Object.fromEntries(await Promise.all(
    names.map(async (name) => [name, await bundleWorker(name)] as const),
  ));
});

afterAll(async () => {
  await Promise.all(activeHarnesses.map((miniflare) => miniflare.dispose()));
});

describe("Miniflare 多 Worker OIDC 与同步端到端", () => {
  it("beta 首次/重复 OIDC 登录复用账户与账户空间", async () => {
    const harness = await createHarness(true);
    const firstToken = await login(harness);
    const firstSpace = await mine(harness, firstToken);
    const secondToken = await login(harness);
    const secondSpace = await mine(harness, secondToken);
    expect(secondSpace.spaceId).toBe(firstSpace.spaceId);
  }, 15_000);

  it("stable 可禁用 OAuth，保持 telemetry/capabilities 匿名但拒绝匿名数据路径", async () => {
    const harness = await createHarness(false, false);
    const telemetry = await harness.miniflare.dispatchFetch("https://gateway.test/v1/telemetry/events");
    const capabilities = await harness.miniflare.dispatchFetch("https://gateway.test/v1/sync/capabilities");
    const oauth = await harness.miniflare.dispatchFetch("https://gateway.test/v1/oauth/authorize");
    const anonymousData = await harness.miniflare.dispatchFetch("https://gateway.test/v1/sync/spaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spaceId: "forbidden" }),
    });
    expect(telemetry.status).toBe(204);
    expect(capabilities.status).toBe(200);
    expect(oauth.status).toBe(503);
    expect(await oauth.json()).toMatchObject({ error: "service_unavailable" });
    expect(harness.provider.requests).toEqual([]);
    expect(anonymousData.status).toBe(401);
  });
});

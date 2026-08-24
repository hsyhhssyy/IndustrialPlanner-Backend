import {
  authorizationCodeGrant,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  customFetch,
  discovery,
  randomNonce,
  randomPKCECodeVerifier,
  randomState,
  type Configuration,
} from "openid-client";

const DISCOVERY_SUFFIX = "/.well-known/openid-configuration";

export interface OidcSettings {
  discoveryUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface OidcAuthorizationRequest {
  authorizationUrl: URL;
  state: string;
  codeVerifier: string;
  nonce: string;
}

export interface OidcIdentity {
  issuer: string;
  subject: string;
  username: string;
}

export interface OidcClient {
  createAuthorizationRequest(): Promise<OidcAuthorizationRequest>;
  exchangeCallback(
    callbackUrl: URL,
    expected: { state: string; codeVerifier: string; nonce: string },
  ): Promise<OidcIdentity>;
}

export type OidcFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class OidcConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "OidcConfigurationError";
  }
}

function parseHttpsUrl(value: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OidcConfigurationError(`${name} 不是合法 URL`);
  }
  if (url.protocol !== "https:") {
    throw new OidcConfigurationError(`${name} 必须使用 HTTPS`);
  }
  return url;
}

function issuerFromDiscoveryUrl(value: string): URL {
  const discoveryUrl = parseHttpsUrl(value, "OIDC_DISCOVERY_URL");
  if (discoveryUrl.search || discoveryUrl.hash || !discoveryUrl.pathname.endsWith(DISCOVERY_SUFFIX)) {
    throw new OidcConfigurationError(
      `OIDC_DISCOVERY_URL 必须指向标准 ${DISCOVERY_SUFFIX}`,
    );
  }
  const issuerPrefix = discoveryUrl.pathname.slice(0, -DISCOVERY_SUFFIX.length);
  const issuerPath = issuerPrefix ? `${issuerPrefix}/` : "/";
  return new URL(issuerPath, discoveryUrl.origin);
}

function validateSettings(settings: OidcSettings): { issuer: URL; redirectUri: URL } {
  if (!settings.clientId.trim()) {
    throw new OidcConfigurationError("OIDC_CLIENT_ID 不能为空");
  }
  if (!settings.clientSecret.trim()) {
    throw new OidcConfigurationError("OIDC_CLIENT_SECRET 不能为空");
  }
  const issuer = issuerFromDiscoveryUrl(settings.discoveryUrl);
  const redirectUri = parseHttpsUrl(settings.redirectUri, "OIDC_REDIRECT_URI");
  return { issuer, redirectUri };
}

export function createOidcClient(settings: OidcSettings, fetchImpl?: OidcFetch): OidcClient {
  const validated = validateSettings(settings);
  let configurationPromise: Promise<Configuration> | undefined;

  const normalizedFetch: OidcFetch = async (input, init) => {
    let normalizedInit = init;
    if (
      init?.body instanceof URLSearchParams
      && init.body.get("grant_type") === "authorization_code"
    ) {
      const body = new URLSearchParams(init.body);
      body.set("redirect_uri", validated.redirectUri.href);
      normalizedInit = { ...init, body };
    }
    return (fetchImpl ?? fetch)(input, normalizedInit);
  };

  function configuration(): Promise<Configuration> {
    configurationPromise ??= discovery(
      validated.issuer,
      settings.clientId,
      { client_secret: settings.clientSecret },
      undefined,
      { [customFetch]: normalizedFetch },
    );
    return configurationPromise;
  }

  return {
    async createAuthorizationRequest() {
      const state = randomState();
      const codeVerifier = randomPKCECodeVerifier();
      const nonce = randomNonce();
      const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
      const authorizationUrl = buildAuthorizationUrl(await configuration(), {
        redirect_uri: validated.redirectUri.href,
        response_type: "code",
        scope: "openid profile",
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      });
      return { authorizationUrl, state, codeVerifier, nonce };
    },

    async exchangeCallback(callbackUrl, expected) {
      const verifiedCallbackUrl = new URL(validated.redirectUri);
      verifiedCallbackUrl.search = callbackUrl.search;
      const tokens = await authorizationCodeGrant(await configuration(), verifiedCallbackUrl, {
        expectedState: expected.state,
        expectedNonce: expected.nonce,
        pkceCodeVerifier: expected.codeVerifier,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      const username = typeof claims?.preferred_username === "string"
        ? claims.preferred_username.trim()
        : "";
      if (
        !claims
        || typeof claims.iss !== "string"
        || typeof claims.sub !== "string"
        || !username
      ) {
        throw new Error("OIDC id_token 缺少 iss、sub 或 preferred_username");
      }
      return { issuer: claims.iss, subject: claims.sub, username };
    },
  };
}

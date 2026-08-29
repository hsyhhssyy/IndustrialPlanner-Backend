import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOrangeAuthProvider } from "./orangeauth";
import {
  LoginProviderConfigurationError,
  type LoginProviderFetch,
} from "./provider";

const BASE_URL = "https://auth.yituliu.cn";
const CLIENT_ID = "industrial-planner";
const CLIENT_SECRET = "orangeauth-client-secret";
const REDIRECT_URI = "https://backend.test/v1/oauth/callback";

interface ProviderState {
  tokenResult: unknown;
  userinfoResult: unknown;
  revokeResult: unknown;
  tokenStatus: number;
  userinfoStatus: number;
  revokeStatus: number;
  throwAt: "token" | "userinfo" | "revoke" | null;
  requests: string[];
  tokenForm: URLSearchParams | null;
  revokeForm: URLSearchParams | null;
  userinfoAuthorization: string | null;
}

let state: ProviderState;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

const providerFetch: LoginProviderFetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  state.requests.push(`${request.method} ${url.href}`);
  if (url.pathname === "/oauth2/token") {
    if (state.throwAt === "token") throw new Error("provider unavailable");
    state.tokenForm = new URLSearchParams(await request.text());
    return json(state.tokenResult, state.tokenStatus);
  }
  if (url.pathname === "/oauth2/userinfo") {
    if (state.throwAt === "userinfo") throw new Error("provider unavailable");
    state.userinfoAuthorization = request.headers.get("authorization");
    return json(state.userinfoResult, state.userinfoStatus);
  }
  if (url.pathname === "/oauth2/revoke") {
    if (state.throwAt === "revoke") throw new Error("provider unavailable");
    state.revokeForm = new URLSearchParams(await request.text());
    return json(state.revokeResult, state.revokeStatus);
  }
  return json({ code: 404 }, 404);
};

function provider() {
  return createOrangeAuthProvider({
    baseUrl: BASE_URL,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
    scope: "user.read",
  }, providerFetch);
}

async function authorization() {
  return provider().createAuthorizationRequest();
}

async function exchange() {
  const request = await authorization();
  const callback = new URL(REDIRECT_URI);
  callback.search = new URLSearchParams({ code: "provider-code", state: request.state }).toString();
  return provider().exchangeCallback(callback, {
    state: request.state,
    codeVerifier: request.codeVerifier,
    validationContext: request.validationContext,
  });
}

beforeEach(() => {
  state = {
    tokenResult: {
      code: 200,
      data: {
        access_token: "orange-access-token",
        refresh_token: "orange-refresh-token",
        expires_in: 7200,
      },
    },
    userinfoResult: {
      code: 200,
      data: { uid: 123456, userName: "planner-user" },
    },
    revokeResult: { code: 200 },
    tokenStatus: 200,
    userinfoStatus: 200,
    revokeStatus: 200,
    throwAt: null,
    requests: [],
    tokenForm: null,
    revokeForm: null,
    userinfoAuthorization: null,
  };
});

describe("OrangeAuth 登录适配器", () => {
  it("构造标准 S256 authorization URL", async () => {
    const subtle = crypto.subtle;
    const deterministicRandom = <T extends ArrayBufferView | null>(array: T): T => {
      if (array) new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(1);
      return array;
    };
    vi.stubGlobal("crypto", { subtle, getRandomValues: deterministicRandom });
    try {
      const request = await authorization();
      const url = request.authorizationUrl;
      expect(url.href.startsWith(`${BASE_URL}/oauth2/authorize?`)).toBe(true);
      expect(url.searchParams.get("response_type")).toBe("code");
      expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
      expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
      expect(url.searchParams.get("scope")).toBe("user.read");
      expect(url.searchParams.get("state")).toBe(request.state);
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");

      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(request.codeVerifier),
      );
      let binary = "";
      for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
      const standardChallenge = btoa(binary)
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/u, "");
      expect(btoa(binary)).toContain("/");
      expect(url.searchParams.get("code_challenge")).toBe(standardChallenge);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("以 client_secret_post 换取身份并优先吊销 refresh token", async () => {
    await expect(exchange()).resolves.toEqual({
      providerKey: "orangeauth:https://auth.yituliu.cn",
      subject: "123456",
      username: "planner-user",
    });
    expect(Object.fromEntries(state.tokenForm?.entries() ?? [])).toMatchObject({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: "provider-code",
      redirect_uri: REDIRECT_URI,
    });
    expect(state.tokenForm?.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43,128}$/u);
    expect(state.userinfoAuthorization).toBe("Bearer orange-access-token");
    expect(Object.fromEntries(state.revokeForm?.entries() ?? [])).toEqual({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      token: "orange-refresh-token",
    });
  });

  it("没有 refresh token 时吊销 access token，吊销失败不改变已验证身份", async () => {
    state.tokenResult = {
      code: 200,
      data: { access_token: "orange-access-token", expires_in: 7200 },
    };
    state.throwAt = "revoke";
    await expect(exchange()).resolves.toMatchObject({ subject: "123456" });
    expect(state.requests.at(-1)).toBe(`POST ${BASE_URL}/oauth2/revoke`);
  });

  it.each([
    [90001, "configuration"],
    [90002, "configuration"],
    [90003, "configuration"],
    [90006, "configuration"],
    [90007, "configuration"],
    [90004, "callback_invalid"],
    [90005, "callback_invalid"],
    [90008, "callback_invalid"],
    [90009, "callback_invalid"],
    [99999, "unavailable"],
  ] as const)("将 OrangeAuth 错误码 %i 收敛为 %s", async (code, kind) => {
    state.tokenResult = { code, msg: "provider detail must not escape" };
    await expect(exchange()).rejects.toMatchObject({ kind });
  });

  it.each([
    { tokenStatus: 502 },
    { tokenStatus: 302 },
    { tokenResult: "not-an-object" },
    { tokenResult: { code: 200 } },
    { tokenResult: { code: 200, data: { access_token: " invalid " } } },
    { userinfoResult: { code: 200 } },
    { throwAt: "token" as const },
  ])("将 HTTP、网络和 Result 结构错误收敛为 unavailable：$tokenStatus$throwAt", async (change) => {
    Object.assign(state, change);
    await expect(exchange()).rejects.toMatchObject({
      kind: "unavailable",
    });
  });

  it("Provider 请求超时时 fail-closed", async () => {
    vi.useFakeTimers();
    try {
      const hangingFetch: LoginProviderFetch = async (_input, init) => new Promise<Response>(
        (_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        },
      );
      const timeoutProvider = createOrangeAuthProvider({
        baseUrl: BASE_URL,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        redirectUri: REDIRECT_URI,
        scope: "user.read",
      }, hangingFetch);
      const request = await timeoutProvider.createAuthorizationRequest();
      const callback = new URL(REDIRECT_URI);
      callback.search = new URLSearchParams({
        code: "provider-code",
        state: request.state,
      }).toString();
      const result = timeoutProvider.exchangeCallback(callback, {
        state: request.state,
        codeVerifier: request.codeVerifier,
        validationContext: request.validationContext,
      });
      const rejection = expect(result).rejects.toMatchObject({ kind: "unavailable" });
      await vi.advanceTimersByTimeAsync(10_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { uid: "", userName: "planner-user" },
    { uid: 1.5, userName: "planner-user" },
    { uid: "uid-1", userName: "" },
    { uid: "uid-1", userName: "bad\nname" },
  ])("拒绝非法 uid/userName：$uid/$userName", async (identity) => {
    state.userinfoResult = { code: 200, data: identity };
    await expect(exchange()).rejects.toMatchObject({
      kind: "callback_invalid",
    });
    expect(state.revokeForm?.get("token")).toBe("orange-refresh-token");
  });

  it("在访问 Provider 前拒绝非法 callback", async () => {
    const request = await authorization();
    const callback = new URL(`${REDIRECT_URI}?code=provider-code&state=wrong-state`);
    await expect(provider().exchangeCallback(callback, {
      state: request.state,
      codeVerifier: request.codeVerifier,
      validationContext: "",
    })).rejects.toMatchObject({ kind: "callback_invalid" });
    expect(state.requests).toEqual([]);
  });

  it("配置只接受固定 HTTPS 根地址、HTTPS callback 和 user.read", () => {
    const base = {
      baseUrl: BASE_URL,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
      scope: "user.read",
    };
    for (const change of [
      { baseUrl: "http://auth.yituliu.cn" },
      { baseUrl: `${BASE_URL}/oauth2` },
      { baseUrl: "https://user@auth.yituliu.cn" },
      { redirectUri: "http://backend.test/v1/oauth/callback" },
      { scope: "user.read,user.email" },
    ]) {
      expect(() => createOrangeAuthProvider({ ...base, ...change }, providerFetch))
        .toThrow(LoginProviderConfigurationError);
    }
  });
});

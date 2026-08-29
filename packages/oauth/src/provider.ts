export type LoginProviderType = "oidc" | "orangeauth";

export interface LoginProviderAuthorizationRequest {
  authorizationUrl: URL;
  state: string;
  codeVerifier: string;
  validationContext: string;
}

export interface LoginProviderIdentity {
  providerKey: string;
  subject: string;
  username: string;
}

export interface LoginIdentityProvider {
  readonly type: LoginProviderType;
  createAuthorizationRequest(): Promise<LoginProviderAuthorizationRequest>;
  exchangeCallback(
    callbackUrl: URL,
    expected: { state: string; codeVerifier: string; validationContext: string },
  ): Promise<LoginProviderIdentity>;
}

export type LoginProviderFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export class LoginProviderConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "LoginProviderConfigurationError";
  }
}

export class LoginProviderProtocolError extends Error {
  public constructor(
    public readonly kind: "configuration" | "callback_invalid" | "unavailable",
  ) {
    super("登录身份 Provider 协议失败");
    this.name = "LoginProviderProtocolError";
  }
}

import {
  INTERNAL_SERVICE_AUTH_HEADER,
  type CreateAccountResponse,
  type CreateSessionResponse,
} from "@industrial/shared";

export interface IdentityBinding {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

export interface IdentityClient {
  createAccount(): Promise<CreateAccountResponse>;
  createSession(accountId: string): Promise<CreateSessionResponse>;
}

export class IdentityClientError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "IdentityClientError";
  }
}

function headers(secret: string, json = false): Headers {
  const result = new Headers({ [INTERNAL_SERVICE_AUTH_HEADER]: secret });
  if (json) result.set("content-type", "application/json");
  return result;
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new IdentityClientError("identity 返回了非 JSON 响应");
  }
}

export function createIdentityClient(binding: IdentityBinding, internalSecret: string): IdentityClient {
  if (new TextEncoder().encode(internalSecret).byteLength < 32) {
    throw new IdentityClientError("INTERNAL_SERVICE_SECRET 配置无效");
  }

  return {
    async createAccount() {
      const response = await binding.fetch(new Request("http://identity/internal/accounts", {
        method: "POST",
        headers: headers(internalSecret),
      }));
      const body = await parseJson(response);
      if (!response.ok || typeof body !== "object" || body === null ||
          typeof (body as { accountId?: unknown }).accountId !== "string") {
        throw new IdentityClientError("identity 创建账户失败");
      }
      return body as CreateAccountResponse;
    },

    async createSession(accountId) {
      const response = await binding.fetch(new Request("http://identity/internal/sessions", {
        method: "POST",
        headers: headers(internalSecret, true),
        body: JSON.stringify({ accountId }),
      }));
      const body = await parseJson(response);
      const candidate = body as Partial<CreateSessionResponse> | null;
      if (!response.ok || !candidate || typeof candidate.accessToken !== "string" ||
          candidate.tokenType !== "Bearer" || typeof candidate.expiresAt !== "string") {
        throw new IdentityClientError("identity 签发会话失败");
      }
      return candidate as CreateSessionResponse;
    },
  };
}

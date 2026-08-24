import {
  signJwt,
  type AccountId,
  type CreateAccountResponse,
  type CreateSessionResponse,
} from "@industrial/shared";
import type { AccountRepository } from "./repository";

const DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface IdentityServiceDependencies {
  accounts: AccountRepository;
  jwtSecret: string;
  sessionTtlSeconds?: number;
  now?: () => number;
  createId?: () => string;
}

export class IdentityServiceError extends Error {
  public constructor(
    public readonly status: 400 | 404 | 500,
    public readonly code: "account_not_found" | "configuration_error",
    message: string,
  ) {
    super(message);
    this.name = "IdentityServiceError";
  }
}

export async function createAccount(
  dependencies: IdentityServiceDependencies,
): Promise<CreateAccountResponse> {
  const timestamp = new Date((dependencies.now ?? Date.now)()).toISOString();
  const accountId = dependencies.createId?.() ?? crypto.randomUUID();
  await dependencies.accounts.create({
    id: accountId,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return { accountId };
}

export async function createSession(
  accountId: AccountId,
  dependencies: IdentityServiceDependencies,
): Promise<CreateSessionResponse> {
  if (!(await dependencies.accounts.exists(accountId))) {
    throw new IdentityServiceError(404, "account_not_found", "账户不存在");
  }

  const ttl = dependencies.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
  if (!Number.isSafeInteger(ttl) || ttl <= 0) {
    throw new IdentityServiceError(500, "configuration_error", "SESSION_TTL_SECONDS 配置无效");
  }

  const issuedAt = Math.floor((dependencies.now ?? Date.now)() / 1000);
  const expiresAt = issuedAt + ttl;
  let accessToken: string;
  try {
    accessToken = await signJwt({ sub: accountId, iat: issuedAt, exp: expiresAt }, dependencies.jwtSecret);
  } catch {
    throw new IdentityServiceError(500, "configuration_error", "JWT_SECRET 配置无效");
  }

  return {
    accessToken,
    tokenType: "Bearer",
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  };
}

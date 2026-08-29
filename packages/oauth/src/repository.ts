import type { AccountId } from "@industrial/shared";
import type {
  OAuthCallbackCode,
  OAuthLoginTransaction,
  OAuthMapping,
} from "./model";
import type { LoginProviderType } from "./provider";

interface LoginTransactionRow {
  state_hash: string;
  state_value: string;
  code_verifier: string;
  provider_type: LoginProviderType;
  provider_context: string;
  frontend_redirect_uri: string;
  oauth_channel: string;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
}

interface MappingRow {
  provider_key: string;
  subject: string;
  account_id: string;
  created_at: string;
}

interface CallbackCodeRow {
  code_hash: string;
  account_id: string;
  username: string;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
}

export interface OAuthRepository {
  createLoginTransaction(transaction: OAuthLoginTransaction): Promise<void>;
  consumeLoginTransaction(
    stateHash: string,
    consumedAt: string,
  ): Promise<OAuthLoginTransaction | null>;
  findMapping(providerKey: string, subject: string): Promise<OAuthMapping | null>;
  createMappingIfAbsent(mapping: OAuthMapping): Promise<OAuthMapping>;
  createCallbackCode(code: OAuthCallbackCode): Promise<void>;
  consumeCallbackCode(
    codeHash: string,
    consumedAt: string,
  ): Promise<{ accountId: AccountId; username: string } | null>;
  checkHealth(): Promise<boolean>;
}

function toLoginTransaction(row: LoginTransactionRow): OAuthLoginTransaction {
  return {
    stateHash: row.state_hash,
    stateValue: row.state_value,
    codeVerifier: row.code_verifier,
    providerType: row.provider_type,
    providerContext: row.provider_context,
    frontendRedirectUri: row.frontend_redirect_uri,
    oauthChannel: row.oauth_channel,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    createdAt: row.created_at,
  };
}

function toMapping(row: MappingRow): OAuthMapping {
  return {
    providerKey: row.provider_key,
    subject: row.subject,
    accountId: row.account_id,
    createdAt: row.created_at,
  };
}

export function createOAuthRepository(db: D1Database): OAuthRepository {
  return {
    async createLoginTransaction(transaction) {
      await db.prepare(
        `INSERT INTO oauth_login_transactions(
           state_hash, state_value, code_verifier, provider_type, provider_context,
           frontend_redirect_uri, oauth_channel, expires_at, consumed_at, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      ).bind(
        transaction.stateHash,
        transaction.stateValue,
        transaction.codeVerifier,
        transaction.providerType,
        transaction.providerContext,
        transaction.frontendRedirectUri,
        transaction.oauthChannel,
        transaction.expiresAt,
        transaction.consumedAt,
        transaction.createdAt,
      ).run();
    },

    async consumeLoginTransaction(stateHash, consumedAt) {
      const row = await db.prepare(
        `UPDATE oauth_login_transactions
         SET consumed_at=?2
         WHERE state_hash=?1 AND consumed_at IS NULL AND expires_at>?2
         RETURNING state_hash, state_value, code_verifier, provider_type, provider_context,
                   frontend_redirect_uri, oauth_channel, expires_at,
                   consumed_at, created_at`,
      ).bind(stateHash, consumedAt).first<LoginTransactionRow>();
      return row ? toLoginTransaction(row) : null;
    },

    async findMapping(providerKey, subject) {
      const row = await db.prepare(
        `SELECT provider_key, subject, account_id, created_at
         FROM oauth_mappings WHERE provider_key=?1 AND subject=?2`,
      ).bind(providerKey, subject).first<MappingRow>();
      return row ? toMapping(row) : null;
    },

    async createMappingIfAbsent(mapping) {
      await db.prepare(
        `INSERT OR IGNORE INTO oauth_mappings(provider_key, subject, account_id, created_at)
         VALUES (?1, ?2, ?3, ?4)`,
      ).bind(
        mapping.providerKey,
        mapping.subject,
        mapping.accountId,
        mapping.createdAt,
      ).run();

      const row = await db.prepare(
        `SELECT provider_key, subject, account_id, created_at
         FROM oauth_mappings WHERE provider_key=?1 AND subject=?2`,
      ).bind(mapping.providerKey, mapping.subject).first<MappingRow>();
      if (!row) throw new Error("登录身份映射写入后不存在");
      return toMapping(row);
    },

    async createCallbackCode(code) {
      await db.prepare(
        `INSERT INTO oauth_callback_codes(
           code_hash, account_id, username, expires_at, consumed_at, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      ).bind(
        code.codeHash,
        code.accountId,
        code.username,
        code.expiresAt,
        code.consumedAt,
        code.createdAt,
      ).run();
    },

    async consumeCallbackCode(codeHash, consumedAt) {
      const row = await db.prepare(
        `UPDATE oauth_callback_codes
         SET consumed_at=?2
         WHERE code_hash=?1 AND username<>'' AND consumed_at IS NULL AND expires_at>?2
         RETURNING code_hash, account_id, username, expires_at, consumed_at, created_at`,
      ).bind(codeHash, consumedAt).first<CallbackCodeRow>();
      return row ? { accountId: row.account_id, username: row.username } : null;
    },

    async checkHealth() {
      try {
        const row = await db.prepare("SELECT 1 AS ok").first<{ ok: number }>();
        return row?.ok === 1;
      } catch {
        return false;
      }
    },
  };
}

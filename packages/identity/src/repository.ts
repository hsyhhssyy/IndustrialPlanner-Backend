import type { AccountId } from "@industrial/shared";
import type { Account } from "./model";

export interface AccountRepository {
  create(account: Account): Promise<void>;
  exists(accountId: AccountId): Promise<boolean>;
  checkHealth(): Promise<boolean>;
}

export function createAccountRepository(db: D1Database): AccountRepository {
  return {
    async create(account) {
      await db.prepare(
        `INSERT INTO accounts(id, created_at, updated_at)
         VALUES (?1, ?2, ?3)`,
      ).bind(account.id, account.createdAt, account.updatedAt).run();
    },

    async exists(accountId) {
      const row = await db.prepare(
        "SELECT 1 AS found FROM accounts WHERE id=?1",
      ).bind(accountId).first<{ found: number }>();
      return row?.found === 1;
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

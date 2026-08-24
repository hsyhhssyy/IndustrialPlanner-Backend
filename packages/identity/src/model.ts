import type { AccountId } from "@industrial/shared";

export interface Account {
  id: AccountId;
  createdAt: string;
  updatedAt: string;
}

export function isAccountId(value: unknown): value is AccountId {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

import type pg from "pg";
import { AppError } from "./errors.js";
import { Money } from "./money.js";

export type AccountRow = {
  id: string;
  currency: string;
  balance_cents: string;
  created_at: Date;
};

export type AccountPublic = {
  id: string;
  currency: string;
  balance: string;
  created_at: string;
};

export function toAccountPublic(row: AccountRow): AccountPublic {
  return {
    id: row.id,
    currency: row.currency.trim(),
    balance: Money.fromCents(BigInt(row.balance_cents)).toDecimalString(),
    created_at: new Date(row.created_at).toISOString(),
  };
}

export async function createAccount(
  pool: pg.Pool,
  input: { currency: string; initialBalance: Money },
): Promise<AccountPublic> {
  if (input.currency !== "USD") {
    throw new AppError(
      422,
      "UNSUPPORTED_CURRENCY",
      "only USD accounts are supported",
    );
  }
  const result = await pool.query<AccountRow>(
    `INSERT INTO accounts (currency, balance_cents)
     VALUES ($1, $2)
     RETURNING id, currency, balance_cents, created_at`,
    [input.currency, input.initialBalance.cents.toString()],
  );
  return toAccountPublic(result.rows[0]!);
}

export async function getAccountBalance(
  pool: pg.Pool,
  accountId: string,
): Promise<AccountPublic> {
  const result = await pool.query<AccountRow>(
    `SELECT id, currency, balance_cents, created_at FROM accounts WHERE id = $1`,
    [accountId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new AppError(404, "ACCOUNT_NOT_FOUND", "account does not exist");
  }
  return toAccountPublic(row);
}

export async function sumBalancesCents(pool: pg.Pool): Promise<bigint> {
  const result = await pool.query<{ sum: string | null }>(
    `SELECT COALESCE(SUM(balance_cents), 0)::text AS sum FROM accounts`,
  );
  return BigInt(result.rows[0]?.sum ?? "0");
}

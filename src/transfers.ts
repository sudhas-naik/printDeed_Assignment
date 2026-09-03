import type pg from "pg";
import { AppError } from "./errors.js";
import { requestHash } from "./db.js";
import { Money } from "./money.js";

export type TransferRow = {
  id: string;
  from_account_id: string;
  to_account_id: string;
  amount_cents: string;
  currency: string;
  status: string;
  api_key_id: string;
  idempotency_key: string;
  created_at: Date;
};

export type TransferPublic = {
  id: string;
  from_account_id: string;
  to_account_id: string;
  amount: string;
  currency: string;
  status: string;
  created_at: string;
};

export function toTransferPublic(row: TransferRow): TransferPublic {
  return {
    id: row.id,
    from_account_id: row.from_account_id,
    to_account_id: row.to_account_id,
    amount: Money.fromCents(BigInt(row.amount_cents)).toDecimalString(),
    currency: row.currency.trim(),
    status: row.status,
    created_at: new Date(row.created_at).toISOString(),
  };
}

export type CreateTransferInput = {
  fromAccountId: string;
  toAccountId: string;
  amount: Money;
  currency: string;
};

const MAX_ATTEMPTS = 5;

export async function createTransfer(
  pool: pg.Pool,
  callerId: string,
  idempotencyKey: string,
  input: CreateTransferInput,
): Promise<{ transfer: TransferPublic; replayed: boolean }> {
  if (!idempotencyKey || idempotencyKey.length > 256) {
    throw new AppError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "Idempotency-Key must be 1-256 characters",
    );
  }
  if (input.currency !== "USD") {
    throw new AppError(
      422,
      "UNSUPPORTED_CURRENCY",
      "only USD transfers are supported",
    );
  }
  if (input.fromAccountId === input.toAccountId) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "from_account_id and to_account_id must be different",
    );
  }

  const hash = requestHash({
    fromAccountId: input.fromAccountId,
    toAccountId: input.toAccountId,
    amountCents: input.amount.cents.toString(),
    currency: input.currency,
  });

  const client = await pool.connect();
  try {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        await client.query("BEGIN");
        const outcome = await executeTransfer(client, callerId, idempotencyKey, hash, input);
        await client.query("COMMIT");
        return outcome;
      } catch (err) {
        await rollbackQuiet(client);
        if (
          err instanceof RetryTransaction ||
          isRetryablePg(err) ||
          isUniqueViolation(err)
        ) {
          continue;
        }
        throw err;
      }
    }
    throw new AppError(
      409,
      "CONFLICT",
      "could not complete transfer due to concurrent retries; retry with the same Idempotency-Key",
    );
  } finally {
    client.release();
  }
}

class RetryTransaction extends Error {
  constructor() {
    super("retry transaction");
    this.name = "RetryTransaction";
  }
}

async function executeTransfer(
  client: pg.PoolClient,
  callerId: string,
  idempotencyKey: string,
  hash: string,
  input: CreateTransferInput,
): Promise<{ transfer: TransferPublic; replayed: boolean }> {
  const reserved = await client.query(
    `INSERT INTO idempotency_keys (api_key_id, idempotency_key, request_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT (api_key_id, idempotency_key) DO NOTHING
     RETURNING api_key_id`,
    [callerId, idempotencyKey, hash],
  );

  if ((reserved.rowCount ?? 0) === 0) {
    return replayExisting(client, callerId, idempotencyKey, hash);
  }

  return performNewTransfer(client, callerId, idempotencyKey, input);
}

async function replayExisting(
  client: pg.PoolClient,
  callerId: string,
  idempotencyKey: string,
  hash: string,
): Promise<{ transfer: TransferPublic; replayed: boolean }> {
  // Wait for the in-flight owner of this key to commit or roll back.
  const existing = await client.query<{
    request_hash: string;
    transfer_id: string | null;
  }>(
    `SELECT request_hash, transfer_id
     FROM idempotency_keys
     WHERE api_key_id = $1 AND idempotency_key = $2
     FOR UPDATE`,
    [callerId, idempotencyKey],
  );

  const row = existing.rows[0];
  if (!row) {
    // Owner rolled back; retry so we can insert the reservation ourselves.
    throw new RetryTransaction();
  }
  if (row.request_hash !== hash) {
    throw new AppError(
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "Idempotency-Key was already used with a different request body",
    );
  }
  if (!row.transfer_id) {
    throw new RetryTransaction();
  }

  const transfer = await client.query<TransferRow>(
    `SELECT id, from_account_id, to_account_id, amount_cents, currency, status,
            api_key_id, idempotency_key, created_at
     FROM transfers WHERE id = $1`,
    [row.transfer_id],
  );
  const found = transfer.rows[0];
  if (!found) {
    throw new RetryTransaction();
  }
  return { transfer: toTransferPublic(found), replayed: true };
}

async function performNewTransfer(
  client: pg.PoolClient,
  callerId: string,
  idempotencyKey: string,
  input: CreateTransferInput,
): Promise<{ transfer: TransferPublic; replayed: boolean }> {
  // Lock both accounts in UUID order to avoid deadlocks when concurrent
  // transfers touch the same pair in opposite directions.
  const orderedIds = [input.fromAccountId, input.toAccountId].sort();
  const locked = await client.query<{
    id: string;
    balance_cents: string;
    currency: string;
  }>(
    `SELECT id, balance_cents, currency
     FROM accounts
     WHERE id = ANY($1::uuid[])
     FOR UPDATE`,
    [orderedIds],
  );

  const byId = new Map(locked.rows.map((r) => [r.id, r]));
  const from = byId.get(input.fromAccountId);
  const to = byId.get(input.toAccountId);
  if (!from || !to) {
    throw new AppError(404, "ACCOUNT_NOT_FOUND", "one or both accounts do not exist");
  }
  if (from.currency.trim() !== "USD" || to.currency.trim() !== "USD") {
    throw new AppError(422, "UNSUPPORTED_CURRENCY", "only USD transfers are supported");
  }

  const fromBal = BigInt(from.balance_cents);
  if (fromBal < input.amount.cents) {
    throw new AppError(
      409,
      "INSUFFICIENT_FUNDS",
      "from_account does not have sufficient funds",
    );
  }

  const cents = input.amount.cents.toString();
  const debit = await client.query(
    `UPDATE accounts
     SET balance_cents = balance_cents - $1
     WHERE id = $2 AND balance_cents >= $1`,
    [cents, input.fromAccountId],
  );
  if ((debit.rowCount ?? 0) !== 1) {
    throw new AppError(
      409,
      "INSUFFICIENT_FUNDS",
      "from_account does not have sufficient funds",
    );
  }
  await client.query(
    `UPDATE accounts SET balance_cents = balance_cents + $1 WHERE id = $2`,
    [cents, input.toAccountId],
  );

  const inserted = await client.query<TransferRow>(
    `INSERT INTO transfers (
       from_account_id, to_account_id, amount_cents, currency,
       status, api_key_id, idempotency_key
     ) VALUES ($1, $2, $3, $4, 'completed', $5, $6)
     RETURNING id, from_account_id, to_account_id, amount_cents, currency, status,
               api_key_id, idempotency_key, created_at`,
    [
      input.fromAccountId,
      input.toAccountId,
      input.amount.cents.toString(),
      "USD",
      callerId,
      idempotencyKey,
    ],
  );
  const row = inserted.rows[0]!;

  await client.query(
    `UPDATE idempotency_keys
     SET transfer_id = $1
     WHERE api_key_id = $2 AND idempotency_key = $3`,
    [row.id, callerId, idempotencyKey],
  );

  return { transfer: toTransferPublic(row), replayed: false };
}

export async function getTransfer(
  pool: pg.Pool,
  callerId: string,
  transferId: string,
): Promise<TransferPublic> {
  const result = await pool.query<TransferRow>(
    `SELECT id, from_account_id, to_account_id, amount_cents, currency, status,
            api_key_id, idempotency_key, created_at
     FROM transfers
     WHERE id = $1 AND api_key_id = $2`,
    [transferId, callerId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new AppError(404, "TRANSFER_NOT_FOUND", "transfer does not exist");
  }
  return toTransferPublic(row);
}

function pgCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) {
    return undefined;
  }
  const code = (err as { code: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isRetryablePg(err: unknown): boolean {
  const code = pgCode(err);
  return code === "40001" || code === "40P01";
}

function isUniqueViolation(err: unknown): boolean {
  return pgCode(err) === "23505";
}

async function rollbackQuiet(client: pg.PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Connection may already be aborted; the caller releases it either way.
  }
}

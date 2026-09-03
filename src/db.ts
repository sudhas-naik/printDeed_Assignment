import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;

export function createPool(databaseUrl: string): pg.Pool {
  return new Pool({
    connectionString: databaseUrl,
    max: 20,
  });
}

export async function migrate(pool: pg.Pool): Promise<void> {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = ["001_init.sql"];
  for (const file of files) {
    const applied = await pool.query(
      "SELECT 1 FROM schema_migrations WHERE version = $1",
      [file],
    );
    if ((applied.rowCount ?? 0) > 0) {
      continue;
    }
    const sql = await readFile(join(dir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}

export function requestHash(input: {
  fromAccountId: string;
  toAccountId: string;
  amountCents: string;
  currency: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        from_account_id: input.fromAccountId,
        to_account_id: input.toAccountId,
        amount_cents: input.amountCents,
        currency: input.currency,
      }),
    )
    .digest("hex");
}

export function hashApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { buildApp } from "../src/app.js";
import { createPool, migrate } from "../src/db.js";

export const API_KEY = "dev-secret-key";
export const OTHER_API_KEY = "other-secret-key";

export type TestCtx = {
  pool: pg.Pool;
  app: FastifyInstance;
  baseUrl: string;
};

export async function startTestApp(): Promise<TestCtx> {
  const databaseUrl =
    process.env.DATABASE_URL ?? "postgres://transfer:transfer@localhost:15432/transfer";
  const pool = createPool(databaseUrl);
  await waitForDb(pool);
  await migrate(pool);
  const app = await buildApp({
    pool,
    apiKeys: new Set([API_KEY, OTHER_API_KEY]),
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address() as AddressInfo;
  return { pool, app, baseUrl: `http://127.0.0.1:${addr.port}` };
}

export async function stopTestApp(ctx: TestCtx): Promise<void> {
  await ctx.app.close();
  await ctx.pool.end();
}

export async function resetDb(pool: pg.Pool): Promise<void> {
  await pool.query("TRUNCATE transfers, idempotency_keys, accounts CASCADE");
}

export async function jsonRequest(
  ctx: TestCtx,
  path: string,
  init: RequestInit & { apiKey?: string | undefined } = {},
): Promise<{ status: number; body: unknown }> {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type") && init.body) {
    headers.set("content-type", "application/json");
  }
  headers.set("x-api-key", init.apiKey ?? API_KEY);
  const res = await fetch(`${ctx.baseUrl}${path}`, { ...init, headers });
  const text = await res.text();
  const body = text.length === 0 ? null : JSON.parse(text);
  return { status: res.status, body };
}

export async function createAccountHttp(
  ctx: TestCtx,
  initialBalance: string,
  apiKey = API_KEY,
): Promise<{ id: string; balance: string; currency: string }> {
  const { status, body } = await jsonRequest(ctx, "/accounts", {
    method: "POST",
    apiKey,
    body: JSON.stringify({ currency: "USD", initial_balance: initialBalance }),
  });
  if (status !== 201) {
    throw new Error(`create account failed: ${status} ${JSON.stringify(body)}`);
  }
  return body as { id: string; balance: string; currency: string };
}

export async function transferHttp(
  ctx: TestCtx,
  input: {
    from: string;
    to: string;
    amount: string;
    currency?: string;
    key: string;
    apiKey?: string;
  },
): Promise<{ status: number; body: unknown }> {
  return jsonRequest(ctx, "/transfers", {
    method: "POST",
    apiKey: input.apiKey,
    headers: { "Idempotency-Key": input.key },
    body: JSON.stringify({
      from_account_id: input.from,
      to_account_id: input.to,
      amount: input.amount,
      currency: input.currency ?? "USD",
    }),
  });
}

export async function balanceHttp(
  ctx: TestCtx,
  accountId: string,
): Promise<string> {
  const { status, body } = await jsonRequest(ctx, `/accounts/${accountId}/balance`);
  if (status !== 200) {
    throw new Error(`balance failed: ${status} ${JSON.stringify(body)}`);
  }
  return (body as { balance: string }).balance;
}

async function waitForDb(pool: pg.Pool): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < 40; i++) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(
    `Postgres is not reachable. Run \`docker compose up -d --wait\`. Last error: ${String(lastErr)}`,
  );
}

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool } from "../src/db.js";
import { getAccountBalance } from "../src/accounts.js";
import {
  API_KEY,
  createAccountHttp,
  jsonRequest,
  resetDb,
  startTestApp,
  stopTestApp,
  transferHttp,
  type TestCtx,
} from "./helpers.js";

let ctx: TestCtx;

describe("API decisions and invariants", () => {
  beforeAll(async () => {
    ctx = await startTestApp();
  });
  afterAll(async () => {
    await stopTestApp(ctx);
  });
  beforeEach(async () => {
    await resetDb(ctx.pool);
  });

  it("requires X-API-Key", async () => {
    const res = await fetch(`${ctx.baseUrl}/accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initial_balance: "1.00", currency: "USD" }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });

  it("rejects unknown accounts on transfer", async () => {
    const to = await createAccountHttp(ctx, "0.00");
    const res = await transferHttp(ctx, {
      from: "00000000-0000-4000-8000-000000000001",
      to: to.id,
      amount: "1.00",
      key: "unknown-from",
    });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: { code: "ACCOUNT_NOT_FOUND" } });
  });

  it("rejects overdrafts", async () => {
    const from = await createAccountHttp(ctx, "10.00");
    const to = await createAccountHttp(ctx, "0.00");
    const res = await transferHttp(ctx, {
      from: from.id,
      to: to.id,
      amount: "10.01",
      key: "overdraft",
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: { code: "INSUFFICIENT_FUNDS" } });
    const bal = await jsonRequest(ctx, `/accounts/${from.id}/balance`);
    expect(bal.body).toMatchObject({ balance: "10.00" });
  });

  it("rejects cross-currency transfers", async () => {
    const from = await createAccountHttp(ctx, "10.00");
    const to = await createAccountHttp(ctx, "0.00");
    const res = await transferHttp(ctx, {
      from: from.id,
      to: to.id,
      amount: "1.00",
      currency: "EUR",
      key: "fx",
    });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: { code: "UNSUPPORTED_CURRENCY" } });
  });

  it("rejects a JSON number amount", async () => {
    const from = await createAccountHttp(ctx, "10.00");
    const to = await createAccountHttp(ctx, "0.00");
    const res = await jsonRequest(ctx, "/transfers", {
      method: "POST",
      headers: { "Idempotency-Key": "float" },
      body: JSON.stringify({
        from_account_id: from.id,
        to_account_id: to.id,
        amount: 1.1,
        currency: "USD",
      }),
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  });

  it("survives a new process (new pool) reading the same rows", async () => {
    const created = await createAccountHttp(ctx, "33.44");
    const databaseUrl =
      process.env.DATABASE_URL ?? "postgres://transfer:transfer@localhost:15432/transfer";
    const fresh = createPool(databaseUrl);
    try {
      const account = await getAccountBalance(fresh, created.id);
      expect(account.balance).toBe("33.44");
    } finally {
      await fresh.end();
    }
  });

  it("requires Idempotency-Key", async () => {
    const from = await createAccountHttp(ctx, "10.00");
    const to = await createAccountHttp(ctx, "0.00");
    const res = await jsonRequest(ctx, "/transfers", {
      method: "POST",
      headers: { "x-api-key": API_KEY, "content-type": "application/json" },
      body: JSON.stringify({
        from_account_id: from.id,
        to_account_id: to.id,
        amount: "1.00",
        currency: "USD",
      }),
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REQUIRED" } });
  });
});

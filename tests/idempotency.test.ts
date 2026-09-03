import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sumBalancesCents } from "../src/accounts.js";
import {
  OTHER_API_KEY,
  balanceHttp,
  createAccountHttp,
  jsonRequest,
  resetDb,
  startTestApp,
  stopTestApp,
  transferHttp,
  type TestCtx,
} from "./helpers.js";

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await startTestApp();
});
afterAll(async () => {
  await stopTestApp(ctx);
});
beforeEach(async () => {
  await resetDb(ctx.pool);
});

describe("POST /transfers idempotency (real HTTP + Postgres)", () => {

  it("returns the original transfer for the same Idempotency-Key and does not move money twice", async () => {
    const from = await createAccountHttp(ctx, "100.00");
    const to = await createAccountHttp(ctx, "0.00");
    const totalBefore = await sumBalancesCents(ctx.pool);

    const first = await transferHttp(ctx, {
      from: from.id,
      to: to.id,
      amount: "25.00",
      key: "pay-invoice-1",
    });
    expect(first.status).toBe(201);
    const created = first.body as { id: string; status: string; amount: string };
    expect(created.status).toBe("completed");
    expect(created.amount).toBe("25.00");

    const second = await transferHttp(ctx, {
      from: from.id,
      to: to.id,
      amount: "25.00",
      key: "pay-invoice-1",
    });
    expect(second.status).toBe(200);
    const replayed = second.body as { id: string; amount: string };
    expect(replayed.id).toBe(created.id);
    expect(replayed.amount).toBe("25.00");

    expect(await balanceHttp(ctx, from.id)).toBe("75.00");
    expect(await balanceHttp(ctx, to.id)).toBe("25.00");
    expect(await sumBalancesCents(ctx.pool)).toBe(totalBefore);

    const count = await ctx.pool.query("SELECT COUNT(*)::int AS n FROM transfers");
    expect(count.rows[0].n).toBe(1);
  });

  it("does not create a second transfer when the retry arrives during the first request", async () => {
    const from = await createAccountHttp(ctx, "50.00");
    const to = await createAccountHttp(ctx, "0.00");
    const totalBefore = await sumBalancesCents(ctx.pool);

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        transferHttp(ctx, {
          from: from.id,
          to: to.id,
          amount: "10.00",
          key: "same-key-storm",
        }),
      ),
    );

    const bodies = results.map((r) => r.body as { id: string });
    const ids = new Set(bodies.map((b) => b.id));
    expect(ids.size).toBe(1);
    expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);

    expect(await balanceHttp(ctx, from.id)).toBe("40.00");
    expect(await balanceHttp(ctx, to.id)).toBe("10.00");
    expect(await sumBalancesCents(ctx.pool)).toBe(totalBefore);

    const count = await ctx.pool.query("SELECT COUNT(*)::int AS n FROM transfers");
    expect(count.rows[0].n).toBe(1);
  });

  it("rejects reuse of an Idempotency-Key with a different body", async () => {
    const from = await createAccountHttp(ctx, "100.00");
    const to = await createAccountHttp(ctx, "0.00");
    const other = await createAccountHttp(ctx, "0.00");

    const first = await transferHttp(ctx, {
      from: from.id,
      to: to.id,
      amount: "10.00",
      key: "reuse-me",
    });
    expect(first.status).toBe(201);

    const second = await transferHttp(ctx, {
      from: from.id,
      to: other.id,
      amount: "10.00",
      key: "reuse-me",
    });
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({
      error: { code: "IDEMPOTENCY_KEY_REUSED" },
    });
    expect(await balanceHttp(ctx, from.id)).toBe("90.00");
  });

  it("scopes idempotency keys to the caller", async () => {
    const from = await createAccountHttp(ctx, "100.00");
    const to = await createAccountHttp(ctx, "0.00");

    const a = await transferHttp(ctx, {
      from: from.id,
      to: to.id,
      amount: "10.00",
      key: "shared-key",
      apiKey: OTHER_API_KEY,
    });
    const b = await transferHttp(ctx, {
      from: from.id,
      to: to.id,
      amount: "10.00",
      key: "shared-key",
    });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect((a.body as { id: string }).id).not.toBe((b.body as { id: string }).id);
    expect(await balanceHttp(ctx, from.id)).toBe("80.00");
  });
});

describe("GET /transfers/:id", () => {
  it("returns a created transfer and 404s for unknown ids", async () => {
    const from = await createAccountHttp(ctx, "20.00");
    const to = await createAccountHttp(ctx, "0.00");
    const created = await transferHttp(ctx, {
      from: from.id,
      to: to.id,
      amount: "5.00",
      key: "lookup",
    });
    const id = (created.body as { id: string }).id;

    const got = await jsonRequest(ctx, `/transfers/${id}`);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ id, amount: "5.00", status: "completed" });

    const missing = await jsonRequest(
      ctx,
      "/transfers/00000000-0000-4000-8000-000000000000",
    );
    expect(missing.status).toBe(404);
  });
});

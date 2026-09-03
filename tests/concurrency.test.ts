import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sumBalancesCents } from "../src/accounts.js";
import {
  balanceHttp,
  createAccountHttp,
  resetDb,
  startTestApp,
  stopTestApp,
  transferHttp,
  type TestCtx,
} from "./helpers.js";

let ctx: TestCtx;

describe("concurrency safety (real concurrent HTTP + Postgres row locks)", () => {
  beforeAll(async () => {
    ctx = await startTestApp();
  });
  afterAll(async () => {
    await stopTestApp(ctx);
  });
  beforeEach(async () => {
    await resetDb(ctx.pool);
  });

  it("two concurrent transfers debiting the same account do not corrupt balances", async () => {
    const from = await createAccountHttp(ctx, "100.00");
    const toA = await createAccountHttp(ctx, "0.00");
    const toB = await createAccountHttp(ctx, "0.00");
    const totalBefore = await sumBalancesCents(ctx.pool);

    const [a, b] = await Promise.all([
      transferHttp(ctx, {
        from: from.id,
        to: toA.id,
        amount: "40.00",
        key: "concurrent-a",
      }),
      transferHttp(ctx, {
        from: from.id,
        to: toB.id,
        amount: "40.00",
        key: "concurrent-b",
      }),
    ]);

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(await balanceHttp(ctx, from.id)).toBe("20.00");
    expect(await balanceHttp(ctx, toA.id)).toBe("40.00");
    expect(await balanceHttp(ctx, toB.id)).toBe("40.00");
    expect(await sumBalancesCents(ctx.pool)).toBe(totalBefore);
  });

  it("concurrent over-draw attempts conserve money: only one 60 from 100 succeeds", async () => {
    const from = await createAccountHttp(ctx, "100.00");
    const toA = await createAccountHttp(ctx, "0.00");
    const toB = await createAccountHttp(ctx, "0.00");
    const totalBefore = await sumBalancesCents(ctx.pool);

    const results = await Promise.all([
      transferHttp(ctx, {
        from: from.id,
        to: toA.id,
        amount: "60.00",
        key: "overdraw-a",
      }),
      transferHttp(ctx, {
        from: from.id,
        to: toB.id,
        amount: "60.00",
        key: "overdraw-b",
      }),
    ]);

    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409]);
    const failed = results.find((r) => r.status === 409);
    expect(failed?.body).toMatchObject({ error: { code: "INSUFFICIENT_FUNDS" } });

    const fromBal = await balanceHttp(ctx, from.id);
    const aBal = await balanceHttp(ctx, toA.id);
    const bBal = await balanceHttp(ctx, toB.id);
    expect(fromBal).toBe("40.00");
    expect([aBal, bBal].sort()).toEqual(["0.00", "60.00"]);
    expect(await sumBalancesCents(ctx.pool)).toBe(totalBefore);
  });

  it("opposite-direction concurrent transfers do not deadlock and conserve money", async () => {
    const a = await createAccountHttp(ctx, "80.00");
    const b = await createAccountHttp(ctx, "20.00");
    const totalBefore = await sumBalancesCents(ctx.pool);

    const results = await Promise.all([
      transferHttp(ctx, {
        from: a.id,
        to: b.id,
        amount: "30.00",
        key: "a-to-b",
      }),
      transferHttp(ctx, {
        from: b.id,
        to: a.id,
        amount: "10.00",
        key: "b-to-a",
      }),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([201, 201]);
    expect(await balanceHttp(ctx, a.id)).toBe("60.00");
    expect(await balanceHttp(ctx, b.id)).toBe("40.00");
    expect(await sumBalancesCents(ctx.pool)).toBe(totalBefore);
  });

  it("many concurrent transfers against one hot account keep the conservation invariant", async () => {
    const payroll = await createAccountHttp(ctx, "1000.00");
    const workers = await Promise.all(
      Array.from({ length: 20 }, () => createAccountHttp(ctx, "0.00")),
    );
    const totalBefore = await sumBalancesCents(ctx.pool);

    const results = await Promise.all(
      workers.map((w, i) =>
        transferHttp(ctx, {
          from: payroll.id,
          to: w.id,
          amount: "25.00",
          key: `payroll-${i}`,
        }),
      ),
    );

    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(await balanceHttp(ctx, payroll.id)).toBe("500.00");
    for (const w of workers) {
      expect(await balanceHttp(ctx, w.id)).toBe("25.00");
    }
    expect(await sumBalancesCents(ctx.pool)).toBe(totalBefore);

    const count = await ctx.pool.query("SELECT COUNT(*)::int AS n FROM transfers");
    expect(count.rows[0].n).toBe(20);
  });
});

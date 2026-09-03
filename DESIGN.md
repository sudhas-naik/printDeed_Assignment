# Design

## 3.1 Scale

At 500 transfers/second the global write rate is modest. What breaks first is **row-lock contention on the hot 1% of accounts**. Forty percent of 500 tps is 200 serialized updates per second against a handful of rows (payroll disburser, escrow). Every transfer to or from that account takes `FOR UPDATE` on that row, so those 200 tps become a single-file queue. p99 latency on the hotspot climbs first; lock wait, then pool checkout, then client timeouts. Long-tail accounts are fine: millions of cold rows do not contend with each other.

WAL volume and index churn on `transfers` are the next bottleneck, not CPU. A unique index on `(api_key_id, idempotency_key)` is cheap at this rate.

What I would change:

- Stop treating a hot account as one mutable balance row. Split the payroll funding account into many sub-accounts (or a queue of workers that are the only writers to that account — a single-writer actor per hot id).
- Longer term, append debit/credit lines and materialize balances. `GET /accounts/:id/balance` can read a cache with a generation, while the conservation invariant lives in the ledger, not in an in-place `UPDATE`.
- Put hot account ids on dedicated primaries if you shard; hash-sharding by account id otherwise spreads the long tail and *concentrates* the hotspot, which is what you want only if that shard is sized for it.
- 500 tps does not need a rewrite by itself. The change is driven by the 40% skew, not the headline rate.

## 3.2 Debugging

The customer saw one HTTP request. The database has two transfer rows, different ids, the same `Idempotency-Key`, same `from_account_id`, same amount, 40ms apart. That interval is a race window, not a user double-click.

Order I would check:

1. **Unique constraint.** `\d transfers` / `\d idempotency_keys`. If `(api_key_id, idempotency_key)` is not unique, this is the bug. Two rows with the same key should have been impossible.
2. **Caller scope.** Are the two rows the same `api_key_id`? If the unique key is only `idempotency_key` globally, skip this; if it is per caller, two keys (or a missing caller column, like the PR in 3.3) explain it.
3. **Application path.** Read the insert code that was deployed at that timestamp. A `SELECT` existing key *then* insert, outside one transaction, produces exactly two rows ~tens of milliseconds apart under overlapping retries.
4. **Access logs, not the client.** Search both app instances and the load balancer for that key and those 40ms. A single browser call can still become two POSTs (LB retry on a slow first response, a proxy timeout, a client SDK retry the user does not count). Confirm request ids and `upstream_status`.
5. **Key bytes.** Length, whitespace, encoding. `pay-1` vs `pay-1\n` would *not* match this report (the keys are equal). Still dump `length()` and `convert_to(key, 'UTF8')` so you are not arguing about display.
6. **Request hash.** If we store a hash of the body, check both rows see the same from/to/amount. Same key + same amount does not prove same `to_account_id`.
7. **Connection pooling / `BEGIN` on the pool.** If `BEGIN` and the following statements used different connections, both “transactions” can commit. That also shows up as two rows and no rollback.
8. **Once you know which of 1–7 it is, freeze it.** Add the unique constraint if missing (after de-duping), deploy the reservation-row insert, and credit one of the two transfers back so conservation holds. Do not “fix” by deleting a row until you have a compensating transfer; operators will need the audit trail.

The client being sure they sent one request does not contradict (4). The 40ms gap is a strong smell for (3) or (4), not for a second user action.

## 3.3 PR review

Reviewing `src/transfers.ts` as submitted. Line numbers refer to that snippet, starting at the `export async function` as line 1.

```
 1  export async function createTransfer(
 2    db: DbClient,
 3    input: { fromId: string; toId: string; amount: string; idempotencyKey: string }
 4  ): Promise<Transfer> {
 5    const existing = await db.query(
 6      "SELECT * FROM transfers WHERE idempotency_key = $1",
 7      [input.idempotencyKey]
 8    );
 9    if (existing.rows.length > 0) {
10      return existing.rows[0];
11    }
12    const from = await db.query("SELECT balance FROM accounts WHERE id = $1", [input.fromId]);
13    const to = await db.query("SELECT balance FROM accounts WHERE id = $1", [input.toId]);
14    const amount = parseFloat(input.amount);
15    if (from.rows[0].balance < amount) {
16      throw new Error("Insufficient funds");
17    }
18    await db.query("BEGIN");
19    await db.query(
20      "UPDATE accounts SET balance = balance - $1 WHERE id = $2",
21      [amount, input.fromId]
22    );
23    await db.query(
24      "UPDATE accounts SET balance = balance + $1 WHERE id = $2",
25      [amount, input.toId]
26    );
27    const inserted = await db.query(
28      "INSERT INTO transfers (from_id, to_id, amount, idempotency_key) VALUES ($1, $2, $3, $4) RETURNING *",
29      [input.fromId, input.toId, amount, input.idempotencyKey]
30    );
31    await db.query("COMMIT");
32    return inserted.rows[0];
33  }
```

**Block merge.** I would not approve this as-is. None of the hard requirements hold.

Comments I would leave:

- **Lines 5–11 — idempotency race (block).** The read is outside a transaction and is not backed by a unique constraint in this PR. Two retries 40ms apart both see `rows.length === 0` and both insert. Even with a unique index, this code has no handling for the conflict, so one caller gets a raw driver error instead of the original transfer. The key is also not scoped to a caller.
- **Lines 18–31 — `BEGIN` on what is probably a pool (block).** If `db` is a pool, `BEGIN`, the `UPDATE`s, the `INSERT`, and `COMMIT` can run on different connections. You get abandoned open transactions and committed half-updates. This must be a single checked-out client. There is also no `ROLLBACK` on error, so a failure after line 18 poisons the connection.
- **Lines 12–17, 19–25 — lost updates (block).** Balances are read before `BEGIN`, and the `UPDATE`s do not use `SELECT ... FOR UPDATE` or `WHERE balance >= $amount`. Two concurrent transfers both read 100, both subtract 80, both commit: money disappeared. This is the conservation bug.
- **Line 14 — `parseFloat` (block).** Money cannot go through IEEE-754. `parseFloat("0.10")` and `0.1 + 0.2` are the textbook problem. Store integer minor units or a decimal type; keep the HTTP amount as a string.
- **Lines 12–15 — missing rows and types.** `from.rows[0]` throws if the account is missing. `to` is loaded and never used. No same-account check. No currency check.
- **Lines 15–16 — error shape.** `throw new Error("Insufficient funds")` becomes a 500. This should be a 409 with the structured `{ error: { code, message } }` body.
- **Line 18 vs 12 — transaction started too late.** Even on a dedicated client, the reads that decide overdraft must happen *inside* the transaction, after the row locks.

What I would approve once the above is fixed: the overall function shape (one entry point that returns a `Transfer`), using `RETURNING *`, and taking the idempotency key as an explicit argument rather than hiding it in middleware. There is nothing in this diff I would merge on its own.

I would ask the author to add two tests before re-review: same key, concurrent POSTs, one transfer row; two concurrent transfers off the same account, `SUM(balance)` unchanged. Those tests would have failed this PR.

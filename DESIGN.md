# Design

## 3.1 Scale

At 500 transfers/second, the overall write rate is manageable. The first issue I would expect is **row-lock contention on the hot 1% of accounts**. Forty percent of 500 TPS is approximately 200 transfers/second concentrated on a small number of accounts such as a payroll funding account or marketplace escrow account. Since transfers touching the same account require row-level locking, those operations become serialized. I would expect p99 latency and lock-wait time on those accounts to increase first, followed by connection-pool pressure and eventually client timeouts.

The long-tail accounts should continue to scale well because they have relatively little contention. After lock contention, I would monitor WAL volume, index growth, database I/O, and connection-pool utilization.

### What I would change

* **Short term:** Identify hot accounts and monitor lock wait time, transaction latency, and queue depth. If necessary, isolate workloads involving extremely hot accounts so they cannot exhaust the general connection pool.

* **Medium term:** For accounts with sustained high write contention, move toward a **single-writer/partitioned model**. For example, a hot payroll account could be split into multiple funding sub-accounts, or transfers could be processed through a queue with a dedicated writer for that account.

* **Long term:** Move from an in-place mutable balance model toward an **append-only double-entry ledger**. Each transfer would create corresponding debit and credit entries, while account balances could be materialized or cached from the ledger. This makes the conservation invariant easier to audit and recover.

* **Sharding:** If the database eventually needs to be sharded, account ID can be used as the partitioning key. This spreads the long-tail workload effectively, but hot accounts remain concentrated on a shard, so those accounts would need separate capacity or a different write strategy.

I would not rewrite the architecture solely because the service reached 500 TPS. The important factor is the **40% workload concentration on 1% of accounts**, rather than the aggregate transfer rate itself.

---

## 3.2 Debugging

The database contains two transfer rows with different IDs, the same idempotency key, the same source account, the same amount, and timestamps only 40 milliseconds apart. I would treat this primarily as an **idempotency/concurrency failure** until proven otherwise.

I would investigate in this order:

1. **Check the database constraint.**
   Verify that there is a unique constraint or unique index on `(api_key_id, idempotency_key)`. If it is missing, concurrent requests can both pass an initial existence check and create separate transfers.

2. **Verify caller scope.**
   Confirm that both rows belong to the same caller/API key. Idempotency should normally be scoped to the caller, so the uniqueness rule should be based on both the caller identity and idempotency key.

3. **Inspect the deployed application code.**
   Check the exact version deployed at the time of the incident. A pattern such as `SELECT` for an existing key followed by `INSERT`, without a database uniqueness constraint and atomic transaction, can produce exactly this race.

4. **Check server and load-balancer logs.**
   Search all application instances and the load balancer for the idempotency key, request ID, timestamp, and source IP. A client may display one request even if a proxy, SDK, load balancer, or retry mechanism caused a second request.

5. **Compare request payloads.**
   Confirm that both requests had the same `from_account_id`, `to_account_id`, amount, and currency. If request hashes are stored, compare those as well. The same idempotency key should also be associated with the same request parameters.

6. **Inspect transaction and connection-pool behavior.**
   Verify that `BEGIN`, all database operations, and `COMMIT` were executed on the same database connection. A transaction accidentally spread across pooled connections can cause unexpected commits or incomplete transactional behavior.

7. **Check database transaction history and timing.**
   Correlate the two inserts with database logs and transaction IDs to determine whether the requests actually overlapped. The 40ms difference is consistent with concurrent retries, but I would verify this from the server/database evidence rather than assume it.

8. **Correct the data without destroying the audit trail.**
   After determining which transfer is valid, I would use a compensating transaction to reverse any duplicate movement rather than simply deleting a transfer row. Then I would add or repair the unique constraint and deploy an atomic idempotency implementation.

The key lesson is that **the database must enforce idempotency**. Application-level existence checks are useful for fast-path reads but cannot be the correctness mechanism under concurrency.

---

## 3.3 PR Review

I would **block this PR from merging** because it violates several hard requirements: idempotency, concurrency safety, money precision, and transaction correctness.

Line numbers below refer to the supplied snippet, with the first line of `createTransfer` treated as line 1.

### Lines 5–11 — Idempotency race — BLOCKER

```text
5  const existing = await db.query(
6    "SELECT * FROM transfers WHERE idempotency_key = $1",
7    [input.idempotencyKey]
8  );
9  if (existing.rows.length > 0) {
10   return existing.rows[0];
11 }
```

This is a classic check-then-act race. Two concurrent requests can both execute the `SELECT`, see no existing row, and then both insert a transfer.

Idempotency must be enforced by a **database unique constraint**, ideally on `(api_key_id, idempotency_key)`, with the reservation/insert performed atomically inside the transaction. If a duplicate key is encountered, the implementation should return the original transfer rather than expose a raw database error.

The key is also not scoped to a caller.

### Lines 12–15 and 19–25 — Concurrency/lost-update bug — BLOCKER

```text
12 const from = await db.query(...);
13 const to = await db.query(...);
14 const amount = parseFloat(input.amount);
15 if (from.rows[0].balance < amount) {
```

The balance is read before the transaction begins, and there is no row locking or equivalent concurrency control.

For example, two concurrent transfers could both read a balance of 100 and both determine that an 80-unit transfer is valid. Both then update the account. The resulting state can violate the intended balance and overdraft rules.

The balance reads and updates must occur inside one transaction with an explicit concurrency strategy such as:

```sql
SELECT balance
FROM accounts
WHERE id = $1
FOR UPDATE;
```

Both accounts should be locked deterministically to avoid deadlocks when two transfers involve the same pair of accounts in opposite directions.

### Line 14 — Floating-point money — BLOCKER

```text
14 const amount = parseFloat(input.amount);
```

Money must not be represented using JavaScript floating-point numbers. `parseFloat()` introduces IEEE-754 floating-point semantics and can produce precision errors.

The API should accept the amount as a decimal string and convert it to **integer minor units** such as cents, or use a database decimal/numeric representation consistently.

This requirement applies throughout the money path, including validation, calculations, persistence, and comparisons.

### Line 18 — Transaction handling — BLOCKER

```text
18 await db.query("BEGIN");
```

If `db` represents a connection pool rather than a dedicated checked-out client, there is no guarantee that `BEGIN`, the subsequent statements, and `COMMIT` execute on the same connection.

The implementation should explicitly acquire one database client, run the complete transaction on that client, and release it afterward.

It also needs a `ROLLBACK` path for every failure after `BEGIN`. Without that, an error can leave the connection in an open transaction state and potentially poison the connection pool.

### Lines 12–13 — Account validation

```text
12 const from = await db.query(...);
13 const to = await db.query(...);
```

There is no handling for unknown accounts. `from.rows[0]` can be undefined, resulting in an unexpected application error.

The implementation should explicitly validate both accounts and return a structured 404-style error when an account does not exist.

The `to` query is also not actually used to validate or lock the destination account.

### Lines 15–16 — Incorrect error semantics

```text
15 if (from.rows[0].balance < amount) {
16   throw new Error("Insufficient funds");
```

An insufficient-funds condition should not become an unhandled 500 response. It should produce a documented client error, for example:

```json
{
  "error": {
    "code": "INSUFFICIENT_FUNDS",
    "message": "Insufficient funds"
  }
}
```

The API should consistently document its HTTP status and error format.

### Lines 12–25 — Transaction starts too late

The balance reads and insufficient-funds decision occur before `BEGIN`.

Even if the transaction is correctly implemented later, these reads are outside the atomic operation. The balance check needs to happen inside the same transaction that locks and updates the accounts.

### Line 28 — Missing database-level idempotency guarantee

```text
28 "INSERT INTO transfers (... idempotency_key) VALUES (...) RETURNING *",
```

The database schema must enforce the idempotency invariant. I would expect a unique constraint such as:

```sql
UNIQUE (api_key_id, idempotency_key)
```

The application should then handle the uniqueness conflict deterministically.

### What I would approve

The general function structure is reasonable: the function accepts the transfer input, performs the operation, and returns the created `Transfer`. Using `RETURNING *` is also appropriate for returning the persisted transfer.

However, those positives do not outweigh the correctness issues above.

### Tests required before re-review

I would ask for at least these integration tests:

1. **Concurrent idempotent requests:** send multiple real concurrent `POST /transfers` requests with the same caller and idempotency key. They must all return the same transfer ID and only one transfer row/movement may be created.

2. **Concurrent balance updates:** send two real concurrent transfers against the same source account and verify that the resulting balances are correct and that an insufficient-funds condition cannot be bypassed.

3. **Conservation invariant:** verify that the total balance before and after a successful transfer is unchanged.

I would **block the merge** until the transaction, idempotency, money representation, and concurrency issues are fixed and covered by integration tests.

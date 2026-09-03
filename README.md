# Money Transfer API

HTTP API for moving USD between accounts. TypeScript, Node.js, PostgreSQL.

## Run

Postgres 16 and Node 20+ are required.

```bash
npm install
docker compose up -d --wait
cp .env.example .env
npm start
```

The default compose mapping is `localhost:15432` so it does not collide with a local Postgres on 5432 or 5433.

```bash
# create two accounts
FROM=$(curl -s -X POST http://localhost:3000/accounts \
  -H "X-API-Key: dev-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"currency":"USD","initial_balance":"100.00"}' | jq -r .id)

TO=$(curl -s -X POST http://localhost:3000/accounts \
  -H "X-API-Key: dev-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"currency":"USD","initial_balance":"0.00"}' | jq -r .id)

# transfer (retry this curl; the second call returns the same transfer)
curl -s -X POST http://localhost:3000/transfers \
  -H "X-API-Key: dev-secret-key" \
  -H "Idempotency-Key: pay-invoice-1" \
  -H "Content-Type: application/json" \
  -d "{\"from_account_id\":\"$FROM\",\"to_account_id\":\"$TO\",\"amount\":\"25.00\",\"currency\":\"USD\"}"

curl -s http://localhost:3000/accounts/$FROM/balance \
  -H "X-API-Key: dev-secret-key"
```

`make run` and `make test` wrap the same docker + env setup.

## Tests

Integration tests open a real HTTP server and a real Postgres database. They fire concurrent `fetch` calls. Nothing is mocked.

```bash
docker compose up -d --wait
DATABASE_URL=postgres://transfer:transfer@localhost:15432/transfer \
  API_KEYS=dev-secret-key \
  npm test
```

Or `make test`.

The required proofs:

- `tests/idempotency.test.ts` — same `Idempotency-Key` returns the same transfer id and does not move money twice, including a 20-way concurrent retry storm.
- `tests/concurrency.test.ts` — two concurrent HTTP transfers against the same account; balances stay consistent and the sum of all balances is unchanged.

## API

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/accounts` | Create an account. Body: `{ "currency": "USD", "initial_balance": "100.00" }` |
| `GET` | `/accounts/:id/balance` | Current balance |
| `POST` | `/transfers` | Header `Idempotency-Key` required. First success: `201`. Replay: `200` with the original body. |
| `GET` | `/transfers/:id` | Transfer owned by this API key |
| `GET` | `/health` | Liveness, no auth |

All amounts are **decimal strings** (`"10.50"`), never JSON numbers.

### Auth

`X-API-Key` on every request except `/health`. Keys are a comma-separated list in `API_KEYS`. The default key is `dev-secret-key`. Callers are distinguished by SHA-256 of the key; idempotency is per caller.

### Errors

```json
{ "error": { "code": "INSUFFICIENT_FUNDS", "message": "from_account does not have sufficient funds" } }
```

| HTTP | Code |
| --- | --- |
| 400 | `VALIDATION_ERROR`, `IDEMPOTENCY_KEY_REQUIRED` |
| 401 | `UNAUTHORIZED` |
| 404 | `ACCOUNT_NOT_FOUND`, `TRANSFER_NOT_FOUND` |
| 409 | `INSUFFICIENT_FUNDS`, `IDEMPOTENCY_KEY_REUSED`, `CONFLICT` |
| 422 | `UNSUPPORTED_CURRENCY` |
| 500 | `INTERNAL_ERROR` |

## Decisions (the ambiguous items)

**Accounts.** Explicit `POST /accounts`. Nothing is created on first reference. A transfer that names an unknown account returns `404 ACCOUNT_NOT_FOUND`. Implicit account creation would make typos invent balances and would break conservation unless those accounts started at zero and you still had a deposit story.

**Overdraft.** Rejected (`409 INSUFFICIENT_FUNDS`). A `CHECK (balance_cents >= 0)` constraint is the backstop. Allowing overdraft is a product choice that should be a credit-limit field, not an accident of a race.

**Currency.** USD only. Cross-currency transfers return `422`. FX is a different service: you'd need a rate source, a spread, and a way to keep both currency books conserved.

**Money.** Integer cents (`BIGINT`) end to end. `parseFloat` / `number` are rejected at the boundary. See `src/money.ts`.

**Idempotency.** Unique `(api_key_id, idempotency_key)` on `idempotency_keys`. The row is inserted in the same transaction as the ledger writes. A concurrent retry with that key blocks on `SELECT ... FOR UPDATE` of the reservation row, then returns the committed transfer. Same key + different body → `409 IDEMPOTENCY_KEY_REUSED`. Failed requests roll back the reservation, so a later retry after a deposit is allowed.

**Concurrency.** `SELECT ... FOR UPDATE` on both accounts, locked in sorted UUID order so `A→B` and `B→A` cannot deadlock. Read Committed plus row locks, not SERIALIZABLE: the hotspot is a small number of accounts, and row locks serialize exactly those rows without aborting unrelated work. Unique constraints make idempotency safe under that isolation level.

**Conservation.** Transfers only move cents between existing rows. The only way money enters the system is `POST /accounts` with `initial_balance`. Tests assert `SUM(balance_cents)` is unchanged across concurrent transfers.

**Persistence.** PostgreSQL. Process restart does not lose accounts or transfers.

## What I cut for time

- No ledger/event table (accounts + transfers is the book). A double-entry ledger would make forensics easier.
- No Docker image for the API process itself (compose only runs Postgres).
- No pagination, webhooks, or multi-currency.
- Auth is a static API key list, not a customer/tenant table.
- Failed transfers are not recorded; the idempotency row is rolled back.

## What I'd do next

- Append-only ledger lines plus a materialized balance, so a hot payroll account is not a single updated row.
- Store the original HTTP status and body on `idempotency_keys` (Stripe-style) including failures you want to freeze.
- Structured request ids and an audit log keyed by `Idempotency-Key`.
- Connection-pool and lock-wait metrics; a timeout that returns `409 CONFLICT` instead of hanging on a stuck locker.
- Schema for multiple keys per tenant and key rotation.

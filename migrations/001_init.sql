-- Balances are integer minor units (cents). The CHECK is a last line of
-- defense; the service also rejects overdrafts before writing.
CREATE TABLE accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  currency CHAR(3) NOT NULL CHECK (currency = 'USD'),
  balance_cents BIGINT NOT NULL CHECK (balance_cents >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_account_id UUID NOT NULL REFERENCES accounts (id),
  to_account_id UUID NOT NULL REFERENCES accounts (id),
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  currency CHAR(3) NOT NULL CHECK (currency = 'USD'),
  status TEXT NOT NULL CHECK (status = 'completed'),
  api_key_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (api_key_id, idempotency_key)
);

CREATE INDEX transfers_from_account_id_idx ON transfers (from_account_id);
CREATE INDEX transfers_to_account_id_idx ON transfers (to_account_id);

-- One row per (caller, key). Inserted first so a concurrent retry with the
-- same key blocks on FOR UPDATE instead of creating a second transfer.
CREATE TABLE idempotency_keys (
  api_key_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  transfer_id UUID REFERENCES transfers (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (api_key_id, idempotency_key)
);

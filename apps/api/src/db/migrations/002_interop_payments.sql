-- Milestone 2: integration gateway, payments to CBS (ISO 20022),
-- double-entry ledger, bank reconciliation, MoAD registry and payroll.

-- Every message in or out of ZenithCore, for the monitoring console.
CREATE TABLE integration_messages (
  id              BIGSERIAL PRIMARY KEY,
  direction       TEXT NOT NULL CHECK (direction IN ('IN','OUT')),
  partner         TEXT NOT NULL,
  msg_type        TEXT NOT NULL,
  correlation_id  TEXT NOT NULL,
  idempotency_key TEXT,
  request_hash    TEXT,
  status          TEXT NOT NULL,
  http_status     INT,
  attempts        INT NOT NULL DEFAULT 0,
  last_error      TEXT,
  request         TEXT,
  response        TEXT,
  business_ref    TEXT,
  duration_ms     INT,
  next_attempt_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX integ_corr_idx ON integration_messages (correlation_id);
CREATE INDEX integ_status_idx ON integration_messages (status);
CREATE UNIQUE INDEX integ_idem_idx ON integration_messages (partner, msg_type, idempotency_key) WHERE direction = 'IN' AND idempotency_key IS NOT NULL;

-- API clients (partner systems) authenticated by key; only the hash is stored.
CREATE TABLE api_clients (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  key_hash        TEXT NOT NULL,
  scopes          TEXT[] NOT NULL,
  rate_per_minute INT NOT NULL DEFAULT 120,
  active          BOOLEAN NOT NULL DEFAULT TRUE
);

-- Payment order lifecycle with CBS.
ALTER TABLE payment_orders ADD COLUMN end_to_end_id TEXT;
ALTER TABLE payment_orders ADD COLUMN cbs_status TEXT;
ALTER TABLE payment_orders ADD COLUMN cbs_reason TEXT;
ALTER TABLE payment_orders ADD COLUMN sent_at TIMESTAMPTZ;
ALTER TABLE payment_orders ADD COLUMN settled_at TIMESTAMPTZ;
ALTER TABLE payment_orders ADD COLUMN returned_at TIMESTAMPTZ;
ALTER TABLE payment_orders ADD COLUMN replaces_id INT REFERENCES payment_orders(id);
CREATE UNIQUE INDEX po_e2e_idx ON payment_orders (end_to_end_id) WHERE end_to_end_id IS NOT NULL;

-- Double-entry ledger (cash basis for this milestone).
CREATE TABLE ledger_entries (
  id              BIGSERIAL PRIMARY KEY,
  journal         TEXT NOT NULL,
  posted_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  account         TEXT NOT NULL,
  budget_line_id  TEXT REFERENCES budget_lines(id),
  debit           NUMERIC(20,2) NOT NULL DEFAULT 0,
  credit          NUMERIC(20,2) NOT NULL DEFAULT 0,
  source          TEXT NOT NULL,
  source_ref      TEXT NOT NULL,
  memo            TEXT
);
CREATE INDEX ledger_source_idx ON ledger_entries (source, source_ref);

-- Government bank accounts in the TSA structure.
CREATE TABLE bank_accounts (
  id              TEXT PRIMARY KEY,
  name_en         TEXT NOT NULL,
  name_ar         TEXT NOT NULL,
  name_fr         TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('TSA_MAIN','TSA_SUB','COLLECTION')),
  central_government BOOLEAN NOT NULL DEFAULT TRUE,
  active          BOOLEAN NOT NULL DEFAULT TRUE
);

-- Statement lines received from CBS (camt.053) and reconciliation results.
CREATE TABLE bank_statement_lines (
  id              BIGSERIAL PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES bank_accounts(id),
  statement_id    TEXT NOT NULL,
  booking_date    DATE NOT NULL,
  amount          NUMERIC(20,2) NOT NULL,
  direction       TEXT NOT NULL CHECK (direction IN ('DBIT','CRDT')),
  end_to_end_id   TEXT,
  remittance      TEXT,
  matched_po_id   INT REFERENCES payment_orders(id),
  match_status    TEXT NOT NULL DEFAULT 'UNMATCHED' CHECK (match_status IN ('UNMATCHED','MATCHED','EXPLAINED')),
  note            TEXT,
  imported_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX stmt_line_uq ON bank_statement_lines (statement_id, COALESCE(end_to_end_id, ''), amount, direction, COALESCE(remittance, ''));

CREATE TABLE reconciliations (
  id              SERIAL PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES bank_accounts(id),
  period          TEXT NOT NULL,                 -- e.g. 2026-Q3
  period_end      DATE NOT NULL,
  completed_at    TIMESTAMPTZ,
  matched         INT NOT NULL DEFAULT 0,
  unmatched       INT NOT NULL DEFAULT 0,
  completed_by    TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, period)
);

-- MoAD personnel registry (received through the API) and the payroll master.
CREATE TABLE moad_registry (
  national_id     TEXT PRIMARY KEY,
  full_name_ar    TEXT NOT NULL,
  full_name_en    TEXT,
  position_id     TEXT NOT NULL,
  ministry_id     TEXT NOT NULL REFERENCES orgs(id),
  grade           TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('ACTIVE','SUSPENDED','RETIRED','DECEASED')),
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  correlation_id  TEXT
);

CREATE TABLE payroll_employees (
  employee_no     TEXT PRIMARY KEY,
  national_id     TEXT NOT NULL,
  full_name_ar    TEXT NOT NULL,
  ministry_id     TEXT NOT NULL REFERENCES orgs(id),
  position_id     TEXT,
  monthly_net     NUMERIC(20,2) NOT NULL,
  paid_via_module BOOLEAN NOT NULL DEFAULT TRUE,
  biometric_enrolled BOOLEAN NOT NULL DEFAULT FALSE,
  active          BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX payroll_nid_idx ON payroll_employees (national_id);

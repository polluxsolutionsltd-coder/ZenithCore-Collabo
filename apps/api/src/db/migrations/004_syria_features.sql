-- Milestone 4: Syria-specific features.
-- Values seeded for these features are SAMPLES until confirmed by a Syrian legal / PFM adviser.

-- New role: Ministry of Finance budget directorate (approves virements above ministry authority)
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN
  ('SPENDING_UNIT','MINISTRY_APPROVER','FIN_CONTROLLER','REGIONAL_TREASURY','TREASURY_HQ','ADMIN','AUDITOR',
   'REVENUE_OFFICER','HELPDESK','HR_OFFICER','BUDGET_DIRECTOR'));

-- 1. Multi-currency: lines, requests and payment orders carry their currency (SYP unless donor-funded)
ALTER TABLE budget_lines ADD COLUMN currency TEXT NOT NULL DEFAULT 'SYP';
ALTER TABLE budget_lines ADD COLUMN original_allotment NUMERIC(20,2);
UPDATE budget_lines SET original_allotment = allotment;
ALTER TABLE payment_orders ADD COLUMN currency TEXT NOT NULL DEFAULT 'SYP';
ALTER TABLE payment_orders ADD COLUMN fx_rate NUMERIC(20,6);
ALTER TABLE bank_accounts ADD COLUMN currency TEXT NOT NULL DEFAULT 'SYP';
ALTER TABLE bank_accounts DROP CONSTRAINT bank_accounts_kind_check;
ALTER TABLE bank_accounts ADD CONSTRAINT bank_accounts_kind_check CHECK (kind IN ('TSA_MAIN','TSA_SUB','COLLECTION','DONOR'));
-- the ledger is kept in Syrian pounds; a foreign-currency posting keeps its original amount beside it
ALTER TABLE ledger_entries ADD COLUMN fc_currency TEXT;
ALTER TABLE ledger_entries ADD COLUMN fc_amount NUMERIC(20,2);

-- 2. Virements (Decree 54/2006): transfers between budget lines with approval by level
CREATE SEQUENCE virement_ref_seq START 1;
CREATE TABLE virements (
  id              SERIAL PRIMARY KEY,
  ref             TEXT UNIQUE NOT NULL,
  from_line       TEXT NOT NULL REFERENCES budget_lines(id),
  to_line         TEXT NOT NULL REFERENCES budget_lines(id),
  amount          NUMERIC(20,2) NOT NULL CHECK (amount > 0),
  reason          TEXT NOT NULL,
  level           TEXT NOT NULL CHECK (level IN ('MINISTRY','MOF')),
  level_reason    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED','APPROVED','REJECTED')),
  requested_by    INT NOT NULL REFERENCES users(id),
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by      INT REFERENCES users(id),
  decided_at      TIMESTAMPTZ,
  decision_reason TEXT,
  signature       TEXT,
  signed_payload  TEXT,
  CHECK (from_line <> to_line)
);

-- 3. Income tax on payroll: gross, tax and net per employee and run
ALTER TABLE payroll_employees ADD COLUMN monthly_gross NUMERIC(20,2);
UPDATE payroll_employees SET monthly_gross = monthly_net;
ALTER TABLE payroll_run_lines ADD COLUMN gross NUMERIC(20,2);
ALTER TABLE payroll_run_lines ADD COLUMN tax NUMERIC(20,2);
ALTER TABLE payroll_runs ADD COLUMN total_gross NUMERIC(20,2);
ALTER TABLE payroll_runs ADD COLUMN total_tax NUMERIC(20,2);
ALTER TABLE payroll_runs ADD COLUMN tax_rule JSONB;

-- 4. Central / governorate revenue sharing on receipts
ALTER TABLE receipts ADD COLUMN governorate TEXT;
ALTER TABLE receipts ADD COLUMN central_amount NUMERIC(20,2);
ALTER TABLE receipts ADD COLUMN governorate_amount NUMERIC(20,2);

-- 5. Electronic signature (Law 3/2014): one signing key per user; signatures on approvals
CREATE TABLE user_keys (
  user_id         INT PRIMARY KEY REFERENCES users(id),
  algorithm       TEXT NOT NULL DEFAULT 'Ed25519',
  public_key      TEXT NOT NULL,
  private_key_enc TEXT NOT NULL,          -- encrypted with SIGNING_SECRET (an HSM or smart card in production)
  fingerprint     TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE approvals ADD COLUMN signature TEXT;
ALTER TABLE approvals ADD COLUMN signed_at TIMESTAMPTZ;
ALTER TABLE approvals ADD COLUMN key_fingerprint TEXT;

-- 6. Currency redenomination (Decree 293/2025) needs no table: legacy data in old pounds is
--    converted when it is loaded (modules/loaders), and the control totals go to the audit trail.

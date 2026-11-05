-- Milestone 3: configurable workflow and delegation (D4), user administration,
-- official receipts, Citizen's Budget Helpdesk, payroll runs and biometric
-- enrolment, offline capture (D5), login protection.

ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN
  ('SPENDING_UNIT','MINISTRY_APPROVER','FIN_CONTROLLER','REGIONAL_TREASURY','TREASURY_HQ','ADMIN','AUDITOR','REVENUE_OFFICER','HELPDESK','HR_OFFICER'));
ALTER TABLE users ADD COLUMN failed_logins INT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN locked_until TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- The route a request follows is fixed when it is submitted (WORKFLOW_ROUTE rule),
-- so a configuration change never disturbs requests already in progress.
ALTER TABLE documents ADD COLUMN route TEXT[];
-- Client reference for requests captured offline: replaying a sync never creates a duplicate.
ALTER TABLE documents ADD COLUMN client_ref TEXT;
CREATE UNIQUE INDEX documents_client_ref_idx ON documents (created_by, client_ref) WHERE client_ref IS NOT NULL;

ALTER TABLE approvals ADD COLUMN on_behalf_of INT REFERENCES users(id);

-- Delegation of approval authority for a period (leave, mission).
CREATE TABLE delegations (
  id              SERIAL PRIMARY KEY,
  from_user_id    INT NOT NULL REFERENCES users(id),
  to_user_id      INT NOT NULL REFERENCES users(id),
  starts_on       DATE NOT NULL,
  ends_on         DATE NOT NULL,
  reason          TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at      TIMESTAMPTZ,
  CHECK (ends_on >= starts_on),
  CHECK (from_user_id <> to_user_id)
);

-- Official receipts for government revenue.
CREATE SEQUENCE receipt_ref_seq START 1000;
CREATE TABLE revenue_codes (
  code            TEXT PRIMARY KEY,
  name_en         TEXT NOT NULL,
  name_ar         TEXT NOT NULL,
  name_fr         TEXT NOT NULL,
  account_id      TEXT NOT NULL REFERENCES bank_accounts(id)
);
CREATE TABLE receipts (
  id              SERIAL PRIMARY KEY,
  ref             TEXT UNIQUE NOT NULL,
  revenue_code    TEXT NOT NULL REFERENCES revenue_codes(code),
  payer_name      TEXT NOT NULL,
  payer_id        TEXT,
  amount          NUMERIC(20,2) NOT NULL CHECK (amount > 0),
  method          TEXT NOT NULL CHECK (method IN ('CASH','BANK_TRANSFER','CHEQUE')),
  office_id       TEXT NOT NULL REFERENCES orgs(id),
  account_id      TEXT NOT NULL REFERENCES bank_accounts(id),
  verify_code     TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'ISSUED' CHECK (status IN ('ISSUED','CANCELLED')),
  cancel_reason   TEXT,
  issued_by       INT NOT NULL REFERENCES users(id),
  issued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at    TIMESTAMPTZ,
  client_ref      TEXT
);
CREATE UNIQUE INDEX receipts_client_ref_idx ON receipts (issued_by, client_ref) WHERE client_ref IS NOT NULL;

-- Citizen's Budget Helpdesk.
CREATE SEQUENCE ticket_ref_seq START 100;
CREATE TABLE helpdesk_tickets (
  id              SERIAL PRIMARY KEY,
  ref             TEXT UNIQUE NOT NULL,
  access_code     TEXT NOT NULL,
  category        TEXT NOT NULL CHECK (category IN ('BUDGET','PAYMENT','REVENUE','PORTAL','OTHER')),
  lang            TEXT NOT NULL CHECK (lang IN ('ar','en','fr')),
  question        TEXT NOT NULL,
  contact         TEXT,
  status          TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ANSWERED','CLOSED')),
  answer          TEXT,
  answered_by     INT REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  answered_at     TIMESTAMPTZ,
  due_at          TIMESTAMPTZ NOT NULL
);

-- Payroll runs (lean): one run per ministry and month, paid only to staff
-- whose MoAD record is active (the payroll control behind indicators 4 and 5).
CREATE TABLE payroll_runs (
  id              SERIAL PRIMARY KEY,
  period          TEXT NOT NULL,                  -- YYYY-MM
  ministry_id     TEXT NOT NULL REFERENCES orgs(id),
  status          TEXT NOT NULL CHECK (status IN ('CALCULATED','APPROVED')),
  employees       INT NOT NULL,
  excluded        INT NOT NULL,
  total_net       NUMERIC(20,2) NOT NULL,
  created_by      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by     TEXT,
  approved_at     TIMESTAMPTZ,
  UNIQUE (period, ministry_id)
);
CREATE TABLE payroll_run_lines (
  run_id          INT NOT NULL REFERENCES payroll_runs(id),
  employee_no     TEXT NOT NULL REFERENCES payroll_employees(employee_no),
  net             NUMERIC(20,2) NOT NULL,
  included        BOOLEAN NOT NULL,
  exclusion       TEXT,
  PRIMARY KEY (run_id, employee_no)
);
ALTER TABLE payroll_employees ADD COLUMN biometric_ref TEXT;
ALTER TABLE payroll_employees ADD COLUMN biometric_at TIMESTAMPTZ;

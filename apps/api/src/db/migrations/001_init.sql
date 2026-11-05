-- ZenithCore FMIS 4.0 – core schema (organisations, users, budget, rules,
-- payment requests and their workflow, payment orders, notifications, audit)

CREATE TABLE orgs (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('MINISTRY','SPENDING_UNIT','REGIONAL_TREASURY','TREASURY_HQ','CONTROLLER','MOF','AUDIT','EXTERNAL')),
  parent_id     TEXT REFERENCES orgs(id),
  governorate   TEXT,
  name_en       TEXT NOT NULL,
  name_ar       TEXT NOT NULL,
  name_fr       TEXT NOT NULL
);

CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name_en  TEXT NOT NULL,
  full_name_ar  TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('SPENDING_UNIT','MINISTRY_APPROVER','FIN_CONTROLLER','REGIONAL_TREASURY','TREASURY_HQ','ADMIN','AUDITOR')),
  org_id        TEXT NOT NULL REFERENCES orgs(id),
  lang          TEXT NOT NULL DEFAULT 'ar' CHECK (lang IN ('ar','en','fr')),
  active        BOOLEAN NOT NULL DEFAULT TRUE
);

-- Budget lines carry the BC-CoA segments. `allotment` is the amount released
-- (warrant) to the spending unit for the year, in new Syrian pounds.
CREATE TABLE budget_lines (
  id              TEXT PRIMARY KEY,
  year            INT  NOT NULL,
  ministry_id     TEXT NOT NULL REFERENCES orgs(id),
  spending_unit_id TEXT NOT NULL REFERENCES orgs(id),
  fund            TEXT NOT NULL,
  economic        TEXT NOT NULL,
  functional      TEXT NOT NULL,
  programme       TEXT NOT NULL,
  name_en         TEXT NOT NULL,
  name_ar         TEXT NOT NULL,
  name_fr         TEXT NOT NULL,
  allotment       NUMERIC(20,2) NOT NULL CHECK (allotment >= 0)
);

-- Effective-dated business rules (thresholds, limits, workflow options).
-- The most specific scope wins; NULL scope = applies everywhere.
CREATE TABLE rules (
  id              SERIAL PRIMARY KEY,
  key             TEXT NOT NULL,
  scope           TEXT,
  value           JSONB NOT NULL,
  effective_from  DATE NOT NULL,
  effective_to    DATE,
  note            TEXT,
  created_by      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX rules_key_idx ON rules (key, scope, effective_from);

CREATE TABLE documents (
  id              SERIAL PRIMARY KEY,
  ref             TEXT UNIQUE NOT NULL,
  doc_type        TEXT NOT NULL DEFAULT 'PAYMENT_REQUEST',
  spending_unit_id TEXT NOT NULL REFERENCES orgs(id),
  ministry_id     TEXT NOT NULL REFERENCES orgs(id),
  rto_id          TEXT NOT NULL REFERENCES orgs(id),
  budget_line_id  TEXT NOT NULL REFERENCES budget_lines(id),
  supplier_name   TEXT NOT NULL,
  supplier_iban   TEXT NOT NULL,
  description     TEXT NOT NULL,
  amount          NUMERIC(20,2) NOT NULL CHECK (amount > 0),
  currency        TEXT NOT NULL DEFAULT 'SYP',
  status          TEXT NOT NULL,
  visa_required   BOOLEAN NOT NULL DEFAULT FALSE,
  created_by      INT NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  version         INT NOT NULL DEFAULT 1
);
CREATE INDEX documents_status_idx ON documents (status);
CREATE INDEX documents_line_idx ON documents (budget_line_id);

CREATE TABLE approvals (
  id              SERIAL PRIMARY KEY,
  document_id     INT NOT NULL REFERENCES documents(id),
  step            TEXT NOT NULL,
  decision        TEXT NOT NULL,
  actor_id        INT NOT NULL REFERENCES users(id),
  reason          TEXT,
  checks          JSONB,
  amount          NUMERIC(20,2),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX approvals_doc_idx ON approvals (document_id);

CREATE TABLE payment_orders (
  id              SERIAL PRIMARY KEY,
  ref             TEXT UNIQUE NOT NULL,
  document_id     INT REFERENCES documents(id),
  amount          NUMERIC(20,2) NOT NULL,
  debit_account   TEXT NOT NULL,
  via_tsa         BOOLEAN NOT NULL,
  beneficiary_name TEXT NOT NULL,
  beneficiary_iban TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'ISSUED',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at         TIMESTAMPTZ
);

CREATE TABLE notifications (
  id              SERIAL PRIMARY KEY,
  recipient_user_id INT REFERENCES users(id),
  recipient_role  TEXT,
  recipient_org_id TEXT REFERENCES orgs(id),
  key             TEXT NOT NULL,
  params          JSONB NOT NULL DEFAULT '{}',
  document_id     INT REFERENCES documents(id),
  channel         TEXT NOT NULL DEFAULT 'IN_APP',
  read_by         INT[] NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tamper-evident audit trail: each entry hashes the previous one.
CREATE TABLE audit_log (
  id              BIGSERIAL PRIMARY KEY,
  ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor           TEXT NOT NULL,
  action          TEXT NOT NULL,
  entity          TEXT NOT NULL,
  entity_id       TEXT NOT NULL,
  data            JSONB NOT NULL DEFAULT '{}',
  prev_hash       TEXT NOT NULL,
  hash            TEXT NOT NULL
);
CREATE INDEX audit_entity_idx ON audit_log (entity, entity_id);

-- Reference figures used by the results indicators (e.g. total budget
-- execution from the annual accounts, baselines before go-live).
CREATE TABLE reference_figures (
  key             TEXT NOT NULL,
  period          TEXT NOT NULL,
  value           NUMERIC(20,2) NOT NULL,
  source          TEXT NOT NULL,
  PRIMARY KEY (key, period)
);

CREATE SEQUENCE doc_ref_seq START 1000;
CREATE SEQUENCE po_ref_seq START 5000;

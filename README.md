# ZenithCore FMIS 4.0 – SIFMIS edition

ZenithCore IFMIS: the build for the ZenithCore IFMIS demonstration, by Millenium Instrumentation and Pollux.

ZenithCore FMIS is Millenium Instrumentation Ltd's configurable financial management platform. This repository is the 4.0 generation, built for the Syria Integrated Financial Management Information System (SIFMIS) demonstration and implementation.

| | |
|---|---|
| Languages | Arabic (default, right-to-left), English, French |
| Stack | TypeScript end to end: Node.js 22 API, React 19 web app, PostgreSQL 16 |
| Status | **Milestones 1–3 done:** all five demonstration scenarios (D1–D5), official receipts, payroll, the Transparency Portal and Citizen's Budget Helpdesk, and all eight results indicators computed live |

## Run it

Requirements: Node.js 22+, PostgreSQL 16.

```bash
npm install
createdb zenithcore                          # or use docker compose (below)
export DATABASE_URL=postgresql://user:pass@localhost:5432/zenithcore
npm run db:seed                               # schema + demonstration data (resets the database)
npm run build:web
npm run start:cbs &                           # CBS payment sandbox on http://localhost:8090/sandbox
DEMO_MODE=1 CBS_URL=http://localhost:8090 npm start   # http://localhost:8080
```

Or with Docker: `docker compose up --build -d --wait`, then `docker compose exec api npm run db:seed`. Compose starts the database, the API and the CBS sandbox, each with a health check and `restart: unless-stopped`; the API runs as the non-root `node` user and waits for the database before starting. Backups go to the `backups` volume: `docker compose exec api scripts/backup.sh`.

All demonstration accounts use the password `Demo@2027` (set `SEED_PASSWORD` to change it). With `DEMO_MODE=1` the sign-in page lists them. **Never enable DEMO_MODE in production.**

| Username | Role | Organisation |
|---|---|---|
| `su.health` | Spending unit accountant | Damascus Health Directorate |
| `min.health` | Ministry approver | Ministry of Health |
| `fc.health` | Financial Controller | Financial Controller – Ministry of Health |
| `rto.damascus` | Regional Treasury Office | Damascus Regional Treasury Office |
| `treasury.hq` | Treasury HQ | MoF Treasury HQ |
| `admin` | System administrator | Ministry of Finance |
| `auditor.cofc` | Auditor (read-only) | Central Organisation for Financial Control |
| `su.education`, `min.education`, `fc.education`, `rto.aleppo` | Same roles for the Ministry of Education in Aleppo | |
| `cashier.damascus` | Revenue officer (official receipts) | Damascus Regional Treasury Office |
| `hr.mof` | HR / payroll officer | Ministry of Finance |
| `helpdesk.mof` | Citizen's Budget Helpdesk officer | Ministry of Finance |

The public Transparency Portal needs no account: `http://localhost:8080/#/public`.

Sample supplier IBAN for new requests: `SY600010000000123456789012`.

## Tests

```bash
npm test                                   # API tests against TEST_DATABASE_URL (default: zenithcore_test)
npm run typecheck                          # TypeScript check of the API and the web app
DB_DRIVER=pg npm test                      # same tests on node-postgres (`pg`, installed as an optional dependency)
node scripts/e2e-d1.mjs http://localhost:8080 shots   # browser rehearsal of D1, with screenshots
node scripts/e2e-d2d3.mjs http://localhost:8080 http://localhost:8090 shots-d2d3   # D2 and D3 (fresh seed)
```

The API tests start their own CBS sandbox on a free port with short time-outs, so they need nothing else running.

```bash
node scripts/e2e-d4d5.mjs http://localhost:8080 shots-d4d5   # D4, D5, receipts, portal, helpdesk, payroll, offline (fresh seed)
DATABASE_URL=... scripts/backup.sh                            # backup with checksum (see docs/ha-dr-runbook.md)
scripts/restore.sh backups/<file>.dump postgresql://…/zenithcore_restore   # restore + integrity check
npm run load -- budget samples/budget_lines.csv              # data migration loader, dry run (add --commit to load)
```

The D4/D5 rehearsal also checks basic accessibility on every screen it visits (skip link first in the tab order, language and direction set, every form control named).

`npm run build:web` fails if any message is missing in Arabic, English or French, if an Arabic message is not in Arabic script, if a message's `{placeholders}` differ between languages, or if `styles.css` uses physical left/right instead of start/end (which would break the Arabic right-to-left layout).

`apps/api/test/guards.test.ts` protects fixes that must never regress: array parameters sent to PostgreSQL intact, the canonical JSON behind the audit hash chain (golden value), and chain verification under any server time zone.

**Continuous integration** (`.github/workflows/ci.yml`) runs on every push and pull request: type checks, the build checks above, all API tests on both database drivers, the three browser rehearsals with a backup and restore drill (screenshots kept as a build artifact), and the Docker stack.

## Scenario coverage (Selection Criteria, technical demonstration)

| Scenario | Weight | Status | Where |
|---|---|---|---|
| D1 End-to-end transaction, workflow, approval, amendment/rejection, notification, audit | 25% | **Done** | `modules/documents`, `test/d1.test.ts`, `scripts/e2e-d1.mjs` |
| D2 API exchange, validation, errors, retry, idempotency, correlation, monitoring | 20% | **Done** | `modules/integration`, `modules/moad`, `test/d2.test.ts`, *Integration* screen |
| D3 Payments to a CBS sandbox: initiation, response, receipt, reconciliation, timeout, duplicate, reversal | 20% | **Done** | `apps/cbs-sandbox`, `modules/payments`, `modules/reconciliation`, `test/d3.test.ts`, *Payments* and *Bank reconciliation* screens |
| D4 Configurable rules/workflows, roles, delegation, reporting, audit | 15% | **Done** | `modules/rules`, `documents` (configurable route), `delegation`, `users`, `reports`, `test/d4.test.ts`, *Rules*, *Delegations*, *Users*, *Reports*, *Audit trail* screens |
| D5 Security, accessibility, three languages, low connectivity, monitoring, backup/restore, resilience | 20% | **Done** | `lib/config.ts`, `modules/ops`, `apps/web/src/offline.ts`, `public/sw.js`, `scripts/backup.sh`, `scripts/restore.sh`, `test/d5.test.ts`, `docs/` |

All eight results indicators are computed live from transactions (`modules/indicators`); none are typed in:

| # | Indicator | Computed from |
|---|---|---|
| 1 | Executed budget paid through the TSA | payment orders + baseline reference figures |
| 2 | Executed budget processed through SIFMIS | payment orders vs. total execution |
| 3 | Timeliness of quarterly bank reconciliation | reconciliation records, last 4 quarters, `REC_DEADLINE_DAYS` |
| 4 | Staff paid through the payroll module | latest approved payroll run vs. all staff (incl. those still paid outside) |
| 5 | MoAD registry ↔ payroll reconciliation | payroll master matched to the MoAD registry |
| 6 | Transparency Portal and Citizen's Budget Helpdesk operational | portal publishing the current budget + share of questions answered within `HELPDESK_SLA_DAYS` |
| 7 | Staff biometrically registered | enrolment records (no biometric data is stored, only the enrolment event) |
| 8 | GHG emissions reduction | paperless transactions × `GHG_FACTORS` – an **estimate**; the factors must be agreed with the Ministry |

## D1 demonstration script

1. **Spending unit** (`su.health`, Arabic): New request → line `0203-01-2221` → supplier, IBAN, 1,200,000 SYP → Save draft → Submit. Funds are reserved. The visa is required because the amount is at or above the 500,000 SYP threshold.
2. **Ministry** (`min.health`): the inbox and the bell show the request → Approve.
3. **Financial Controller** (`fc.health`, French): Grant visa. Refusing needs a written reason and releases the funds.
4. **Regional Treasury Office** (`rto.damascus`): three second-level controls are shown live (budget, commitment/visa, monthly cash limit) → Approve.
5. **Treasury HQ** (`treasury.hq`): Authorise payment. Payment order `PO-…` is issued against `SY-CBS-TSA-0001`.
6. **Amendment:** the spending unit reduces an amount (approvals kept) or increases it (back to the ministry, funds re-checked).
7. **Audit:** every step is in the document's audit trail. `auditor.cofc` runs *Verify integrity* on the hash chain.
8. **Rules (D4 preview):** `admin` changes the visa threshold or a cash limit with an effective date. No code change is needed.

## D2 demonstration script (interoperability)

MoAD's HR system sends personnel records to `POST /api/v1/moad/personnel`:

```bash
curl -i http://localhost:8080/api/v1/moad/personnel \
  -H 'content-type: application/json' \
  -H 'x-api-key: zc-demo-moad-7f3a9c2e51b84d06' \
  -H 'idempotency-key: MOAD-2027-0001' \
  -H 'x-correlation-id: demo-moad-batch-1' \
  -d '{"records":[{"nationalId":"30000308841","fullNameAr":"نادين حموي","positionId":"POS-0203-039","ministryId":"MIN-0203","grade":"3A","status":"ACTIVE"},
                  {"nationalId":"123","fullNameAr":"Test","positionId":"","ministryId":"MIN-9999","grade":"Z","status":"UNKNOWN"}]}'
```

1. **Validation:** the answer is `207` with `accepted: 1, rejected: 1` and one error per field (`moad.national_id_format`, `moad.arabic_name_required`, …). Valid records are kept; nothing is dropped silently. An all-invalid batch gets `422`.
2. **Idempotency:** send the same request again. The stored answer is replayed with `Idempotent-Replay: true` and the original correlation ID; nothing is processed twice. The same key with a different body gets `409 integration.idempotency_conflict`.
3. **Security:** no key or a wrong key gets `401`. Each client has a per-minute rate limit (`429` with `retryAfterSeconds`). Only a SHA-256 hash of the key is stored. Set `MOAD_API_KEY` before seeding anywhere other than a demonstration.
4. **Monitoring** (`auditor.cofc` or `treasury.hq` → *Integration*): every message in and out, with correlation ID, attempts, duration, request and response. The dead-letter count is at the top; Treasury HQ can retry a dead-lettered payment from here.
5. **Indicator 5** rises as MoAD sends the missing employees. The exceptions (not in registry, retired, other ministry) are listed under the console.

## D3 demonstration script (payments and reconciliation)

Open the CBS sandbox (`http://localhost:8090/sandbox`) next to ZenithCore. It is a simulation for testing and demonstration only. It speaks ISO 20022 (pacs.008 in; pacs.002, pacs.004 and camt.053 out) and has a switch to inject a fault into the next transfer.

1. **Send** (`treasury.hq` → *Payments*): choose an issued order → *Send to CBS*. The order becomes *Settled*. The ledger shows Dr `EXP:2221` / Cr `BANK:SY-CBS-TSA-0001`, and the spending unit is notified.
2. **Rejection:** set the sandbox fault to *reject*, send another order. It comes back *Rejected* with `AC04` (account closed). *Reissue* with a written reason (and corrected IBAN if needed) creates a new order; the old one stays in the record. Send the new one.
3. **Timeout without double payment:** set *timeout*. The bank settles but answers too late. ZenithCore asks the bank for the payment's status before any resend, learns it was settled, and records one payment. The sandbox shows one transfer for that end-to-end ID.
4. **Bank down:** stop the sandbox and send. After three attempts with back-off the message goes to the dead-letter queue and the order shows *Not delivered*. Start the sandbox and press *Retry* in *Integration*: status is checked first, then the payment is sent once.
5. **Return and reversal:** set *return*, send, then *Check for returns*. The order becomes *Returned by the bank* (`AC03`) and the ledger posting is reversed. Running the check again changes nothing.
6. **Reconciliation** (*Bank reconciliation*): *Import today's statement (camt.053)*. Debits are matched to orders by end-to-end ID and amount; the return credit is matched to the returned order. A revenue credit stays unmatched until it is explained. *Complete reconciliation* is refused while anything is unmatched, then closes the quarter. **Indicator 3** moves.

## D4 demonstration script (configuration, roles, delegation, reporting)

1. **Approval route as configuration** (`admin`, *Rules* → *Approval route*): choose a ministry, tick the steps (ministry, Financial Controller visa, Regional Treasury, Treasury HQ – always last), set an effective date. Requests submitted from that date follow the new route; requests already in progress keep the route they started with.
2. **Thresholds and limits:** add a new version of `VISA_THRESHOLD`, `CASH_LIMIT_MONTHLY`, `REC_DEADLINE_DAYS`, `HELPDESK_SLA_DAYS` or `GHG_FACTORS` with an effective date. The history of every version stays visible.
3. **Users and roles** (*Users*): create a user with a role and organisation. They get a temporary password and must change it at first sign-in. Deactivating a user, or changing their role or organisation, ends their open sessions at once. Every change is audited.
4. **Delegation** (*Delegations*): `rto.damascus` delegates to `rto.aleppo` for a period, with a reason. `rto.aleppo` sees Damascus's requests in the inbox and approves them; the record shows "on behalf of". The delegation ends automatically at its end date or can be revoked. Segregation of duties holds through delegations too: nobody can act on a request they created or have already decided at another step.
5. **Reports** (*Reports*): budget execution by ministry and line (allotment, reserved, paid, available) and the payment register, filtered, in three languages and as CSV.
6. **Auditor workspace** (`auditor.cofc`, *Audit trail*): read-only. Search the audit trail by user, action, record and date; the exceptions list (rejections, refused visas, returned payments, dead letters, delegated approvals, rule changes); *Verify integrity* recomputes the hash chain.

## D5 demonstration script (security, accessibility, connectivity, resilience)

1. **Security:** five wrong passwords lock an account for 15 minutes (`LOGIN_MAX_FAILED`, `LOGIN_LOCK_MINUTES`); password policy and forced change of temporary passwords; security headers (CSP, frame denial, no-sniff, HSTS behind TLS). In production the API **refuses to start** with a weak `JWT_SECRET`, with `DEMO_MODE` on, or without its own `MOAD_API_KEY` and `RECEIPT_SECRET` (`lib/config.ts`). See `docs/security.md`.
2. **Three languages and accessibility:** switch Arabic ↔ English ↔ French on any screen; Arabic is right-to-left throughout. Keyboard only: *Tab* lands first on "Skip to content"; every control has a label; status messages are announced. See `docs/accessibility.md`.
3. **Low connectivity:** as `su.health`, switch the browser offline (DevTools → Network → Offline). The app still opens (service worker). Save a new request: it is queued on the device with its own idempotency key. Go back online: it is sent once, even if the connection drops mid-way.
4. **Monitoring:** `GET /api/health/deep` (database, migrations, audit chain, CBS link, dead letters) for the load balancer; `GET /api/metrics` (Prometheus format, protected by `METRICS_TOKEN`) for request counts, errors and latency.
5. **Backup and restore:** `scripts/backup.sh` writes a checksummed (optionally GPG-encrypted) archive; `scripts/restore.sh` checks the checksum, refuses to overwrite a non-empty database without `--force`, restores, then verifies record counts, that the ledger balances and that the audit chain is intact. A tampered backup is refused.
6. **Resilience:** stateless API (any instance serves any request), idempotent payments and partner messages, retries with dead-letter queue. The physical primary/DR-site design, RPO/RTO and the failover drill are in `docs/ha-dr-runbook.md`.

## Other services in this build

- **Official receipts** (`cashier.damascus`, *Receipts*): sequential receipt numbers per office, a verification code printed on the receipt, cancellation only with a reason (the number is never reused), revenue posting Dr collection account / Cr revenue code. Anyone can check a receipt on the public portal.
- **Payroll** (`hr.mof` → `treasury.hq`, *Payroll*): monthly run calculated only for employees who are active in the MoAD registry; the rest are held as exceptions. Treasury HQ approves (segregation of duties). Biometric enrolment is recorded per employee.
- **Transparency Portal and Citizen's Budget Helpdesk** (`#/public`, no sign-in): budget and payments by ministry and revenue collected, straight from transactions; citizens ask a question and get a reference number and an access code to follow it; `helpdesk.mof` answers within the SLA.
- **Data migration:** CSV loaders for budget lines and employees (`npm run load`), dry run first, all-or-nothing commit, per-line errors. See `docs/data-migration.md` and `samples/`.

## Documentation

| File | Contents |
|---|---|
| `docs/security.md` | Authentication, authorisation, secrets, headers, audit, hardening checklist |
| `docs/accessibility.md` | What is covered (keyboard, labels, RTL, contrast) and how it is checked |
| `docs/ha-dr-runbook.md` | Physical primary and DR sites, RPO/RTO, backup, failover and failback steps |
| `docs/data-migration.md` | Loaders, validation, reconciliation of migrated balances |

## Design notes

- **Configuration over code.** Thresholds and limits are rows in `rules` with effective dates and scopes (`modules/rules`). Workflow steps are a declarative table in `documents.service.ts`.
- **Audit.** `audit_log` is append-only and hash-chained (SHA-256 over the previous hash and the canonical entry). `/api/audit/verify` recomputes the chain.
- **Security.** scrypt password hashes, HS256 tokens (`JWT_SECRET` must be set in production), role and organisation scoping on every query, and optimistic locking (`version`) against double approval.
- **PostgreSQL client.** `apps/api/src/lib/pg` is a small wire-protocol client with the same interface as `node-postgres`. It was used because the build environment had no package-registry access. To switch, replace `import { Pool } from "../lib/pg/pool.js"` with `import pg from "pg"` in `db/index.ts`. Application code does not change.
- **API framework.** The API uses Node's built-in HTTP server with a small router (`lib/http.ts`), with controllers in `routes.ts` and services per module. Moving to NestJS or Fastify is mechanical.
- **No double payment.** A payment order keeps one end-to-end ID for life. After a time-out or connection error the client always queries the bank for that ID before sending again, and never resends while the status is unknown (`modules/payments/cbs.client.ts`). The network call runs outside database transactions; the order is claimed first (`SENDING`) so two operators cannot send it at once.
- **Ledger.** Cash-basis double entry in `ledger_entries` for this milestone. Returns are reversed by mirror entries, never by deleting rows.
- **Money.** Amounts are `NUMERIC(20,2)` in new Syrian pounds. They are converted to JavaScript numbers only for display and comparison (safe below 9×10¹⁵).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgresql://zc:zc@localhost:5432/zenithcore` | Database |
| `DB_DRIVER` | `builtin` | `builtin` (no dependencies) or `pg` (node-postgres); both pass the same tests |
| `DB_POOL_MAX` | 10 | Database connections per API instance |
| `DB_START_ATTEMPTS` | 30 | Start-up waits up to this many × 2 s for the database; during an outage requests get `503` with `Retry-After` and recover automatically |
| `PORT` | `8080` | HTTP port |
| `JWT_SECRET` | dev value | **Set in every non-development environment** |
| `JWT_TTL_SECONDS` | 28800 | Session length |
| `DEMO_MODE` | off | Lists demonstration accounts on the sign-in page |
| `LOG_REQUESTS` | off | Logs each request with its correlation ID |
| `CBS_URL` | `http://localhost:8090` | Central Bank (sandbox) ISO 20022 endpoint |
| `CBS_PUBLIC_URL` | `CBS_URL` | Address of the sandbox control page for the browser (demo mode) |
| `CBS_TIMEOUT_MS` | 5000 | Time-out per call to CBS |
| `CBS_MAX_ATTEMPTS` | 3 | Attempts before dead-lettering |
| `CBS_BACKOFF_MS` | 1000 | First back-off; doubles each attempt |
| `SANDBOX_PORT` | 8090 | Port of the CBS sandbox |
| `SANDBOX_TIMEOUT_DELAY_MS` | 8000 | How late the sandbox answers when the *timeout* fault is set |
| `MOAD_API_KEY` | demo value | MoAD client key, hashed at seed time. **Set outside demonstrations** |
| `RECEIPT_SECRET` | demo value | Key for receipt verification codes. **Required in production** |
| `NODE_ENV` | – | `production` turns on the start-up safety checks |
| `LOGIN_MAX_FAILED` / `LOGIN_LOCK_MINUTES` | 5 / 15 | Account lock-out |
| `METRICS_TOKEN` | – | Bearer token required for `/api/metrics` |
| `PUBLIC_SUBMISSIONS_PER_HOUR` | 10 | Helpdesk questions per IP address per hour |
| `TRUST_PROXY` | off | Read the client IP from `X-Forwarded-For` (only behind your own load balancer) |
| `HSTS` | off | Send `Strict-Transport-Security` (only when served over TLS) |

© Millenium Instrumentation Ltd. All data in the seed is sample data for demonstration.

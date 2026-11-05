# ZenithCore FMIS 4.0 – SIFMIS edition

ZenithCore IFMIS: the build for the ZenithCore IFMIS demonstration, by Millenium Instrumentation and Pollux.

ZenithCore FMIS is Millenium Instrumentation Ltd's configurable financial management platform. This repository is the 4.0 generation, built for the Syria Integrated Financial Management Information System (SIFMIS) demonstration and implementation.

| | |
|---|---|
| Languages | Arabic (default, right-to-left), English, French |
| Stack | TypeScript end to end: Node.js 22 API, React 19 web app, PostgreSQL 16 |
| Status | **Milestone 1 done:** platform and scenario D1 (end-to-end transaction). Milestones 2–3 in progress |

## Run it

Requirements: Node.js 22+, PostgreSQL 16.

```bash
npm install
createdb zenithcore                          # or use docker compose (below)
export DATABASE_URL=postgresql://user:pass@localhost:5432/zenithcore
npm run db:seed                               # schema + demonstration data (resets the database)
npm run build:web
DEMO_MODE=1 npm start                         # http://localhost:8080
```

Or with Docker: `docker compose up --build`, then `docker compose exec api npm run db:seed`.

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

Sample supplier IBAN for new requests: `SY600010000000123456789012`.

## Tests

```bash
npm test                                   # API tests against TEST_DATABASE_URL (default: zenithcore_test)
npm run typecheck                          # TypeScript check of the API
node scripts/e2e-d1.mjs http://localhost:8080 shots   # browser rehearsal of D1, with screenshots
```

`npm run build:web` fails if any message is missing in Arabic, English or French.

## Scenario coverage (Selection Criteria, technical demonstration)

| Scenario | Weight | Status | Where |
|---|---|---|---|
| D1 End-to-end transaction, workflow, approval, amendment/rejection, notification, audit | 25% | **Done** | `modules/documents`, `test/d1.test.ts`, `scripts/e2e-d1.mjs` |
| D2 API exchange, validation, errors, retry, idempotency, correlation, monitoring | 20% | Milestone 2 | correlation IDs already on every request (`x-correlation-id`) |
| D3 Payments to a CBS sandbox: initiation, response, receipt, reconciliation, timeout, duplicate, reversal | 20% | Milestone 2 | payment orders are issued against the TSA account |
| D4 Configurable rules/workflows, roles, delegation, reporting, audit | 15% | Partly done | effective-dated rules with admin screen (`modules/rules`) |
| D5 Security, accessibility, three languages, low connectivity, monitoring, backup/restore, resilience | 20% | Partly done | three languages + RTL, offline banner, hashed passwords, tamper-evident audit |

Results indicators 1 and 2 are computed live from payment orders and reference figures (`modules/indicators`). Indicators 3–8 follow in milestones 2–3.

## D1 demonstration script

1. **Spending unit** (`su.health`, Arabic): New request → line `0203-01-2221` → supplier, IBAN, 1,200,000 SYP → Save draft → Submit. Funds are reserved. The visa is required because the amount is at or above the 500,000 SYP threshold.
2. **Ministry** (`min.health`): the inbox and the bell show the request → Approve.
3. **Financial Controller** (`fc.health`, French): Grant visa. Refusing needs a written reason and releases the funds.
4. **Regional Treasury Office** (`rto.damascus`): three second-level controls are shown live (budget, commitment/visa, monthly cash limit) → Approve.
5. **Treasury HQ** (`treasury.hq`): Authorise payment. Payment order `PO-…` is issued against `SY-CBS-TSA-0001`.
6. **Amendment:** the spending unit reduces an amount (approvals kept) or increases it (back to the ministry, funds re-checked).
7. **Audit:** every step is in the document's audit trail. `auditor.cofc` runs *Verify integrity* on the hash chain.
8. **Rules (D4 preview):** `admin` changes the visa threshold or a cash limit with an effective date. No code change is needed.

## Design notes

- **Configuration over code.** Thresholds and limits are rows in `rules` with effective dates and scopes (`modules/rules`). Workflow steps are a declarative table in `documents.service.ts`.
- **Audit.** `audit_log` is append-only and hash-chained (SHA-256 over the previous hash and the canonical entry). `/api/audit/verify` recomputes the chain.
- **Security.** scrypt password hashes, HS256 tokens (`JWT_SECRET` must be set in production), role and organisation scoping on every query, and optimistic locking (`version`) against double approval.
- **PostgreSQL client.** `apps/api/src/lib/pg` is a small wire-protocol client with the same interface as `node-postgres`. It was used because the build environment had no package-registry access. To switch, replace `import { Pool } from "../lib/pg/pool.js"` with `import pg from "pg"` in `db/index.ts`. Application code does not change.
- **API framework.** The API uses Node's built-in HTTP server with a small router (`lib/http.ts`), with controllers in `routes.ts` and services per module. Moving to NestJS or Fastify is mechanical.
- **Money.** Amounts are `NUMERIC(20,2)` in new Syrian pounds. They are converted to JavaScript numbers only for display and comparison (safe below 9×10¹⁵).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgresql://zc:zc@localhost:5432/zenithcore` | Database |
| `PORT` | `8080` | HTTP port |
| `JWT_SECRET` | dev value | **Set in every non-development environment** |
| `JWT_TTL_SECONDS` | 28800 | Session length |
| `DEMO_MODE` | off | Lists demonstration accounts on the sign-in page |
| `LOG_REQUESTS` | off | Logs each request with its correlation ID |

© Millenium Instrumentation Ltd. All data in the seed is sample data for demonstration.

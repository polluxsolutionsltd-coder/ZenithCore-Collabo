# ZenithCore FMIS – Security controls

## In the product (this repository)

| Area | Control | Where |
|---|---|---|
| Authentication | scrypt password hashes; signed tokens (HS256) with expiry; passwords ≥ 10 characters with letters and digits, not containing the username | `lib/security.ts`, `modules/users` |
| | Lock-out after 5 failed sign-ins for 15 minutes (`LOGIN_MAX_FAILED`, `LOGIN_LOCK_MINUTES`); every attempt audited | `modules/users` |
| | New and reset accounts get a one-time temporary password that must be changed at first sign-in | `modules/users`, web *Change password* |
| | A deactivated account, or a changed role or organisation, ends existing sessions at the next request | `server.ts` |
| Authorisation | Role and organisation checked on every request and every query (row-level scoping by ministry, controller, governorate) | `budget.service.ts` `scopeFilter` |
| | Segregation of duties: one person decides at most one step of a request, also under delegation; payroll prepared and approved by different people | `documents.service.ts`, `payroll.service.ts` |
| | Delegation is time-boxed, reasoned, revocable and recorded on every decision | `modules/delegation` |
| Integrity | Hash-chained, append-only audit trail with an integrity check | `modules/audit` |
| | Optimistic locking against double approval; database locks around budget reservation | `documents.service.ts` |
| | Payments: one end-to-end ID per order, status query before any resend | `modules/payments` |
| Partner APIs | API keys stored as SHA-256 hashes; scopes; per-client rate limit; idempotency keys | `modules/integration` |
| Public portal | No personal data published; receipt check needs the receipt's code (HMAC); access codes for helpdesk questions; rate limits and a honeypot against automated submissions | `modules/helpdesk`, `modules/receipts` |
| Web | Content-Security-Policy, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy`; HSTS with `HSTS=1` | `server.ts` |
| | CSV exports neutralise spreadsheet formulas | `reports.service.ts` |
| Configuration | The API **refuses to start in production** with `DEMO_MODE=1`, a missing or short `JWT_SECRET`, or missing `MOAD_API_KEY` / `RECEIPT_SECRET` | `lib/config.ts` |
| Monitoring | `/api/metrics` needs `METRICS_TOKEN` in production | `routes.ts` |

## Production checklist

- [ ] `NODE_ENV=production`; `DEMO_MODE` unset
- [ ] `JWT_SECRET` (≥ 32 random characters), `RECEIPT_SECRET`, `MOAD_API_KEY`, `METRICS_TOKEN` from the secrets store; rotated at least yearly
- [ ] Seed only reference data; no demonstration users or passwords
- [ ] TLS terminated at the load balancer, `HSTS=1`, `TRUST_PROXY=1`
- [ ] Database reachable only from the application network; least-privilege database user
- [ ] Backups encrypted (`BACKUP_GPG_RECIPIENT`) and copied to the DR site
- [ ] Independent penetration test before go-live, and after each major release
- [ ] Mutual TLS or a VPN on the CBS link, as CBS requires

## Not yet in the product

Single sign-on and two-factor authentication, field-level encryption of personal data at rest, and a security information and event management (SIEM) feed are planned for the implementation phase.

# ZenithCore FMIS 4.0 – Demonstration Script

Copy of the shared Claude Doc (6 Nov 2026). The doc is the working version; update this file when the doc changes.

## How to use this script

The demonstration runs scenarios D1 to D5 in the Client's weighting order, with six short **Syria spotlight** slots placed where each feature fits naturally. The timings assume a 90-minute slot; if the Client allocates less, trim the spotlights to their one-line version (Section 4) before cutting any scored step.

**Presenters.** One lead narrator (Millenium) and one driver at the keyboard. A second laptop stays logged in as the auditor and holds the CBS sandbox control page, so faults can be injected without switching windows.

**Setup, the evening before**

1. Fresh database: `npx tsx apps/api/src/db/migrate.ts --reset` then `npm run db:seed` (demo password Demo@2027).
2. Start the CBS sandbox (`npm run start:cbs`, port 8090) and the API with `DEMO_MODE=1`.
3. Run all four rehearsals in order, re-seeding between them: e2e-d1, e2e-d2d3, e2e-d4d5, e2e-syria. All must pass.
4. Re-seed once more so the live run starts clean. Keep the rehearsal screenshots on a USB stick as the fallback deck.
5. Browser at 125% zoom, language set to Arabic, notifications muted, one tab per role (bookmarks in the order of this script).

**Rules of honesty (World Bank procurement).** Say these out loud at the start and do not drift from them.

- The Central Bank of Syria link is a **sandbox we built** to the ISO 20022 standard. It is not connected to the CBS.
- The MoAD registry, staff and suppliers are **sample data**.
- Rule values for income tax, revenue shares, virement limits and the USD rate are **samples** awaiting confirmation by a Syrian adviser. The Rules screen labels them so.
- Signing keys are held by the server in the demo. Production uses smart cards or an HSM with certificates from the accredited Syrian authority.
- The redenomination facts come from public reporting of Decree 293/2025; the system treats them as a configurable rule.

**Users used in this script** (all with the demo password)

| User | Role | Language shown |
| --- | --- | --- |
| su.health | Spending unit accountant, Damascus Health Directorate | Arabic |
| min.health | Ministry of Health approver | English / Arabic |
| fc.health | Financial Controller | French |
| rto.damascus | Damascus Regional Treasury Office | Arabic |
| treasury.hq | MoF Treasury HQ | English |
| budget.mof | MoF Budget Directorate | French |
| hr.mof | HR and payroll officer | English |
| cashier.damascus | Revenue officer | Arabic |
| admin | System administrator | French / English |
| auditor.cofc | Auditor, Central Organisation for Financial Control | Arabic / English |

## Run of show

Scored scenarios take 76 of the 90 minutes; the six Syria spotlights take 17 minutes in total and sit inside the scenario they strengthen, so no scored step is displaced.

| Start | Segment | Weight | Minutes | Syria spotlight inside it |
| --- | --- | --- | --- | --- |
| 0:00 | Opening: who we are, what is live, what is sample | – | 4 | – |
| 0:04 | D1 End-to-end payment request | 25% | 20 | S1 Electronic signatures on every approval (2 min) |
| 0:24 | D2 Interoperability (MoAD personnel API) | 20% | 12 | S2 Legacy data in old pounds, Decree 293/2025 (2 min) |
| 0:36 | D3 Payments through the CBS sandbox | 20% | 15 | S3 Donor funds in USD (3 min) |
| 0:51 | D4 Rules, workflow, roles, delegation, reporting | 15% | 16 | S4 Virements by level (4 min); S5 Income tax law as a dated rule (2 min); S6 Revenue sharing with governorates (2 min) |
| 1:07 | D5 Security, languages, offline, monitoring, backup | 20% | 13 | S1b Tampered record caught by its signature (2 min) |
| 1:20 | The eight results indicators, live | – | 4 | – |
| 1:24 | Close: what this means for SIFMIS | – | 3 | – |
| 1:27 | Buffer / questions | – | 3 | – |

If time runs short, cut in this order: the buffer, then S6, S5 and S2 to their one-line version, then S3 to the settled screen only. Never cut S4 or S1: they are the two features the Ministry will recognise first.

## Scenario steps D1–D5

Each row is one click-path with the result the panel should see; rows marked SPOTLIGHT are the Syria slots detailed in the next section.

### D1 End-to-end payment request (25%, 20 min)

| # | Who | Do | Expected result |
| --- | --- | --- | --- |
| 1 | su.health (Arabic) | New request on line 0203-01-2221, 600,000 SYP, sample IBAN; submit | Funds checked against the line; reference PR-2026-…; status Awaiting ministry |
| 2 | min.health | Open from the bell; approve | Notification arrives; route moves to Financial Controller (above visa threshold) |
| 3 | fc.health (French) | Grant visa | Visa step ticked in French; same record |
| 4 | rto.damascus (Arabic) | Run second-level checks; approve | Checks list all green |
| 5 | treasury.hq | Authorise | Payment order PO-2026-… issued, debit account shown |
| 6 | min.health | Second request: reject with a short reason, then a proper one | Short reason refused; rejection notified to the requester |
| 7 | su.health | Amend the rejected request and resubmit | Amendment recorded from-to; route restarts |
| 8 | SPOTLIGHT S1 | Open the authorised request; press Verify signatures | Every decision carries a valid electronic signature |
| 9 | auditor.cofc (Arabic) | Audit trail; Verify integrity | Hash chain valid, entry count shown |

### D2 Interoperability (20%, 12 min)

| # | Who | Do | Expected result |
| --- | --- | --- | --- |
| 1 | Partner call (Postman) | POST a MoAD batch of 6 records with an Idempotency-Key | 207: 2 accepted, 4 rejected, each error by record and field |
| 2 | Partner call | Send the same batch again; then same key, different body | Replayed answer with the original correlation ID; second one refused |
| 3 | Partner call | Burst past the rate limit; call with no API key | 429 with the seconds to wait; 401 |
| 4 | treasury.hq | Integration screen: open a message, follow its correlation ID | Request, answer, timing and retries on one page |
| 5 | treasury.hq | Results indicators | Indicator 5 moved with the accepted records |
| 6 | SPOTLIGHT S2 | admin: Legacy data, paste the old-pounds budget file, Check | Divided by 100 with control totals; nothing loads while any row is wrong |

### D3 Payments through the CBS sandbox (20%, 15 min)

| # | Who | Do | Expected result |
| --- | --- | --- | --- |
| 1 | treasury.hq | Send the D1 payment order | pacs.008 out, pacs.002 back; Settled; balanced ledger posting |
| 2 | Sandbox page | Inject timeout; send another order | System asks the bank for the status instead of paying twice; settles once |
| 3 | Sandbox page | Inject reject; send; reissue | Rejected with reason AC04; reissued order settles; history shows both |
| 4 | Sandbox page | Inject return; send; poll returns | pacs.004 reverses the ledger; requester notified |
| 5 | treasury.hq | Send a settled order again | Refused: cannot pay twice |
| 6 | treasury.hq | Bank reconciliation: import camt.053; explain the one open line; complete | Auto-matched by EndToEndId; reconciliation dated for indicator 3 |
| 7 | SPOTLIGHT S3 | Vaccine request on the USD donor line, paid from the donor account | 4,000 USD to the bank, 440,000 SYP in the ledger at the dated rate |

### D4 Rules, workflow, roles, delegation, reporting (15%, 16 min)

| # | Who | Do | Expected result |
| --- | --- | --- | --- |
| 1 | admin (French) | Rules: raise the visa threshold from a future date | New value effective-dated; old one kept; audit entry |
| 2 | admin | Approval route for MIN-0410 without visa and RTO; save | Next Education request skips those steps; no release |
| 3 | admin | Create a new approver; they sign in | Temporary password; forced change on first login |
| 4 | min.health | Delegate to the new approver for a week | Delegate acts "on behalf of", shown on the record |
| 5 | SPOTLIGHT S4 | Virements: one within ministry authority, one to another chapter, one out of salaries | Ministry level / MoF level / refused, each with its reason |
| 6 | SPOTLIGHT S5 | Rules: new INCOME_TAX from next month; payroll run this month and next | This month keeps the old bands; next month uses the new |
| 7 | treasury.hq | Reports: budget execution, payments; CSV export | Figures match the transactions just made |
| 8 | SPOTLIGHT S6 | Receipts: sharing report after three receipts | Central and governorate shares by revenue code |

### D5 Security, languages, offline, monitoring, backup (20%, 13 min)

| # | Who | Do | Expected result |
| --- | --- | --- | --- |
| 1 | Any | Switch Arabic, English, French on the same screen | Full right-to-left layout in Arabic; all labels translated |
| 2 | Any | Keyboard only: Tab from the top | Skip link first; every control named |
| 3 | su.health | Go offline (DevTools), capture a request, reconnect | Queued in the outbox, synced once on reconnect |
| 4 | admin | Deep health and metrics; stop the sandbox | Status Degraded, not down; payments queue |
| 5 | admin | Backup, alter a dump byte, restore | Tampered file refused; clean restore verified by hash chain |
| 6 | admin | Deactivate a user who is signed in | Their session ends at the next click |
| 7 | SPOTLIGHT S1b | auditor: Check all signatures; change one approval in the database; check again | Clean sweep, then the altered approval named as failing |

## The six Syria spotlights

Each spotlight answers a need the Ministry has that a generic FMIS demo would miss; each is built, tested (apps/api/test/syria.test.ts) and rehearsed in the browser (scripts/e2e-syria.mjs, 11 screenshots kept as fallback).

| Slot | Feature | Basis | Fallback screenshot |
| --- | --- | --- | --- |
| S1 / S1b | Electronic signatures on approvals and virements | Electronic Signature Law 3/2014 | 05, 10, 11 |
| S2 | Legacy data in old pounds converted on load | Decree 293/2025 (new pound, 100 old = 1 new, from 1 Jan 2026) | 08 |
| S3 | Donor funds in USD, booked in SYP | Donor reporting; CBS rate (sample) | 05 |
| S4 | Virements approved at the level the law sets | Basic Finance Law, Decree 54/2006 (under revision) | 01–04 |
| S5 | Income tax on salaries as a dated rule | New Income Tax Law (bands are samples) | 06, 09 |
| S6 | Revenue sharing with the governorates | Decentralisation of local revenue (shares are samples) | 07 |

### S1 Electronic signatures (2 min, in D1) and S1b tamper check (2 min, in D5)

**Show.** On the authorised request press Verify signatures: four decisions, each "Signature valid". In D5, the auditor runs Check all signatures (clean), the driver changes one approved amount directly in the database, the auditor runs it again: that approval is named as failing.

**Say.** "Every approval is signed with the approver's own key, as Law 3/2014 allows. The hash chain tells you the log was not edited; the signature tells you the decision itself was not. Even someone with database access cannot change an approved amount without it showing."

**One-line version.** "Every approval is electronically signed; change the record and the signature fails."

### S2 Legacy data in old pounds (2 min, in D2)

**Show.** admin → Legacy data. The Decree 293/2025 banner. Paste samples/budget_lines_old_pounds.csv, tick "Amounts are in old pounds", Check: 13,075,678,950 old SYP becomes 130,756,789.50 new SYP, with expected total and rounding side by side. Load.

**Say.** "Syria's historical budgets and staff files are in old pounds. Migration divides them by 100 on the way in and proves it with control totals, so the opening balances in SIFMIS reconcile with the old systems to the piastre."

**One-line version.** "Old-pound files are converted on load with control totals."

### S3 Donor funds in USD (3 min, in D3)

**Show.** Request on 0203-01-2224 Vaccines (donor grant, USD) for 4,000 USD; approvals; authorise. The payment order debits SY-CBS-USD-0001, not the TSA; send; settled in USD at the sandbox. The header shows ≈ 440,000 SYP at 110 SYP per unit.

**Say.** "Reconstruction will be largely donor-financed. Donor money stays in its own currency and account, as the donor requires, while the budget and the eight indicators see it in Syrian pounds at the rate in force on the day."

**One-line version.** "Donor lines pay in dollars and report in pounds."

### S4 Virements by level (4 min, in D4)

**Show.** su.health → Virements. 400,000 SYP between two lines of chapter 22: Ministry level. min.health approves in Arabic and signs; allotments move. Then 200,000 SYP to capital (chapter 31): MoF level. Then an attempt out of salaries (chapter 21): refused. budget.mof approves the MoF one in French.

**Say.** "Under the Basic Finance Law a ministry may move money within its own chapter up to a limit; beyond that, the Ministry of Finance decides. The limits are a rule, so when the law is revised the Budget Directorate changes a value, not the software."

**One-line version.** "Virements go to the ministry or to MoF by law, and salaries are protected."

### S5 Income tax as a dated rule (2 min, in D4)

**Show.** Payroll run: gross, income tax and net per employee, with the bands applied. Rules → INCOME_TAX: the JSON editor opens on the bands in force; save new bands from next month. Run next month: new tax; this month unchanged.

**Say.** "The new income tax law is still being finalised. Whatever bands it settles on are entered here with the date they apply from; this month's payroll is untouched and next month's follows the new law."

**One-line version.** "A new tax law is a dated rule, not a new release."

### S6 Revenue sharing with governorates (2 min, in D4)

**Show.** Three receipts at the Damascus office: customs, income tax, administrative fees. treasury.hq → Receipts → sharing report: customs 100% central, the others split with Damascus. Cancel one: its share is reversed.

**Say.** "Where a share of local revenue belongs to the governorate, the split is booked when the receipt is issued, so each governorate's share is known daily, not reconstructed at year end."

**One-line version.** "Each governorate's revenue share is booked at the receipt."

**Room for Millenium's own words.** Before the day, add one sentence per spotlight from Millenium's Syria experience (a ministry, a past project, a local partner). Keep it factual and verifiable.

## Indicators, close and questions

**Indicators (4 min).** treasury.hq → Results indicators. Point out that all eight are computed from the transactions the panel just watched, none typed in; USD payments count at their SYP value.

**Close (3 min).** "Everything you saw runs on one platform: the five scenarios you set, and six things specific to Syria – the law on virements, the new tax law, revenue for the governorates, donor dollars, electronic signatures and the new pound. The values are samples; the mechanisms are built, so the Ministry's own rules can be entered as data."

**Likely questions**

| Question | Answer |
| --- | --- |
| Are the tax bands real? | No. They are samples, labelled as such; the final law's bands are entered as a dated rule. |
| Is this connected to the CBS? | No. It is a sandbox we built to ISO 20022 (pacs.008/002/004, camt.053); the same messages go to the CBS once access is granted. |
| Where are signing keys kept? | In the demo, encrypted on the server. In production, smart cards or an HSM, with certificates from the accredited Syrian authority under Law 3/2014. |
| What if the redenomination factor or dates change? | They are a rule (REDENOMINATION); the loader reads it. |
| Can a ministry change its own virement limits? | No. Only the administrator, with effective dates and an audit entry; the limits apply per the rule in force. |
| What about other currencies (EUR, SAR)? | The currency list is configuration; adding one means a rate rule and a donor account. |

**Contingency.** If the network or a laptop fails, switch to the rehearsal screenshots (USB) and narrate the same steps. If the sandbox stalls, show D5 step 4 early: the system degrades but stays up. Re-seed takes under a minute between segments if a step is mis-clicked.

## Sources

- Decree 293/2025 (new pound from 1 January 2026, 100 old = 1 new): [MRI Guide](https://mriguide.com/syria-decree-293-2025-offers-re-denomination-details/), [bne IntelliNews – two zeros removed](https://www.intellinews.com/syria-strips-two-zeros-off-currency-as-citizens-face-90-day-deadline-to-swap-old-pounds-417967/).
- Old-note exchange extended to the end of July 2026: [bne IntelliNews](https://www.intellinews.com/syrian-central-bank-extends-currency-exchange-deadline-to-end-july-445717/).
- Basic Finance Law (Legislative Decree 54/2006), Electronic Signature Law 3/2014 and the draft income tax law: as summarised in the bid's Syria research notes; to be confirmed by Millenium's Syrian legal adviser.

/**
 * Syria-specific features (Milestone 4). These are the points the Ministry of
 * Finance will recognise as Syrian, beyond the generic D1–D5 scenarios:
 *
 *  1. Virements with approval by level (Basic Finance Law, Decree 54/2006)
 *  2. Income tax on salaries from a dated rule (New Income Tax Law – sample brackets)
 *  3. Revenue sharing with the governorates (decentralisation)
 *  4. Donor funds in USD, valued in Syrian pounds
 *  5. Electronic signatures on approvals (Law 3/2014)
 *  6. Legacy data in old pounds converted on load (Decree 293/2025, 100 old = 1 new)
 *
 * Values in the seeded rules are SAMPLES until confirmed by a Syrian adviser.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startApp, startCbs } from "./helpers.js";

let app: Awaited<ReturnType<typeof startApp>>;
let cbs: Awaited<ReturnType<typeof startCbs>>;
before(async () => { cbs = await startCbs(); app = await startApp(); });
after(async () => { await app.stop(); await cbs.stop(); });

const line = async (id: string) => (await (await app.as("treasury.hq")).get("/api/budget-lines")).body.find((l: any) => l.id === id);
const nextMonth = () => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 1); return d.toISOString().slice(0, 10); };

test("virement within ministry authority: approved by the ministry, allotments move, decision signed", async () => {
  const su = await app.as("su.health"), min = await app.as("min.health");
  const [from0, to0] = [await line("0203-01-2221"), await line("0203-01-2231")];
  const r = await su.post("/api/virements", { fromLine: "0203-01-2221", toLine: "0203-01-2231", amount: 400_000, reason: "Urgent repair of the dialysis unit" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.level, r.body.levelReason], ["MINISTRY", "within_ministry_authority"]);
  assert.match(r.body.ref, /^VR-\d{4}-\d{5}$/);
  assert.equal((await (await app.as("budget.mof")).post(`/api/virements/${r.body.id}/decision`, { decision: "approve" })).status, 403, "not the Ministry of Finance's level");
  assert.equal((await min.post(`/api/virements/${r.body.id}/decision`, { decision: "approve" })).status, 200);
  const [from1, to1] = [await line("0203-01-2221"), await line("0203-01-2231")];
  assert.deepEqual([from0.allotment - from1.allotment, to1.allotment - to0.allotment], [400_000, 400_000]);
  const v = (await min.get("/api/virements")).body.find((x: any) => x.id === r.body.id);
  assert.deepEqual([v.status, v.signed, v.signatureValid], ["APPROVED", true, true]);
  assert.equal((await min.post(`/api/virements/${r.body.id}/decision`, { decision: "approve" })).body.error, "virement.already_decided");
});

test("virement levels: other chapter or above the limits goes to the Ministry of Finance; protected chapter refused", async () => {
  const su = await app.as("su.health"), mof = await app.as("budget.mof");
  const cross = await su.post("/api/virements", { fromLine: "0203-01-2221", toLine: "0203-01-3121", amount: 200_000, reason: "Buy a replacement autoclave" });
  assert.deepEqual([cross.body.level, cross.body.levelReason], ["MOF", "cross_chapter"]);
  const big = await su.post("/api/virements", { fromLine: "0203-01-2221", toLine: "0203-01-2231", amount: 1_500_000, reason: "Maintenance contract for all clinics" });
  assert.deepEqual([big.body.level, big.body.levelReason], ["MOF", "above_amount"]);
  assert.equal((await (await app.as("min.health")).post(`/api/virements/${big.body.id}/decision`, { decision: "approve" })).status, 403);
  assert.equal((await mof.post(`/api/virements/${big.body.id}/decision`, { decision: "reject" })).body.error, "virement.reason_required");
  assert.equal((await mof.post(`/api/virements/${big.body.id}/decision`, { decision: "reject", reason: "Fund it from next quarter's release" })).status, 200);
  const salaries = await su.post("/api/virements", { fromLine: "0203-01-2111", toLine: "0203-01-2221", amount: 100_000, reason: "Move unspent salaries to medicines" });
  assert.deepEqual([salaries.status, salaries.body.error], [400, "virement.protected_chapter"]);
  assert.equal((await su.post("/api/virements", { fromLine: "0203-01-2224", toLine: "0203-01-2221", amount: 100, reason: "Donor money to a pound line" })).body.error, "virement.currency_mismatch");
  assert.equal((await (await app.as("su.education")).post("/api/virements", { fromLine: "0203-01-2221", toLine: "0203-01-2231", amount: 100, reason: "Not my ministry's line" })).status, 403);
});

test("income tax is withheld from gross pay by the dated rule; a new law applies from its date without a release", async () => {
  const { incomeTax } = await import("../src/modules/payroll/payroll.service.js");
  const sample = { exemption: 300_000, brackets: [{ upTo: 500_000, rate: 0.05 }, { upTo: 1_000_000, rate: 0.10 }, { upTo: null, rate: 0.15 }] };
  assert.equal(incomeTax(250_000, sample), 0, "below the exemption");
  assert.equal(incomeTax(800_000, sample), 500_000 * 0.05 + 0 , "first band only: 500,000 taxable at 5%");
  assert.equal(incomeTax(1_500_000, sample), 500_000 * 0.05 + 500_000 * 0.10 + 200_000 * 0.15);

  const hr = await app.as("hr.mof"), admin = await app.as("admin");
  const period = new Date().toISOString().slice(0, 7);
  const run = (await hr.post("/api/payroll/runs", { period, ministryId: "MIN-0203" })).body;
  const detail = (await hr.get(`/api/payroll/runs/${run.id}`)).body;
  const inc = detail.lines.filter((l: any) => l.included);
  assert.ok(inc.length > 0);
  for (const l of inc) assert.deepEqual([l.tax, l.net], [incomeTax(l.gross, sample), Math.round((l.gross - l.tax) * 100) / 100]);
  assert.equal(detail.total_gross, Math.round(inc.reduce((s: number, l: any) => s + l.gross, 0) * 100) / 100);
  assert.ok(detail.total_tax > 0);

  const from = nextMonth();
  const law = { exemption: 1_000_000, brackets: [{ upTo: 2_000_000, rate: 0.04 }, { upTo: null, rate: 0.08 }] };
  assert.equal((await admin.post("/api/rules", { key: "INCOME_TAX", value: law, effectiveFrom: from, note: "SAMPLE: new law from next month" })).status, 200);
  const later = (await hr.post("/api/payroll/runs", { period: from.slice(0, 7), ministryId: "MIN-0203" })).body;
  const ld = (await hr.get(`/api/payroll/runs/${later.id}`)).body;
  for (const l of ld.lines.filter((x: any) => x.included)) assert.equal(l.tax, incomeTax(l.gross, law));
  assert.ok(ld.total_tax < detail.total_tax, "this month keeps the old rule, next month uses the new one");
});

test("revenue sharing: the governorate's share is split at the receipt and reversed on cancellation", async () => {
  const cash = await app.as("cashier.damascus"), hq = await app.as("treasury.hq");
  const { db } = await import("../src/db/index.js");
  const fees = await cash.post("/api/receipts", { revenueCode: "1401", payerName: "Barada Trading Co.", amount: 300_000, method: "CASH" });
  assert.equal(fees.status, 200, JSON.stringify(fees.body));
  const ledger = async (ref: string) => (await db().query("SELECT account, debit::float8 AS debit, credit::float8 AS credit FROM ledger_entries WHERE source_ref = $1 ORDER BY id", [ref])).rows
    .map((l: any) => [l.account, l.debit, l.credit]);
  assert.deepEqual((await ledger(fees.body.ref)).filter((l: any) => l[2] > 0), [["REV:1401", 0, 150_000], ["GOV:DAM:1401", 0, 150_000]]);
  const customs = await cash.post("/api/receipts", { revenueCode: "1101", payerName: "Barada Trading Co.", amount: 1_000_000, method: "BANK_TRANSFER" });
  assert.deepEqual((await ledger(customs.body.ref)).filter((l: any) => l[2] > 0), [["REV:1101", 0, 1_000_000]], "customs stay central");

  const row = (rep: any[]) => rep.find(r => r.governorate === "DAM" && r.revenue_code === "1401");
  const before = row((await hq.get("/api/receipts/sharing")).body);
  assert.deepEqual([before.collected, before.central, before.governorate_share], [300_000, 150_000, 150_000]);
  assert.equal((await cash.post(`/api/receipts/${fees.body.id}/cancel`, { reason: "Issued against the wrong payer" })).status, 200);
  const bal = (await ledger(fees.body.ref)).reduce((m: any, [a, d, c]: any) => ({ ...m, [a]: (m[a] ?? 0) + c - d }), {});
  assert.deepEqual([bal["REV:1401"], bal["GOV:DAM:1401"]], [0, 0]);
  assert.equal(row((await hq.get("/api/receipts/sharing")).body), undefined, "cancelled receipts leave the report");
});

test("donor line in USD: paid in dollars from the donor account, booked in pounds at the dated rate", async () => {
  const su = await app.as("su.health"), hq = await app.as("treasury.hq");
  const { db } = await import("../src/db/index.js");
  const c = await su.post("/api/documents", { budgetLineId: "0203-01-2224", supplierName: app.supplier.name, supplierIban: app.supplier.iban, description: "Cold-chain vaccine delivery", amount: 4_000 });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const id = c.body.id;
  await su.post(`/api/documents/${id}/submit`);
  await (await app.as("min.health")).post(`/api/documents/${id}/actions/approve`);
  await (await app.as("fc.health")).post(`/api/documents/${id}/actions/grant_visa`); // 4,000 USD = 440,000 SYP: under the visa threshold, harmless if not needed
  await (await app.as("rto.damascus")).post(`/api/documents/${id}/actions/approve`);
  const a = await hq.post(`/api/documents/${id}/actions/authorise`);
  assert.equal(a.body.status, "AUTHORISED", JSON.stringify(a.body));
  const po = a.body.paymentOrder;
  assert.deepEqual([po.currency, Number(po.fx_rate), po.debit_account, po.via_tsa], ["USD", 110, "SY-CBS-USD-0001", false]);

  const sent = await hq.post(`/api/payment-orders/${po.id}/send`);
  assert.equal(sent.body.status, "SETTLED", JSON.stringify(sent.body));
  const atCbs = (await cbs.state()).payments.find((p: any) => p.account === "SY-CBS-USD-0001");
  assert.deepEqual([atCbs.amount, atCbs.currency], [4_000, "USD"]);
  const rows = (await db().query("SELECT account, debit::float8 AS debit, credit::float8 AS credit, fc_currency, fc_amount::float8 AS fc_amount FROM ledger_entries WHERE source = 'payment_order' AND source_ref = $1 ORDER BY id", [po.ref])).rows;
  assert.deepEqual(rows.map((l: any) => [l.account, l.debit, l.credit, l.fc_currency, l.fc_amount]),
    [["EXP:2224", 440_000, 0, "USD", 4_000], ["BANK:SY-CBS-USD-0001", 0, 440_000, "USD", 4_000]]);
  const ln = await line("0203-01-2224");
  assert.equal(ln.currency, "USD");
  const cur = (await hq.get("/api/currency")).body;
  assert.equal(cur.rates.USD, 110);
});

test("approvals carry an electronic signature that stops verifying if the record is altered in the database", async () => {
  const su = await app.as("su.health"), auditor = await app.as("auditor.cofc");
  const { db } = await import("../src/db/index.js");
  const c = await su.post("/api/documents", { budgetLineId: "0203-01-2221", supplierName: app.supplier.name, supplierIban: app.supplier.iban, description: "Syringes and gloves", amount: 120_000 });
  await su.post(`/api/documents/${c.body.id}/submit`);
  await (await app.as("min.health")).post(`/api/documents/${c.body.id}/actions/approve`);
  const sigs = (await auditor.get(`/api/documents/${c.body.id}/signatures`)).body;
  assert.ok(sigs.length >= 2);
  assert.ok(sigs.every((s: any) => s.signed && s.valid), JSON.stringify(sigs));
  const all = (await auditor.get("/api/signatures/verify")).body;
  assert.equal(all.invalid, 0);
  assert.equal((await su.get("/api/signatures/verify")).status, 403);

  // someone with database access raises the approved amount behind the system's back
  await db().query("UPDATE approvals SET amount = 1200000 WHERE document_id = $1", [c.body.id]);
  const after = (await auditor.get(`/api/documents/${c.body.id}/signatures`)).body;
  assert.ok(after.every((s: any) => s.valid === false), "every signature over the old amount now fails");
  const sweep = (await auditor.get("/api/signatures/verify")).body;
  assert.equal(sweep.invalid, after.length);
  await db().query("UPDATE approvals SET amount = 120000 WHERE document_id = $1", [c.body.id]);
  assert.equal((await auditor.get("/api/signatures/verify")).body.invalid, 0);
});

test("legacy budget in old pounds: converted on load at 100 old = 1 new, with control totals", async () => {
  const admin = await app.as("admin");
  const csv = fs.readFileSync(path.resolve(import.meta.dirname, "../../../samples/budget_lines_old_pounds.csv"), "utf8");
  const dry = await admin.post("/api/loaders/budget", { csv, commit: false, oldPounds: true });
  assert.equal(dry.status, 200, JSON.stringify(dry.body));
  assert.deepEqual([dry.body.committed, dry.body.valid, dry.body.errors.length], [false, 3, 0]);
  const conv = dry.body.conversion;
  assert.deepEqual([conv.decree, conv.effectiveDate, conv.factor], ["293/2025", "2026-01-01", 100]);
  const ctl = conv.controls.find((x: any) => x.field === "allotment");
  assert.equal(ctl.oldTotal, 420_000_000 + 310_000_000 + 12_345_678_950);
  assert.equal(ctl.newTotal, 4_200_000 + 3_100_000 + 123_456_789.5);
  assert.ok(Math.abs(ctl.rounding) <= 0.005 * 3, "rounding stays within half a piastre per row");
  assert.equal((await admin.post("/api/loaders/budget", { csv, commit: true, oldPounds: true })).body.committed, true);
  const l = await line("0203-01-2251");
  assert.deepEqual([l.allotment, l.original_allotment], [123_456_789.5, 123_456_789.5]);
  assert.equal((await (await app.as("su.health")).post("/api/loaders/budget", { csv, commit: false, oldPounds: true })).status, 403);
});

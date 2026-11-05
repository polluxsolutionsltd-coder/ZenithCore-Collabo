/**
 * D1 – end-to-end transaction (25% of the demonstration score).
 * Mirrors the HTML reference model: commitment & visa, Regional Treasury
 * second-level controls, Treasury HQ authorisation, amendment, rejection,
 * notifications and a tamper-evident audit trail.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApp } from "./helpers.js";

let app: Awaited<ReturnType<typeof startApp>>;
before(async () => { app = await startApp(); });
after(async () => { await app.stop(); });

async function newRequest(amount: number, line = "0203-01-2221") {
  const su = await app.as("su.health");
  const c = await su.post("/api/documents", { budgetLineId: line, supplierName: app.supplier.name, supplierIban: app.supplier.iban, description: "Insulin and syringes, Q1", amount });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  return c.body.id as number;
}

test("D1 happy path: spending unit → ministry → FC visa → RTO checks → HQ → payment order", async () => {
  const id = await newRequest(1_200_000);
  const su = await app.as("su.health"), min = await app.as("min.health"), fc = await app.as("fc.health"),
    rto = await app.as("rto.damascus"), hq = await app.as("treasury.hq");

  const s = await su.post(`/api/documents/${id}/submit`);
  assert.equal(s.body.status, "SUBMITTED");
  assert.equal(s.body.visaRequired, true, "1.2m is above the 500k visa threshold");

  // the ministry sees it in its inbox and has a notification
  assert.ok((await min.get("/api/documents?scope=inbox")).body.some((d: any) => d.id === id));
  assert.ok((await min.get("/api/notifications")).body.some((n: any) => n.key === "doc.awaiting_ministry" && n.document_id === id));

  // the wrong actor cannot jump the queue
  assert.equal((await hq.post(`/api/documents/${id}/actions/authorise`)).status, 403);
  assert.equal((await (await app.as("min.education")).post(`/api/documents/${id}/actions/approve`)).status, 403);

  assert.equal((await min.post(`/api/documents/${id}/actions/approve`)).body.status, "AWAITING_VISA");
  assert.equal((await fc.post(`/api/documents/${id}/actions/grant_visa`)).body.status, "AWAITING_RTO");

  const view = await rto.get(`/api/documents/${id}`);
  assert.deepEqual(view.body.checks.map((c: any) => [c.key, c.ok]), [["check.budget", true], ["check.commitment", true], ["check.cash_limit", true]]);
  assert.deepEqual(view.body.actions, ["approve", "reject"]);

  assert.equal((await rto.post(`/api/documents/${id}/actions/approve`)).body.status, "AWAITING_HQ");
  const auth = await hq.post(`/api/documents/${id}/actions/authorise`);
  assert.equal(auth.body.status, "AUTHORISED");
  assert.match(auth.body.paymentOrder.ref, /^PO-\d{4}-\d{6}$/);

  const final = await su.get(`/api/documents/${id}`);
  assert.equal(final.body.paymentOrder.debit_account, "SY-CBS-TSA-0001");
  assert.deepEqual(final.body.approvals.map((a: any) => a.decision), ["SUBMITTED", "APPROVED", "VISA_GRANTED", "APPROVED", "AUTHORISED"]);
  assert.ok((await su.get("/api/notifications")).body.some((n: any) => n.key === "doc.authorised"));
});

test("below the visa threshold the Financial Controller step is skipped", async () => {
  const id = await newRequest(300_000);
  const su = await app.as("su.health"), min = await app.as("min.health");
  assert.equal((await su.post(`/api/documents/${id}/submit`)).body.visaRequired, false);
  assert.equal((await min.post(`/api/documents/${id}/actions/approve`)).body.status, "AWAITING_RTO");
});

test("rejection needs a reason, releases funds and notifies the requester", async () => {
  const id = await newRequest(900_000);
  const su = await app.as("su.health"), min = await app.as("min.health"), fc = await app.as("fc.health");
  const before = (await su.get("/api/budget-lines")).body.find((l: any) => l.id === "0203-01-2221").available;
  await su.post(`/api/documents/${id}/submit`);
  assert.equal((await su.get("/api/budget-lines")).body.find((l: any) => l.id === "0203-01-2221").available, before - 900_000);
  await min.post(`/api/documents/${id}/actions/approve`);
  const noReason = await fc.post(`/api/documents/${id}/actions/refuse_visa`, { reason: "no" });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.body.error, "document.reason_required");
  const refused = await fc.post(`/api/documents/${id}/actions/refuse_visa`, { reason: "Supplier quotation is missing from the file." });
  assert.equal(refused.body.status, "REJECTED");
  assert.equal((await su.get("/api/budget-lines")).body.find((l: any) => l.id === "0203-01-2221").available, before);
  const n = (await su.get("/api/notifications")).body.find((x: any) => x.key === "doc.rejected" && x.document_id === id);
  assert.equal(n.params.reason, "Supplier quotation is missing from the file.");
});

test("amendment: a reduction keeps approvals, an increase goes back to the ministry", async () => {
  const id = await newRequest(1_000_000);
  const su = await app.as("su.health"), min = await app.as("min.health"), fc = await app.as("fc.health");
  await su.post(`/api/documents/${id}/submit`);
  await min.post(`/api/documents/${id}/actions/approve`);
  await fc.post(`/api/documents/${id}/actions/grant_visa`);
  const down = await su.post(`/api/documents/${id}/amend`, { amount: 800_000, reason: "Quantity reduced after stock count" });
  assert.deepEqual(down.body, { status: "AWAITING_RTO", amount: 800_000 });
  const up = await su.post(`/api/documents/${id}/amend`, { amount: 1_500_000, reason: "Additional insulin for Rif Dimashq clinics" });
  assert.equal(up.body.status, "SUBMITTED");
  const doc = (await su.get(`/api/documents/${id}`)).body;
  assert.equal(doc.visa_required, true);
  assert.deepEqual(doc.approvals.map((a: any) => a.decision).slice(-2), ["AMENDED", "AMENDED"]);
});

test("insufficient funds and stale versions are refused", async () => {
  const su = await app.as("su.health");
  const big = await newRequest(2_400_000, "0203-01-2231"); // allotment 2.5m
  assert.equal((await su.post(`/api/documents/${big}/submit`)).status, 200);
  const over = await newRequest(200_000, "0203-01-2231");
  const r = await su.post(`/api/documents/${over}/submit`);
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "document.insufficient_funds");

  const id = await newRequest(100_000);
  const doc = (await su.get(`/api/documents/${id}`)).body;
  assert.equal((await su.post(`/api/documents/${id}/submit`, { version: doc.version + 5 })).body.error, "document.stale");
});

test("RTO cash-limit control blocks approval with an explained check", async () => {
  const admin = await app.as("admin");
  const today = new Date().toISOString().slice(0, 10);
  assert.equal((await admin.post("/api/rules", { key: "CASH_LIMIT_MONTHLY", scope: "SU-0203-01", value: { amount: 50_000 }, effectiveFrom: today })).status, 200);
  const id = await newRequest(200_000, "0203-01-3121");
  const su = await app.as("su.health"), min = await app.as("min.health"), rto = await app.as("rto.damascus");
  await su.post(`/api/documents/${id}/submit`);
  await min.post(`/api/documents/${id}/actions/approve`);
  const r = await rto.post(`/api/documents/${id}/actions/approve`);
  assert.equal(r.status, 409);
  assert.equal(r.body.details.checks.find((c: any) => c.key === "check.cash_limit").ok, false);
  await admin.post("/api/rules", { key: "CASH_LIMIT_MONTHLY", scope: "SU-0203-01", value: { amount: 20_000_000 }, effectiveFrom: today });
});

test("validation: invalid IBAN and someone else's budget line are refused", async () => {
  const su = await app.as("su.health");
  const bad = await su.post("/api/documents", { budgetLineId: "0203-01-2221", supplierName: "X Co", supplierIban: "SY00123", description: "test", amount: 10 });
  assert.equal(bad.body.error, "document.invalid_iban");
  const other = await su.post("/api/documents", { budgetLineId: "0410-05-2211", supplierName: "X Co", supplierIban: app.supplier.iban, description: "test", amount: 10 });
  assert.equal(other.body.error, "document.line_not_allowed");
});

test("visibility: a spending unit cannot open another unit's request", async () => {
  const id = await newRequest(10_000);
  assert.equal((await (await app.as("su.education")).get(`/api/documents/${id}`)).status, 404);
});

test("audit trail is complete and tamper-evident", async () => {
  const aud = await app.as("auditor.cofc");
  const v = await aud.get("/api/audit/verify");
  assert.equal(v.body.valid, true);
  assert.ok(v.body.entries > 20);
  assert.equal((await (await app.as("su.health")).get("/api/audit/verify")).status, 403);

  // tamper with one entry directly in the database: verification must catch it
  const { db } = await import("../src/db/index.js");
  await db().query("UPDATE audit_log SET data = jsonb_set(data, '{amount}', '1') WHERE id = (SELECT id FROM audit_log WHERE action = 'document.create' ORDER BY id LIMIT 1)");
  const broken = await aud.get("/api/audit/verify");
  assert.equal(broken.body.valid, false);
  assert.ok(broken.body.brokenAt > 0);
});

test("indicators 1 and 2 are computed from live payment orders", async () => {
  const r = (await (await app.as("treasury.hq")).get("/api/indicators")).body;
  const i1 = r.find((x: any) => x.id === 1), i2 = r.find((x: any) => x.id === 2);
  assert.equal(i1.status, "live");
  // baseline 52m/80m plus the 1.2m authorised in the happy-path test
  assert.equal(i1.numerator, 52_000_000 + 1_200_000);
  assert.equal(i1.denominator, 80_000_000 + 1_200_000);
  assert.equal(i2.numerator, 30_000_000 + 1_200_000);
  assert.equal(r.length, 8);
});

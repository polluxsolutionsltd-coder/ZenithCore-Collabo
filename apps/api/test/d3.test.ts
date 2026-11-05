/**
 * D3 – payments and reconciliation (20% of the demonstration score).
 * Authorised order → pacs.008 to the CBS sandbox → pacs.002 → ledger;
 * rejection and reissue; timeout without double payment; dead letter and
 * retry; pacs.004 return with reversal; camt.053 reconciliation; indicator 3.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { authorised, startApp, startCbs } from "./helpers.js";

let app: Awaited<ReturnType<typeof startApp>>;
let cbs: Awaited<ReturnType<typeof startCbs>>;
before(async () => { cbs = await startCbs(); app = await startApp(); });
after(async () => { await app.stop(); await cbs.stop(); });

const hq = () => app.as("treasury.hq");
const balanced = (ledger: any[]) => ledger.reduce((s, l) => s + l.debit - l.credit, 0);

test("only Treasury HQ sends payment orders", async () => {
  const d = await authorised(app, 150_000);
  assert.equal((await (await app.as("su.health")).post(`/api/payment-orders/${d.paymentOrder.id}/send`)).status, 403);
  assert.equal((await (await app.as("rto.damascus")).post(`/api/payment-orders/${d.paymentOrder.id}/send`)).status, 403);
});

test("happy path: send → settled at CBS → balanced ledger posting", async () => {
  const d = await authorised(app, 600_000);
  const r = await (await hq()).post(`/api/payment-orders/${d.paymentOrder.id}/send`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, "SETTLED");
  assert.equal(r.body.cbs_status, "ACSC");
  assert.match(r.body.end_to_end_id, /^E2E-PO-/);
  assert.deepEqual(r.body.ledger.map((l: any) => [l.account, l.debit, l.credit]), [["EXP:2221", 600_000, 0], ["BANK:SY-CBS-TSA-0001", 0, 600_000]]);
  assert.equal(r.body.messages[0].status, "DELIVERED");
  assert.equal((await (await hq()).post(`/api/payment-orders/${d.paymentOrder.id}/send`)).status, 409, "cannot be sent twice");
  assert.ok((await (await app.as("su.health")).get("/api/notifications")).body.some((n: any) => n.key === "po.settled"));
});

test("rejected by CBS → reissue with reason → settled; the old order is kept", async () => {
  const d = await authorised(app, 200_000);
  await cbs.fault("reject");
  const r = await (await hq()).post(`/api/payment-orders/${d.paymentOrder.id}/send`);
  assert.equal(r.body.status, "REJECTED");
  assert.equal(r.body.cbs_reason, "AC04");
  assert.equal((await (await hq()).post(`/api/payment-orders/${d.paymentOrder.id}/reissue`, { reason: "short" })).body.error, "payment.reissue_reason_required");
  const n = await (await hq()).post(`/api/payment-orders/${d.paymentOrder.id}/reissue`, { reason: "Supplier confirmed account in writing" });
  assert.equal(n.body.status, "ISSUED");
  assert.equal((await (await hq()).post(`/api/payment-orders/${d.paymentOrder.id}/reissue`, { reason: "Supplier confirmed account in writing" })).status, 409);
  assert.equal((await (await hq()).post(`/api/payment-orders/${n.body.id}/send`)).body.status, "SETTLED");
  const doc = (await (await hq()).get(`/api/documents/${d.id}`)).body;
  assert.deepEqual(doc.paymentOrders.map((p: any) => p.status), ["REJECTED", "SETTLED"]);
  assert.equal(doc.paymentOrder.id, n.body.id);
});

test("timeout: the bank settled but answered late → status query, no second payment", async () => {
  const d = await authorised(app, 250_000);
  await cbs.fault("timeout");
  const r = await (await hq()).post(`/api/payment-orders/${d.paymentOrder.id}/send`);
  assert.equal(r.body.status, "SETTLED");
  assert.equal(r.body.messages[0].attempts, 1, "settled was learnt from the status query, not from a resend");
  const atBank = (await cbs.state()).payments.filter((p: any) => p.endToEndId === r.body.end_to_end_id);
  assert.equal(atBank.length, 1);
  assert.equal(balanced(r.body.ledger), 0);
});

test("CBS unreachable → dead letter; retry from the console asks first, then settles once", async () => {
  const d = await authorised(app, 300_000);
  const real = process.env.CBS_URL;
  process.env.CBS_URL = "http://127.0.0.1:9"; // nothing listens here
  const r = await (await hq()).post(`/api/payment-orders/${d.paymentOrder.id}/send`);
  assert.equal(r.body.status, "SEND_FAILED");
  assert.equal(r.body.messages[0].status, "DEAD_LETTER");
  assert.equal(r.body.messages[0].attempts, 3);
  assert.ok((await (await app.as("admin")).get("/api/integration/summary")).body.deadLetters >= 1);
  process.env.CBS_URL = real;
  const retry = await (await app.as("admin")).post(`/api/integration/messages/${r.body.messages[0].id}/retry`);
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.status, "SETTLED");
  assert.equal((await cbs.state()).payments.filter((p: any) => p.endToEndId === r.body.end_to_end_id).length, 1);
});

test("return (pacs.004) → RETURNED, posting reversed, applied once", async () => {
  const d = await authorised(app, 350_000);
  await cbs.fault("return");
  const s = await (await hq()).post(`/api/payment-orders/${d.paymentOrder.id}/send`);
  assert.equal(s.body.status, "SETTLED");
  const p1 = await (await hq()).post("/api/payments/poll-returns");
  assert.deepEqual(p1.body.returned, [s.body.ref]);
  assert.deepEqual((await (await hq()).post("/api/payments/poll-returns")).body.returned, [], "a return is applied once");
  const po = (await (await hq()).get(`/api/payment-orders/${d.paymentOrder.id}`)).body;
  assert.equal(po.status, "RETURNED");
  assert.equal(po.cbs_reason, "AC03");
  assert.equal(po.ledger.length, 4);
  assert.equal(po.ledger.filter((l: any) => l.account === "EXP:2221").reduce((a: number, l: any) => a + l.debit - l.credit, 0), 0);
  assert.equal((await (await hq()).post(`/api/payment-orders/${d.paymentOrder.id}/reissue`, { reason: "New account details received from supplier" })).body.status, "ISSUED");
});

test("camt.053 reconciliation: auto-match, explain the rest, close the quarter, indicator 3 moves", async () => {
  const h = await hq();
  const ind = async () => (await h.get("/api/indicators")).body.find((i: any) => i.id === 3);
  const before = await ind();
  assert.equal(before.status, "live");
  assert.deepEqual([before.numerator, before.denominator], [6, 9]);

  await cbs.credit(4_750_000, "Customs revenue transfer");
  const imp = await h.post("/api/reconciliation/import", { accountId: "SY-CBS-TSA-0001" });
  assert.equal(imp.status, 200, JSON.stringify(imp.body));
  const period = imp.body.period;
  assert.ok(imp.body.matched >= 5, JSON.stringify(imp.body));
  assert.equal((await h.post("/api/reconciliation/import", { accountId: "SY-CBS-TSA-0001" })).body.added, 0, "re-import adds nothing");

  const view = (await h.get(`/api/reconciliation?accountId=SY-CBS-TSA-0001&period=${period}`)).body;
  const open = view.lines.filter((l: any) => l.match_status === "UNMATCHED");
  assert.deepEqual(open.map((l: any) => [l.direction, l.amount]), [["CRDT", 4_750_000]]);
  assert.ok(view.lines.some((l: any) => l.direction === "CRDT" && l.match_status === "MATCHED" && /^RETURN/.test(l.remittance)), "the return credit matches the returned order");

  const blocked = await h.post("/api/reconciliation/complete", { accountId: "SY-CBS-TSA-0001", period });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.details.unmatched, 1);
  assert.equal((await h.post(`/api/reconciliation/lines/${open[0].id}/explain`, { note: "Revenue – posted by the revenue module" })).status, 200);
  assert.equal((await h.post("/api/reconciliation/complete", { accountId: "SY-CBS-TSA-0001", period })).status, 200);
  assert.equal((await h.post("/api/reconciliation/import", { accountId: "SY-CBS-TSA-0001" })).status, 409, "closed period");

  const after = await ind();
  assert.deepEqual([after.numerator, after.denominator], [7, 10]);
  const trail = (await (await app.as("auditor.cofc")).get("/api/audit/verify")).body;
  assert.equal(trail.valid, true);
});

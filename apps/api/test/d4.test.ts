/**
 * D4 – configurable rules and workflows, roles, delegation, reporting, audit
 * (15% of the demonstration score), plus receipts, the Citizen's Budget
 * Helpdesk, payroll and the remaining live indicators (4, 6, 7, 8).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApp, startCbs } from "./helpers.js";

let app: Awaited<ReturnType<typeof startApp>>;
let cbs: Awaited<ReturnType<typeof startCbs>>;
before(async () => { cbs = await startCbs(); app = await startApp(); });
after(async () => { await app.stop(); await cbs.stop(); });

const today = () => new Date().toISOString().slice(0, 10);
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const pub = async (path: string, body: any) => {
  const r = await fetch(app.base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

async function request(su: string, line: string, amount: number) {
  const u = await app.as(su);
  const c = await u.post("/api/documents", { budgetLineId: line, supplierName: app.supplier.name, supplierIban: app.supplier.iban, description: "School supplies batch", amount });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  return c.body.id as number;
}

test("workflow route is configuration: new requests follow it, requests in progress keep theirs", async () => {
  const admin = await app.as("admin"), su = await app.as("su.education"), min = await app.as("min.education"), hq = await app.as("treasury.hq");
  const before = await request("su.education", "0410-05-2211", 600_000);
  assert.equal((await su.post(`/api/documents/${before}/submit`)).body.status, "SUBMITTED");

  assert.equal((await admin.post("/api/rules", { key: "WORKFLOW_ROUTE", scope: "MIN-0410", value: { steps: ["HQ", "MINISTRY"] }, effectiveFrom: today() })).status, 400);
  const set = await admin.post("/api/rules", { key: "WORKFLOW_ROUTE", scope: "MIN-0410", value: { steps: ["MINISTRY", "HQ"] }, effectiveFrom: today(), note: "Pilot: simplified route" });
  assert.equal(set.status, 200, JSON.stringify(set.body));

  const after = await request("su.education", "0410-05-2211", 600_000);
  const s = await su.post(`/api/documents/${after}/submit`);
  assert.deepEqual([s.body.status, s.body.visaRequired, s.body.route], ["SUBMITTED", false, ["MINISTRY", "HQ"]]);
  assert.equal((await min.post(`/api/documents/${after}/actions/approve`)).body.status, "AWAITING_HQ");
  const view = await hq.get(`/api/documents/${after}`);
  assert.deepEqual(view.body.routeSteps, ["MINISTRY", "HQ"]);
  assert.ok(view.body.checks?.length === 3, "with no RTO step the second-level controls run at HQ");
  assert.equal((await hq.post(`/api/documents/${after}/actions/authorise`)).body.status, "AUTHORISED");

  // the earlier request still goes through the visa and the Regional Treasury
  assert.equal((await min.post(`/api/documents/${before}/actions/approve`)).body.status, "AWAITING_VISA");
});

test("delegation: the delegate acts for the delegator, both are recorded, revocation ends it", async () => {
  const id = await request("su.health", "0203-01-2231", 200_000);
  await (await app.as("su.health")).post(`/api/documents/${id}/submit`);
  await (await app.as("min.health")).post(`/api/documents/${id}/actions/approve`);
  const dam = await app.as("rto.damascus"), ale = await app.as("rto.aleppo");
  assert.equal((await ale.post(`/api/documents/${id}/actions/approve`)).status, 403, "no delegation yet");

  assert.equal((await dam.post("/api/delegations", { toUsername: "rto.aleppo", startsOn: today(), endsOn: inDays(7), reason: "short" })).body.error, "delegation.reason_required");
  const d = await dam.post("/api/delegations", { toUsername: "rto.aleppo", startsOn: today(), endsOn: inDays(7), reason: "Annual leave – Aleppo office covers" });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.equal((await dam.post("/api/delegations", { toUsername: "rto.aleppo", startsOn: inDays(2), endsOn: inDays(3), reason: "Annual leave – Aleppo office covers" })).status, 409, "no overlapping delegation");
  assert.equal((await (await app.as("su.health")).post("/api/delegations", { toUsername: "rto.aleppo", startsOn: today(), endsOn: inDays(1), reason: "Not an approver at all" })).status, 403);

  assert.ok((await ale.get("/api/documents?scope=inbox")).body.some((x: any) => x.id === id), "the item is in the delegate's inbox");
  const view = await ale.get(`/api/documents/${id}`);
  assert.equal(view.body.actingFor.username, "rto.damascus");
  assert.equal((await ale.post(`/api/documents/${id}/actions/approve`)).body.status, "AWAITING_HQ");
  const doc = (await (await app.as("auditor.cofc")).get(`/api/documents/${id}`)).body;
  const rto = doc.approvals.find((a: any) => a.step === "RTO");
  assert.deepEqual([rto.username, rto.behalf_username], ["rto.aleppo", "rto.damascus"]);
  const ex = (await (await app.as("auditor.cofc")).get("/api/audit/exceptions")).body;
  assert.ok(ex.delegatedDecisions.some((x: any) => x.ref === doc.ref && x.on_behalf_of === "rto.damascus"));

  assert.equal((await dam.post(`/api/delegations/${d.body.id}/revoke`)).status, 200);
  const id2 = await request("su.health", "0203-01-2231", 100_000);
  await (await app.as("su.health")).post(`/api/documents/${id2}/submit`);
  await (await app.as("min.health")).post(`/api/documents/${id2}/actions/approve`);
  assert.equal((await ale.post(`/api/documents/${id2}/actions/approve`)).status, 403, "revoked");
});

test("segregation of duties holds even under delegation", async () => {
  const hq = await app.as("treasury.hq"), dam = await app.as("rto.damascus");
  await hq.post("/api/delegations", { toUsername: "rto.damascus", startsOn: today(), endsOn: inDays(3), reason: "Mission abroad – RTO Damascus covers HQ" });
  const id = await request("su.health", "0203-01-2231", 150_000);
  await (await app.as("su.health")).post(`/api/documents/${id}/submit`);
  await (await app.as("min.health")).post(`/api/documents/${id}/actions/approve`);
  assert.equal((await dam.post(`/api/documents/${id}/actions/approve`)).body.status, "AWAITING_HQ");
  const tryHq = await dam.post(`/api/documents/${id}/actions/authorise`);
  assert.deepEqual([tryHq.status, tryHq.body.error], [403, "document.segregation_of_duties"]);
  assert.equal((await hq.post(`/api/documents/${id}/actions/authorise`)).body.status, "AUTHORISED");
});

test("users and roles: create, first-login password change, lock-out, deactivation", async () => {
  const admin = await app.as("admin");
  assert.equal((await admin.post("/api/users", { username: "bad.mix", role: "FIN_CONTROLLER", orgId: "MIN-0203", fullNameEn: "X Y", fullNameAr: "س ص" })).body.error, "users.role_org_mismatch");
  const c = await admin.post("/api/users", { username: "approver2.health", role: "MINISTRY_APPROVER", orgId: "MIN-0203", fullNameEn: "Salma Aziz", fullNameAr: "سلمى عزيز" });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const login = (pw: string) => pub("/api/auth/login", { username: "approver2.health", password: pw });
  const first = await login(c.body.temporaryPassword);
  assert.equal(first.body.mustChangePassword, true);
  const h = { "content-type": "application/json", authorization: `Bearer ${first.body.token}` };
  const change = (next: string) => fetch(app.base + "/api/me/password", { method: "POST", headers: h, body: JSON.stringify({ current: c.body.temporaryPassword, next }) });
  assert.equal((await (await change("short1")).json()).error, "auth.weak_password");
  assert.equal((await change("Damascus2027safe")).status, 200);

  for (let i = 0; i < 5; i++) assert.equal((await login("wrong-password-1")).status, 401);
  const locked = await login("Damascus2027safe");
  assert.deepEqual([locked.status, locked.body.error], [423, "auth.locked"]);
  assert.equal((await admin.post(`/api/users/${c.body.id}`, { unlock: true })).status, 200);
  const ok = await login("Damascus2027safe");
  assert.equal(ok.status, 200);

  assert.equal((await admin.post(`/api/users/${c.body.id}`, { active: false })).status, 200);
  const me = await fetch(app.base + "/api/me", { headers: { authorization: `Bearer ${ok.body.token}` } });
  assert.equal(me.status, 401, "a deactivated user's session ends at once");
  const self = (await admin.get("/api/me")).body.id;
  assert.equal((await admin.post(`/api/users/${self}`, { active: false })).body.error, "users.not_on_self");
});

test("reports are scoped and export to CSV; the auditor searches the trail", async () => {
  const su = (await (await app.as("su.health")).get("/api/reports/budget-execution")).body;
  assert.ok(su.length > 0 && su.every((r: any) => r.spending_unit_id === "SU-0203-01"));
  const hq = (await (await app.as("treasury.hq")).get("/api/reports/budget-execution")).body;
  assert.ok(hq.some((r: any) => r.spending_unit_id === "SU-0410-05"));
  const tok = (await pub("/api/auth/login", { username: "auditor.cofc", password: "pw" })).body.token;
  const csv = await fetch(app.base + "/api/audit/search?actor=rto.aleppo&format=csv", { headers: { authorization: `Bearer ${tok}` } });
  assert.match(csv.headers.get("content-type") ?? "", /text\/csv/);
  const bytes = Buffer.from(await csv.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "UTF-8 byte-order mark so Arabic opens correctly in Excel");
  const text = bytes.subarray(3).toString("utf8");
  assert.ok(text.startsWith("id,ts,actor,action"));
  assert.ok(text.split("\r\n").slice(1).filter(Boolean).every(l => l.includes(",rto.aleppo,")), text.slice(0, 600));
  assert.equal((await (await app.as("su.health")).get("/api/audit/search")).status, 403);
});

test("official receipts: issue, verify publicly, cancel by reversal, offline replay", async () => {
  const cash = await app.as("cashier.damascus");
  assert.equal((await (await app.as("su.health")).post("/api/receipts", { revenueCode: "1101", payerName: "X Trading", amount: 10, method: "CASH" })).status, 403);
  const r = await cash.post("/api/receipts", { revenueCode: "1101", payerName: "Barada Trading Co.", payerId: "TIN-0099812", amount: 1_250_000, method: "BANK_TRANSFER", clientRef: "offline-rc-00000001" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.ref, /^RC-\d{4}-\d{6}$/);
  const again = await cash.post("/api/receipts", { revenueCode: "1101", payerName: "Barada Trading Co.", amount: 1_250_000, method: "BANK_TRANSFER", clientRef: "offline-rc-00000001" });
  assert.deepEqual([again.body.ref, again.body.replay], [r.body.ref, true]);

  const v = await pub("/api/public/receipts/verify", { ref: r.body.ref, code: r.body.verifyCode });
  assert.equal(v.body.valid, true);
  assert.equal(v.body.receipt.amount, 1_250_000);
  assert.equal(v.body.receipt.payer_name, undefined, "no personal data on the public check");
  assert.equal((await pub("/api/public/receipts/verify", { ref: r.body.ref, code: "0000000000" })).body.valid, false);

  assert.equal((await cash.post(`/api/receipts/${r.body.id}/cancel`, { reason: "short" })).status, 400);
  assert.equal((await cash.post(`/api/receipts/${r.body.id}/cancel`, { reason: "Duplicate of a bank-transfer receipt" })).status, 200);
  assert.equal((await pub("/api/public/receipts/verify", { ref: r.body.ref, code: r.body.verifyCode })).body.receipt.status, "CANCELLED");
  const verify = (await (await app.as("auditor.cofc")).get("/api/audit/verify")).body;
  assert.equal(verify.valid, true);
});

test("Citizen's Budget Helpdesk: ask without an account, follow up with the code, staff answer", async () => {
  const { resetPublicLimits } = await import("../src/modules/helpdesk/helpdesk.service.js");
  resetPublicLimits();
  const q = await pub("/api/public/helpdesk", { category: "BUDGET", lang: "ar", question: "ما هي اعتمادات مديرية صحة دمشق لهذا العام؟", contact: "" });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  assert.equal((await pub("/api/public/helpdesk/status", { ref: q.body.ref, accessCode: "WRONG000" })).status, 404);
  assert.equal((await pub("/api/public/helpdesk", { category: "BUDGET", lang: "ar", question: "spam spam spam spam", website: "http://x" })).status, 400, "honeypot");

  const desk = await app.as("helpdesk.mof");
  const t = (await desk.get("/api/helpdesk/tickets?status=OPEN")).body.find((x: any) => x.ref === q.body.ref);
  assert.equal((await desk.post(`/api/helpdesk/tickets/${t.id}/answer`, { answer: "Too short" })).status, 400);
  assert.equal((await desk.post(`/api/helpdesk/tickets/${t.id}/answer`, { answer: "الاعتمادات منشورة في بوابة الشفافية ضمن جدول الوزارات، وتبلغ 26.5 مليون ليرة." })).status, 200);
  const st = await pub("/api/public/helpdesk/status", { ref: q.body.ref, accessCode: q.body.accessCode });
  assert.equal(st.body.status, "ANSWERED");
  assert.equal((await (await app.as("su.health")).get("/api/helpdesk/tickets")).status, 403);

  const portal = await fetch(app.base + "/api/public/budget").then(r => r.json());
  assert.ok(portal.ministries.length === 2 && portal.revenue.length === 3);

  resetPublicLimits();
  const codes: number[] = [];
  for (let i = 0; i < 11; i++) codes.push((await pub("/api/public/helpdesk", { category: "OTHER", lang: "en", question: `Repeated question number ${i}` })).status);
  assert.equal(codes.filter(c => c === 429).length, 1, "ten per hour per address");
  resetPublicLimits();
});

test("payroll run excludes staff not active at MoAD; four-eyes approval; indicators 4 and 7 move", async () => {
  const hr = await app.as("hr.mof"), hq = await app.as("treasury.hq");
  const ind = async (n: number) => (await hq.get("/api/indicators")).body.find((i: any) => i.id === n);
  const i4 = await ind(4), i7 = await ind(7);
  assert.deepEqual([i4.numerator, i4.denominator], [36, 48]);
  const period = new Date().toISOString().slice(0, 7);
  const run = await hr.post("/api/payroll/runs", { period, ministryId: "MIN-0203" });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(run.body.employees + run.body.excluded, 20);
  const detail = (await hr.get(`/api/payroll/runs/${run.body.id}`)).body;
  assert.ok(detail.lines.filter((l: any) => !l.included).every((l: any) => l.exclusion));
  assert.equal((await hr.post(`/api/payroll/runs/${run.body.id}/approve`)).status, 403);
  assert.equal((await hq.post(`/api/payroll/runs/${run.body.id}/approve`)).status, 200);
  assert.equal((await hr.post("/api/payroll/runs", { period, ministryId: "MIN-0203" })).body.error, "payroll.already_approved");
  const n4 = await ind(4);
  assert.equal(n4.detail.period, period);
  assert.equal(n4.numerator, run.body.employees, "only the latest approved period counts");

  const emp = (await hr.get("/api/payroll/employees")).body.find((e: any) => !e.biometric_enrolled);
  assert.equal((await hr.post(`/api/payroll/employees/${emp.employee_no}/biometric`, { deviceRef: "BIO-DAM-0042" })).status, 200);
  assert.equal((await hr.post(`/api/payroll/employees/${emp.employee_no}/biometric`, { deviceRef: "BIO-DAM-0042" })).status, 409);
  assert.equal((await ind(7)).numerator, i7.numerator + 1);
});

test("all eight results indicators are live; 8 is shown as an estimate with its method", async () => {
  const all = (await (await app.as("auditor.cofc")).get("/api/indicators")).body;
  assert.deepEqual(all.map((i: any) => i.status), Array(8).fill("live"));
  const i6 = all.find((i: any) => i.id === 6), i8 = all.find((i: any) => i.id === 8);
  assert.equal(i6.detail.portal, true);
  assert.ok(i8.value > 0 && i8.detail.transactions > 0 && i8.detail.factors.kgPerDocument > 0);
  assert.match(i8.source, /estimate/);
});

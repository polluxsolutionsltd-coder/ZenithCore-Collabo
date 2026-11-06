/**
 * D2 – interoperability (20% of the demonstration score).
 * MoAD personnel API: authentication, validation with per-record errors,
 * idempotent replay and conflict, rate limiting, correlation IDs, the
 * monitoring console, and live indicator 5. CBS timeouts are covered in d3.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApp, startCbs } from "./helpers.js";

let app: Awaited<ReturnType<typeof startApp>>;
let cbs: Awaited<ReturnType<typeof startCbs>>;
let KEY: string;
before(async () => { cbs = await startCbs(); app = await startApp(); KEY = (await import("../src/db/seed.js")).DEMO_MOAD_KEY; });
after(async () => { await app.stop(); await cbs.stop(); });

const rec = (nid: string, extra: any = {}) => ({ nationalId: nid, fullNameAr: "سارة الحلبي", fullNameEn: "Sara Al-Halabi", positionId: "POS-0203-900", ministryId: "MIN-0203", grade: "2A", status: "ACTIVE", ...extra });

async function push(body: any, headers: Record<string, string> = {}) {
  const r = await fetch(app.base + "/api/v1/moad/personnel", { method: "POST", headers: { "content-type": "application/json", "x-api-key": KEY, ...headers }, body: JSON.stringify(body) });
  return { status: r.status, headers: r.headers, body: await r.json() };
}

test("partner calls need a valid API key", async () => {
  assert.equal((await push({ records: [rec("12345678901")] }, { "x-api-key": "", "idempotency-key": "k-000001" })).status, 401);
  assert.equal((await push({ records: [rec("12345678901")] }, { "x-api-key": "wrong-key-0000000000", "idempotency-key": "k-000001" })).status, 401);
  assert.equal((await push({ records: [rec("12345678901")] })).body.error, "integration.idempotency_key_required");
});

test("valid records are accepted, invalid ones are reported one by one", async () => {
  const r = await push({ records: [
    rec("30000079190", { ministryId: "MIN-0410" }),     // employee 10, already in registry: update
    rec("123"),                                           // bad national ID
    rec("40000000001", { fullNameAr: "Sara" }),           // name not in Arabic
    rec("40000000002", { ministryId: "MIN-9999" }),       // unknown ministry
    rec("40000000003", { status: "ON_LEAVE", grade: "X" }), // two errors in one record
    rec("40000000004"),
  ] }, { "idempotency-key": "batch-0001", "x-correlation-id": "corr-batch-0001" });
  assert.equal(r.status, 207);
  assert.equal(r.headers.get("x-correlation-id"), "corr-batch-0001");
  assert.equal(r.body.accepted, 2);
  assert.equal(r.body.rejected, 4);
  assert.deepEqual(r.body.errors.map((e: any) => [e.index, e.field, e.code]), [
    [1, "nationalId", "moad.national_id_format"],
    [2, "fullNameAr", "moad.arabic_name_required"],
    [3, "ministryId", "moad.unknown_ministry"],
    [4, "grade", "moad.grade_format"],
    [4, "status", "moad.status_invalid"],
  ]);
});

test("same Idempotency-Key and body replays the stored answer; a different body is refused", async () => {
  const body = { records: [rec("40000000010")] };
  const first = await push(body, { "idempotency-key": "batch-0002", "x-correlation-id": "corr-first" });
  assert.equal(first.status, 200);
  const again = await push(body, { "idempotency-key": "batch-0002", "x-correlation-id": "corr-retry" });
  assert.equal(again.status, 200);
  assert.equal(again.headers.get("idempotent-replay"), "true");
  assert.equal(again.headers.get("x-original-correlation-id"), "corr-first");
  assert.deepEqual(again.body, first.body);
  const clash = await push({ records: [rec("40000000011")] }, { "idempotency-key": "batch-0002" });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.error, "integration.idempotency_conflict");
  // processed once: one message row, two attempts recorded
  const admin = await app.as("admin");
  const msgs = (await admin.get("/api/integration/messages?correlationId=corr-first")).body;
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].attempts, 2);
  assert.equal(msgs[0].status, "PROCESSED");
});

test("an all-invalid batch is rejected with 422", async () => {
  const r = await push({ records: [rec("1")] }, { "idempotency-key": "batch-0003" });
  assert.equal(r.status, 422);
  assert.equal(r.body.accepted, 0);
});

test("indicator 5 moves when MoAD sends the missing employees", async () => {
  const ind = async () => (await (await app.as("admin")).get("/api/indicators")).body.find((i: any) => i.id === 5);
  const before = await ind();
  assert.equal(before.status, "live");
  assert.deepEqual([before.numerator, before.denominator], [36, 40]);
  const { sampleNid } = await import("../src/db/seed.js");
  // employee 39 is MIN-0203 (odd), employee 40 is MIN-0410; employee 37 comes back from retirement
  const r = await push({ records: [
    rec(sampleNid(39), { ministryId: "MIN-0203" }), rec(sampleNid(40), { ministryId: "MIN-0410" }), rec(sampleNid(37), { ministryId: "MIN-0203" }),
  ] }, { "idempotency-key": "batch-0004" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const after = await ind();
  assert.deepEqual([after.numerator, after.denominator], [39, 40]);
  const ex = (await (await app.as("auditor.cofc")).get("/api/moad/match")).body.exceptions;
  assert.deepEqual(ex.map((e: any) => e.result), ["DIFFERENT_MINISTRY"]);
});

test("monitoring console is limited to admin, auditor and treasury", async () => {
  assert.equal((await (await app.as("su.health")).get("/api/integration/messages")).status, 403);
  const s = (await (await app.as("auditor.cofc")).get("/api/integration/summary")).body;
  assert.ok(s.rows.some((r: any) => r.partner === "MOAD" && r.direction === "IN"));
  const one = (await (await app.as("admin")).get("/api/integration/messages?partner=MOAD")).body[0];
  const detail = (await (await app.as("admin")).get(`/api/integration/messages/${one.id}`)).body;
  assert.ok(detail.request && detail.response);
});

test("rate limit answers 429 with a retry hint", async () => {
  const { db } = await import("../src/db/index.js");
  const { resetRateLimits } = await import("../src/modules/integration/gateway.service.js");
  await db().query("UPDATE api_clients SET rate_per_minute = 3 WHERE id = 'MOAD'");
  resetRateLimits();
  const codes: number[] = [];
  for (let i = 0; i < 5; i++) codes.push((await push({ records: [rec("40000000020")] }, { "idempotency-key": "rate-000" + i })).status);
  assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  await db().query("UPDATE api_clients SET rate_per_minute = 120 WHERE id = 'MOAD'");
  resetRateLimits();
});

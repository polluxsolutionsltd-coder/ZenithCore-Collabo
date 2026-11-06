// Browser rehearsal of scenarios D2 and D3, run against a seeded server with the CBS sandbox:
//   npm run db:seed; npm run start:cbs & DEMO_MODE=1 CBS_URL=http://localhost:8090 npm start
// Usage: node scripts/e2e-d2d3.mjs [baseUrl] [cbsUrl] [screenshotDir]
// Prepares authorised orders through the API, then sends, rejects, reissues, returns and
// reconciles them through the user interface. Exits non-zero if any step fails.
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.argv[2] ?? "http://localhost:8080";
const CBS = process.argv[3] ?? "http://localhost:8090";
const OUT = process.argv[4] ?? "e2e-shots-d2d3";
const PW = process.env.DEMO_PASSWORD ?? "Demo@2027";
const IBAN = process.env.DEMO_IBAN ?? "SY600010000000123456789012";
const MOAD_KEY = process.env.MOAD_API_KEY ?? "zc-demo-moad-7f3a9c2e51b84d06";
fs.mkdirSync(OUT, { recursive: true });

// ---- API set-up -------------------------------------------------------------
const tokens = {};
async function api(user, method, path, body) {
  if (!tokens[user]) {
    const r = await fetch(BASE + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: user, password: PW }) });
    tokens[user] = (await r.json()).token;
  }
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json", authorization: `Bearer ${tokens[user]}` }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(`${user} ${method} ${path} → ${r.status} ${JSON.stringify(j)}`);
  return j;
}
async function authorisedOrder(amount, what) {
  const d = await api("su.health", "POST", "/api/documents", { budgetLineId: "0203-01-2221", supplierName: "Al-Sham Medical Supplies", supplierIban: IBAN, description: what, amount });
  await api("su.health", "POST", `/api/documents/${d.id}/submit`, {});
  await api("min.health", "POST", `/api/documents/${d.id}/actions/approve`, {});
  if (amount >= 500_000) await api("fc.health", "POST", `/api/documents/${d.id}/actions/grant_visa`, {});
  await api("rto.damascus", "POST", `/api/documents/${d.id}/actions/approve`, {});
  const a = await api("treasury.hq", "POST", `/api/documents/${d.id}/actions/authorise`, {});
  return a.paymentOrder.ref;
}
const fault = mode => fetch(CBS + "/sandbox/fault", { method: "POST", body: JSON.stringify({ mode, count: 1 }) });

const refs = [
  await authorisedOrder(800_000, "Insulin and syringes – Q1"),
  await authorisedOrder(300_000, "Laboratory reagents"),
  await authorisedOrder(450_000, "Dressings and gauze"),
];
await fetch(CBS + "/sandbox/credit", { method: "POST", body: JSON.stringify({ account: "SY-CBS-TSA-0001", amount: 4_750_000, remittance: "Customs revenue transfer" }) });

// D2: MoAD sends a batch (one record invalid) and then repeats it (idempotent replay)
const batch = { records: [
  { nationalId: "30000308841", fullNameAr: "نادين حموي", positionId: "POS-0203-039", ministryId: "MIN-0203", grade: "3A", status: "ACTIVE" },
  { nationalId: "30000316760", fullNameAr: "سلمى خوري", positionId: "POS-0410-040", ministryId: "MIN-0410", grade: "2B", status: "ACTIVE" },
  { nationalId: "123", fullNameAr: "Test", positionId: "", ministryId: "MIN-9999", grade: "Z", status: "UNKNOWN" },
] };
for (const corr of ["demo-moad-batch-1", "demo-moad-batch-1-retry"]) {
  const r = await fetch(BASE + "/api/v1/moad/personnel", { method: "POST", headers: { "content-type": "application/json", "x-api-key": MOAD_KEY, "idempotency-key": "MOAD-2027-0001", "x-correlation-id": corr }, body: JSON.stringify(batch) });
  if (r.status !== 207) throw new Error(`MoAD batch → ${r.status}`);
}

// ---- Browser ----------------------------------------------------------------
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const errors = [];
page.on("pageerror", e => errors.push(String(e)));
let n = 0;
const shot = async name => page.screenshot({ path: `${OUT}/${String(++n).padStart(2, "0")}-${name}.png`, fullPage: true });
async function login(user, lang) {
  await page.goto(BASE + "/#/inbox");
  await page.evaluate(() => localStorage.removeItem("zc.token"));
  await page.evaluate(l => localStorage.setItem("zc.lang", l), lang);
  await page.reload();
  await page.locator("input[autocomplete=username]").fill(user);
  await page.locator("input[type=password]").fill(PW);
  await page.locator("form button.btn.primary").click();
  await page.waitForSelector("header.top");
}
async function selectOrder(ref) {
  await page.goto(BASE + "/#/payments");
  await page.reload();
  await page.locator("tr.clickable", { hasText: ref }).click();
  await page.waitForSelector(`.panel b.mono:text("${ref}")`);
}
const chip = () => page.locator(".grid2 .panel .chip").first();

await login("treasury.hq", "en");
// D3.1 happy path
await selectOrder(refs[0]);
await shot("payment-order-issued");
await page.getByRole("button", { name: "Send to CBS" }).click();
await page.waitForFunction(() => document.querySelector(".grid2 .panel .chip")?.textContent === "Settled");
await shot("payment-settled-ledger");

// D3.2 rejection and reissue
await fault("reject");
await selectOrder(refs[1]);
await page.getByRole("button", { name: "Send to CBS" }).click();
await page.waitForFunction(() => document.querySelector(".grid2 .panel .chip")?.textContent === "Rejected");
await shot("payment-rejected-ac04");
await page.getByRole("button", { name: "Reissue" }).click();
await page.locator(".grid2 .panel textarea").fill("Supplier confirmed the account in writing");
await page.locator(".grid2 .panel form .btn.primary").click();
await page.waitForFunction(() => !document.querySelector(".grid2 .panel textarea"));
const reissued = (await api("treasury.hq", "GET", "/api/payment-orders?status=ISSUED")).find(p => p.replaces_id).ref;
await selectOrder(reissued);
await page.getByRole("button", { name: "Send to CBS" }).click();
await page.waitForFunction(() => document.querySelector(".grid2 .panel .chip")?.textContent === "Settled");
await shot("reissued-and-settled");

// D3.3 timeout handled without double payment, then a bank return
await fault("return");
await selectOrder(refs[2]);
await page.getByRole("button", { name: "Send to CBS" }).click();
await page.waitForFunction(() => document.querySelector(".grid2 .panel .chip")?.textContent === "Settled");
await page.getByRole("button", { name: "Check for returns" }).click();
await page.waitForSelector(".note.ok");
await selectOrder(refs[2]);
if ((await chip().textContent()) !== "Returned by the bank") throw new Error("return not applied");
await shot("returned-and-reversed");

// D3.4 reconciliation, in Arabic
await login("treasury.hq", "ar");
await page.goto(BASE + "/#/reconciliation");
await page.getByRole("button", { name: "استيراد كشف اليوم (camt.053)" }).click();
await page.waitForSelector(".note.ok");
await shot("reconciliation-imported-ar");
await page.locator("td input").first().fill("إيراد جمركي – يُقيد في وحدة الإيرادات");
await page.getByRole("button", { name: "تفسير" }).click();
await page.waitForFunction(() => !document.querySelector("td input"));
await page.getByRole("button", { name: "إتمام التسوية" }).click();
await page.waitForSelector(".note.ok");
await shot("reconciliation-complete-ar");

// D2 monitoring console and indicators
await login("auditor.cofc", "en");
await page.goto(BASE + "/#/integration");
await page.waitForSelector("tr.clickable");
await shot("integration-console");
await page.locator("tr.clickable", { hasText: "MOAD" }).first().click();
await page.waitForSelector("pre.code");
await shot("integration-message-detail");
await page.goto(BASE + "/#/dashboard");
await page.waitForSelector(".ind-grid");
await shot("indicators");
await page.goto(CBS + "/sandbox");
await page.waitForSelector("#pay tr:nth-child(2)");
await shot("cbs-sandbox");

await browser.close();
if (errors.length) { console.error("Page errors:", errors); process.exit(1); }
console.log(`D2/D3 rehearsal passed – ${n} screenshots in ${OUT}/`);

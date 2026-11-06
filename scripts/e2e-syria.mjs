// Browser rehearsal of the Syria-specific features (Milestone 4), run against a freshly
// seeded server with the CBS sandbox (see README). It produces the screenshots used in
// the "Syria spotlight" slots of docs/demo-script.md.
// Usage: node scripts/e2e-syria.mjs [baseUrl] [screenshotDir]
// Optional: TAMPER_DB_URL=postgresql://… also shows a signature failing after a direct database edit (needs psql).
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const BASE = process.argv[2] ?? "http://localhost:8080";
const OUT = process.argv[3] ?? "e2e-shots-syria";
const PW = process.env.DEMO_PASSWORD ?? "Demo@2027";
const IBAN = process.env.DEMO_IBAN ?? "SY600010000000123456789012";
fs.mkdirSync(OUT, { recursive: true });

const tokens = {};
async function api(user, method, path, body) {
  if (!tokens[user]) tokens[user] = (await (await fetch(BASE + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: user, password: PW }) })).json()).token;
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json", authorization: `Bearer ${tokens[user]}` }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(`${user} ${method} ${path} → ${r.status} ${JSON.stringify(j)}`);
  return j;
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", e => errors.push(String(e)));
let n = 0;
const shot = async name => page.screenshot({ path: `${OUT}/${String(++n).padStart(2, "0")}-${name}.png`, fullPage: true });
async function login(user, lang) {
  await page.goto(BASE + "/#/inbox");
  await page.evaluate(l => { localStorage.removeItem("zc.token"); localStorage.removeItem("zc.mustChange"); localStorage.setItem("zc.lang", l); }, lang);
  await page.reload();
  await page.locator("input[autocomplete=username]").fill(user);
  await page.locator("input[type=password]").fill(PW);
  await page.locator("form button.btn.primary").click();
  await page.waitForSelector("header.top");
}
const go = async hash => { await page.goto(BASE + "/#" + hash); await page.reload(); await page.waitForSelector("main h1"); };
const form = () => page.locator("main form.form");

// 1. Virement within the ministry's authority: requested by the spending unit, approved and signed by the ministry
await login("su.health", "en");
await go("/virements");
await page.waitForSelector("[data-testid=vr-limits]");
await form().locator("select").nth(0).selectOption("0203-01-2221");
await form().locator("select").nth(1).selectOption("0203-01-2231");
await form().locator("input").nth(0).fill("400000");
await form().locator("input").nth(1).fill("Urgent repair of the dialysis unit");
await page.getByRole("button", { name: "Submit virement" }).click();
await page.waitForSelector("text=Ministry level (within the ministry's authority)");
await shot("virement-requested-ministry-level");

await login("min.health", "ar");
await go("/virements");
await page.getByRole("button", { name: "الموافقة والتوقيع" }).first().click();
await page.waitForSelector(".chip.ok:text('توقيع صحيح')");
await shot("virement-approved-signed-ar");

// 2. Another chapter goes to the Ministry of Finance; salaries are protected
await login("su.health", "en");
await go("/virements");
await form().locator("select").nth(0).selectOption("0203-01-2221");
await form().locator("select").nth(1).selectOption("0203-01-3121");
await form().locator("input").nth(0).fill("200000");
await form().locator("input").nth(1).fill("Buy a replacement autoclave");
await page.getByRole("button", { name: "Submit virement" }).click();
await page.waitForSelector("text=Ministry of Finance level (moves money to another chapter)");
await form().locator("select").nth(0).selectOption("0203-01-2111");
await form().locator("select").nth(1).selectOption("0203-01-2221");
await form().locator("input").nth(0).fill("100000");
await form().locator("input").nth(1).fill("Move unspent salaries to medicines");
await page.getByRole("button", { name: "Submit virement" }).click();
await page.waitForSelector("text=Chapter 21 is protected");
await shot("virement-mof-level-and-protected-chapter");

await login("budget.mof", "fr");
await go("/virements");
await page.getByRole("button", { name: "Approuver et signer" }).first().click();
await page.waitForSelector(".chip.ok:text('Signature valide')");
await shot("virement-approved-by-mof-fr");

// 3. Donor line in USD: request, approvals, payment in dollars through the CBS sandbox
const doc = await api("su.health", "POST", "/api/documents", { budgetLineId: "0203-01-2224", supplierName: "Al-Shifa Medical Supplies LLC", supplierIban: IBAN, description: "Cold-chain vaccine delivery", amount: 4000 });
await api("su.health", "POST", `/api/documents/${doc.id}/submit`);
await api("min.health", "POST", `/api/documents/${doc.id}/actions/approve`);
await api("rto.damascus", "POST", `/api/documents/${doc.id}/actions/approve`).catch(async () => {
  await api("fc.health", "POST", `/api/documents/${doc.id}/actions/grant_visa`);
  await api("rto.damascus", "POST", `/api/documents/${doc.id}/actions/approve`);
});
const auth = await api("treasury.hq", "POST", `/api/documents/${doc.id}/actions/authorise`);
const sent = await api("treasury.hq", "POST", `/api/payment-orders/${auth.paymentOrder.id}/send`);
if (sent.status !== "SETTLED") throw new Error("USD payment not settled: " + JSON.stringify(sent));
await login("treasury.hq", "en");
await go(`/documents/${doc.id}`);
await page.waitForSelector("text=Donor line · USD");
await page.getByTestId("verify-signatures").click();
await page.waitForSelector("text=electronic signatures verify");
await shot("donor-usd-payment-signatures-valid");

// 4. Income tax on gross pay, from the dated rule
await login("hr.mof", "en");
await go("/payroll");
await page.getByRole("button", { name: "Calculate run" }).click();
await page.waitForSelector("[data-testid=tax-rule]");
await shot("payroll-gross-tax-net");

// 5. Revenue sharing with the governorate
await api("cashier.damascus", "POST", "/api/receipts", { revenueCode: "1401", payerName: "Barada Trading Co.", amount: 300000, method: "CASH" });
await api("cashier.damascus", "POST", "/api/receipts", { revenueCode: "1201", payerName: "Qasioun Pharma", amount: 1000000, method: "BANK_TRANSFER" });
await api("cashier.damascus", "POST", "/api/receipts", { revenueCode: "1101", payerName: "Barada Trading Co.", amount: 2500000, method: "BANK_TRANSFER" });
await login("treasury.hq", "ar");
await go("/receipts");
await page.waitForSelector("[data-testid=sharing] tbody tr");
await shot("revenue-sharing-ar");

// 6. Legacy budget in old pounds, converted on load with control totals
await login("admin", "en");
await go("/data-load");
await page.waitForSelector("[data-testid=redenomination]");
await page.locator("main textarea").fill(fs.readFileSync(new URL("../samples/budget_lines_old_pounds.csv", import.meta.url), "utf8"));
await page.getByRole("button", { name: "Check" }).click();
await page.waitForSelector("text=3 rows are ready to load.");
await shot("legacy-old-pounds-control-totals");
await page.getByRole("button", { name: "Load", exact: true }).click();
await page.waitForSelector("text=3 rows loaded.");

// 7. The law changes: a new income-tax rule is entered with its date, no release needed
await go("/rules");
await page.locator("form.form select").first().selectOption("INCOME_TAX");
await page.waitForFunction(() => document.querySelector("form.form textarea")?.value.includes("exemption"));
await shot("rules-income-tax-json-editor");

// 8. Auditor: all signatures checked; optionally show one failing after a direct database edit
await login("auditor.cofc", "en");
await go("/audit");
await page.getByRole("button", { name: "Check all signatures" }).click();
await page.waitForSelector("[data-testid=sig-sweep] .note.ok");
await shot("auditor-signature-sweep-ok");
if (process.env.TAMPER_DB_URL) {
  const sql = `UPDATE approvals SET amount = amount * 10 WHERE document_id = ${doc.id}`;
  execFileSync("psql", [process.env.TAMPER_DB_URL, "-qc", sql]);
  await page.getByRole("button", { name: "Check all signatures" }).click();
  await page.waitForSelector("[data-testid=sig-sweep] .note.bad");
  await shot("auditor-signature-sweep-tampered");
  execFileSync("psql", [process.env.TAMPER_DB_URL, "-qc", `UPDATE approvals SET amount = amount / 10 WHERE document_id = ${doc.id}`]);
}

await browser.close();
if (errors.length) { console.error("Page errors:", errors); process.exit(1); }
console.log(`Syria rehearsal passed – ${n} screenshots in ${OUT}/`);

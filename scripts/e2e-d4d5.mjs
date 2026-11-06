// Browser rehearsal of scenarios D4 and D5 plus receipts, helpdesk, portal and payroll,
// run against a freshly seeded server with the CBS sandbox (see README).
// Usage: node scripts/e2e-d4d5.mjs [baseUrl] [screenshotDir]
// Also checks basic accessibility on every screen visited: a skip link first in the tab
// order, lang/dir set, and every form control with an accessible name.
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.argv[2] ?? "http://localhost:8080";
const OUT = process.argv[3] ?? "e2e-shots-d4d5";
const PW = process.env.DEMO_PASSWORD ?? "Demo@2027";
const IBAN = process.env.DEMO_IBAN ?? "SY600010000000123456789012";
fs.mkdirSync(OUT, { recursive: true });
const today = new Date().toISOString().slice(0, 10);
const inDays = n => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

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
const errors = [], a11y = [];
page.on("pageerror", e => errors.push(String(e)));
let n = 0;
async function check(label) {
  const r = await page.evaluate(() => {
    const unnamed = [...document.querySelectorAll("input:not([type=hidden]):not(.hp), select, textarea")].filter(el => {
      if (el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || el.closest("label")) return false;
      return !(el.id && document.querySelector(`label[for="${el.id}"]`));
    }).map(el => el.outerHTML.slice(0, 80));
    return { unnamed, lang: document.documentElement.lang, dir: document.documentElement.dir, skip: !!document.querySelector("a.skip") };
  });
  if (r.unnamed.length) a11y.push(`${label}: controls without a name ${JSON.stringify(r.unnamed)}`);
  if (!r.lang || !r.dir) a11y.push(`${label}: lang/dir missing`);
  if (!r.skip && !label.startsWith("login")) a11y.push(`${label}: no skip link`);
}
const shot = async name => { await check(name); await page.screenshot({ path: `${OUT}/${String(++n).padStart(2, "0")}-${name}.png`, fullPage: true }); };
async function login(user, lang, pw = PW) {
  await page.goto(BASE + "/#/inbox");
  await page.evaluate(l => { localStorage.removeItem("zc.token"); localStorage.removeItem("zc.mustChange"); localStorage.setItem("zc.lang", l); }, lang);
  await page.reload();
  await page.locator("input[autocomplete=username]").fill(user);
  await page.locator("input[type=password]").fill(pw);
  await page.locator("form button.btn.primary").click();
  await page.waitForSelector("header.top");
}
const go = async hash => { await page.goto(BASE + "/#" + hash); await page.reload(); await page.waitForSelector("main h1"); };

// 1. Admin (French): approval route as configuration, new user
await login("admin", "fr");
await go("/rules");
await page.locator(".wf-steps li").nth(1).locator("input").uncheck(); // no visa
await page.locator(".wf-steps li").nth(2).locator("input").uncheck(); // no RTO
await page.locator(".panel select").last().selectOption("MIN-0410");
await page.getByRole("button", { name: "Enregistrer" }).last().click();
await page.waitForSelector(".panel .note.ok");
await shot("admin-workflow-route-fr");
await go("/users");
const inputs = page.locator("form.form input");
await inputs.nth(0).fill("approver2.health");
await inputs.nth(1).fill("Salma Aziz");
await inputs.nth(2).fill("سلمى عزيز");
await page.locator("form.form select").nth(1).selectOption("MIN-0203");
await page.getByRole("button", { name: "Créer l’utilisateur" }).click();
await page.waitForSelector(".note.ok b.mono");
const tempPw = await page.locator(".note.ok b.mono").textContent();
await shot("admin-user-created-fr");

// 2. New user signs in with the temporary password and must change it
await login("approver2.health", "en", tempPw);
await page.waitForSelector("text=Change your password");
await shot("first-login-change-password");
const pws = page.locator("form.form input[type=password]");
await pws.nth(0).fill(tempPw); await pws.nth(1).fill("Damascus2027safe"); await pws.nth(2).fill("Damascus2027safe");
await page.locator("form.form .btn.primary").click();
await page.waitForSelector("main h1:text('My inbox')");

// 3. Delegation: RTO Damascus goes on leave; RTO Aleppo covers (Arabic)
await login("rto.damascus", "en");
await go("/delegations");
const d = page.locator("form.form input");
await d.nth(0).fill("rto.aleppo");
await d.nth(1).fill(today); await d.nth(2).fill(inDays(7));
await page.locator("form.form textarea").fill("Annual leave – the Aleppo office covers Damascus");
await page.getByRole("button", { name: "Delegate" }).click();
await page.waitForSelector("td .chip.ok");
await shot("delegation-created");
const doc = await api("su.health", "POST", "/api/documents", { budgetLineId: "0203-01-2231", supplierName: "Al-Sham Medical Supplies", supplierIban: IBAN, description: "Repair of X-ray unit", amount: 350_000 });
await api("su.health", "POST", `/api/documents/${doc.id}/submit`, {});
await api("min.health", "POST", `/api/documents/${doc.id}/actions/approve`, {});
await login("rto.aleppo", "ar");
await go(`/documents/${doc.id}`);
await page.waitForSelector(".note.warn");
await page.getByRole("button", { name: "موافقة" }).click();
await page.waitForSelector(".note.ok");
await shot("delegate-approved-on-behalf-ar");

// 4. Official receipt (Arabic), then the public check
await login("cashier.damascus", "ar");
await go("/receipts");
const rf = page.locator("form.form input");
await rf.nth(0).fill("شركة بردى للتجارة"); await rf.nth(1).fill("TIN-0099812"); await rf.nth(2).fill("1250000");
await page.getByRole("button", { name: "إصدار الإيصال" }).click();
await page.waitForSelector(".note.ok");
await page.getByRole("button", { name: "عرض" }).first().click();
await page.waitForSelector(".receipt");
const rcRef = (await page.locator(".receipt-head b.mono").textContent()).trim();
const rcCode = (await page.locator(".receipt dd b.mono").textContent()).trim();
await shot("receipt-issued-ar");

// 5. Public portal (no sign-in): budget, ask a question, verify the receipt
await page.evaluate(() => { localStorage.removeItem("zc.token"); localStorage.setItem("zc.lang", "ar"); });
await go("/public");
const pf = page.locator("section[aria-labelledby=ask-h] textarea");
await pf.fill("كم بلغ ما دُفع من موازنة وزارة الصحة حتى اليوم؟");
await page.getByRole("button", { name: "إرسال السؤال" }).click();
await page.waitForSelector("section[aria-labelledby=ask-h] .note.ok");
const vr = page.locator("section[aria-labelledby=rc-h] input");
await vr.nth(0).fill(rcRef); await vr.nth(1).fill(rcCode);
await page.locator("section[aria-labelledby=rc-h] button").click();
await page.waitForSelector("section[aria-labelledby=rc-h] .note.ok");
await shot("public-portal-ar");

// 6. Helpdesk answers
await login("helpdesk.mof", "en");
await go("/helpdesk");
await page.locator("article textarea").first().fill("Payments so far are shown on the Transparency Portal under the Ministry of Health line, updated live.");
await page.getByRole("button", { name: "Send answer" }).first().click();
await page.waitForTimeout(500);
await shot("helpdesk-staff");

// 7. Payroll: HR calculates, Treasury HQ approves
await login("hr.mof", "en");
await go("/payroll");
await page.getByRole("button", { name: "Calculate run" }).click();
await page.waitForSelector(".panel.stack .tbl");
await login("treasury.hq", "en");
await go("/payroll");
await page.locator("tr.clickable", { hasText: "Awaiting approval" }).first().click();
await page.getByRole("button", { name: "Approve run" }).click();
await page.waitForSelector("tr.clickable .chip.ok");
await shot("payroll-approved");

// 8. Offline capture and sync (spending unit)
await login("su.health", "en");
await go("/documents/new");
await page.locator("select").selectOption("0203-01-2221");
const nf = page.locator("form.form input");
await nf.nth(0).fill("Al-Sham Medical Supplies"); await nf.nth(1).fill(IBAN); await nf.nth(2).fill("98000");
await page.locator("form.form textarea").fill("Bandages – captured with no connection");
await context.setOffline(true);
await page.locator("form.form button.btn.primary").click();
await page.waitForSelector(".note.warn");
await page.waitForSelector("button.outbox");
await shot("offline-queued");
await context.setOffline(false);
await page.waitForSelector("button.outbox", { state: "detached", timeout: 15000 });
await go("/documents");
await page.waitForSelector("td.n:text(\"98,000\")");
await shot("offline-synced");

// 9. Auditor: exceptions, search, reports, indicators
await login("auditor.cofc", "en");
await go("/audit");
await page.getByRole("button", { name: "Verify integrity" }).click();
await page.waitForSelector(".note.ok");
await shot("auditor-workspace");
await go("/reports");
await shot("reports-budget-execution");
await go("/dashboard");
await page.waitForSelector(".ind-grid");
await shot("indicators-all-live");

// keyboard: the first Tab lands on the skip link
await page.keyboard.press("Tab");
if (!(await page.evaluate(() => document.activeElement?.classList.contains("skip")))) a11y.push("first Tab does not reach the skip link");

await browser.close();
if (errors.length || a11y.length) { console.error("Page errors:", errors, "\nAccessibility:", a11y); process.exit(1); }
console.log(`D4/D5 rehearsal passed – ${n} screenshots in ${OUT}/ (accessibility checks passed on every screen)`);

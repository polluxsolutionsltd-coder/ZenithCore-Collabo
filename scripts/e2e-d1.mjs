// Browser rehearsal of scenario D1, run against a seeded server (npm run db:seed; DEMO_MODE=1 npm start).
// Usage: node scripts/e2e-d1.mjs [baseUrl] [screenshotDir]
// Walks the full approval route through the user interface, switching users and languages,
// and saves a screenshot at each step. Exits non-zero if any step fails.
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.argv[2] ?? "http://localhost:8080";
const OUT = process.argv[3] ?? "e2e-shots";
const PW = process.env.DEMO_PASSWORD ?? "Demo@2027";
const IBAN = process.env.DEMO_IBAN ?? "SY600010000000123456789012";
fs.mkdirSync(OUT, { recursive: true });

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
async function openDoc(id) {
  await page.goto(`${BASE}/#/documents/${id}`);
  await page.waitForSelector(".route");
}
async function act(label, reason) {
  await page.getByRole("button", { name: label, exact: true }).click();
  if (reason !== undefined) {
    await page.locator(".form.inset textarea").fill(reason);
    await page.locator(".form.inset .btn").first().click();
  }
  await page.waitForSelector(".note.ok");
}

// 1. Spending unit (Arabic) creates and submits
await login("su.health", "ar");
await shot("su-inbox-ar");
await page.goto(BASE + "/#/documents/new");
await page.locator("select").selectOption("0203-01-2221");
const inputs = page.locator("form.form input");
await inputs.nth(0).fill("Al-Sham Medical Supplies");
await inputs.nth(1).fill(IBAN);
await page.locator("form.form textarea").fill("أنسولين وحقن – الربع الأول");
await inputs.nth(2).fill("1200000");
await shot("su-new-request-ar");
await page.locator("form.form button.btn.primary").click();
await page.waitForURL(/#\/documents\/\d+$/);
const id = Number(page.url().split("/").pop());
await page.waitForSelector(".route");
await act("إرسال");
await shot("su-submitted-ar");

// 2. Ministry approves (English)
await login("min.health", "en");
await shot("ministry-inbox-en");
await openDoc(id);
await act("Approve");
// 3. Financial Controller grants visa (French)
await login("fc.health", "fr");
await openDoc(id);
await shot("fc-before-visa-fr");
await act("Accorder le visa");
// 4. Regional Treasury Office: second-level checks then approve (Arabic)
await login("rto.damascus", "ar");
await openDoc(id);
await shot("rto-checks-ar");
await act("موافقة");
// 5. Treasury HQ authorises (English) → payment order
await login("treasury.hq", "en");
await openDoc(id);
await act("Authorise payment");
await shot("hq-authorised-en");
// 6. Requester sees notification; indicators updated
await login("su.health", "en");
await page.locator(".notif button").first().click();
await shot("su-notifications-en");
await page.goto(BASE + "/#/dashboard");
await page.waitForSelector(".ind-grid");
await shot("indicators-en");
// 7. Auditor verifies the chain
await login("auditor.cofc", "ar");
await page.goto(BASE + "/#/audit");
await page.locator("main > .view > .ctrl .btn.primary").first().click(); // hash-chain check (the signature check has its own panel)
await page.waitForSelector(".note.ok");
await shot("auditor-verify-ar");

await browser.close();
if (errors.length) { console.error("page errors:", errors); process.exit(1); }
console.log(`D1 rehearsal passed for ${BASE}: document ${id}, ${n} screenshots in ${OUT}/`);

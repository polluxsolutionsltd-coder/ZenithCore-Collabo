/**
 * Demonstration data set (sample data, not real figures). Recreates the schema.
 * Names and amounts follow the SIFMIS reference model used as the demo script.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, closeDb, tx } from "./index.js";
import { migrate } from "./migrate.js";
import { hashPassword, sha256 } from "../lib/security.js";
import { lastQuarters } from "../modules/reconciliation/reconciliation.service.js";
import { audit } from "../modules/audit/audit.service.js";

/** Builds a mod-97-valid IBAN for sample suppliers. */
export function makeIban(country: string, bban: string): string {
  const s = bban + country + "00";
  let rem = 0;
  for (const ch of s) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return country + String(98 - rem).padStart(2, "0") + bban;
}

const ORGS: [string, string, string | null, string | null, string, string, string][] = [
  // id, kind, parent, governorate, en, ar, fr
  ["MOF", "MOF", null, "DAM", "Ministry of Finance", "وزارة المالية", "Ministère des Finances"],
  ["TRE-HQ", "TREASURY_HQ", "MOF", "DAM", "MoF Treasury HQ", "الإدارة العامة للخزينة", "Trésor central (MdF)"],
  ["RTO-DAM", "REGIONAL_TREASURY", "TRE-HQ", "DAM", "Damascus Regional Treasury Office", "مكتب الخزينة في محافظة دمشق", "Trésorerie régionale de Damas"],
  ["RTO-ALE", "REGIONAL_TREASURY", "TRE-HQ", "ALE", "Aleppo Regional Treasury Office", "مكتب الخزينة في محافظة حلب", "Trésorerie régionale d’Alep"],
  ["MIN-0203", "MINISTRY", null, "DAM", "Ministry of Health", "وزارة الصحة", "Ministère de la Santé"],
  ["MIN-0410", "MINISTRY", null, "DAM", "Ministry of Education", "وزارة التربية", "Ministère de l’Éducation"],
  ["FC-0203", "CONTROLLER", "MIN-0203", "DAM", "Financial Controller – Ministry of Health", "المراقب المالي – وزارة الصحة", "Contrôleur financier – Santé"],
  ["FC-0410", "CONTROLLER", "MIN-0410", "DAM", "Financial Controller – Ministry of Education", "المراقب المالي – وزارة التربية", "Contrôleur financier – Éducation"],
  ["SU-0203-01", "SPENDING_UNIT", "MIN-0203", "DAM", "Damascus Health Directorate", "مديرية صحة دمشق", "Direction de la santé de Damas"],
  ["SU-0410-05", "SPENDING_UNIT", "MIN-0410", "ALE", "Aleppo Education Directorate", "مديرية تربية حلب", "Direction de l’éducation d’Alep"],
  ["COFC", "AUDIT", null, "DAM", "Central Organisation for Financial Control", "الجهاز المركزي للرقابة المالية", "Organisme central de contrôle financier"],
];

const USERS: [string, string, string, string, string][] = [
  // username, role, org, name en, name ar
  ["su.health", "SPENDING_UNIT", "SU-0203-01", "Rana Haddad", "رنا حداد"],
  ["su.education", "SPENDING_UNIT", "SU-0410-05", "Omar Kassab", "عمر قصاب"],
  ["min.health", "MINISTRY_APPROVER", "MIN-0203", "Dr Samer Khoury", "د. سامر خوري"],
  ["min.education", "MINISTRY_APPROVER", "MIN-0410", "Lina Saleh", "لينا صالح"],
  ["fc.health", "FIN_CONTROLLER", "FC-0203", "Maher Al-Ali", "ماهر العلي"],
  ["fc.education", "FIN_CONTROLLER", "FC-0410", "Hiba Darwish", "هبة درويش"],
  ["rto.damascus", "REGIONAL_TREASURY", "RTO-DAM", "Khaled Mansour", "خالد منصور"],
  ["rto.aleppo", "REGIONAL_TREASURY", "RTO-ALE", "Nour Hamwi", "نور حموي"],
  ["treasury.hq", "TREASURY_HQ", "TRE-HQ", "Bassam Youssef", "بسام يوسف"],
  ["admin", "ADMIN", "MOF", "System Administrator", "مدير النظام"],
  ["auditor.cofc", "AUDITOR", "COFC", "Ahmad Shami", "أحمد شامي"],
  ["cashier.damascus", "REVENUE_OFFICER", "RTO-DAM", "Yara Nassar", "يارا نصار"],
  ["helpdesk.mof", "HELPDESK", "MOF", "Dima Haddad", "ديما حداد"],
  ["hr.mof", "HR_OFFICER", "MOF", "Fadi Sabbagh", "فادي صباغ"],
  ["budget.mof", "BUDGET_DIRECTOR", "MOF", "Rami Atassi", "رامي الأتاسي"],
];

const LINES: [string, string, string, string, string, string, string, string, string, number][] = [
  // id, ministry, unit, economic, functional, programme, en, ar, fr, allotment (new SYP)
  ["0203-01-2221", "MIN-0203", "SU-0203-01", "2221", "0731", "P07", "Medicines and medical supplies", "أدوية ومستلزمات طبية", "Médicaments et fournitures médicales", 6_000_000],
  ["0203-01-2231", "MIN-0203", "SU-0203-01", "2231", "0731", "P07", "Maintenance of medical equipment", "صيانة التجهيزات الطبية", "Entretien du matériel médical", 2_500_000],
  ["0203-01-3121", "MIN-0203", "SU-0203-01", "3121", "0731", "P07", "Medical equipment (capital)", "تجهيزات طبية (استثمارية)", "Équipement médical (investissement)", 18_000_000],
  ["0410-05-2211", "MIN-0410", "SU-0410-05", "2211", "0912", "P12", "School supplies", "لوازم مدرسية", "Fournitures scolaires", 3_000_000],
  ["0410-05-3112", "MIN-0410", "SU-0410-05", "3112", "0912", "P12", "School rehabilitation works", "أعمال إعادة تأهيل المدارس", "Réhabilitation des écoles", 25_000_000],
];

export async function seed(opts: { password?: string } = {}) {
  await migrate({ reset: true, quiet: true });
  const year = new Date().getFullYear();
  const pw = hashPassword(opts.password ?? process.env.SEED_PASSWORD ?? "Demo@2027");
  await tx(async c => {
    for (const o of ORGS) await c.query("INSERT INTO orgs (id, kind, parent_id, governorate, name_en, name_ar, name_fr) VALUES ($1,$2,$3,$4,$5,$6,$7)", o);
    for (const u of USERS) await c.query("INSERT INTO users (username, role, org_id, full_name_en, full_name_ar, password_hash) VALUES ($1,$2,$3,$4,$5,$6)", [...u, pw]);
    for (const l of LINES) {
      await c.query(`INSERT INTO budget_lines (id, ministry_id, spending_unit_id, economic, functional, programme, name_en, name_ar, name_fr, allotment, year, fund)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'01')`, [...l, year]);
    }
    const rules: [string, string | null, any, string][] = [
      ["VISA_THRESHOLD", null, { amount: 500_000 }, `${year}-01-01`],
      ["CASH_LIMIT_MONTHLY", "SU-0203-01", { amount: 20_000_000 }, `${year}-01-01`],
      ["CASH_LIMIT_MONTHLY", "SU-0410-05", { amount: 15_000_000 }, `${year}-01-01`],
      ["TSA_DEBIT_ACCOUNT", null, { account: "SY-CBS-TSA-0001" }, `${year}-01-01`],
      ["REJECTION_REASON_MIN", null, { chars: 10 }, `${year}-01-01`],
      ["REC_DEADLINE_DAYS", null, { days: 30 }, `${year - 1}-01-01`],
      ["HELPDESK_SLA_DAYS", null, { days: 5 }, `${year - 1}-01-01`],
      // Illustrative factors for the demonstration; the real ones are agreed with the Ministry and the World Bank
      ["GHG_FACTORS", null, { kgPerDocument: 0.03, kgPerTrip: 0.4, tripsPerDocument: 0.5 }, `${year - 1}-01-01`],
    ];
    for (const r of rules) await c.query("INSERT INTO rules (key, scope, value, effective_from, note, created_by) VALUES ($1,$2,$3,$4,'Initial configuration','seed')", r);
    const refs: [string, number][] = [
      ["TOTAL_EXECUTION", 100_000_000], ["PAID_TOTAL_BASELINE", 80_000_000], ["PAID_VIA_TSA_BASELINE", 52_000_000],
      ["SIFMIS_EXECUTION_BASELINE", 30_000_000], ["TARGET_IND_1", 0.9], ["TARGET_IND_2", 0.8],
      ["TARGET_IND_3", 0.9], ["TARGET_IND_5", 0.95], ["TARGET_IND_4", 0.9], ["TARGET_IND_7", 0.95],
      ["PAYROLL_HEADCOUNT", 48],
    ];
    for (const [k, v] of refs) await c.query("INSERT INTO reference_figures (key, period, value, source) VALUES ($1,$2,$3,'Sample data for demonstration')", [k, String(year), v]);
    await seedM2(c);
    await seedM3(c);
    await c.query("UPDATE budget_lines SET original_allotment = allotment WHERE original_allotment IS NULL");
    await seedSyria(c, year);
    await audit(c, { actor: "seed", action: "system.seed", entity: "system", entityId: "demo", data: { orgs: ORGS.length, users: USERS.length, lines: LINES.length } });
  });
}

/** Demo API key for the MoAD interface. Override with MOAD_API_KEY; never use the default outside a demo. */
export const DEMO_MOAD_KEY = process.env.MOAD_API_KEY ?? "zc-demo-moad-7f3a9c2e51b84d06";

const FIRST = ["محمد", "أحمد", "علي", "خالد", "سامر", "يوسف", "مريم", "فاطمة", "ريم", "هالة", "نادين", "سلمى"];
const LAST = ["الحلبي", "الشامي", "العلي", "حداد", "خوري", "درويش", "قصاب", "منصور", "صالح", "حموي"];

/** Sample national ID (11 digits) for employee `i`. */
export const sampleNid = (i: number) => String(30_000_000_000 + i * 7919);

async function seedM2(c: any) {
  const accounts: [string, string, string, string, string][] = [
    ["SY-CBS-TSA-0001", "TSA_MAIN", "Treasury Single Account – main", "حساب الخزينة الموحد – الرئيسي", "Compte unique du Trésor – principal"],
    ["SY-CBS-TSA-0002", "TSA_SUB", "TSA sub-account – Aleppo", "حساب فرعي للخزينة – حلب", "Sous-compte du CUT – Alep"],
    ["SY-CBS-COL-0001", "COLLECTION", "Revenue collection account", "حساب تحصيل الإيرادات", "Compte de recouvrement des recettes"],
  ];
  for (const [id, kind, en, ar, fr] of accounts) await c.query("INSERT INTO bank_accounts (id, kind, name_en, name_ar, name_fr) VALUES ($1,$2,$3,$4,$5)", [id, kind, en, ar, fr]);

  await c.query("INSERT INTO api_clients (id, name, key_hash, scopes, rate_per_minute) VALUES ('MOAD', 'Ministry of Administrative Development – HR registry', $1, $2, $3)",
    [sha256(DEMO_MOAD_KEY), ["moad.personnel.write"], Number(process.env.MOAD_RATE_PER_MINUTE ?? 120)]);

  // 40 payroll employees; the MoAD registry matches 36 of them (sample data)
  for (let i = 1; i <= 40; i++) {
    const ministry = i % 2 ? "MIN-0203" : "MIN-0410";
    const name = `${FIRST[i % FIRST.length]} ${LAST[(i * 3) % LAST.length]}`;
    await c.query("INSERT INTO payroll_employees (employee_no, national_id, full_name_ar, ministry_id, position_id, monthly_net, monthly_gross, biometric_enrolled) VALUES ($1,$2,$3,$4,$5,$6,$6,$7)",
      [`EMP-${String(i).padStart(5, "0")}`, sampleNid(i), name, ministry, `POS-${ministry.slice(4)}-${String(i).padStart(3, "0")}`, 850_000 + (i % 7) * 65_000, i % 3 !== 0]);
    if (i === 39 || i === 40) continue; // not yet in the registry
    const status = i === 37 ? "RETIRED" : "ACTIVE";
    const regMinistry = i === 38 ? (ministry === "MIN-0203" ? "MIN-0410" : "MIN-0203") : ministry;
    await c.query("INSERT INTO moad_registry (national_id, full_name_ar, position_id, ministry_id, grade, status, correlation_id) VALUES ($1,$2,$3,$4,$5,$6,'seed')",
      [sampleNid(i), name, `POS-${ministry.slice(4)}-${String(i).padStart(3, "0")}`, regMinistry, `${1 + (i % 5)}A`, status]);
  }

  // Reconciliation history for the three previous quarters (sample): 6 on time, 1 late, 2 missing
  const today = new Date().toISOString().slice(0, 10);
  const past = lastQuarters(today, 4).slice(0, 3);
  const plan: Record<string, (number | null)[]> = { "SY-CBS-TSA-0001": [12, 9, 15], "SY-CBS-TSA-0002": [21, 48, 18], "SY-CBS-COL-0001": [null, 25, 28] };
  for (const [acct, lags] of Object.entries(plan)) {
    for (const [k, q] of past.entries()) {
      const lag = lags[k];
      if (acct === "SY-CBS-TSA-0002" && k === 0) continue; // missing reconciliation
      if (lag === null) continue;
      const done = new Date(Date.parse(q.periodEnd + "T12:00:00Z") + lag * 86_400_000).toISOString();
      await c.query("INSERT INTO reconciliations (account_id, period, period_end, completed_at, matched, completed_by, started_at) VALUES ($1,$2,$3,$4,$5,'seed',$4)",
        [acct, q.period, q.periodEnd, done, 40 + lag]);
    }
  }
}

async function seedM3(c: any) {
  const codes: [string, string, string, string][] = [
    ["1101", "Customs duties", "الرسوم الجمركية", "Droits de douane"],
    ["1201", "Income tax", "ضريبة الدخل", "Impôt sur le revenu"],
    ["1401", "Administrative fees and service charges", "الرسوم الإدارية وبدلات الخدمات", "Frais administratifs et redevances"],
  ];
  for (const [code, en, ar, fr] of codes) await c.query("INSERT INTO revenue_codes (code, name_en, name_ar, name_fr, account_id) VALUES ($1,$2,$3,$4,'SY-CBS-COL-0001')", [code, en, ar, fr]);

  // Helpdesk history (sample): 6 answered on time, 1 late, 2 open
  const staff = (await c.query("SELECT id FROM users WHERE username = 'helpdesk.mof'")).rows[0].id;
  const day = 86_400_000, now = Date.now();
  const tickets: [string, string, string, number, number | null][] = [
    // category, lang, question, created (days ago), answered after (days) or null
    ["BUDGET", "ar", "كم تبلغ الاعتمادات المخصصة لوزارة الصحة هذا العام؟", 80, 2],
    ["PAYMENT", "ar", "متى يتم صرف مستحقات المورد بعد اعتماد أمر الدفع؟", 70, 3],
    ["REVENUE", "en", "How can I check that my customs receipt is genuine?", 60, 1],
    ["PORTAL", "fr", "Où trouver l’exécution du budget par ministère ?", 45, 4],
    ["BUDGET", "ar", "هل تُنشر الموازنة المبسطة للمواطن على البوابة؟", 30, 2],
    ["OTHER", "en", "Is there an English version of the citizen budget?", 20, 3],
    ["PAYMENT", "ar", "تأخر صرف دفعة لمقاول في حلب، كيف أتابع الطلب؟", 40, 9],
    ["BUDGET", "ar", "ما هي نسبة تنفيذ موازنة التربية حتى الآن؟", 1, null],
    ["REVENUE", "en", "Which revenue codes apply to municipal service fees?", 0, null],
  ];
  let n = 0;
  for (const [cat, lang, q, ago, after] of tickets) {
    const created = new Date(now - ago * day), due = new Date(created.getTime() + 5 * day);
    const answered = after === null ? null : new Date(created.getTime() + after * day);
    await c.query(
      `INSERT INTO helpdesk_tickets (ref, access_code, category, lang, question, status, answer, answered_by, created_at, answered_at, due_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [`HD-${created.getFullYear()}-S${String(++n).padStart(4, "0")}`, "SAMPLE" + n, cat, lang, q, answered ? "ANSWERED" : "OPEN",
       answered ? "Answered by the helpdesk (sample data)." : null, answered ? staff : null, created, answered, due]);
  }

  // Last month's payroll, approved (sample), so indicator 4 has a baseline
  const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1);
  const period = d.toISOString().slice(0, 7);
  for (const ministry of ["MIN-0203", "MIN-0410"]) {
    const emps = (await c.query(
      `SELECT p.employee_no, p.monthly_net, (m.status = 'ACTIVE' AND m.ministry_id = p.ministry_id) AS ok,
              CASE WHEN m.national_id IS NULL THEN 'NOT_IN_REGISTRY' WHEN m.status <> 'ACTIVE' THEN 'NOT_ACTIVE_IN_REGISTRY' WHEN m.ministry_id <> p.ministry_id THEN 'DIFFERENT_MINISTRY' END AS why
         FROM payroll_employees p LEFT JOIN moad_registry m ON m.national_id = p.national_id WHERE p.ministry_id = $1`, [ministry])).rows;
    const inc = emps.filter((e: any) => e.ok);
    const run = (await c.query(
      `INSERT INTO payroll_runs (period, ministry_id, status, employees, excluded, total_net, created_by, approved_by, approved_at)
       VALUES ($1,$2,'APPROVED',$3,$4,$5,'seed','seed',now()) RETURNING id`,
      [period, ministry, inc.length, emps.length - inc.length, inc.reduce((s: number, e: any) => s + Number(e.monthly_net), 0)])).rows[0];
    for (const e of emps) await c.query("INSERT INTO payroll_run_lines (run_id, employee_no, net, included, exclusion) VALUES ($1,$2,$3,$4,$5)", [run.id, e.employee_no, e.monthly_net, !!e.ok, e.ok ? null : e.why]);
  }
}

export const SAMPLE_SUPPLIER = { name: "Al-Sham Medical Supplies", iban: makeIban("SY", "0010000000123456789012") };

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  seed().then(async () => { console.log("Seeded demo data. Supplier IBAN for testing:", SAMPLE_SUPPLIER.iban); await closeDb(); })
    .catch(e => { console.error(e); process.exit(1); });
}

/**
 * Syria-specific configuration and data.
 * REDENOMINATION is from Decree 293/2025 as reported (1 Jan 2026, 100 old = 1 new; old notes legal tender until 31 Jul 2026).
 * Every other value below is a SAMPLE to be replaced once confirmed by a Syrian legal / PFM adviser.
 */
async function seedSyria(c: any, year: number) {
  const rule = (key: string, scope: string | null, value: any, from: string, note: string) =>
    c.query("INSERT INTO rules (key, scope, value, effective_from, note, created_by) VALUES ($1,$2,$3,$4,$5,'seed')", [key, scope, value, from, note]);
  await rule("REDENOMINATION", null, { decree: "293/2025", effectiveDate: "2026-01-01", factor: 100, oldNotesLegalTenderUntil: "2026-07-31" }, "2026-01-01", "Decree 293/2025 as reported by the Central Bank of Syria");
  await rule("INCOME_TAX", null, { exemption: 300_000, brackets: [{ upTo: 500_000, rate: 0.05 }, { upTo: 1_000_000, rate: 0.10 }, { upTo: null, rate: 0.15 }] }, `${year}-01-01`, "SAMPLE brackets – replace with the New Income Tax Law");
  await rule("VIREMENT_LIMITS", null, { ministryMaxAmount: 1_000_000, ministryMaxShare: 0.10, protectedChapters: ["21"] }, `${year}-01-01`, "SAMPLE limits – to confirm under Decree 54/2006 and its revision");
  for (const [code, share] of [["1101", 0], ["1201", 0.2], ["1401", 0.5]] as const) {
    await rule("REVENUE_SHARING", code, { governorateShare: share }, `${year}-01-01`, "SAMPLE share – to confirm");
  }
  await rule("FX_RATE", "USD", { sypPerUnit: 110 }, `${year}-01-01`, "SAMPLE rate in new pounds – use the Central Bank of Syria rate");
  await rule("TSA_DEBIT_ACCOUNT", "CUR:USD", { account: "SY-CBS-USD-0001" }, `${year}-01-01`, "Donor designated account (USD)");
  await c.query("INSERT INTO bank_accounts (id, kind, name_en, name_ar, name_fr, currency, central_government) VALUES ($1,'DONOR',$2,$3,$4,'USD',FALSE)",
    ["SY-CBS-USD-0001", "Donor designated account (USD) – health grant", "الحساب المخصص للمانحين (دولار) – منحة الصحة", "Compte désigné bailleur (USD) – don santé"]);
  // a donor-funded line in USD and a salaries line (chapter 21, protected from virements)
  await c.query(`INSERT INTO budget_lines (id, ministry_id, spending_unit_id, economic, functional, programme, name_en, name_ar, name_fr, allotment, original_allotment, year, fund, currency)
    VALUES ('0203-01-2224','MIN-0203','SU-0203-01','2224','0731','P07','Vaccines (donor grant, USD)','لقاحات (منحة مانحين، دولار)','Vaccins (don, USD)',250000,250000,$1,'DON','USD'),
           ('0203-01-2111','MIN-0203','SU-0203-01','2111','0731','P07','Salaries and wages','الرواتب والأجور','Salaires et traitements',40000000,40000000,$1,'01','SYP')`, [year]);
}

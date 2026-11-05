/**
 * Demonstration data set (sample data, not real figures). Recreates the schema.
 * Names and amounts follow the SIFMIS reference model used as the demo script.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, closeDb, tx } from "./index.js";
import { migrate } from "./migrate.js";
import { hashPassword } from "../lib/security.js";
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
    ];
    for (const r of rules) await c.query("INSERT INTO rules (key, scope, value, effective_from, note, created_by) VALUES ($1,$2,$3,$4,'Initial configuration','seed')", r);
    const refs: [string, number][] = [
      ["TOTAL_EXECUTION", 100_000_000], ["PAID_TOTAL_BASELINE", 80_000_000], ["PAID_VIA_TSA_BASELINE", 52_000_000],
      ["SIFMIS_EXECUTION_BASELINE", 30_000_000], ["TARGET_IND_1", 0.9], ["TARGET_IND_2", 0.8],
    ];
    for (const [k, v] of refs) await c.query("INSERT INTO reference_figures (key, period, value, source) VALUES ($1,$2,$3,'Sample data for demonstration')", [k, String(year), v]);
    await audit(c, { actor: "seed", action: "system.seed", entity: "system", entityId: "demo", data: { orgs: ORGS.length, users: USERS.length, lines: LINES.length } });
  });
}

export const SAMPLE_SUPPLIER = { name: "Al-Sham Medical Supplies", iban: makeIban("SY", "0010000000123456789012") };

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  seed().then(async () => { console.log("Seeded demo data. Supplier IBAN for testing:", SAMPLE_SUPPLIER.iban); await closeDb(); })
    .catch(e => { console.error(e); process.exit(1); });
}

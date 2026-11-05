import { db } from "../../db/index.js";
import { reconciliationTimeliness } from "../reconciliation/reconciliation.service.js";
import { payrollMatch } from "../moad/moad.service.js";
import { biometricShare, payrollShare } from "../payroll/payroll.service.js";
import { transparencyStatus } from "../helpdesk/helpdesk.service.js";
import { getRule } from "../rules/rules.service.js";

/**
 * Project results indicators, computed from live data (never typed in).
 * Each returns value (0–1 ratio unless stated), numerator, denominator,
 * baseline and target, so the dashboard can drill down and explain itself.
 */
export interface Indicator {
  id: number;
  key: string;
  value: number | null;
  numerator?: number;
  denominator?: number;
  unit: "ratio" | "boolean" | "tco2e";
  /** what numerator/denominator count: money (SYP) or items */
  measure?: "money" | "count";
  target: number | null;
  status: "live" | "planned";
  /** extra facts shown with the indicator (e.g. the parts of a yes/no indicator, or an estimate's method) */
  detail?: Record<string, any>;
  source: string;
}

async function ref(key: string, period: string): Promise<number | null> {
  const r = await db().query("SELECT value::float8 AS v FROM reference_figures WHERE key = $1 AND period = $2", [key, period]);
  return r.rows[0]?.v ?? null;
}

async function target(n: number): Promise<number | null> {
  return ref(`TARGET_IND_${n}`, String(new Date().getFullYear()));
}

export async function computeIndicators(): Promise<Indicator[]> {
  const year = String(new Date().getFullYear());
  const pay = (await db().query(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE via_tsa), 0)::float8 AS tsa, COALESCE(SUM(amount), 0)::float8 AS total
       FROM payment_orders WHERE status NOT IN ('REJECTED','RETURNED') AND date_part('year', created_at) = $1::int`, [year])).rows[0];

  // 1. Share of executed budget paid through the TSA (baseline payments before go-live + live payment orders)
  const baseTsa = (await ref("PAID_VIA_TSA_BASELINE", year)) ?? 0;
  const baseAll = (await ref("PAID_TOTAL_BASELINE", year)) ?? 0;
  const n1 = baseTsa + pay.tsa, d1 = baseAll + pay.total;

  // 2. Share of executed budget processed through SIFMIS (vs total execution reported in the accounts)
  const totalExec = (await ref("TOTAL_EXECUTION", year)) ?? 0;
  const baseSifmis = (await ref("SIFMIS_EXECUTION_BASELINE", year)) ?? 0;
  const n2 = baseSifmis + pay.total;

  const rec = await reconciliationTimeliness();
  const match = await payrollMatch();
  const pay4 = await payrollShare();
  const tr = await transparencyStatus();
  const bio = await biometricShare();
  const ghg = await ghgEstimate(year);

    return [
    { id: 1, key: "ind.tsa_share", value: d1 ? n1 / d1 : null, numerator: n1, denominator: d1, unit: "ratio", target: await target(1), status: "live", source: "payment_orders + reference_figures" },
    { id: 2, key: "ind.sifmis_share", value: totalExec ? n2 / totalExec : null, numerator: n2, denominator: totalExec, unit: "ratio", target: await target(2), status: "live", source: "payment_orders + reference_figures.TOTAL_EXECUTION" },
    { id: 3, key: "ind.bank_rec_timeliness", value: rec.ratio, numerator: rec.onTime, denominator: rec.due, unit: "ratio", measure: "count", target: await target(3), status: "live", source: `reconciliations, last 4 quarters, deadline ${rec.deadlineDays} days` },
    { id: 4, key: "ind.payroll_share", value: pay4.ratio, numerator: pay4.paid, denominator: pay4.headcount, unit: "ratio", measure: "count", target: await target(4), status: "live", source: `approved payroll runs ${pay4.period ?? "–"} ÷ reference_figures.PAYROLL_HEADCOUNT`, detail: { period: pay4.period } },
    { id: 5, key: "ind.moad_payroll_match", value: match.ratio, numerator: match.matched, denominator: match.total, unit: "ratio", measure: "count", target: await target(5), status: "live", source: "payroll_employees ↔ moad_registry" },
    { id: 6, key: "ind.transparency_helpdesk", value: tr.operational ? 1 : 0, numerator: tr.onTime, denominator: tr.due, unit: "boolean", measure: "count", target: 1, status: "live", source: "public budget data + helpdesk answers within SLA (≥ 80%, last 90 days)", detail: { portal: tr.portal, helpdesk: tr.helpdesk, ratio: tr.ratio } },
    { id: 7, key: "ind.biometric_share", value: bio.ratio, numerator: bio.enrolled, denominator: bio.total, unit: "ratio", measure: "count", target: await target(7), status: "live", source: "payroll_employees.biometric_enrolled" },
    { id: 8, key: "ind.ghg_reduction", value: ghg.tco2e, unit: "tco2e", target: null, status: "live", source: "estimate: electronic transactions × GHG_FACTORS rule (factors to be agreed with the Ministry)", detail: ghg },
  ];
}

/**
 * Indicator 8 – an estimate, not a measurement: paper documents and office
 * trips avoided by processing transactions electronically, multiplied by the
 * emission factors in the GHG_FACTORS rule. The method and counts are shown
 * with the result so the figure can be checked.
 */
async function ghgEstimate(year: string) {
  const f = (await getRule("GHG_FACTORS")) ?? { kgPerDocument: 0, kgPerTrip: 0, tripsPerDocument: 0 };
  const n = (await db().query(
    `SELECT (SELECT COUNT(*) FROM documents WHERE status <> 'DRAFT' AND date_part('year', created_at) = $1::int)::int AS requests,
            (SELECT COUNT(*) FROM payment_orders WHERE status IN ('SETTLED','RETURNED') AND date_part('year', created_at) = $1::int)::int AS payments,
            (SELECT COUNT(*) FROM receipts WHERE date_part('year', issued_at) = $1::int)::int AS receipts,
            (SELECT COUNT(*) FROM helpdesk_tickets WHERE date_part('year', created_at) = $1::int)::int AS questions,
            (SELECT COUNT(*) FROM payroll_run_lines l JOIN payroll_runs r ON r.id = l.run_id WHERE r.status = 'APPROVED' AND l.included AND left(r.period, 4) = $1::text)::int AS payslips`, [year])).rows[0];
  const transactions = n.requests + n.payments + n.receipts + n.questions + n.payslips;
  const kg = transactions * (f.kgPerDocument + f.tripsPerDocument * f.kgPerTrip);
  return { ...n, transactions, factors: f, tco2e: Math.round(kg) / 1000 };
}

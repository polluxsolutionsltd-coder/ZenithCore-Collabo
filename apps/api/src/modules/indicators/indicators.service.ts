import { db } from "../../db/index.js";

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
  target: number | null;
  status: "live" | "planned";
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
       FROM payment_orders WHERE status <> 'REJECTED' AND date_part('year', created_at) = $1::int`, [year])).rows[0];

  // 1. Share of executed budget paid through the TSA (baseline payments before go-live + live payment orders)
  const baseTsa = (await ref("PAID_VIA_TSA_BASELINE", year)) ?? 0;
  const baseAll = (await ref("PAID_TOTAL_BASELINE", year)) ?? 0;
  const n1 = baseTsa + pay.tsa, d1 = baseAll + pay.total;

  // 2. Share of executed budget processed through SIFMIS (vs total execution reported in the accounts)
  const totalExec = (await ref("TOTAL_EXECUTION", year)) ?? 0;
  const baseSifmis = (await ref("SIFMIS_EXECUTION_BASELINE", year)) ?? 0;
  const n2 = baseSifmis + pay.total;

  const planned = (id: number, key: string, unit: Indicator["unit"], source: string): Indicator =>
    ({ id, key, value: null, unit, target: null, status: "planned", source });

  return [
    { id: 1, key: "ind.tsa_share", value: d1 ? n1 / d1 : null, numerator: n1, denominator: d1, unit: "ratio", target: await target(1), status: "live", source: "payment_orders + reference_figures" },
    { id: 2, key: "ind.sifmis_share", value: totalExec ? n2 / totalExec : null, numerator: n2, denominator: totalExec, unit: "ratio", target: await target(2), status: "live", source: "payment_orders + reference_figures.TOTAL_EXECUTION" },
    planned(3, "ind.bank_rec_timeliness", "ratio", "Milestone 2: reconciliation records"),
    planned(4, "ind.payroll_share", "ratio", "Milestone 3: payroll runs"),
    planned(5, "ind.moad_payroll_match", "ratio", "Milestone 2: MoAD interface"),
    planned(6, "ind.transparency_helpdesk", "boolean", "Milestone 3: portal and helpdesk"),
    planned(7, "ind.biometric_share", "ratio", "Milestone 3: HR enrolment"),
    planned(8, "ind.ghg_reduction", "tco2e", "Milestone 3: GHG calculator"),
  ];
}

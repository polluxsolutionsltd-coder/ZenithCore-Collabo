import { Db, db } from "../../db/index.js";
import { badRequest } from "../../lib/http.js";
import { audit } from "../audit/audit.service.js";

/** Known rule keys and how to validate their values. Configuration, not code. */
export const RULE_KEYS: Record<string, { describe: string; validate: (v: any) => boolean }> = {
  VISA_THRESHOLD: { describe: "Amount (SYP) at or above which the Financial Controller visa is required", validate: v => typeof v?.amount === "number" && v.amount >= 0 },
  CASH_LIMIT_MONTHLY: { describe: "Monthly cash limit (SYP) for a spending unit, checked by the Regional Treasury Office", validate: v => typeof v?.amount === "number" && v.amount >= 0 },
  TSA_DEBIT_ACCOUNT: { describe: "TSA account debited for payment orders", validate: v => typeof v?.account === "string" && v.account.length > 3 },
  WORKFLOW_ROUTE: { describe: "Approval steps for a ministry, in order: MINISTRY, VISA, RTO, HQ (HQ required, last). Applies to requests submitted from the effective date", validate: v => Array.isArray(v?.steps) && v.steps.length > 0 && v.steps[v.steps.length - 1] === "HQ" && v.steps.every((x: string, i: number) => ["MINISTRY", "VISA", "RTO", "HQ"].indexOf(x) > (i ? ["MINISTRY", "VISA", "RTO", "HQ"].indexOf(v.steps[i - 1]) : -1)) },
  HELPDESK_SLA_DAYS: { describe: "Working days within which a Citizen's Budget Helpdesk question must be answered (indicator 6)", validate: v => Number.isInteger(v?.days) && v.days > 0 },
  GHG_FACTORS: { describe: "Emission factors (kg CO2e) used to estimate the reduction from paperless processing (indicator 8): per paper document avoided and per office trip avoided", validate: v => typeof v?.kgPerDocument === "number" && typeof v?.kgPerTrip === "number" && typeof v?.tripsPerDocument === "number" },
  REC_DEADLINE_DAYS: { describe: "Days after period end within which a bank reconciliation counts as timely (indicator 3)", validate: v => Number.isInteger(v?.days) && v.days >= 0 },
  REJECTION_REASON_MIN: { describe: "Minimum length of a rejection reason", validate: v => Number.isInteger(v?.chars) && v.chars >= 0 },
};

const today = () => new Date().toISOString().slice(0, 10);

/** Value of `key` on `date`, preferring the most specific scope among `scopes` (most specific first). */
export async function getRule(key: string, scopes: (string | null)[] = [null], date = today(), c: Db = db()): Promise<any | null> {
  const r = await c.query(
    `SELECT scope, value FROM rules
      WHERE key = $1 AND effective_from <= $2::date AND (effective_to IS NULL OR effective_to >= $2::date)
      ORDER BY effective_from DESC, id DESC`,
    [key, date],
  );
  for (const s of [...scopes, null]) {
    const hit = r.rows.find(x => (x.scope ?? null) === s);
    if (hit) return hit.value;
  }
  return null;
}

export async function listRules() {
  return (await db().query("SELECT * FROM rules ORDER BY key, scope NULLS FIRST, effective_from")).rows;
}

/** Adds a new version of a rule from `effective_from`; the previous open version is closed the day before. */
export async function setRule(c: Db, actor: string, input: { key: string; scope?: string | null; value: any; effectiveFrom: string; note?: string }) {
  const def = RULE_KEYS[input.key];
  if (!def) throw badRequest("rules.unknown_key");
  if (!def.validate(input.value)) throw badRequest("rules.invalid_value");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom)) throw badRequest("rules.invalid_date");
  const scope = input.scope ?? null;
  await c.query(
    `UPDATE rules SET effective_to = ($3::date - 1)
      WHERE key = $1 AND scope IS NOT DISTINCT FROM $2 AND effective_to IS NULL AND effective_from < $3::date`,
    [input.key, scope, input.effectiveFrom],
  );
  const r = await c.query(
    "INSERT INTO rules (key, scope, value, effective_from, note, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
    [input.key, scope, input.value, input.effectiveFrom, input.note ?? null, actor],
  );
  await audit(c, { actor, action: "rule.set", entity: "rule", entityId: r.rows[0].id, data: { key: input.key, scope, value: input.value, effectiveFrom: input.effectiveFrom } });
  return r.rows[0];
}

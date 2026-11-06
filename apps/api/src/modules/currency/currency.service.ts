/**
 * Currencies.
 *
 * - The functional currency is the Syrian pound (SYP), in its new
 *   denomination since 1 January 2026 (Decree 293/2025: 100 old = 1 new).
 *   Legacy data recorded in old pounds is converted when it is loaded
 *   (`fromOldPounds`), with control totals; see modules/loaders.
 * - Donor-funded lines and payments can be in a foreign currency (USD).
 *   They keep their own currency and are valued in SYP at the FX_RATE rule
 *   for budget totals and the results indicators.
 */
import { Db, db } from "../../db/index.js";
import { badRequest } from "../../lib/http.js";
import { getRule } from "../rules/rules.service.js";

export const CURRENCIES = ["SYP", "USD"];

/** SYP per one unit of `currency` on `date` (1 for SYP). */
export async function fxRate(currency: string, date?: string, c: Db = db()): Promise<number> {
  if (!currency || currency === "SYP") return 1;
  const r = await getRule("FX_RATE", [currency], date, c);
  if (!r?.sypPerUnit) throw badRequest("currency.no_rate", { currency });
  return r.sypPerUnit;
}

/** Current rates for every non-SYP currency, for SQL valuation. */
export async function rateTable(c: Db = db()): Promise<Record<string, number>> {
  const out: Record<string, number> = { SYP: 1 };
  for (const cur of CURRENCIES.filter(x => x !== "SYP")) {
    const r = await getRule("FX_RATE", [cur], undefined, c);
    if (r?.sypPerUnit) out[cur] = r.sypPerUnit;
  }
  return out;
}

/** SQL expression valuing `<alias>.amount` (or another column) in SYP, given a rate table. */
export function sypSql(amountExpr: string, currencyExpr: string, rates: Record<string, number>) {
  const cases = Object.entries(rates).filter(([k]) => k !== "SYP").map(([k, v]) => `WHEN ${currencyExpr} = '${k}' THEN ${amountExpr} * ${Number(v)}`).join(" ");
  return cases ? `(CASE ${cases} ELSE ${amountExpr} END)` : amountExpr;
}

export async function redenomination(c: Db = db()) {
  return (await getRule("REDENOMINATION", [], undefined, c)) as { decree: string; effectiveDate: string; factor: number; oldNotesLegalTenderUntil?: string } | null;
}

/** Converts an amount recorded in old Syrian pounds into new pounds (rounded to the piastre). */
export function fromOldPounds(amount: number, factor: number) {
  return Math.round((amount / factor) * 100) / 100;
}

/**
 * Data migration loaders: opening budget (allotments) and the payroll master,
 * from CSV files exported from the legacy systems. Every row is validated and
 * every error reported with its line number. A dry run changes nothing; a
 * committed load is all-or-nothing and recorded in the audit trail.
 */
import { tx } from "../../db/index.js";
import { audit } from "../audit/audit.service.js";

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some(c => c.trim() !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some(c => c.trim() !== "")) rows.push(row);
  return rows;
}

export interface LoadError { line: number; field: string; code: string; value?: string }
export interface LoadResult { kind: string; rows: number; valid: number; errors: LoadError[]; committed: boolean }

const SPECS = {
  budget: {
    columns: ["id", "year", "ministry_id", "spending_unit_id", "fund", "economic", "functional", "programme", "name_en", "name_ar", "name_fr", "allotment"],
    table: "budget_lines",
    check: (r: Record<string, string>, err: (f: string, c: string) => void, ctx: Ctx) => {
      if (!/^\d{4}-\d{2}-\d{4}$/.test(r.id)) err("id", "load.line_id_format");
      if (!/^\d{4}$/.test(r.year)) err("year", "load.year_format");
      if (ctx.orgs.get(r.ministry_id) !== "MINISTRY") err("ministry_id", "load.unknown_ministry");
      if (ctx.orgs.get(r.spending_unit_id) !== "SPENDING_UNIT") err("spending_unit_id", "load.unknown_spending_unit");
      for (const f of ["fund", "economic", "functional", "programme"]) if (!/^[A-Z0-9]{2,6}$/.test(r[f])) err(f, "load.code_format");
      if (!r.name_en || !/[؀-ۿ]/.test(r.name_ar) || !r.name_fr) err("name_ar", "load.names_required");
      if (!/^\d+(\.\d{1,2})?$/.test(r.allotment)) err("allotment", "load.amount_format");
    },
    upsert: "ON CONFLICT (id) DO UPDATE SET allotment = EXCLUDED.allotment, name_en = EXCLUDED.name_en, name_ar = EXCLUDED.name_ar, name_fr = EXCLUDED.name_fr",
  },
  employees: {
    columns: ["employee_no", "national_id", "full_name_ar", "ministry_id", "position_id", "monthly_net"],
    table: "payroll_employees",
    check: (r: Record<string, string>, err: (f: string, c: string) => void, ctx: Ctx) => {
      if (!/^EMP-\d{5}$/.test(r.employee_no)) err("employee_no", "load.employee_no_format");
      if (!/^\d{11}$/.test(r.national_id)) err("national_id", "moad.national_id_format");
      if (!/[؀-ۿ]/.test(r.full_name_ar)) err("full_name_ar", "moad.arabic_name_required");
      if (ctx.orgs.get(r.ministry_id) !== "MINISTRY") err("ministry_id", "load.unknown_ministry");
      if (!/^\d+(\.\d{1,2})?$/.test(r.monthly_net) || Number(r.monthly_net) <= 0) err("monthly_net", "load.amount_format");
    },
    upsert: "ON CONFLICT (employee_no) DO UPDATE SET national_id = EXCLUDED.national_id, full_name_ar = EXCLUDED.full_name_ar, ministry_id = EXCLUDED.ministry_id, position_id = EXCLUDED.position_id, monthly_net = EXCLUDED.monthly_net",
  },
} as const;
interface Ctx { orgs: Map<string, string> }

export async function load(kind: keyof typeof SPECS, csv: string, opts: { commit: boolean; actor: string }): Promise<LoadResult> {
  const spec = SPECS[kind];
  if (!spec) throw new Error(`unknown kind ${kind}`);
  const rows = parseCsv(csv);
  const errors: LoadError[] = [];
  const header = (rows.shift() ?? []).map(h => h.trim());
  const missing = spec.columns.filter(c => !header.includes(c));
  if (missing.length) return { kind, rows: 0, valid: 0, errors: missing.map(c => ({ line: 1, field: c, code: "load.missing_column" })), committed: false };
  return tx(async c => {
    const ctx: Ctx = { orgs: new Map((await c.query("SELECT id, kind FROM orgs")).rows.map(o => [o.id, o.kind])) };
    const records: Record<string, string>[] = [];
    const seen = new Set<string>();
    rows.forEach((cells, i) => {
      const line = i + 2;
      const r = Object.fromEntries(header.map((h, k) => [h, (cells[k] ?? "").trim()]));
      const before = errors.length;
      spec.check(r, (field, code) => errors.push({ line, field, code, value: r[field] }), ctx);
      const key = r[spec.columns[0]];
      if (seen.has(key)) errors.push({ line, field: spec.columns[0], code: "load.duplicate", value: key });
      seen.add(key);
      if (errors.length === before) records.push(r);
    });
    const commit = opts.commit && errors.length === 0;
    if (commit) {
      for (const r of records) {
        const cols = spec.columns;
        await c.query(`INSERT INTO ${spec.table} (${cols.join(", ")}) VALUES (${cols.map((_, i) => "$" + (i + 1)).join(", ")}) ${spec.upsert}`, cols.map(k => r[k]));
      }
      await audit(c, { actor: opts.actor, action: `load.${kind}`, entity: "load", entityId: kind, data: { rows: records.length } });
    }
    return { kind, rows: rows.length, valid: records.length, errors, committed: commit };
  });
}

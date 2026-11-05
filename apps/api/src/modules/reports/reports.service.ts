/**
 * D4 – reporting and the auditor's workspace. Every report is scoped to what
 * the user may see and can be downloaded as CSV (UTF-8 with BOM, so Arabic
 * opens correctly in spreadsheet programs).
 */
import { db } from "../../db/index.js";
import { AuthUser, badRequest, forbidden } from "../../lib/http.js";
import { scopeFilter } from "../budget/budget.service.js";
import { getRule } from "../rules/rules.service.js";

export function toCsv(rows: any[], columns: string[]): string {
  const cell = (v: any) => {
    if (v === null || v === undefined) return "";
    const s = v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
    const safe = /^[=+\-@]/.test(s) && isNaN(Number(s)) ? "'" + s : s; // no formula injection in spreadsheets
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return "﻿" + [columns.join(","), ...rows.map(r => columns.map(c => cell(r[c])).join(","))].join("\r\n") + "\r\n";
}

/** Budget execution by line: allotment, in approval, authorised, paid, available. */
export async function budgetExecution(u: AuthUser) {
  const f = scopeFilter(u, "b", 1);
  return (await db().query(
    `SELECT b.id AS line, b.ministry_id, b.spending_unit_id, b.economic, b.programme, b.name_en, b.name_ar, b.name_fr, b.allotment::float8 AS allotment,
            COALESCE((SELECT SUM(d.amount) FROM documents d WHERE d.budget_line_id = b.id AND d.status IN ('SUBMITTED','AWAITING_VISA','AWAITING_RTO','AWAITING_HQ')), 0)::float8 AS in_approval,
            COALESCE((SELECT SUM(d.amount) FROM documents d WHERE d.budget_line_id = b.id AND d.status = 'AUTHORISED'), 0)::float8 AS authorised,
            COALESCE((SELECT SUM(p.amount) FROM payment_orders p JOIN documents d ON d.id = p.document_id WHERE d.budget_line_id = b.id AND p.status = 'SETTLED'), 0)::float8 AS paid
       FROM budget_lines b WHERE ${f.sql} ORDER BY b.id`, f.vals)).rows
    .map(r => ({ ...r, available: r.allotment - r.in_approval - r.authorised, execution: r.allotment ? r.paid / r.allotment : 0 }));
}

export async function paymentsReport(u: AuthUser, from: string, to: string) {
  if (!["TREASURY_HQ", "REGIONAL_TREASURY", "ADMIN", "AUDITOR"].includes(u.role)) throw forbidden();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw badRequest("reports.invalid_dates");
  return (await db().query(
    `SELECT p.ref, d.ref AS request, d.spending_unit_id, d.budget_line_id, p.beneficiary_name, p.beneficiary_iban, p.amount::float8 AS amount,
            p.status, p.cbs_status, p.cbs_reason, p.end_to_end_id, p.created_at, p.settled_at, p.returned_at
       FROM payment_orders p JOIN documents d ON d.id = p.document_id
      WHERE p.created_at::date BETWEEN $1 AND $2 ORDER BY p.id`, [from, to])).rows;
}

/** Auditor search over the hash-chained audit log. */
export async function auditSearch(q: { actor?: string; action?: string; entity?: string; from?: string; to?: string; limit?: number }) {
  const where: string[] = [], vals: any[] = [];
  const add = (sql: string, v: any) => { vals.push(v); where.push(sql.replace("?", "$" + vals.length)); };
  if (q.actor) add("actor = ?", q.actor);
  if (q.action) add("action LIKE ?", q.action.replace(/[%_]/g, "") + "%");
  if (q.entity) add("entity = ?", q.entity);
  if (q.from) add("ts >= ?::date", q.from);
  if (q.to) add("ts < (?::date + 1)", q.to);
  vals.push(Math.min(q.limit ?? 500, 5000));
  return (await db().query(
    `SELECT id, ts, actor, action, entity, entity_id, data, hash FROM audit_log ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT $${vals.length}`, vals)).rows;
}

/**
 * Control exceptions for the auditor: requests approved above the visa threshold
 * without a visa, decisions taken under delegation, cancelled receipts,
 * payroll exclusions and returned payments.
 */
export async function exceptions() {
  const visa = (await getRule("VISA_THRESHOLD"))?.amount ?? 0;
  const q = async (sql: string, v: any[] = []) => (await db().query(sql, v)).rows;
  return {
    noVisaAboveThreshold: await q(
      `SELECT d.id, d.ref, d.amount::float8 AS amount, d.status FROM documents d
        WHERE d.amount >= $1 AND d.status IN ('AWAITING_RTO','AWAITING_HQ','AUTHORISED')
          AND d.route @> ARRAY['VISA'] AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.document_id = d.id AND a.decision = 'VISA_GRANTED')`, [visa]),
    delegatedDecisions: await q(
      `SELECT d.ref, a.step, a.decision, a.created_at, u.username AS actor, b.username AS on_behalf_of
         FROM approvals a JOIN documents d ON d.id = a.document_id JOIN users u ON u.id = a.actor_id JOIN users b ON b.id = a.on_behalf_of ORDER BY a.id DESC`),
    cancelledReceipts: await q("SELECT ref, amount::float8 AS amount, cancel_reason, cancelled_at FROM receipts WHERE status = 'CANCELLED' ORDER BY id DESC"),
    payrollExclusions: await q(
      `SELECT r.period, r.ministry_id, l.employee_no, l.exclusion FROM payroll_run_lines l JOIN payroll_runs r ON r.id = l.run_id WHERE NOT l.included ORDER BY r.period DESC, l.employee_no`),
    returnedPayments: await q("SELECT ref, amount::float8 AS amount, cbs_reason, returned_at FROM payment_orders WHERE status = 'RETURNED' ORDER BY id DESC"),
  };
}

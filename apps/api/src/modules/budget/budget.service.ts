import { Db, db } from "../../db/index.js";
import { AuthUser, notFound } from "../../lib/http.js";

/** Statuses whose amount is reserved against the budget line. */
export const RESERVING = ["SUBMITTED", "AWAITING_VISA", "AWAITING_RTO", "AWAITING_HQ", "AUTHORISED"];

export async function orgOf(c: Db, id: string) {
  const r = await c.query("SELECT * FROM orgs WHERE id = $1", [id]);
  if (!r.rows[0]) throw notFound("org.not_found");
  return r.rows[0];
}

/** SQL fragment + values limiting budget lines/documents to what the user may see. */
export function scopeFilter(u: AuthUser, alias: string, start: number): { sql: string; vals: any[] } {
  switch (u.role) {
    case "SPENDING_UNIT": return { sql: `${alias}.spending_unit_id = $${start}`, vals: [u.orgId] };
    case "MINISTRY_APPROVER":
      return { sql: `${alias}.ministry_id = $${start}`, vals: [u.orgId] };
    case "FIN_CONTROLLER":
      return { sql: `${alias}.ministry_id = (SELECT parent_id FROM orgs WHERE id = $${start})`, vals: [u.orgId] };
    case "REGIONAL_TREASURY":
      return { sql: `${alias}.spending_unit_id IN (SELECT id FROM orgs WHERE governorate = (SELECT governorate FROM orgs WHERE id = $${start}))`, vals: [u.orgId] };
    default: return { sql: "TRUE", vals: [] }; // Treasury HQ, admin, auditor
  }
}

export async function lineAvailability(c: Db, lineId: string, excludeDocId?: number) {
  const r = await c.query(
    `SELECT b.allotment::numeric AS allotment,
            COALESCE((SELECT SUM(amount) FROM documents d WHERE d.budget_line_id = b.id AND d.status = ANY($2) AND d.id <> $3), 0) AS reserved
       FROM budget_lines b WHERE b.id = $1`,
    [lineId, RESERVING, excludeDocId ?? -1],
  );
  if (!r.rows[0]) throw notFound("budget.line_not_found");
  const allotment = Number(r.rows[0].allotment), reserved = Number(r.rows[0].reserved);
  return { allotment, reserved, available: allotment - reserved };
}

export async function listLines(u: AuthUser) {
  const f = scopeFilter(u, "b", 2);
  const r = await db().query(
    `SELECT b.*, b.allotment::float8 AS allotment, b.original_allotment::float8 AS original_allotment,
            COALESCE((SELECT SUM(amount) FROM documents d WHERE d.budget_line_id = b.id AND d.status = ANY($1)), 0)::float8 AS reserved
       FROM budget_lines b WHERE ${f.sql} ORDER BY b.id`,
    [RESERVING, ...f.vals],
  );
  return r.rows.map(x => ({ ...x, available: x.allotment - x.reserved }));
}

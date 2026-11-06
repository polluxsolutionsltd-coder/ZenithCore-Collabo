/**
 * D3 – bank reconciliation of TSA accounts against CBS camt.053 statements,
 * and results indicator 3 (timeliness of bank reconciliation).
 */
import { db, tx } from "../../db/index.js";
import { AppError, AuthUser, badRequest, conflict, forbidden, notFound } from "../../lib/http.js";
import { audit } from "../audit/audit.service.js";
import { getRule } from "../rules/rules.service.js";
import { startOutbound, updateOutbound } from "../integration/gateway.service.js";
import { cbsUrl } from "../payments/cbs.client.js";
import { readCamt053 } from "../../../../cbs-sandbox/src/iso20022.js";

const ROLES = ["TREASURY_HQ", "ADMIN"];
const VIEW = ["TREASURY_HQ", "REGIONAL_TREASURY", "ADMIN", "AUDITOR"];

export function quarterOf(date: string) {
  const [y, m] = date.split("-").map(Number);
  const q = Math.floor((m - 1) / 3) + 1;
  const end = new Date(Date.UTC(y, q * 3, 0)).toISOString().slice(0, 10);
  return { period: `${y}-Q${q}`, periodEnd: end };
}

/** The last `n` quarters ending with the one containing `date`, oldest first. */
export function lastQuarters(date: string, n: number) {
  const out: { period: string; periodEnd: string }[] = [];
  let [y, m] = date.split("-").map(Number);
  let q = Math.floor((m - 1) / 3) + 1;
  for (let i = 0; i < n; i++) {
    out.unshift(quarterOf(`${y}-${String(q * 3).padStart(2, "0")}-01`));
    if (--q === 0) { q = 4; y--; }
  }
  return out;
}

export async function listBankAccounts() {
  return (await db().query("SELECT * FROM bank_accounts WHERE active ORDER BY id")).rows;
}

/** Fetches the camt.053 statement for an account and day from CBS, stores it and auto-matches it. */
export async function importStatement(u: AuthUser, input: { accountId: string; date?: string }, correlationId: string) {
  if (!ROLES.includes(u.role)) throw forbidden();
  const acct = (await db().query("SELECT id FROM bank_accounts WHERE id = $1 AND active", [input.accountId])).rows[0];
  if (!acct) throw badRequest("reconciliation.unknown_account");
  const date = input.date ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest("reconciliation.invalid_date");
  const { period, periodEnd } = quarterOf(date);
  const done = (await db().query("SELECT completed_at FROM reconciliations WHERE account_id = $1 AND period = $2", [acct.id, period])).rows[0];
  if (done?.completed_at) throw conflict("reconciliation.period_closed");

  const url = `${cbsUrl()}/iso20022/camt.053?account=${encodeURIComponent(acct.id)}&date=${date}`;
  const started = Date.now();
  const msgId = await startOutbound(db(), { partner: "CBS", msgType: "camt.053", correlationId, businessRef: `${acct.id}/${date}`, request: `GET ${url}` });
  let xml: string;
  try {
    const r = await fetch(url, { headers: { "x-correlation-id": correlationId }, signal: AbortSignal.timeout(Number(process.env.CBS_TIMEOUT_MS ?? 5000)) });
    xml = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (e: any) {
    await updateOutbound(msgId, { status: "FAILED", attempts: 1, error: String(e?.message ?? e), durationMs: Date.now() - started });
    throw new AppError(502, "integration.cbs_unavailable");
  }
  await updateOutbound(msgId, { status: "DELIVERED", attempts: 1, httpStatus: 200, response: xml, durationMs: Date.now() - started });
  const stmt = readCamt053(xml);

  return tx(async c => {
    await c.query("INSERT INTO reconciliations (account_id, period, period_end) VALUES ($1,$2,$3) ON CONFLICT (account_id, period) DO NOTHING", [acct.id, period, periodEnd]);
    let added = 0, matched = 0;
    for (const e of stmt.entries) {
      const ins = await c.query(
        `INSERT INTO bank_statement_lines (account_id, statement_id, booking_date, amount, direction, end_to_end_id, remittance)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id`,
        [acct.id, stmt.statementId, e.bookingDate, e.amount, e.direction, e.endToEndId, e.remittance]);
      if (!ins.rows.length) continue;
      added++;
      if (!e.endToEndId) continue;
      // DBIT ↔ settled (or later returned) order; CRDT ↔ returned order
      const statuses = e.direction === "DBIT" ? ["SETTLED", "RETURNED"] : ["RETURNED"];
      const po = (await c.query("SELECT id FROM payment_orders WHERE end_to_end_id = $1 AND amount = $2 AND debit_account = $3 AND status = ANY($4)",
        [e.endToEndId, e.amount, acct.id, statuses])).rows[0];
      if (po) {
        await c.query("UPDATE bank_statement_lines SET match_status = 'MATCHED', matched_po_id = $2 WHERE id = $1", [ins.rows[0].id, po.id]);
        matched++;
      }
    }
    await audit(c, { actor: u.username, action: "reconciliation.import", entity: "bank_account", entityId: acct.id, data: { statementId: stmt.statementId, lines: added, autoMatched: matched } });
    return { period, statementId: stmt.statementId, added, matched };
  });
}

export async function getReconciliation(u: AuthUser, accountId: string, period: string) {
  if (!VIEW.includes(u.role)) throw forbidden();
  if (!/^\d{4}-Q[1-4]$/.test(period)) throw badRequest("reconciliation.invalid_period");
  const year = Number(period.slice(0, 4)), q = Number(period.slice(-1));
  const from = `${year}-${String(q * 3 - 2).padStart(2, "0")}-01`, to = quarterOf(`${year}-${String(q * 3).padStart(2, "0")}-01`).periodEnd;
  const rec = (await db().query("SELECT * FROM reconciliations WHERE account_id = $1 AND period = $2", [accountId, period])).rows[0] ?? null;
  const lines = (await db().query(
    `SELECT l.id, l.statement_id, l.booking_date, l.amount::float8 AS amount, l.direction, l.end_to_end_id, l.remittance, l.match_status, l.note, p.ref AS po_ref
       FROM bank_statement_lines l LEFT JOIN payment_orders p ON p.id = l.matched_po_id
      WHERE l.account_id = $1 AND l.booking_date BETWEEN $2 AND $3 ORDER BY l.booking_date, l.id`, [accountId, from, to])).rows;
  // settled in the books but not yet on any statement (in transit)
  const bookOnly = (await db().query(
    `SELECT p.id, p.ref, p.amount::float8 AS amount, p.settled_at, p.end_to_end_id FROM payment_orders p
      WHERE p.debit_account = $1 AND p.status IN ('SETTLED','RETURNED') AND p.settled_at::date BETWEEN $2 AND $3
        AND NOT EXISTS (SELECT 1 FROM bank_statement_lines l WHERE l.matched_po_id = p.id AND l.direction = 'DBIT') ORDER BY p.id`, [accountId, from, to])).rows;
  return { reconciliation: rec, lines, bookOnly, period, from, to };
}

export async function explainLine(u: AuthUser, lineId: number, note: string) {
  if (!ROLES.includes(u.role)) throw forbidden();
  if (typeof note !== "string" || note.trim().length < 10) throw badRequest("reconciliation.note_required");
  return tx(async c => {
    const l = (await c.query("SELECT * FROM bank_statement_lines WHERE id = $1 FOR UPDATE", [lineId])).rows[0];
    if (!l) throw notFound();
    if (l.match_status !== "UNMATCHED") throw conflict("reconciliation.line_not_open");
    await c.query("UPDATE bank_statement_lines SET match_status = 'EXPLAINED', note = $2 WHERE id = $1", [lineId, note.trim()]);
    await audit(c, { actor: u.username, action: "reconciliation.explain", entity: "bank_statement_line", entityId: lineId, data: { note: note.trim(), amount: Number(l.amount), direction: l.direction } });
    return { ok: true };
  });
}

/** Closes the period once every statement line is matched or explained. */
export async function completeReconciliation(u: AuthUser, accountId: string, period: string) {
  if (!ROLES.includes(u.role)) throw forbidden();
  const view = await getReconciliation(u, accountId, period);
  if (!view.reconciliation) throw badRequest("reconciliation.no_statement");
  if (view.reconciliation.completed_at) throw conflict("reconciliation.period_closed");
  const open = view.lines.filter(l => l.match_status === "UNMATCHED").length;
  if (open) throw conflict("reconciliation.unmatched_lines", { unmatched: open });
  return tx(async c => {
    const matched = view.lines.filter(l => l.match_status === "MATCHED").length;
    await c.query("UPDATE reconciliations SET completed_at = now(), matched = $3, unmatched = 0, completed_by = $4 WHERE account_id = $1 AND period = $2",
      [accountId, period, matched, u.username]);
    await audit(c, { actor: u.username, action: "reconciliation.complete", entity: "bank_account", entityId: accountId, data: { period, matched, explained: view.lines.length - matched, inTransit: view.bookOnly.length } });
    return { ok: true, period, matched };
  });
}

/**
 * Indicator 3 – share of account-quarters (central-government bank accounts,
 * last four quarters) reconciled within the deadline after quarter end.
 * A quarter counts once it is reconciled or once its deadline has passed.
 */
export async function reconciliationTimeliness(today = new Date().toISOString().slice(0, 10)) {
  const days = (await getRule("REC_DEADLINE_DAYS"))?.days ?? 30;
  const accounts = (await db().query("SELECT id FROM bank_accounts WHERE active AND central_government")).rows.map(r => r.id);
  const quarters = lastQuarters(today, 4);
  const recs = (await db().query("SELECT account_id, period, period_end::text AS period_end, completed_at FROM reconciliations WHERE period = ANY($1)", [quarters.map(q => q.period)])).rows;
  let due = 0, onTime = 0;
  const detail: any[] = [];
  for (const q of quarters) {
    const deadline = new Date(Date.parse(q.periodEnd + "T23:59:59Z") + days * 86_400_000);
    for (const a of accounts) {
      const r = recs.find(x => x.account_id === a && x.period === q.period);
      const completed = r?.completed_at ? new Date(r.completed_at) : null;
      const isDue = completed !== null || Date.parse(today + "T00:00:00Z") > deadline.getTime();
      if (!isDue) continue;
      due++;
      const ok = completed !== null && completed <= deadline;
      if (ok) onTime++;
      detail.push({ account: a, period: q.period, completedAt: completed, deadline: deadline.toISOString().slice(0, 10), onTime: ok });
    }
  }
  return { due, onTime, ratio: due ? onTime / due : null, deadlineDays: days, detail };
}

/**
 * Citizen's Budget Helpdesk and the public transparency portal (indicator 6).
 * Citizens need no account: a question gets a reference and an access code
 * for following it up. Staff answer within the SLA set by HELPDESK_SLA_DAYS.
 */
import crypto from "node:crypto";
import { rateTable, sypSql } from "../currency/currency.service.js";
import { db, tx } from "../../db/index.js";
import { AppError, AuthUser, badRequest, conflict, forbidden, notFound } from "../../lib/http.js";
import { audit } from "../audit/audit.service.js";
import { getRule } from "../rules/rules.service.js";
import { notify } from "../notifications/notifications.service.js";

const CATEGORIES = ["BUDGET", "PAYMENT", "REVENUE", "PORTAL", "OTHER"];

/** Per-address limit on public submissions (per process). */
const hits = new Map<string, number[]>();
export function publicRateLimit(ip: string, perHour = Number(process.env.PUBLIC_SUBMISSIONS_PER_HOUR ?? 10)) {
  const now = Date.now();
  const list = (hits.get(ip) ?? []).filter(t => now - t < 3_600_000);
  if (list.length >= perHour) throw new AppError(429, "helpdesk.too_many");
  list.push(now); hits.set(ip, list);
}
export const resetPublicLimits = () => hits.clear();

export async function submitQuestion(input: { category: string; lang: string; question: string; contact?: string; website?: string }) {
  if (input.website) throw badRequest("helpdesk.rejected"); // honeypot field, invisible to people
  if (!CATEGORIES.includes(input.category)) throw badRequest("helpdesk.invalid_category");
  if (!["ar", "en", "fr"].includes(input.lang)) throw badRequest("helpdesk.invalid_lang");
  const q = String(input.question ?? "").trim();
  if (q.length < 10 || q.length > 2000) throw badRequest("helpdesk.question_length");
  const contact = String(input.contact ?? "").trim().slice(0, 120) || null;
  const days = (await getRule("HELPDESK_SLA_DAYS"))?.days ?? 5;
  return tx(async c => {
    const seq = (await c.query("SELECT nextval('ticket_ref_seq') AS n")).rows[0].n;
    const ref = `HD-${new Date().getFullYear()}-${String(seq).padStart(5, "0")}`;
    const code = crypto.randomBytes(4).toString("hex").toUpperCase();
    const due = new Date(Date.now() + days * 86_400_000);
    const r = (await c.query(
      "INSERT INTO helpdesk_tickets (ref, access_code, category, lang, question, contact, due_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
      [ref, code, input.category, input.lang, q, contact, due])).rows[0];
    await audit(c, { actor: "public", action: "helpdesk.submit", entity: "helpdesk_ticket", entityId: r.id, data: { ref, category: input.category, lang: input.lang } });
    await notify(c, { role: "HELPDESK", key: "helpdesk.new", params: { ref } });
    return { ref, accessCode: code, dueAt: due.toISOString() };
  });
}

export async function questionStatus(ref: string, code: string) {
  const t = (await db().query("SELECT ref, access_code, category, question, status, answer, created_at, answered_at, due_at FROM helpdesk_tickets WHERE ref = $1",
    [String(ref ?? "").trim().toUpperCase()])).rows[0];
  const given = String(code ?? "").trim().toUpperCase();
  if (!t || given.length !== t.access_code.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(t.access_code))) throw notFound("helpdesk.not_found");
  const { access_code, ...out } = t;
  return out;
}

export async function listTickets(u: AuthUser, status?: string) {
  if (!["HELPDESK", "ADMIN", "AUDITOR"].includes(u.role)) throw forbidden();
  const vals: any[] = [];
  let where = "";
  if (status) { vals.push(status); where = "WHERE t.status = $1"; }
  return (await db().query(
    `SELECT t.id, t.ref, t.category, t.lang, t.question, t.contact, t.status, t.answer, t.created_at, t.answered_at, t.due_at,
            (t.status = 'OPEN' AND t.due_at < now()) AS overdue, u.username AS answered_by
       FROM helpdesk_tickets t LEFT JOIN users u ON u.id = t.answered_by ${where} ORDER BY (t.status = 'OPEN') DESC, t.due_at, t.id DESC LIMIT 300`, vals)).rows;
}

export async function answerTicket(u: AuthUser, id: number, answer: string) {
  if (u.role !== "HELPDESK") throw forbidden();
  const a = String(answer ?? "").trim();
  if (a.length < 20) throw badRequest("helpdesk.answer_length");
  return tx(async c => {
    const t = (await c.query("SELECT * FROM helpdesk_tickets WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!t) throw notFound();
    if (t.status !== "OPEN") throw conflict("helpdesk.not_open");
    await c.query("UPDATE helpdesk_tickets SET status = 'ANSWERED', answer = $2, answered_by = $3, answered_at = now() WHERE id = $1", [id, a, u.id]);
    await audit(c, { actor: u.username, action: "helpdesk.answer", entity: "helpdesk_ticket", entityId: id, data: { ref: t.ref, withinSla: new Date() <= new Date(t.due_at) } });
    return { ok: true };
  });
}

/**
 * Indicator 6: the Transparency Portal publishes this year's budget data and
 * the helpdesk answers on time (≥ 80% of questions due in the last 90 days).
 */
export async function transparencyStatus() {
  const r = (await db().query(
    `SELECT COUNT(*) FILTER (WHERE status <> 'OPEN' OR due_at < now())::int AS due,
            COUNT(*) FILTER (WHERE answered_at IS NOT NULL AND answered_at <= due_at)::int AS on_time
       FROM helpdesk_tickets WHERE created_at > now() - interval '90 days'`)).rows[0];
  const lines = (await db().query("SELECT COUNT(*)::int AS n FROM budget_lines WHERE year = $1", [new Date().getFullYear()])).rows[0].n;
  const portal = lines > 0;
  const ratio = r.due ? r.on_time / r.due : null;
  const helpdesk = ratio !== null && ratio >= 0.8;
  return { portal, helpdesk, operational: portal && helpdesk, onTime: r.on_time, due: r.due, ratio };
}

/** Public budget data for the Transparency Portal (aggregated; no personal data). */
export async function publicBudget() {
  const year = new Date().getFullYear();
  const rates = await rateTable(); // donor lines in foreign currency are shown at their SYP value
  const rows = (await db().query(
    `SELECT m.id AS ministry_id, m.name_en, m.name_ar, m.name_fr,
            SUM(${sypSql("b.allotment", "b.currency", rates)})::float8 AS allotment,
            COALESCE(SUM((SELECT SUM(p.amount * COALESCE(p.fx_rate, 1)) FROM payment_orders p JOIN documents d ON d.id = p.document_id WHERE d.budget_line_id = b.id AND p.status = 'SETTLED')), 0)::float8 AS paid
       FROM budget_lines b JOIN orgs m ON m.id = b.ministry_id WHERE b.year = $1 GROUP BY m.id, m.name_en, m.name_ar, m.name_fr ORDER BY m.id`, [year])).rows;
  const revenue = (await db().query(
    `SELECT c.code, c.name_en, c.name_ar, c.name_fr, COALESCE(SUM(r.amount) FILTER (WHERE r.status = 'ISSUED'), 0)::float8 AS collected
       FROM revenue_codes c LEFT JOIN receipts r ON r.revenue_code = c.code AND date_part('year', r.issued_at) = $1 GROUP BY c.code ORDER BY c.code`, [year])).rows;
  return { year, updatedAt: new Date().toISOString(), ministries: rows, revenue, note: "Sample data for demonstration" };
}

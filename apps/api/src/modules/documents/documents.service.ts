/**
 * D1 – payment request lifecycle.
 *
 * Spending unit → line ministry → Financial Controller visa (above threshold)
 * → Regional Treasury Office second-level controls → MoF Treasury HQ
 * authorisation → electronic payment order (debit TSA).
 */
import { Db, db, tx } from "../../db/index.js";
import { AuthUser, badRequest, conflict, forbidden, notFound } from "../../lib/http.js";
import { audit } from "../audit/audit.service.js";
import { getRule } from "../rules/rules.service.js";
import { notify } from "../notifications/notifications.service.js";
import { lineAvailability, scopeFilter } from "../budget/budget.service.js";

export const OPEN = ["SUBMITTED", "AWAITING_VISA", "AWAITING_RTO", "AWAITING_HQ"];

export type Action = "approve" | "reject" | "grant_visa" | "refuse_visa" | "authorise";

/** Who acts at each status, and what the actions lead to. */
const STEPS: Record<string, { role: string; step: string; actions: Partial<Record<Action, string>> }> = {
  SUBMITTED:     { role: "MINISTRY_APPROVER", step: "MINISTRY", actions: { approve: "NEXT_AFTER_MINISTRY", reject: "REJECTED" } },
  AWAITING_VISA: { role: "FIN_CONTROLLER",    step: "VISA",     actions: { grant_visa: "AWAITING_RTO", refuse_visa: "REJECTED" } },
  AWAITING_RTO:  { role: "REGIONAL_TREASURY", step: "RTO",      actions: { approve: "AWAITING_HQ", reject: "REJECTED" } },
  AWAITING_HQ:   { role: "TREASURY_HQ",       step: "HQ",       actions: { authorise: "AUTHORISED", reject: "REJECTED" } },
};

const DECISION: Record<Action, string> = { approve: "APPROVED", reject: "REJECTED", grant_visa: "VISA_GRANTED", refuse_visa: "VISA_REFUSED", authorise: "AUTHORISED" };

/** IBAN format and ISO 13616 mod-97 check. */
export function ibanValid(iban: string): boolean {
  const s = iban.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

async function loadDoc(c: Db, id: number, lock = false) {
  const r = await c.query(`SELECT d.*, d.amount::float8 AS amount FROM documents d WHERE d.id = $1 ${lock ? "FOR UPDATE" : ""}`, [id]);
  if (!r.rows[0]) throw notFound("document.not_found");
  return r.rows[0];
}

/** Whether `u` is the right person (role and organisation) to act at the document's current status. */
async function isActor(c: Db, u: AuthUser, doc: any): Promise<boolean> {
  const s = STEPS[doc.status];
  if (!s || s.role !== u.role) return false;
  switch (u.role) {
    case "MINISTRY_APPROVER": return u.orgId === doc.ministry_id;
    case "FIN_CONTROLLER": {
      const r = await c.query("SELECT parent_id FROM orgs WHERE id = $1", [u.orgId]);
      return r.rows[0]?.parent_id === doc.ministry_id;
    }
    case "REGIONAL_TREASURY": return u.orgId === doc.rto_id;
    case "TREASURY_HQ": return true;
    default: return false;
  }
}

export async function allowedActions(c: Db, u: AuthUser, doc: any): Promise<string[]> {
  const out: string[] = [];
  if (doc.status === "DRAFT" && u.role === "SPENDING_UNIT" && u.orgId === doc.spending_unit_id) out.push("submit");
  if (OPEN.includes(doc.status) && u.role === "SPENDING_UNIT" && u.orgId === doc.spending_unit_id) out.push("amend");
  if (await isActor(c, u, doc)) out.push(...Object.keys(STEPS[doc.status].actions));
  return out;
}

async function visaThreshold(c: Db, ministryId: string): Promise<number> {
  const v = await getRule("VISA_THRESHOLD", [ministryId], undefined, c);
  return v?.amount ?? 0;
}

/** Regional Treasury Office second-level controls: budget, commitment (visa), monthly cash limit. */
export async function rtoChecks(c: Db, doc: any) {
  const avail = await lineAvailability(c, doc.budget_line_id, doc.id);
  const checks: Array<{ key: string; ok: boolean; params: Record<string, any> }> = [];
  checks.push({ key: "check.budget", ok: avail.available >= doc.amount, params: { available: avail.available, amount: doc.amount } });

  let visaOk = true;
  if (doc.visa_required) {
    const v = await c.query(
      "SELECT amount::float8 AS amount FROM approvals WHERE document_id = $1 AND decision = 'VISA_GRANTED' ORDER BY id DESC LIMIT 1", [doc.id]);
    visaOk = !!v.rows[0] && v.rows[0].amount >= doc.amount;
  }
  checks.push({ key: "check.commitment", ok: visaOk, params: { visaRequired: doc.visa_required } });

  const limit = await getRule("CASH_LIMIT_MONTHLY", [doc.spending_unit_id], undefined, c);
  const used = await c.query(
    `SELECT COALESCE(SUM(p.amount), 0)::float8 AS used FROM payment_orders p JOIN documents d ON d.id = p.document_id
      WHERE d.spending_unit_id = $1 AND date_trunc('month', p.created_at) = date_trunc('month', now()) AND p.status NOT IN ('REJECTED','RETURNED')`,
    [doc.spending_unit_id]);
  const cap = limit?.amount ?? Infinity;
  checks.push({ key: "check.cash_limit", ok: used.rows[0].used + doc.amount <= cap, params: { limit: Number.isFinite(cap) ? cap : null, used: used.rows[0].used, amount: doc.amount } });
  return checks;
}

const actorName = (u: AuthUser) => u.username;

export async function createDocument(u: AuthUser, input: any) {
  if (u.role !== "SPENDING_UNIT") throw forbidden();
  const amount = Number(input.amount);
  if (!(amount > 0)) throw badRequest("document.invalid_amount");
  for (const f of ["budgetLineId", "supplierName", "supplierIban", "description"]) {
    if (!input[f] || String(input[f]).trim().length < 2) throw badRequest("document.missing_field", { field: f });
  }
  if (!ibanValid(input.supplierIban)) throw badRequest("document.invalid_iban");
  return tx(async c => {
    const line = (await c.query("SELECT * FROM budget_lines WHERE id = $1", [input.budgetLineId])).rows[0];
    if (!line || line.spending_unit_id !== u.orgId) throw badRequest("document.line_not_allowed");
    const unit = (await c.query("SELECT * FROM orgs WHERE id = $1", [u.orgId])).rows[0];
    const rto = (await c.query("SELECT id FROM orgs WHERE kind = 'REGIONAL_TREASURY' AND governorate = $1", [unit.governorate])).rows[0];
    if (!rto) throw badRequest("document.no_regional_treasury");
    const seq = (await c.query("SELECT nextval('doc_ref_seq') AS n")).rows[0].n;
    const ref = `PR-${new Date().getFullYear()}-${String(seq).padStart(6, "0")}`;
    const r = await c.query(
      `INSERT INTO documents (ref, spending_unit_id, ministry_id, rto_id, budget_line_id, supplier_name, supplier_iban, description, amount, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'DRAFT',$10) RETURNING id`,
      [ref, u.orgId, line.ministry_id, rto.id, line.id, input.supplierName.trim(), input.supplierIban.replace(/\s+/g, "").toUpperCase(), input.description.trim(), amount, u.id]);
    const id = r.rows[0].id;
    await audit(c, { actor: actorName(u), action: "document.create", entity: "document", entityId: id, data: { ref, amount, budgetLineId: line.id } });
    return { id, ref };
  });
}

function checkVersion(doc: any, version?: number) {
  if (version !== undefined && version !== null && Number(version) !== doc.version) throw conflict("document.stale", { current: doc.version });
}

async function notifyNext(c: Db, doc: any, status: string) {
  const key = { SUBMITTED: "doc.awaiting_ministry", AWAITING_VISA: "doc.awaiting_visa", AWAITING_RTO: "doc.awaiting_rto", AWAITING_HQ: "doc.awaiting_hq" }[status];
  if (!key) return;
  const role = STEPS[status].role;
  let orgId: string | undefined;
  if (status === "SUBMITTED") orgId = doc.ministry_id;
  if (status === "AWAITING_VISA") orgId = (await c.query("SELECT id FROM orgs WHERE kind = 'CONTROLLER' AND parent_id = $1", [doc.ministry_id])).rows[0]?.id;
  if (status === "AWAITING_RTO") orgId = doc.rto_id;
  await notify(c, { role, orgId, key, params: { ref: doc.ref, amount: doc.amount }, documentId: doc.id });
}

export async function submitDocument(u: AuthUser, id: number, version?: number) {
  return tx(async c => {
    const doc = await loadDoc(c, id, true);
    if (!(await allowedActions(c, u, doc)).includes("submit")) throw forbidden("document.action_not_allowed");
    checkVersion(doc, version);
    await c.query("SELECT id FROM budget_lines WHERE id = $1 FOR UPDATE", [doc.budget_line_id]); // serialise reservations on the line
    const avail = await lineAvailability(c, doc.budget_line_id, doc.id);
    if (avail.available < doc.amount) throw conflict("document.insufficient_funds", { available: avail.available, amount: doc.amount });
    const visa = doc.amount >= (await visaThreshold(c, doc.ministry_id));
    await c.query("UPDATE documents SET status = 'SUBMITTED', visa_required = $2, version = version + 1, updated_at = now() WHERE id = $1", [id, visa]);
    await c.query("INSERT INTO approvals (document_id, step, decision, actor_id, amount, checks) VALUES ($1,'SPENDING_UNIT','SUBMITTED',$2,$3,$4)",
      [id, u.id, doc.amount, JSON.stringify([{ key: "check.budget", ok: true, params: { available: avail.available, amount: doc.amount } }])]);
    await audit(c, { actor: actorName(u), action: "document.submit", entity: "document", entityId: id, data: { status: { from: "DRAFT", to: "SUBMITTED" }, reserved: doc.amount, visaRequired: visa } });
    await notifyNext(c, { ...doc, status: "SUBMITTED" }, "SUBMITTED");
    return { status: "SUBMITTED", visaRequired: visa };
  });
}

export async function actOnDocument(u: AuthUser, id: number, action: Action, input: { reason?: string; version?: number }) {
  return tx(async c => {
    const doc = await loadDoc(c, id, true);
    const step = STEPS[doc.status];
    if (!step || !(action in step.actions) || !(await isActor(c, u, doc))) throw forbidden("document.action_not_allowed");
    checkVersion(doc, input.version);
    const reason = (input.reason ?? "").trim();
    const negative = action === "reject" || action === "refuse_visa";
    if (negative) {
      const min = (await getRule("REJECTION_REASON_MIN", [], undefined, c))?.chars ?? 10;
      if (reason.length < min) throw badRequest("document.reason_required", { min });
    }

    let next = step.actions[action]!;
    if (next === "NEXT_AFTER_MINISTRY") next = doc.visa_required ? "AWAITING_VISA" : "AWAITING_RTO";

    let checks: any = null;
    if (doc.status === "AWAITING_RTO" && action === "approve") {
      checks = await rtoChecks(c, doc);
      if (checks.some((k: any) => !k.ok)) throw conflict("document.checks_failed", { checks });
    }

    await c.query("UPDATE documents SET status = $2, version = version + 1, updated_at = now() WHERE id = $1", [id, next]);
    await c.query("INSERT INTO approvals (document_id, step, decision, actor_id, reason, checks, amount) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [id, step.step, DECISION[action], u.id, reason || null, checks ? JSON.stringify(checks) : null, doc.amount]);

    let paymentOrder: any = null;
    if (next === "AUTHORISED") {
      const acct = (await getRule("TSA_DEBIT_ACCOUNT", [], undefined, c))?.account ?? "TSA-CBS-0001";
      const seq = (await c.query("SELECT nextval('po_ref_seq') AS n")).rows[0].n;
      const ref = `PO-${new Date().getFullYear()}-${String(seq).padStart(6, "0")}`;
      paymentOrder = (await c.query(
        `INSERT INTO payment_orders (ref, document_id, amount, debit_account, via_tsa, beneficiary_name, beneficiary_iban)
         VALUES ($1,$2,$3,$4,TRUE,$5,$6) RETURNING id, ref, status`,
        [ref, id, doc.amount, acct, doc.supplier_name, doc.supplier_iban])).rows[0];
      await audit(c, { actor: actorName(u), action: "payment_order.issue", entity: "payment_order", entityId: paymentOrder.id, data: { ref, documentId: id, amount: doc.amount, debitAccount: acct } });
    }

    await audit(c, { actor: actorName(u), action: `document.${action}`, entity: "document", entityId: id, data: { status: { from: doc.status, to: next }, reason: reason || undefined, checks: checks ?? undefined } });

    if (next === "REJECTED") {
      await notify(c, { userId: doc.created_by, key: "doc.rejected", params: { ref: doc.ref, reason, by: u.role }, documentId: id });
    } else if (next === "AUTHORISED") {
      await notify(c, { userId: doc.created_by, key: "doc.authorised", params: { ref: doc.ref, po: paymentOrder.ref }, documentId: id });
    } else {
      await notifyNext(c, doc, next);
    }
    return { status: next, paymentOrder };
  });
}

/**
 * Amendment by the spending unit. A reduction keeps the approvals already
 * given; an increase re-checks funds and sends the request back to the
 * ministry, recalculating whether a visa is needed.
 */
export async function amendDocument(u: AuthUser, id: number, input: { amount: number; reason: string; version?: number }) {
  return tx(async c => {
    const doc = await loadDoc(c, id, true);
    if (!(await allowedActions(c, u, doc)).includes("amend")) throw forbidden("document.action_not_allowed");
    checkVersion(doc, input.version);
    const amount = Number(input.amount);
    const reason = (input.reason ?? "").trim();
    if (!(amount > 0) || amount === doc.amount) throw badRequest("document.invalid_amount");
    const min = (await getRule("REJECTION_REASON_MIN", [], undefined, c))?.chars ?? 10;
    if (reason.length < min) throw badRequest("document.reason_required", { min });

    const visa = amount >= (await visaThreshold(c, doc.ministry_id));
    let status = doc.status;
    if (amount > doc.amount) {
      await c.query("SELECT id FROM budget_lines WHERE id = $1 FOR UPDATE", [doc.budget_line_id]);
      const avail = await lineAvailability(c, doc.budget_line_id, doc.id);
      if (avail.available < amount) throw conflict("document.insufficient_funds", { available: avail.available, amount });
      status = "SUBMITTED";
    } else if (doc.status === "AWAITING_VISA" && !visa) {
      status = "AWAITING_RTO";
    }
    await c.query("UPDATE documents SET amount = $2, status = $3, visa_required = $4, version = version + 1, updated_at = now() WHERE id = $1",
      [id, amount, status, visa]);
    await c.query("INSERT INTO approvals (document_id, step, decision, actor_id, reason, amount) VALUES ($1,'SPENDING_UNIT','AMENDED',$2,$3,$4)",
      [id, u.id, reason, amount]);
    await audit(c, { actor: actorName(u), action: "document.amend", entity: "document", entityId: id,
      data: { amount: { from: doc.amount, to: amount }, status: { from: doc.status, to: status }, reason } });
    if (status !== doc.status) await notifyNext(c, { ...doc, amount }, status);
    else if (STEPS[status]) await notify(c, { role: STEPS[status].role, key: "doc.amended", params: { ref: doc.ref, from: doc.amount, to: amount }, documentId: id });
    return { status, amount };
  });
}

export async function getDocument(u: AuthUser, id: number) {
  const c = db();
  const f = scopeFilter(u, "d", 2);
  const r = await c.query(`SELECT d.*, d.amount::float8 AS amount FROM documents d WHERE d.id = $1 AND ${f.sql}`, [id, ...f.vals]);
  const doc = r.rows[0];
  if (!doc) throw notFound("document.not_found");
  const orgIds = [doc.spending_unit_id, doc.ministry_id, doc.rto_id];
  const orgs = Object.fromEntries((await c.query("SELECT id, name_en, name_ar, name_fr FROM orgs WHERE id = ANY($1)", [orgIds])).rows.map(o => [o.id, o]));
  const line = (await c.query("SELECT id, name_en, name_ar, name_fr, economic, programme FROM budget_lines WHERE id = $1", [doc.budget_line_id])).rows[0];
  const approvals = (await c.query(
    `SELECT a.step, a.decision, a.reason, a.checks, a.amount::float8 AS amount, a.created_at, u.username, u.full_name_en, u.full_name_ar, u.role
       FROM approvals a JOIN users u ON u.id = a.actor_id WHERE a.document_id = $1 ORDER BY a.id`, [id])).rows;
  const paymentOrders = (await c.query(
    `SELECT id, ref, amount::float8 AS amount, debit_account, beneficiary_iban, status, end_to_end_id, cbs_status, cbs_reason, created_at, sent_at, settled_at, returned_at, paid_at, replaces_id
       FROM payment_orders WHERE document_id = $1 ORDER BY id`, [id])).rows;
  const paymentOrder = paymentOrders[paymentOrders.length - 1] ?? null; // the current order; earlier ones were replaced
  const actions = await allowedActions(c, u, doc);
  const checks = doc.status === "AWAITING_RTO" ? await rtoChecks(c, doc) : null;
  const availability = await lineAvailability(c, doc.budget_line_id); // after this request's reservation
  return { ...doc, orgs, line, approvals, paymentOrder, paymentOrders, actions, checks, availability };
}

export async function listDocuments(u: AuthUser, scope: string) {
  const c = db();
  const f = scopeFilter(u, "d", 1);
  const r = await c.query(
    `SELECT d.id, d.ref, d.status, d.amount::float8 AS amount, d.supplier_name, d.description, d.budget_line_id, d.spending_unit_id, d.ministry_id, d.rto_id,
            d.visa_required, d.created_by, d.updated_at, o.name_en AS unit_en, o.name_ar AS unit_ar, o.name_fr AS unit_fr
       FROM documents d JOIN orgs o ON o.id = d.spending_unit_id WHERE ${f.sql} ORDER BY d.updated_at DESC LIMIT 200`, f.vals);
  if (scope === "inbox") {
    const out: any[] = [];
    for (const d of r.rows) if ((await allowedActions(c, u, d)).some(a => a !== "amend")) out.push(d);
    return out;
  }
  if (scope === "mine") return r.rows.filter(d => d.created_by === u.id);
  return r.rows;
}

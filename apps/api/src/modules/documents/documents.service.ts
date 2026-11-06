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
import { fxRate } from "../currency/currency.service.js";
import { signApproval } from "../esign/esign.service.js";
import { lineAvailability, scopeFilter } from "../budget/budget.service.js";
import { delegatesOf, identities, Identity } from "../delegation/delegation.service.js";

export const OPEN = ["SUBMITTED", "AWAITING_VISA", "AWAITING_RTO", "AWAITING_HQ"];

export type Action = "approve" | "reject" | "grant_visa" | "refuse_visa" | "authorise";

/** Who acts at each status, and what the actions lead to. */
const STEPS: Record<string, { role: string; step: string; actions: Partial<Record<Action, string>> }> = {
  SUBMITTED:     { role: "MINISTRY_APPROVER", step: "MINISTRY", actions: { approve: "NEXT", reject: "REJECTED" } },
  AWAITING_VISA: { role: "FIN_CONTROLLER",    step: "VISA",     actions: { grant_visa: "NEXT", refuse_visa: "REJECTED" } },
  AWAITING_RTO:  { role: "REGIONAL_TREASURY", step: "RTO",      actions: { approve: "NEXT", reject: "REJECTED" } },
  AWAITING_HQ:   { role: "TREASURY_HQ",       step: "HQ",       actions: { authorise: "NEXT", reject: "REJECTED" } },
};

/**
 * Configurable route (D4). The WORKFLOW_ROUTE rule lists the steps for a
 * ministry, in this order: MINISTRY, VISA, RTO, HQ (HQ is always last and
 * required). VISA applies only at or above the visa threshold. The route is
 * stored on the request at submission.
 */
export const ROUTE_ORDER = ["MINISTRY", "VISA", "RTO", "HQ"];
export const DEFAULT_ROUTE = ROUTE_ORDER;
const STEP_STATUS: Record<string, string> = { MINISTRY: "SUBMITTED", VISA: "AWAITING_VISA", RTO: "AWAITING_RTO", HQ: "AWAITING_HQ" };

export function validRoute(steps: any): boolean {
  if (!Array.isArray(steps) || !steps.length || steps[steps.length - 1] !== "HQ") return false;
  let last = -1;
  for (const st of steps) { const i = ROUTE_ORDER.indexOf(st); if (i <= last) return false; last = i; }
  return true;
}
export function routeStatuses(route: string[] | null, visa: boolean): string[] {
  return (route ?? DEFAULT_ROUTE).filter(st => st !== "VISA" || visa).map(st => STEP_STATUS[st]);
}
function nextStatus(route: string[] | null, visa: boolean, current: string): string {
  const list = routeStatuses(route, visa);
  const i = list.indexOf(current);
  return i >= 0 && i < list.length - 1 ? list[i + 1] : "AUTHORISED";
}
async function routeFor(c: Db, ministryId: string): Promise<string[]> {
  const r = await getRule("WORKFLOW_ROUTE", [ministryId], undefined, c);
  return validRoute(r?.steps) ? r.steps : DEFAULT_ROUTE;
}

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

/** The identity (the user, or someone who delegated to the user) entitled to act now, if any. */
async function actingIdentity(c: Db, u: AuthUser, doc: any, ids?: Identity[]): Promise<Identity | null> {
  for (const id of ids ?? await identities(c, u)) if (await isActor(c, id, doc)) return id;
  return null;
}

/** Segregation of duties: one person decides at most one step of a request (delegation included). */
async function alreadyDecided(c: Db, u: AuthUser, doc: any): Promise<boolean> {
  const r = await c.query(
    "SELECT 1 FROM approvals WHERE document_id = $1 AND step <> 'SPENDING_UNIT' AND step <> $2 AND (actor_id = $3 OR on_behalf_of = $3) LIMIT 1",
    [doc.id, STEPS[doc.status]?.step ?? "", u.id]);
  return r.rows.length > 0 || doc.created_by === u.id;
}

export async function allowedActions(c: Db, u: AuthUser, doc: any, ids?: Identity[]): Promise<string[]> {
  const out: string[] = [];
  if (doc.status === "DRAFT" && u.role === "SPENDING_UNIT" && u.orgId === doc.spending_unit_id) out.push("submit");
  if (OPEN.includes(doc.status) && u.role === "SPENDING_UNIT" && u.orgId === doc.spending_unit_id) out.push("amend");
  if (STEPS[doc.status] && (await actingIdentity(c, u, doc, ids)) && !(await alreadyDecided(c, u, doc))) out.push(...Object.keys(STEPS[doc.status].actions));
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
    `SELECT COALESCE(SUM(p.amount * COALESCE(p.fx_rate, 1)), 0)::float8 AS used FROM payment_orders p JOIN documents d ON d.id = p.document_id
      WHERE d.spending_unit_id = $1 AND date_trunc('month', p.created_at) = date_trunc('month', now()) AND p.status NOT IN ('REJECTED','RETURNED')`,
    [doc.spending_unit_id]);
  const cap = limit?.amount ?? Infinity;
  const amountSyp = doc.amount * (await fxRate(doc.currency, undefined, c)); // limits are in SYP
  checks.push({ key: "check.cash_limit", ok: used.rows[0].used + amountSyp <= cap, params: { limit: Number.isFinite(cap) ? cap : null, used: used.rows[0].used, amount: amountSyp } });
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
  const clientRef = typeof input.clientRef === "string" && /^[A-Za-z0-9-]{8,64}$/.test(input.clientRef) ? input.clientRef : null;
  return tx(async c => {
    if (clientRef) { // a request captured offline and synced again: return the one already created
      const prev = (await c.query("SELECT id, ref FROM documents WHERE created_by = $1 AND client_ref = $2", [u.id, clientRef])).rows[0];
      if (prev) return { id: prev.id, ref: prev.ref, replay: true };
    }
    const line = (await c.query("SELECT * FROM budget_lines WHERE id = $1", [input.budgetLineId])).rows[0];
    if (!line || line.spending_unit_id !== u.orgId) throw badRequest("document.line_not_allowed");
    const unit = (await c.query("SELECT * FROM orgs WHERE id = $1", [u.orgId])).rows[0];
    const rto = (await c.query("SELECT id FROM orgs WHERE kind = 'REGIONAL_TREASURY' AND governorate = $1", [unit.governorate])).rows[0];
    if (!rto) throw badRequest("document.no_regional_treasury");
    const seq = (await c.query("SELECT nextval('doc_ref_seq') AS n")).rows[0].n;
    const ref = `PR-${new Date().getFullYear()}-${String(seq).padStart(6, "0")}`;
    const r = await c.query(
      `INSERT INTO documents (ref, spending_unit_id, ministry_id, rto_id, budget_line_id, supplier_name, supplier_iban, description, amount, status, created_by, client_ref, currency)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'DRAFT',$10,$11,$12) RETURNING id`,
      [ref, u.orgId, line.ministry_id, rto.id, line.id, input.supplierName.trim(), input.supplierIban.replace(/\s+/g, "").toUpperCase(), input.description.trim(), amount, u.id, clientRef, line.currency]);
    const id = r.rows[0].id;
    await audit(c, { actor: actorName(u), action: "document.create", entity: "document", entityId: id, data: { ref, amount, currency: line.currency, budgetLineId: line.id, offline: clientRef ? true : undefined } });
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
  for (const userId of await delegatesOf(c, role, role === "TREASURY_HQ" ? undefined : orgId)) {
    await notify(c, { userId, key, params: { ref: doc.ref, amount: doc.amount, delegated: true }, documentId: doc.id });
  }
}

export async function submitDocument(u: AuthUser, id: number, version?: number) {
  return tx(async c => {
    const doc = await loadDoc(c, id, true);
    if (!(await allowedActions(c, u, doc)).includes("submit")) throw forbidden("document.action_not_allowed");
    checkVersion(doc, version);
    await c.query("SELECT id FROM budget_lines WHERE id = $1 FOR UPDATE", [doc.budget_line_id]); // serialise reservations on the line
    const avail = await lineAvailability(c, doc.budget_line_id, doc.id);
    if (avail.available < doc.amount) throw conflict("document.insufficient_funds", { available: avail.available, amount: doc.amount });
    const route = await routeFor(c, doc.ministry_id);
    const visa = route.includes("VISA") && doc.amount * (await fxRate(doc.currency, undefined, c)) >= (await visaThreshold(c, doc.ministry_id)); // threshold in SYP
    const first = routeStatuses(route, visa)[0];
    await c.query("UPDATE documents SET status = $3, visa_required = $2, route = $4, version = version + 1, updated_at = now() WHERE id = $1", [id, visa, first, route]);
    const ap = await c.query("INSERT INTO approvals (document_id, step, decision, actor_id, amount, checks) VALUES ($1,'SPENDING_UNIT','SUBMITTED',$2,$3,$4) RETURNING id",
      [id, u.id, doc.amount, JSON.stringify([{ key: "check.budget", ok: true, params: { available: avail.available, amount: doc.amount } }])]);
    await signApproval(c, ap.rows[0].id);
    await audit(c, { actor: actorName(u), action: "document.submit", entity: "document", entityId: id, data: { status: { from: "DRAFT", to: first }, reserved: doc.amount, visaRequired: visa, route } });
    await notifyNext(c, { ...doc, status: first }, first);
    return { status: first, visaRequired: visa, route };
  });
}

export async function actOnDocument(u: AuthUser, id: number, action: Action, input: { reason?: string; version?: number }) {
  return tx(async c => {
    const doc = await loadDoc(c, id, true);
    const step = STEPS[doc.status];
    const who = step && action in step.actions ? await actingIdentity(c, u, doc) : null;
    if (!who) throw forbidden("document.action_not_allowed");
    if (await alreadyDecided(c, u, doc)) throw forbidden("document.segregation_of_duties");
    const onBehalfOf = who.id !== u.id ? who : null;
    checkVersion(doc, input.version);
    const reason = (input.reason ?? "").trim();
    const negative = action === "reject" || action === "refuse_visa";
    if (negative) {
      const min = (await getRule("REJECTION_REASON_MIN", [], undefined, c))?.chars ?? 10;
      if (reason.length < min) throw badRequest("document.reason_required", { min });
    }

    let next = step.actions[action]!;
    if (next === "NEXT") next = nextStatus(doc.route, doc.visa_required, doc.status);

    // second-level controls run at the Regional Treasury step, or at HQ when the route has no RTO step
    const route: string[] = doc.route ?? DEFAULT_ROUTE;
    let checks: any = null;
    if ((doc.status === "AWAITING_RTO" && action === "approve") || (doc.status === "AWAITING_HQ" && action === "authorise" && !route.includes("RTO"))) {
      checks = await rtoChecks(c, doc);
      if (checks.some((k: any) => !k.ok)) throw conflict("document.checks_failed", { checks });
    }

    await c.query("UPDATE documents SET status = $2, version = version + 1, updated_at = now() WHERE id = $1", [id, next]);
    const ap = await c.query("INSERT INTO approvals (document_id, step, decision, actor_id, reason, checks, amount, on_behalf_of) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
      [id, step.step, DECISION[action], u.id, reason || null, checks ? JSON.stringify(checks) : null, doc.amount, onBehalfOf?.id ?? null]);
    await signApproval(c, ap.rows[0].id); // electronic signature (Law 3/2014)

    let paymentOrder: any = null;
    if (next === "AUTHORISED") {
      // SYP is paid from the TSA; a donor-funded line in foreign currency from its designated account
      const acct = (await getRule("TSA_DEBIT_ACCOUNT", [`CUR:${doc.currency}`], undefined, c))?.account ?? "TSA-CBS-0001";
      const rate = await fxRate(doc.currency, undefined, c);
      const seq = (await c.query("SELECT nextval('po_ref_seq') AS n")).rows[0].n;
      const ref = `PO-${new Date().getFullYear()}-${String(seq).padStart(6, "0")}`;
      paymentOrder = (await c.query(
        `INSERT INTO payment_orders (ref, document_id, amount, debit_account, via_tsa, beneficiary_name, beneficiary_iban, currency, fx_rate)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, ref, status, amount::float8 AS amount, currency, fx_rate::float8 AS fx_rate, debit_account, via_tsa`,
        [ref, id, doc.amount, acct, doc.currency === "SYP", doc.supplier_name, doc.supplier_iban, doc.currency, doc.currency === "SYP" ? null : rate])).rows[0];
      await audit(c, { actor: actorName(u), action: "payment_order.issue", entity: "payment_order", entityId: paymentOrder.id, data: { ref, documentId: id, amount: doc.amount, currency: doc.currency, fxRate: doc.currency === "SYP" ? undefined : rate, debitAccount: acct } });
    }

    await audit(c, { actor: actorName(u), action: `document.${action}`, entity: "document", entityId: id, data: { status: { from: doc.status, to: next }, reason: reason || undefined, checks: checks ?? undefined, onBehalfOf: onBehalfOf?.username } });

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

    const route: string[] = doc.route ?? DEFAULT_ROUTE;
    const visa = route.includes("VISA") && amount * (await fxRate(doc.currency, undefined, c)) >= (await visaThreshold(c, doc.ministry_id));
    let status = doc.status;
    if (amount > doc.amount) {
      await c.query("SELECT id FROM budget_lines WHERE id = $1 FOR UPDATE", [doc.budget_line_id]);
      const avail = await lineAvailability(c, doc.budget_line_id, doc.id);
      if (avail.available < amount) throw conflict("document.insufficient_funds", { available: avail.available, amount });
      status = routeStatuses(route, visa)[0]; // back to the start of the route
    } else if (doc.status === "AWAITING_VISA" && !visa) {
      status = nextStatus(route, true, "AWAITING_VISA");
    }
    await c.query("UPDATE documents SET amount = $2, status = $3, visa_required = $4, version = version + 1, updated_at = now() WHERE id = $1",
      [id, amount, status, visa]);
    const ap = await c.query("INSERT INTO approvals (document_id, step, decision, actor_id, reason, amount) VALUES ($1,'SPENDING_UNIT','AMENDED',$2,$3,$4) RETURNING id",
      [id, u.id, reason, amount]);
    await signApproval(c, ap.rows[0].id);
    await audit(c, { actor: actorName(u), action: "document.amend", entity: "document", entityId: id,
      data: { amount: { from: doc.amount, to: amount }, status: { from: doc.status, to: status }, reason } });
    if (status !== doc.status) await notifyNext(c, { ...doc, amount }, status);
    else if (STEPS[status]) await notify(c, { role: STEPS[status].role, key: "doc.amended", params: { ref: doc.ref, from: doc.amount, to: amount }, documentId: id });
    return { status, amount };
  });
}

export async function getDocument(u: AuthUser, id: number) {
  const c = db();
  const ids = await identities(c, u);
  const f = visibleTo(ids, "d", 2);
  const r = await c.query(`SELECT d.*, d.amount::float8 AS amount FROM documents d WHERE d.id = $1 AND ${f.sql}`, [id, ...f.vals]);
  const doc = r.rows[0];
  if (!doc) throw notFound("document.not_found");
  const orgIds = [doc.spending_unit_id, doc.ministry_id, doc.rto_id];
  const orgs = Object.fromEntries((await c.query("SELECT id, name_en, name_ar, name_fr FROM orgs WHERE id = ANY($1)", [orgIds])).rows.map(o => [o.id, o]));
  const line = (await c.query("SELECT id, name_en, name_ar, name_fr, economic, programme, currency FROM budget_lines WHERE id = $1", [doc.budget_line_id])).rows[0];
  const approvals = (await c.query(
    `SELECT a.id, a.step, a.decision, a.reason, a.checks, a.amount::float8 AS amount, a.created_at, a.signature IS NOT NULL AS signed, a.key_fingerprint, u.username, u.full_name_en, u.full_name_ar, u.role,
            b.username AS behalf_username, b.full_name_en AS behalf_en, b.full_name_ar AS behalf_ar
       FROM approvals a JOIN users u ON u.id = a.actor_id LEFT JOIN users b ON b.id = a.on_behalf_of WHERE a.document_id = $1 ORDER BY a.id`, [id])).rows;
  const paymentOrders = (await c.query(
    `SELECT id, ref, amount::float8 AS amount, currency, fx_rate::float8 AS fx_rate, debit_account, beneficiary_iban, status, end_to_end_id, cbs_status, cbs_reason, created_at, sent_at, settled_at, returned_at, paid_at, replaces_id
       FROM payment_orders WHERE document_id = $1 ORDER BY id`, [id])).rows;
  const paymentOrder = paymentOrders[paymentOrders.length - 1] ?? null; // the current order; earlier ones were replaced
  const actions = await allowedActions(c, u, doc, ids);
  const route: string[] = doc.route ?? DEFAULT_ROUTE;
  const checks = doc.status === "AWAITING_RTO" || (doc.status === "AWAITING_HQ" && !route.includes("RTO")) ? await rtoChecks(c, doc) : null;
  const delegatedFrom = actions.length && doc.status in STEPS ? (await actingIdentity(c, u, doc, ids)) : null;
  const availability = await lineAvailability(c, doc.budget_line_id); // after this request's reservation
  const routeSteps = route.filter(st => st !== "VISA" || doc.visa_required || doc.status === "DRAFT");
  return { ...doc, orgs, line, approvals, paymentOrder, paymentOrders, actions, checks, availability, routeSteps,
    actingFor: delegatedFrom && delegatedFrom.id !== u.id ? { username: delegatedFrom.username, name: delegatedFrom.name } : null };
}

export async function listDocuments(u: AuthUser, scope: string) {
  const c = db();
  const ids = await identities(c, u);
  const f = visibleTo(ids, "d", 1);
  const r = await c.query(
    `SELECT d.id, d.ref, d.status, d.route, d.version, d.amount::float8 AS amount, d.supplier_name, d.description, d.budget_line_id, d.spending_unit_id, d.ministry_id, d.rto_id,
            d.visa_required, d.created_by, d.updated_at, o.name_en AS unit_en, o.name_ar AS unit_ar, o.name_fr AS unit_fr
       FROM documents d JOIN orgs o ON o.id = d.spending_unit_id WHERE ${f.sql} ORDER BY d.updated_at DESC LIMIT 200`, f.vals);
  if (scope === "inbox") {
    const out: any[] = [];
    for (const d of r.rows) if ((await allowedActions(c, u, d, ids)).some(a => a !== "amend")) out.push(d);
    return out;
  }
  if (scope === "mine") return r.rows.filter(d => d.created_by === u.id);
  return r.rows;
}

/** Visibility for a user and the people who delegated to them. */
function visibleTo(ids: Identity[], alias: string, start: number) {
  const parts: string[] = [], vals: any[] = [];
  for (const id of ids) {
    const f = scopeFilter(id, alias, start + vals.length);
    parts.push(`(${f.sql})`); vals.push(...f.vals);
  }
  return { sql: parts.join(" OR "), vals };
}

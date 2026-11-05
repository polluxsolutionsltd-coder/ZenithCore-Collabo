/**
 * D3 – payment execution through the TSA at the Central Bank of Syria.
 *
 * Payment order lifecycle:
 *   ISSUED → SENDING → SETTLED → (RETURNED)
 *                    ↘ REJECTED
 *                    ↘ SEND_FAILED (dead letter, retried by an operator)
 * A rejected or returned order can be reissued (new order, same document,
 * corrected beneficiary); the old order is kept for the audit trail.
 */
import crypto from "node:crypto";
import { Db, db, tx } from "../../db/index.js";
import { AuthUser, badRequest, conflict, forbidden, notFound } from "../../lib/http.js";
import { audit } from "../audit/audit.service.js";
import { notify } from "../notifications/notifications.service.js";
import { ibanValid } from "../documents/documents.service.js";
import { startOutbound, updateOutbound } from "../integration/gateway.service.js";
import { backoff, cbsUrl, maxAttempts, Outcome, queryStatus, sendOnce, sleep } from "./cbs.client.js";
import { readPacs004 } from "../../../../cbs-sandbox/src/iso20022.js";

const TREASURY = ["TREASURY_HQ", "REGIONAL_TREASURY", "ADMIN", "AUDITOR"];
const actorName = (u: AuthUser) => u.username;

const PO_COLUMNS = `p.id, p.ref, p.document_id, p.amount::float8 AS amount, p.debit_account, p.via_tsa, p.beneficiary_name, p.beneficiary_iban, p.status,
  p.end_to_end_id, p.cbs_status, p.cbs_reason, p.created_at, p.sent_at, p.settled_at, p.returned_at, p.replaces_id,
  d.ref AS document_ref, d.spending_unit_id, d.budget_line_id`;

export async function listPaymentOrders(u: AuthUser, status?: string) {
  if (!TREASURY.includes(u.role)) throw forbidden();
  const vals: any[] = [];
  let where = "";
  if (status) { vals.push(status); where = "WHERE p.status = $1"; }
  return (await db().query(`SELECT ${PO_COLUMNS} FROM payment_orders p JOIN documents d ON d.id = p.document_id ${where} ORDER BY p.id DESC LIMIT 200`, vals)).rows;
}

export async function getPaymentOrder(u: AuthUser, id: number) {
  if (!TREASURY.includes(u.role)) throw forbidden();
  const po = (await db().query(`SELECT ${PO_COLUMNS} FROM payment_orders p JOIN documents d ON d.id = p.document_id WHERE p.id = $1`, [id])).rows[0];
  if (!po) throw notFound();
  const messages = (await db().query(
    "SELECT id, msg_type, status, attempts, last_error, correlation_id, created_at, updated_at FROM integration_messages WHERE business_ref = $1 ORDER BY id", [po.ref])).rows;
  const ledger = (await db().query(
    "SELECT journal, account, debit::float8 AS debit, credit::float8 AS credit, posted_at, memo FROM ledger_entries WHERE source = 'payment_order' AND source_ref = $1 ORDER BY id", [po.ref])).rows;
  return { ...po, messages, ledger };
}

/** Sends a payment order to CBS with retry, status-query-before-resend and dead-lettering. */
export async function sendPaymentOrder(u: AuthUser, id: number, correlationId: string) {
  if (!["TREASURY_HQ", "ADMIN"].includes(u.role)) throw forbidden();
  // 1. claim the order (short transaction; no network call while holding locks)
  const claim = await tx(async c => {
    const po = (await c.query(`SELECT p.*, d.ref AS document_ref, p.amount::float8 AS amt FROM payment_orders p JOIN documents d ON d.id = p.document_id WHERE p.id = $1 FOR UPDATE OF p`, [id])).rows[0];
    if (!po) throw notFound();
    if (!["ISSUED", "SEND_FAILED"].includes(po.status)) throw conflict("payment.not_sendable", { status: po.status });
    const e2e = po.end_to_end_id ?? `E2E-${po.ref}-${crypto.randomUUID().slice(0, 8)}`;
    await c.query("UPDATE payment_orders SET status = 'SENDING', end_to_end_id = $2, sent_at = COALESCE(sent_at, now()) WHERE id = $1", [id, e2e]);
    await audit(c, { actor: actorName(u), action: po.status === "SEND_FAILED" ? "payment_order.resend" : "payment_order.send", entity: "payment_order", entityId: id, data: { ref: po.ref, endToEndId: e2e, correlationId } });
    const msgId = await startOutbound(c, { partner: "CBS", msgType: "pacs.008", correlationId, businessRef: po.ref, request: "" });
    return { po, e2e, msgId, wasFailed: po.status === "SEND_FAILED" };
  });
  const { po, e2e, msgId } = claim;
  const transfer = { endToEndId: e2e, amount: Number(po.amt), currency: "SYP", debtorName: "Ministry of Finance – Treasury Single Account", debtorAccount: po.debit_account, creditorName: po.beneficiary_name, creditorIban: po.beneficiary_iban, remittance: `${po.ref} / ${po.document_ref}` };

  // 2. talk to CBS
  const started = Date.now();
  let outcome: Outcome | null = claim.wasFailed ? await queryStatus(e2e, correlationId) : null; // a resend always asks first
  let attempts = 0, lastError: string | null = null, lastRequest = "";
  // status unknown after a failure and the bank cannot tell us: never resend blindly
  const blocked = outcome?.kind === "unknown";
  if (blocked) lastError = (outcome as any).error;
  while (!blocked && !(outcome && outcome.kind === "final") && attempts < maxAttempts()) {
    if (attempts > 0) {
      await updateOutbound(msgId, { status: "RETRYING", attempts, error: lastError, nextAttemptAt: new Date(Date.now() + backoff(attempts)) });
      await sleep(backoff(attempts));
      const known = await queryStatus(e2e, correlationId);
      if (known?.kind === "final") { outcome = known; break; }
      if (known?.kind === "unknown") { lastError = known.error; attempts++; continue; } // cannot know – do not resend blindly
    }
    attempts++;
    const r = await sendOnce(transfer, correlationId);
    lastRequest = r.request;
    outcome = r.outcome;
    if (outcome.kind === "unknown") lastError = outcome.error;
  }
  if (lastRequest) await db().query("UPDATE integration_messages SET request = $2 WHERE id = $1", [msgId, lastRequest]);

  // 3. record the result
  if (!outcome || outcome.kind === "unknown") {
    await updateOutbound(msgId, { status: "DEAD_LETTER", attempts, error: lastError ?? "No answer", durationMs: Date.now() - started });
    await tx(async c => {
      await c.query("UPDATE payment_orders SET status = 'SEND_FAILED' WHERE id = $1", [id]);
      await audit(c, { actor: "system", action: "payment_order.dead_letter", entity: "payment_order", entityId: id, data: { ref: po.ref, attempts, error: lastError } });
      await notify(c, { role: "TREASURY_HQ", key: "po.dead_letter", params: { ref: po.ref }, documentId: po.document_id });
    });
    return getPaymentOrder(u, id);
  }
  await updateOutbound(msgId, { status: outcome.status === "ACSC" ? "DELIVERED" : "REJECTED_BY_PARTNER", attempts, httpStatus: outcome.httpStatus, response: outcome.response, durationMs: Date.now() - started });
  const final = outcome;
  await tx(async c => {
    if (final.status === "ACSC") {
      await c.query("UPDATE payment_orders SET status = 'SETTLED', cbs_status = 'ACSC', cbs_reason = NULL, settled_at = COALESCE($2::timestamptz, now()), paid_at = COALESCE($2::timestamptz, now()) WHERE id = $1", [id, final.settledAt]);
      await postSettlement(c, po.ref, id);
      await audit(c, { actor: "system", action: "payment_order.settled", entity: "payment_order", entityId: id, data: { ref: po.ref, endToEndId: e2e, attempts } });
      await notify(c, { orgId: (await spendingUnit(c, po.document_id)), role: "SPENDING_UNIT", key: "po.settled", params: { ref: po.ref }, documentId: po.document_id });
    } else {
      await c.query("UPDATE payment_orders SET status = 'REJECTED', cbs_status = 'RJCT', cbs_reason = $2 WHERE id = $1", [id, final.reason]);
      await audit(c, { actor: "system", action: "payment_order.rejected_by_cbs", entity: "payment_order", entityId: id, data: { ref: po.ref, reason: final.reason } });
      await notify(c, { role: "TREASURY_HQ", key: "po.rejected", params: { ref: po.ref, reason: final.reason }, documentId: po.document_id });
    }
  });
  return getPaymentOrder(u, id);
}

async function spendingUnit(c: Db, documentId: number) {
  return (await c.query("SELECT spending_unit_id FROM documents WHERE id = $1", [documentId])).rows[0].spending_unit_id as string;
}

/** Cash-basis posting: Dr expenditure (economic classification) / Cr TSA bank account. */
async function postSettlement(c: Db, ref: string, id: number) {
  const r = (await c.query(`SELECT p.amount, p.debit_account, d.budget_line_id, b.economic FROM payment_orders p JOIN documents d ON d.id = p.document_id JOIN budget_lines b ON b.id = d.budget_line_id WHERE p.id = $1`, [id])).rows[0];
  const j = `PAY-${ref}`;
  await c.query("INSERT INTO ledger_entries (journal, account, budget_line_id, debit, source, source_ref, memo) VALUES ($1,$2,$3,$4,'payment_order',$5,'Payment settled')", [j, `EXP:${r.economic}`, r.budget_line_id, r.amount, ref]);
  await c.query("INSERT INTO ledger_entries (journal, account, credit, source, source_ref, memo) VALUES ($1,$2,$3,'payment_order',$4,'Payment settled')", [j, `BANK:${r.debit_account}`, r.amount, ref]);
}

/** Reads pacs.004 returns from CBS; each settled order is returned once and its posting reversed. */
export async function pollReturns(actor: string, correlationId: string) {
  const started = Date.now();
  const msgId = await startOutbound(db(), { partner: "CBS", msgType: "pacs.004", correlationId, businessRef: "RETURNS", request: `GET ${cbsUrl()}/iso20022/pacs.004` });
  let xml: string;
  try {
    const r = await fetch(`${cbsUrl()}/iso20022/pacs.004`, { headers: { "x-correlation-id": correlationId }, signal: AbortSignal.timeout(Number(process.env.CBS_TIMEOUT_MS ?? 5000)) });
    xml = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (e: any) {
    await updateOutbound(msgId, { status: "FAILED", attempts: 1, error: String(e?.message ?? e), durationMs: Date.now() - started });
    throw new (await import("../../lib/http.js")).AppError(502, "integration.cbs_unavailable");
  }
  const applied: string[] = [];
  for (const ret of readPacs004(xml)) {
    await tx(async c => {
      const po = (await c.query("SELECT id, ref, document_id, status, debit_account FROM payment_orders WHERE end_to_end_id = $1 FOR UPDATE", [ret.endToEndId])).rows[0];
      if (!po || po.status !== "SETTLED") return; // unknown or already handled
      await c.query("UPDATE payment_orders SET status = 'RETURNED', cbs_status = 'RTRN', cbs_reason = $2, returned_at = now() WHERE id = $1", [po.id, ret.reason]);
      const j = `RTN-${po.ref}`;
      const legs = (await c.query("SELECT account, budget_line_id, debit, credit FROM ledger_entries WHERE source = 'payment_order' AND source_ref = $1 AND journal = $2", [po.ref, `PAY-${po.ref}`])).rows;
      for (const l of legs) {
        await c.query("INSERT INTO ledger_entries (journal, account, budget_line_id, debit, credit, source, source_ref, memo) VALUES ($1,$2,$3,$4,$5,'payment_order',$6,$7)",
          [j, l.account, l.budget_line_id, l.credit, l.debit, po.ref, `Reversal – returned by bank (${ret.reason})`]);
      }
      await audit(c, { actor, action: "payment_order.returned", entity: "payment_order", entityId: po.id, data: { ref: po.ref, reason: ret.reason, returnId: ret.returnId } });
      await notify(c, { role: "TREASURY_HQ", key: "po.returned", params: { ref: po.ref, reason: ret.reason }, documentId: po.document_id });
      applied.push(po.ref);
    });
  }
  await updateOutbound(msgId, { status: "DELIVERED", attempts: 1, httpStatus: 200, response: xml, durationMs: Date.now() - started });
  return { returned: applied };
}

/** Replaces a rejected or returned order with a new one (e.g. corrected IBAN). */
export async function reissuePaymentOrder(u: AuthUser, id: number, input: { beneficiaryIban?: string; beneficiaryName?: string; reason?: string }) {
  if (!["TREASURY_HQ", "ADMIN"].includes(u.role)) throw forbidden();
  return tx(async c => {
    const po = (await c.query("SELECT * FROM payment_orders WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!po) throw notFound();
    if (!["REJECTED", "RETURNED"].includes(po.status)) throw conflict("payment.not_reissuable", { status: po.status });
    if ((await c.query("SELECT 1 FROM payment_orders WHERE replaces_id = $1", [id])).rows.length) throw conflict("payment.already_reissued");
    const iban = (input.beneficiaryIban ?? po.beneficiary_iban).replace(/\s+/g, "").toUpperCase();
    if (!ibanValid(iban)) throw badRequest("document.invalid_iban");
    if (!input.reason || input.reason.trim().length < 10) throw badRequest("payment.reissue_reason_required");
    const ref = `PO-${new Date().getFullYear()}-${String((await c.query("SELECT nextval('po_ref_seq') AS n")).rows[0].n).padStart(6, "0")}`;
    const created = (await c.query(
      `INSERT INTO payment_orders (ref, document_id, amount, debit_account, via_tsa, beneficiary_name, beneficiary_iban, replaces_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, ref, status`,
      [ref, po.document_id, po.amount, po.debit_account, po.via_tsa, input.beneficiaryName ?? po.beneficiary_name, iban, id])).rows[0];
    await audit(c, { actor: actorName(u), action: "payment_order.reissue", entity: "payment_order", entityId: created.id, data: { ref, replaces: po.ref, ibanChanged: iban !== po.beneficiary_iban, reason: input.reason.trim() } });
    return created;
  });
}

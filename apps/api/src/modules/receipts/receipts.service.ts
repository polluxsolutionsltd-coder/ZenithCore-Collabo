/**
 * Official receipts for government revenue. Each receipt has a verification
 * code that a citizen (or an auditor) can check on the public portal, posts
 * to the ledger, and can only be cancelled with a reason (reversal, never deletion).
 */
import crypto from "node:crypto";
import { db, tx } from "../../db/index.js";
import { AuthUser, badRequest, conflict, forbidden, notFound } from "../../lib/http.js";
import { audit } from "../audit/audit.service.js";

const ISSUERS = ["REVENUE_OFFICER"];
const VIEWERS = ["REVENUE_OFFICER", "TREASURY_HQ", "ADMIN", "AUDITOR"];
const secret = () => process.env.RECEIPT_SECRET ?? process.env.JWT_SECRET ?? "dev-receipt-secret";

/** 10-character code bound to the receipt's reference, amount and date. */
export const verifyCode = (ref: string, amount: number, issuedAt: string) =>
  crypto.createHmac("sha256", secret()).update(`${ref}|${amount.toFixed(2)}|${issuedAt.slice(0, 10)}`).digest("hex").slice(0, 10).toUpperCase();

export async function revenueCodes() {
  return (await db().query("SELECT * FROM revenue_codes ORDER BY code")).rows;
}

export async function issueReceipt(u: AuthUser, input: { revenueCode: string; payerName: string; payerId?: string; amount: number; method: string; clientRef?: string }) {
  if (!ISSUERS.includes(u.role)) throw forbidden();
  const amount = Number(input.amount);
  if (!(amount > 0) || Math.round(amount * 100) !== amount * 100) throw badRequest("receipt.invalid_amount");
  if (!input.payerName || input.payerName.trim().length < 3) throw badRequest("receipt.payer_required");
  if (!["CASH", "BANK_TRANSFER", "CHEQUE"].includes(input.method)) throw badRequest("receipt.invalid_method");
  const clientRef = typeof input.clientRef === "string" && /^[A-Za-z0-9-]{8,64}$/.test(input.clientRef) ? input.clientRef : null;
  return tx(async c => {
    if (clientRef) {
      const prev = (await c.query("SELECT id, ref, verify_code FROM receipts WHERE issued_by = $1 AND client_ref = $2", [u.id, clientRef])).rows[0];
      if (prev) return { id: prev.id, ref: prev.ref, verifyCode: prev.verify_code, replay: true };
    }
    const code = (await c.query("SELECT * FROM revenue_codes WHERE code = $1", [input.revenueCode])).rows[0];
    if (!code) throw badRequest("receipt.unknown_revenue_code");
    const seq = (await c.query("SELECT nextval('receipt_ref_seq') AS n")).rows[0].n;
    const issuedAt = new Date().toISOString();
    const ref = `RC-${issuedAt.slice(0, 4)}-${String(seq).padStart(6, "0")}`;
    const vc = verifyCode(ref, amount, issuedAt);
    const r = (await c.query(
      `INSERT INTO receipts (ref, revenue_code, payer_name, payer_id, amount, method, office_id, account_id, verify_code, issued_by, issued_at, client_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [ref, code.code, input.payerName.trim(), input.payerId?.trim() || null, amount, input.method, u.orgId, code.account_id, vc, u.id, issuedAt, clientRef])).rows[0];
    const j = `RCT-${ref}`;
    await c.query("INSERT INTO ledger_entries (journal, account, debit, source, source_ref, memo) VALUES ($1,$2,$3,'receipt',$4,'Revenue received')", [j, `BANK:${code.account_id}`, amount, ref]);
    await c.query("INSERT INTO ledger_entries (journal, account, credit, source, source_ref, memo) VALUES ($1,$2,$3,'receipt',$4,'Revenue received')", [j, `REV:${code.code}`, amount, ref]);
    await audit(c, { actor: u.username, action: "receipt.issue", entity: "receipt", entityId: r.id, data: { ref, amount, revenueCode: code.code, method: input.method, offline: clientRef ? true : undefined } });
    return { id: r.id, ref, verifyCode: vc };
  });
}

export async function cancelReceipt(u: AuthUser, id: number, reason: string) {
  if (!["REVENUE_OFFICER", "ADMIN"].includes(u.role)) throw forbidden();
  if (!reason || reason.trim().length < 10) throw badRequest("receipt.reason_required");
  return tx(async c => {
    const r = (await c.query("SELECT * FROM receipts WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!r) throw notFound();
    if (u.role === "REVENUE_OFFICER" && r.office_id !== u.orgId) throw forbidden();
    if (r.status !== "ISSUED") throw conflict("receipt.already_cancelled");
    await c.query("UPDATE receipts SET status = 'CANCELLED', cancel_reason = $2, cancelled_at = now() WHERE id = $1", [id, reason.trim()]);
    const j = `RCX-${r.ref}`;
    await c.query("INSERT INTO ledger_entries (journal, account, credit, source, source_ref, memo) VALUES ($1,$2,$3,'receipt',$4,'Receipt cancelled')", [j, `BANK:${r.account_id}`, r.amount, r.ref]);
    await c.query("INSERT INTO ledger_entries (journal, account, debit, source, source_ref, memo) VALUES ($1,$2,$3,'receipt',$4,'Receipt cancelled')", [j, `REV:${r.revenue_code}`, r.amount, r.ref]);
    await audit(c, { actor: u.username, action: "receipt.cancel", entity: "receipt", entityId: id, data: { ref: r.ref, reason: reason.trim() } });
    return { ok: true };
  });
}

export async function listReceipts(u: AuthUser) {
  if (!VIEWERS.includes(u.role)) throw forbidden();
  const own = u.role === "REVENUE_OFFICER";
  return (await db().query(
    `SELECT r.id, r.ref, r.revenue_code, r.payer_name, r.payer_id, r.amount::float8 AS amount, r.method, r.office_id, r.account_id, r.verify_code, r.status, r.cancel_reason,
            r.issued_at, r.cancelled_at, u.username AS issued_by, c.name_en AS code_en, c.name_ar AS code_ar, c.name_fr AS code_fr, o.name_en AS office_en, o.name_ar AS office_ar, o.name_fr AS office_fr
       FROM receipts r JOIN users u ON u.id = r.issued_by JOIN revenue_codes c ON c.code = r.revenue_code JOIN orgs o ON o.id = r.office_id
      ${own ? "WHERE r.office_id = $1" : ""} ORDER BY r.id DESC LIMIT 300`, own ? [u.orgId] : [])).rows;
}

/** Public check: the citizen enters the receipt number and its code. Personal data is not shown. */
export async function verifyReceipt(ref: string, code: string) {
  const r = (await db().query(
    `SELECT r.ref, r.amount::float8 AS amount, r.status, r.issued_at, r.verify_code, c.name_en AS code_en, c.name_ar AS code_ar, c.name_fr AS code_fr,
            o.name_en AS office_en, o.name_ar AS office_ar, o.name_fr AS office_fr
       FROM receipts r JOIN revenue_codes c ON c.code = r.revenue_code JOIN orgs o ON o.id = r.office_id WHERE r.ref = $1`, [String(ref ?? "").trim().toUpperCase()])).rows[0];
  const given = String(code ?? "").trim().toUpperCase();
  if (!r || given.length !== r.verify_code.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(r.verify_code))) return { valid: false };
  const { verify_code, ...out } = r;
  return { valid: true, receipt: out };
}

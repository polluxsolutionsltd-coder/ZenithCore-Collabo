/**
 * Virements: transfers of appropriation between budget lines, with the
 * approval level decided by the VIREMENT_LIMITS rule (Basic Finance Law,
 * Legislative Decree 54/2006, currently under revision; limits are
 * configuration so a revised law is a rule change, not a release).
 *
 *  - Ministry level: same ministry, same chapter, within the amount and share limits.
 *  - Ministry of Finance level: anything else (another chapter, another ministry, larger).
 *  - Refused: out of a protected chapter, between currencies, more than is available.
 *
 * The decision is signed electronically (Law 3/2014) and recorded in the audit trail.
 */
import { db, tx } from "../../db/index.js";
import { AuthUser, badRequest, conflict, forbidden, notFound } from "../../lib/http.js";
import { audit } from "../audit/audit.service.js";
import { notify } from "../notifications/notifications.service.js";
import { getRule } from "../rules/rules.service.js";
import { lineAvailability } from "../budget/budget.service.js";
import { signDecision, verifyDecision } from "../esign/esign.service.js";

const chapter = (economic: string) => economic.slice(0, 2);

export async function virementLimits() {
  return (await getRule("VIREMENT_LIMITS")) as { ministryMaxAmount: number; ministryMaxShare: number; protectedChapters: string[] } | null;
}

/** Works out which level must approve, and why. */
export function levelFor(from: any, to: any, amount: number, lim: { ministryMaxAmount: number; ministryMaxShare: number }) {
  if (from.ministry_id !== to.ministry_id) return { level: "MOF", reason: "cross_ministry" };
  if (chapter(from.economic) !== chapter(to.economic)) return { level: "MOF", reason: "cross_chapter" };
  if (amount > lim.ministryMaxAmount) return { level: "MOF", reason: "above_amount" };
  if (amount > Number(from.original_allotment ?? from.allotment) * lim.ministryMaxShare) return { level: "MOF", reason: "above_share" };
  return { level: "MINISTRY", reason: "within_ministry_authority" };
}

export async function requestVirement(u: AuthUser, input: { fromLine: string; toLine: string; amount: number; reason: string }) {
  if (!["SPENDING_UNIT", "MINISTRY_APPROVER"].includes(u.role)) throw forbidden();
  const amount = Number(input.amount);
  if (!(amount > 0) || Math.round(amount * 100) !== amount * 100) throw badRequest("virement.invalid_amount");
  if (!input.reason || input.reason.trim().length < 10) throw badRequest("virement.reason_required");
  if (input.fromLine === input.toLine) throw badRequest("virement.same_line");
  const lim = await virementLimits();
  if (!lim) throw badRequest("virement.no_rule");
  return tx(async c => {
    const from = (await c.query("SELECT * FROM budget_lines WHERE id = $1", [input.fromLine])).rows[0];
    const to = (await c.query("SELECT * FROM budget_lines WHERE id = $1", [input.toLine])).rows[0];
    if (!from || !to) throw badRequest("virement.unknown_line");
    if (u.role === "SPENDING_UNIT" && from.spending_unit_id !== u.orgId) throw forbidden("virement.not_your_line");
    if (u.role === "MINISTRY_APPROVER" && from.ministry_id !== u.orgId) throw forbidden("virement.not_your_line");
    if (from.currency !== to.currency) throw badRequest("virement.currency_mismatch");
    if (lim.protectedChapters.includes(chapter(from.economic))) throw badRequest("virement.protected_chapter", { chapter: chapter(from.economic) });
    const avail = await lineAvailability(c, from.id);
    if (avail.available < amount) throw conflict("virement.insufficient_funds", { available: avail.available, amount });
    const lv = levelFor(from, to, amount, lim);
    const seq = (await c.query("SELECT nextval('virement_ref_seq') AS n")).rows[0].n;
    const ref = `VR-${new Date().getFullYear()}-${String(seq).padStart(5, "0")}`;
    const v = (await c.query(
      `INSERT INTO virements (ref, from_line, to_line, amount, reason, level, level_reason, requested_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [ref, from.id, to.id, amount, input.reason.trim(), lv.level, lv.reason, u.id])).rows[0];
    await audit(c, { actor: u.username, action: "virement.request", entity: "virement", entityId: v.id, data: { ref, from: from.id, to: to.id, amount, level: lv.level, levelReason: lv.reason } });
    if (lv.level === "MINISTRY") await notify(c, { role: "MINISTRY_APPROVER", orgId: from.ministry_id, key: "virement.awaiting", params: { ref } });
    else await notify(c, { role: "BUDGET_DIRECTOR", key: "virement.awaiting", params: { ref } });
    return { id: v.id, ref, level: lv.level, levelReason: lv.reason };
  });
}

function canDecide(u: AuthUser, v: any, fromMinistry: string) {
  if (v.level === "MINISTRY") return u.role === "MINISTRY_APPROVER" && u.orgId === fromMinistry;
  return u.role === "BUDGET_DIRECTOR";
}

export async function decideVirement(u: AuthUser, id: number, input: { decision: "approve" | "reject"; reason?: string }) {
  if (!["approve", "reject"].includes(input.decision)) throw badRequest("virement.invalid_decision");
  return tx(async c => {
    const v = (await c.query("SELECT * FROM virements WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!v) throw notFound();
    if (v.status !== "SUBMITTED") throw conflict("virement.already_decided");
    const from = (await c.query("SELECT * FROM budget_lines WHERE id = $1 FOR UPDATE", [v.from_line])).rows[0];
    await c.query("SELECT id FROM budget_lines WHERE id = $1 FOR UPDATE", [v.to_line]);
    if (!canDecide(u, v, from.ministry_id)) throw forbidden("virement.not_your_level");
    if (v.requested_by === u.id) throw forbidden("document.segregation_of_duties");
    const reason = (input.reason ?? "").trim();
    if (input.decision === "reject" && reason.length < 10) throw badRequest("virement.reason_required");
    const amount = Number(v.amount);
    if (input.decision === "approve") {
      const avail = await lineAvailability(c, v.from_line);
      if (avail.available < amount) throw conflict("virement.insufficient_funds", { available: avail.available, amount });
      await c.query("UPDATE budget_lines SET allotment = allotment - $2 WHERE id = $1", [v.from_line, amount]);
      await c.query("UPDATE budget_lines SET allotment = allotment + $2 WHERE id = $1", [v.to_line, amount]);
    }
    const status = input.decision === "approve" ? "APPROVED" : "REJECTED";
    const sig = await signDecision(c, u.id, { type: "virement", virementId: v.id, ref: v.ref, from: v.from_line, to: v.to_line, amount: amount.toFixed(2), decision: status, level: v.level });
    await c.query("UPDATE virements SET status = $2, decided_by = $3, decided_at = now(), decision_reason = $4, signature = $5, signed_payload = $6 WHERE id = $1",
      [id, status, u.id, reason || null, sig.signature, sig.payload]);
    await audit(c, { actor: u.username, action: `virement.${input.decision}`, entity: "virement", entityId: id, data: { ref: v.ref, amount, from: v.from_line, to: v.to_line, level: v.level, reason: reason || undefined, signature: sig.fingerprint } });
    await notify(c, { userId: v.requested_by, key: status === "APPROVED" ? "virement.approved" : "virement.rejected", params: { ref: v.ref } });
    return { status };
  });
}

export async function listVirements(u: AuthUser) {
  const where = u.role === "SPENDING_UNIT" ? "WHERE f.spending_unit_id = $1" : u.role === "MINISTRY_APPROVER" ? "WHERE f.ministry_id = $1" : "";
  const vals = where ? [u.orgId] : [];
  if (!["SPENDING_UNIT", "MINISTRY_APPROVER", "BUDGET_DIRECTOR", "TREASURY_HQ", "ADMIN", "AUDITOR"].includes(u.role)) throw forbidden();
  const rows = (await db().query(
    `SELECT v.id, v.ref, v.from_line, v.to_line, v.amount::float8 AS amount, f.currency, v.reason, v.level, v.level_reason, v.status, v.requested_at, v.decided_at, v.decision_reason,
            v.signature IS NOT NULL AS signed, v.signed_payload, v.signature, v.decided_by, rq.username AS requested_by, dc.username AS decided_by_name,
            f.ministry_id AS from_ministry, t.ministry_id AS to_ministry, f.name_en AS from_en, f.name_ar AS from_ar, f.name_fr AS from_fr, t.name_en AS to_en, t.name_ar AS to_ar, t.name_fr AS to_fr
       FROM virements v JOIN budget_lines f ON f.id = v.from_line JOIN budget_lines t ON t.id = v.to_line
       JOIN users rq ON rq.id = v.requested_by LEFT JOIN users dc ON dc.id = v.decided_by ${where} ORDER BY v.id DESC`, vals)).rows;
  const out: any[] = [];
  for (const r of rows) {
    // valid = the signature is genuine AND what it covers still matches the record
    let signatureValid: boolean | null = null;
    if (r.signature) {
      const p = JSON.parse(r.signed_payload);
      signatureValid = (await verifyDecision(db(), r.decided_by, r.signed_payload, r.signature))
        && p.amount === Number(r.amount).toFixed(2) && p.from === r.from_line && p.to === r.to_line && p.decision === r.status;
    }
    const { signed_payload, signature, decided_by, ...rest } = r;
    out.push({ ...rest, signatureValid, actions: canDecide(u, r, r.from_ministry) && r.status === "SUBMITTED" ? ["approve", "reject"] : [] });
  }
  return out;
}

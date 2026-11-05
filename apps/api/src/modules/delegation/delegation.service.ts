/**
 * D4 – delegation of approval authority. While a delegation is active the
 * delegate can act in the delegator's place; every decision records both
 * people. Segregation of duties still applies to the delegate personally.
 */
import { Db, db, tx } from "../../db/index.js";
import { AuthUser, badRequest, conflict, forbidden, notFound } from "../../lib/http.js";
import { audit } from "../audit/audit.service.js";
import { notify } from "../notifications/notifications.service.js";

export interface Identity extends AuthUser { delegatedBy?: number }

const today = () => new Date().toISOString().slice(0, 10);
const APPROVER_ROLES = ["MINISTRY_APPROVER", "FIN_CONTROLLER", "REGIONAL_TREASURY", "TREASURY_HQ"];

/** The user plus everyone who has delegated their authority to the user today. */
export async function identities(c: Db, u: AuthUser): Promise<Identity[]> {
  const r = await c.query(
    `SELECT f.id, f.username, f.role, f.org_id, f.full_name_en FROM delegations d JOIN users f ON f.id = d.from_user_id
      WHERE d.to_user_id = $1 AND d.revoked_at IS NULL AND d.starts_on <= $2::date AND d.ends_on >= $2::date AND f.active
      ORDER BY d.id`, [u.id, today()]);
  return [u, ...r.rows.map(x => ({ id: x.id, username: x.username, role: x.role, orgId: x.org_id, name: x.full_name_en, delegatedBy: x.id }))];
}

/** Active delegates of users holding `role` (optionally in `orgId`), for notifications. */
export async function delegatesOf(c: Db, role: string, orgId?: string): Promise<number[]> {
  const r = await c.query(
    `SELECT DISTINCT d.to_user_id FROM delegations d JOIN users f ON f.id = d.from_user_id
      WHERE f.role = $1 AND ($2::text IS NULL OR f.org_id = $2) AND d.revoked_at IS NULL AND d.starts_on <= $3::date AND d.ends_on >= $3::date`,
    [role, orgId ?? null, today()]);
  return r.rows.map(x => x.to_user_id);
}

export async function createDelegation(u: AuthUser, input: { fromUsername?: string; toUsername: string; startsOn: string; endsOn: string; reason: string }) {
  return tx(async c => {
    const fromName = input.fromUsername && u.role === "ADMIN" ? input.fromUsername : u.username;
    const from = (await c.query("SELECT * FROM users WHERE username = $1 AND active", [fromName])).rows[0];
    const to = (await c.query("SELECT * FROM users WHERE username = $1 AND active", [String(input.toUsername ?? "").trim().toLowerCase()])).rows[0];
    if (!from || !to) throw badRequest("delegation.unknown_user");
    if (!APPROVER_ROLES.includes(from.role)) throw forbidden("delegation.not_an_approver");
    if (from.id === to.id) throw badRequest("delegation.self");
    if (["SPENDING_UNIT", "AUDITOR"].includes(to.role)) throw badRequest("delegation.delegate_not_allowed");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startsOn ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(input.endsOn ?? "") || input.endsOn < input.startsOn) throw badRequest("delegation.invalid_dates");
    if (input.endsOn < today()) throw badRequest("delegation.invalid_dates");
    if (!input.reason || input.reason.trim().length < 10) throw badRequest("delegation.reason_required");
    const overlap = await c.query(
      "SELECT 1 FROM delegations WHERE from_user_id = $1 AND revoked_at IS NULL AND starts_on <= $3::date AND ends_on >= $2::date", [from.id, input.startsOn, input.endsOn]);
    if (overlap.rows.length) throw conflict("delegation.overlap");
    const d = (await c.query(
      "INSERT INTO delegations (from_user_id, to_user_id, starts_on, ends_on, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
      [from.id, to.id, input.startsOn, input.endsOn, input.reason.trim(), u.username])).rows[0];
    await audit(c, { actor: u.username, action: "delegation.create", entity: "delegation", entityId: d.id, data: { from: from.username, to: to.username, startsOn: input.startsOn, endsOn: input.endsOn, reason: input.reason.trim() } });
    await notify(c, { userId: to.id, key: "delegation.received", params: { from: from.full_name_en, until: input.endsOn } });
    return { id: d.id };
  });
}

export async function listDelegations(u: AuthUser) {
  const all = ["ADMIN", "AUDITOR"].includes(u.role);
  return (await db().query(
    `SELECT d.id, d.starts_on::text, d.ends_on::text, d.reason, d.created_by, d.created_at, d.revoked_at,
            f.username AS from_username, f.full_name_en AS from_en, f.full_name_ar AS from_ar, f.role AS from_role,
            t.username AS to_username, t.full_name_en AS to_en, t.full_name_ar AS to_ar, t.role AS to_role,
            (d.revoked_at IS NULL AND d.starts_on <= CURRENT_DATE AND d.ends_on >= CURRENT_DATE) AS active
       FROM delegations d JOIN users f ON f.id = d.from_user_id JOIN users t ON t.id = d.to_user_id
      ${all ? "" : "WHERE d.from_user_id = $1 OR d.to_user_id = $1"} ORDER BY d.id DESC`, all ? [] : [u.id])).rows;
}

export async function revokeDelegation(u: AuthUser, id: number) {
  return tx(async c => {
    const d = (await c.query("SELECT * FROM delegations WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!d) throw notFound();
    if (d.from_user_id !== u.id && u.role !== "ADMIN") throw forbidden();
    if (d.revoked_at) throw conflict("delegation.already_revoked");
    await c.query("UPDATE delegations SET revoked_at = now() WHERE id = $1", [id]);
    await audit(c, { actor: u.username, action: "delegation.revoke", entity: "delegation", entityId: id });
    return { ok: true };
  });
}

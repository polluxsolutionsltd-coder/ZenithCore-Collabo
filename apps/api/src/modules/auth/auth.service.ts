import { db, tx } from "../../db/index.js";
import { AuthUser, unauthorized } from "../../lib/http.js";
import { checkPassword, signToken, verifyToken } from "../../lib/security.js";
import { audit } from "../audit/audit.service.js";

export async function login(username: string, password: string) {
  const r = await db().query("SELECT * FROM users WHERE username = $1 AND active", [String(username ?? "").trim().toLowerCase()]);
  const u = r.rows[0];
  if (!u || !checkPassword(String(password ?? ""), u.password_hash)) {
    await tx(c => audit(c, { actor: String(username ?? "?"), action: "auth.login_failed", entity: "user", entityId: String(username ?? "?") }));
    throw unauthorized("auth.invalid_credentials");
  }
  await tx(c => audit(c, { actor: u.username, action: "auth.login", entity: "user", entityId: u.id }));
  const token = signToken({ sub: u.id, username: u.username, role: u.role, org: u.org_id, name: u.full_name_en });
  return { token, user: await profile(u.id) };
}

export function userFromToken(header?: string): AuthUser | undefined {
  if (!header?.startsWith("Bearer ")) return undefined;
  const p = verifyToken(header.slice(7));
  if (!p) return undefined;
  return { id: p.sub, username: p.username, role: p.role, orgId: p.org, name: p.name };
}

export async function profile(id: number) {
  const r = await db().query(
    `SELECT u.id, u.username, u.full_name_en, u.full_name_ar, u.role, u.lang, u.org_id,
            o.name_en AS org_en, o.name_ar AS org_ar, o.name_fr AS org_fr, o.kind AS org_kind
       FROM users u JOIN orgs o ON o.id = u.org_id WHERE u.id = $1`, [id]);
  return r.rows[0];
}

/** Rehearsal helper: lists demo accounts (only when DEMO_MODE=1). */
export async function demoUsers() {
  const r = await db().query(
    `SELECT u.username, u.role, u.full_name_en, u.full_name_ar, o.name_en AS org_en, o.name_ar AS org_ar, o.name_fr AS org_fr
       FROM users u JOIN orgs o ON o.id = u.org_id WHERE u.active ORDER BY u.id`);
  return r.rows;
}

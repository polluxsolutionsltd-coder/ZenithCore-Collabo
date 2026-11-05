/**
 * D4/D5 – user and role administration, password policy and login protection.
 */
import crypto from "node:crypto";
import { db, tx } from "../../db/index.js";
import { AppError, AuthUser, badRequest, conflict, forbidden, notFound, unauthorized } from "../../lib/http.js";
import { checkPassword, hashPassword, signToken } from "../../lib/security.js";
import { audit } from "../audit/audit.service.js";
import { profile } from "../auth/auth.service.js";

/** Which organisation kinds each role may belong to. */
export const ROLE_ORG: Record<string, string[]> = {
  SPENDING_UNIT: ["SPENDING_UNIT"], MINISTRY_APPROVER: ["MINISTRY"], FIN_CONTROLLER: ["CONTROLLER"],
  REGIONAL_TREASURY: ["REGIONAL_TREASURY"], TREASURY_HQ: ["TREASURY_HQ"], ADMIN: ["MOF"], AUDITOR: ["AUDIT"],
  REVENUE_OFFICER: ["REGIONAL_TREASURY", "TREASURY_HQ"], HELPDESK: ["MOF"], HR_OFFICER: ["MINISTRY", "MOF"],
};

const MAX_FAILED = () => Number(process.env.LOGIN_MAX_FAILED ?? 5);
const LOCK_MINUTES = () => Number(process.env.LOGIN_LOCK_MINUTES ?? 15);

/** At least 10 characters with letters and digits; not the username. */
export function passwordAcceptable(pw: string, username: string) {
  return typeof pw === "string" && pw.length >= 10 && /[A-Za-z]/.test(pw) && /\d/.test(pw) && !pw.toLowerCase().includes(username.toLowerCase());
}

/** Sign-in with lock-out after repeated failures (the lock and every attempt are audited). */
export async function login(username: string, password: string) {
  const name = String(username ?? "").trim().toLowerCase();
  const u = (await db().query("SELECT * FROM users WHERE username = $1 AND active", [name])).rows[0];
  if (u?.locked_until && new Date(u.locked_until) > new Date()) {
    await tx(c => audit(c, { actor: name, action: "auth.login_locked", entity: "user", entityId: u.id }));
    throw new AppError(423, "auth.locked", undefined, { until: u.locked_until });
  }
  if (!u || !checkPassword(String(password ?? ""), u.password_hash)) {
    await tx(async c => {
      if (u) {
        const n = u.failed_logins + 1;
        const lock = n >= MAX_FAILED();
        await c.query("UPDATE users SET failed_logins = $2, locked_until = $3 WHERE id = $1",
          [u.id, lock ? 0 : n, lock ? new Date(Date.now() + LOCK_MINUTES() * 60_000) : null]);
        if (lock) await audit(c, { actor: name, action: "auth.account_locked", entity: "user", entityId: u.id, data: { minutes: LOCK_MINUTES() } });
      }
      await audit(c, { actor: name || "?", action: "auth.login_failed", entity: "user", entityId: name || "?" });
    });
    throw unauthorized("auth.invalid_credentials");
  }
  await tx(async c => {
    await c.query("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1", [u.id]);
    await audit(c, { actor: u.username, action: "auth.login", entity: "user", entityId: u.id });
  });
  const token = signToken({ sub: u.id, username: u.username, role: u.role, org: u.org_id, name: u.full_name_en });
  return { token, user: await profile(u.id), mustChangePassword: u.must_change_password };
}

export async function changePassword(u: AuthUser, current: string, next: string) {
  const row = (await db().query("SELECT password_hash FROM users WHERE id = $1", [u.id])).rows[0];
  if (!row || !checkPassword(String(current ?? ""), row.password_hash)) throw badRequest("auth.wrong_password");
  if (!passwordAcceptable(next, u.username)) throw badRequest("auth.weak_password");
  await tx(async c => {
    await c.query("UPDATE users SET password_hash = $2, must_change_password = FALSE WHERE id = $1", [u.id, hashPassword(next)]);
    await audit(c, { actor: u.username, action: "auth.password_changed", entity: "user", entityId: u.id });
  });
  return { ok: true };
}

export async function listUsers() {
  return (await db().query(
    `SELECT u.id, u.username, u.role, u.org_id, u.full_name_en, u.full_name_ar, u.active, u.locked_until, u.must_change_password, u.created_at,
            o.name_en AS org_en, o.name_ar AS org_ar, o.name_fr AS org_fr
       FROM users u JOIN orgs o ON o.id = u.org_id ORDER BY u.id`)).rows;
}

export async function listOrgs() {
  return (await db().query("SELECT id, kind, parent_id, name_en, name_ar, name_fr FROM orgs ORDER BY id")).rows;
}

const tempPassword = () => "Zc" + crypto.randomBytes(6).toString("base64url") + "7";

export async function createUser(admin: AuthUser, input: { username: string; role: string; orgId: string; fullNameEn: string; fullNameAr: string }) {
  const username = String(input.username ?? "").trim().toLowerCase();
  if (!/^[a-z][a-z0-9._-]{2,39}$/.test(username)) throw badRequest("users.invalid_username");
  if (!ROLE_ORG[input.role]) throw badRequest("users.invalid_role");
  if (!input.fullNameEn?.trim() || !/[؀-ۿ]/.test(input.fullNameAr ?? "")) throw badRequest("users.names_required");
  return tx(async c => {
    const org = (await c.query("SELECT kind FROM orgs WHERE id = $1", [input.orgId])).rows[0];
    if (!org || !ROLE_ORG[input.role].includes(org.kind)) throw badRequest("users.role_org_mismatch");
    if ((await c.query("SELECT 1 FROM users WHERE username = $1", [username])).rows.length) throw conflict("users.username_taken");
    const pw = tempPassword();
    const r = (await c.query(
      `INSERT INTO users (username, role, org_id, full_name_en, full_name_ar, password_hash, must_change_password) VALUES ($1,$2,$3,$4,$5,$6,TRUE) RETURNING id`,
      [username, input.role, input.orgId, input.fullNameEn.trim(), input.fullNameAr.trim(), hashPassword(pw)])).rows[0];
    await audit(c, { actor: admin.username, action: "user.create", entity: "user", entityId: r.id, data: { username, role: input.role, orgId: input.orgId } });
    return { id: r.id, username, temporaryPassword: pw };
  });
}

export async function updateUser(admin: AuthUser, id: number, input: { active?: boolean; role?: string; orgId?: string; resetPassword?: boolean; unlock?: boolean }) {
  return tx(async c => {
    const u = (await c.query("SELECT * FROM users WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!u) throw notFound();
    if (id === admin.id && (input.active === false || (input.role && input.role !== u.role))) throw forbidden("users.not_on_self");
    const changes: Record<string, any> = {};
    if (input.role || input.orgId) {
      const role = input.role ?? u.role, orgId = input.orgId ?? u.org_id;
      const org = (await c.query("SELECT kind FROM orgs WHERE id = $1", [orgId])).rows[0];
      if (!ROLE_ORG[role] || !org || !ROLE_ORG[role].includes(org.kind)) throw badRequest("users.role_org_mismatch");
      await c.query("UPDATE users SET role = $2, org_id = $3 WHERE id = $1", [id, role, orgId]);
      changes.role = { from: u.role, to: role }; changes.org = { from: u.org_id, to: orgId };
    }
    if (typeof input.active === "boolean" && input.active !== u.active) {
      await c.query("UPDATE users SET active = $2 WHERE id = $1", [id, input.active]);
      changes.active = input.active;
    }
    if (input.unlock) { await c.query("UPDATE users SET locked_until = NULL, failed_logins = 0 WHERE id = $1", [id]); changes.unlocked = true; }
    let temporaryPassword: string | undefined;
    if (input.resetPassword) {
      temporaryPassword = tempPassword();
      await c.query("UPDATE users SET password_hash = $2, must_change_password = TRUE, locked_until = NULL, failed_logins = 0 WHERE id = $1", [id, hashPassword(temporaryPassword)]);
      changes.passwordReset = true;
    }
    await audit(c, { actor: admin.username, action: "user.update", entity: "user", entityId: id, data: changes });
    return { ok: true, temporaryPassword };
  });
}

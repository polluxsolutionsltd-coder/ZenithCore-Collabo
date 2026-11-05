/**
 * Lean payroll: monthly runs per ministry, paid only to staff whose MoAD
 * record is active in the same ministry (the ghost-worker control), plus
 * biometric enrolment. Feeds indicators 4 and 7.
 */
import { db, tx } from "../../db/index.js";
import { AuthUser, badRequest, conflict, forbidden, notFound } from "../../lib/http.js";
import { audit } from "../audit/audit.service.js";

const PREPARERS = ["HR_OFFICER", "ADMIN"];
const APPROVERS = ["TREASURY_HQ"];
const VIEWERS = ["HR_OFFICER", "ADMIN", "AUDITOR", "TREASURY_HQ"];

export async function calculateRun(u: AuthUser, input: { period: string; ministryId: string }) {
  if (!PREPARERS.includes(u.role)) throw forbidden();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.period ?? "")) throw badRequest("payroll.invalid_period");
  if (u.role === "HR_OFFICER" && u.orgId !== "MOF" && u.orgId !== input.ministryId) throw forbidden();
  return tx(async c => {
    const m = (await c.query("SELECT id FROM orgs WHERE id = $1 AND kind = 'MINISTRY'", [input.ministryId])).rows[0];
    if (!m) throw badRequest("payroll.unknown_ministry");
    const prev = (await c.query("SELECT * FROM payroll_runs WHERE period = $1 AND ministry_id = $2 FOR UPDATE", [input.period, m.id])).rows[0];
    if (prev?.status === "APPROVED") throw conflict("payroll.already_approved");
    if (prev) { await c.query("DELETE FROM payroll_run_lines WHERE run_id = $1", [prev.id]); await c.query("DELETE FROM payroll_runs WHERE id = $1", [prev.id]); }
    const emps = (await c.query(
      `SELECT p.employee_no, p.monthly_net, m.status AS moad_status, m.ministry_id AS moad_ministry
         FROM payroll_employees p LEFT JOIN moad_registry m ON m.national_id = p.national_id
        WHERE p.active AND p.paid_via_module AND p.ministry_id = $1 ORDER BY p.employee_no`, [m.id])).rows;
    const lines = emps.map(e => {
      const exclusion = !e.moad_status ? "NOT_IN_REGISTRY" : e.moad_status !== "ACTIVE" ? "NOT_ACTIVE_IN_REGISTRY" : e.moad_ministry !== m.id ? "DIFFERENT_MINISTRY" : null;
      return { no: e.employee_no, net: Number(e.monthly_net), exclusion };
    });
    const included = lines.filter(l => !l.exclusion);
    const total = included.reduce((s, l) => s + l.net, 0);
    const run = (await c.query(
      "INSERT INTO payroll_runs (period, ministry_id, status, employees, excluded, total_net, created_by) VALUES ($1,$2,'CALCULATED',$3,$4,$5,$6) RETURNING id",
      [input.period, m.id, included.length, lines.length - included.length, total, u.username])).rows[0];
    for (const l of lines) {
      await c.query("INSERT INTO payroll_run_lines (run_id, employee_no, net, included, exclusion) VALUES ($1,$2,$3,$4,$5)", [run.id, l.no, l.net, !l.exclusion, l.exclusion]);
    }
    await audit(c, { actor: u.username, action: "payroll.calculate", entity: "payroll_run", entityId: run.id, data: { period: input.period, ministry: m.id, employees: included.length, excluded: lines.length - included.length, total } });
    return { id: run.id, employees: included.length, excluded: lines.length - included.length, total };
  });
}

export async function approveRun(u: AuthUser, id: number) {
  if (!APPROVERS.includes(u.role)) throw forbidden();
  return tx(async c => {
    const r = (await c.query("SELECT * FROM payroll_runs WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!r) throw notFound();
    if (r.status !== "CALCULATED") throw conflict("payroll.already_approved");
    if (r.created_by === u.username) throw forbidden("document.segregation_of_duties");
    await c.query("UPDATE payroll_runs SET status = 'APPROVED', approved_by = $2, approved_at = now() WHERE id = $1", [id, u.username]);
    await audit(c, { actor: u.username, action: "payroll.approve", entity: "payroll_run", entityId: id, data: { period: r.period, ministry: r.ministry_id, total: Number(r.total_net) } });
    return { ok: true };
  });
}

export async function listRuns(u: AuthUser) {
  if (!VIEWERS.includes(u.role)) throw forbidden();
  return (await db().query(
    `SELECT r.id, r.period, r.ministry_id, r.status, r.employees, r.excluded, r.total_net::float8 AS total_net, r.created_by, r.created_at, r.approved_by, r.approved_at,
            o.name_en, o.name_ar, o.name_fr FROM payroll_runs r JOIN orgs o ON o.id = r.ministry_id ORDER BY r.period DESC, r.ministry_id`)).rows;
}

export async function getRun(u: AuthUser, id: number) {
  if (!VIEWERS.includes(u.role)) throw forbidden();
  const run = (await db().query("SELECT *, total_net::float8 AS total_net FROM payroll_runs WHERE id = $1", [id])).rows[0];
  if (!run) throw notFound();
  const lines = (await db().query(
    `SELECT l.employee_no, l.net::float8 AS net, l.included, l.exclusion, p.full_name_ar, p.biometric_enrolled
       FROM payroll_run_lines l JOIN payroll_employees p ON p.employee_no = l.employee_no WHERE l.run_id = $1 ORDER BY l.included, l.employee_no`, [id])).rows;
  return { ...run, lines };
}

export async function listEmployees(u: AuthUser) {
  if (!VIEWERS.includes(u.role)) throw forbidden();
  return (await db().query(
    `SELECT employee_no, full_name_ar, ministry_id, position_id, monthly_net::float8 AS monthly_net, paid_via_module, biometric_enrolled, biometric_at
       FROM payroll_employees WHERE active ORDER BY employee_no`)).rows;
}

/** Records that an employee's biometrics were captured (the template itself stays in the enrolment system). */
export async function recordBiometric(u: AuthUser, employeeNo: string, input: { deviceRef: string }) {
  if (u.role !== "HR_OFFICER") throw forbidden();
  if (!input.deviceRef || !/^[A-Za-z0-9-]{4,40}$/.test(input.deviceRef)) throw badRequest("payroll.device_ref_required");
  return tx(async c => {
    const e = (await c.query("SELECT * FROM payroll_employees WHERE employee_no = $1 FOR UPDATE", [employeeNo])).rows[0];
    if (!e) throw notFound();
    if (e.biometric_enrolled) throw conflict("payroll.already_enrolled");
    await c.query("UPDATE payroll_employees SET biometric_enrolled = TRUE, biometric_ref = $2, biometric_at = now() WHERE employee_no = $1", [employeeNo, input.deviceRef]);
    await audit(c, { actor: u.username, action: "payroll.biometric_enrolled", entity: "employee", entityId: employeeNo, data: { deviceRef: input.deviceRef } });
    return { ok: true };
  });
}

/** Indicator 4: staff paid through the module in the latest approved period ÷ headcount in scope. */
export async function payrollShare() {
  const latest = (await db().query("SELECT MAX(period) AS p FROM payroll_runs WHERE status = 'APPROVED'")).rows[0].p as string | null;
  const headcount = Number((await db().query("SELECT value FROM reference_figures WHERE key = 'PAYROLL_HEADCOUNT' ORDER BY period DESC LIMIT 1")).rows[0]?.value ?? 0);
  if (!latest) return { period: null, paid: 0, headcount, ratio: headcount ? 0 : null };
  const paid = (await db().query(
    "SELECT COUNT(DISTINCT l.employee_no)::int AS n FROM payroll_run_lines l JOIN payroll_runs r ON r.id = l.run_id WHERE r.period = $1 AND r.status = 'APPROVED' AND l.included", [latest])).rows[0].n;
  return { period: latest, paid, headcount, ratio: headcount ? paid / headcount : null };
}

/** Indicator 7: share of active staff biometrically registered. */
export async function biometricShare() {
  const r = (await db().query("SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE biometric_enrolled)::int AS enrolled FROM payroll_employees WHERE active")).rows[0];
  return { ...r, ratio: r.total ? r.enrolled / r.total : null };
}

/**
 * MoAD (Ministry of Administrative Development) personnel registry interface
 * and the registry ↔ payroll match behind results indicator 5.
 */
import { db, tx } from "../../db/index.js";
import { audit } from "../audit/audit.service.js";

const STATUSES = ["ACTIVE", "SUSPENDED", "RETIRED", "DECEASED"];

export interface PersonnelRecord { nationalId: string; fullNameAr: string; fullNameEn?: string; positionId: string; ministryId: string; grade: string; status: string }
export interface RecordError { index: number; nationalId: string | null; field: string; code: string }

/** Validates every record; valid ones are upserted, invalid ones are reported one by one (nothing silently dropped). */
export async function ingestPersonnel(clientId: string, correlationId: string, body: any): Promise<{ status: number; body: any; businessRef?: string }> {
  const records = body?.records;
  if (!Array.isArray(records) || records.length === 0) {
    return { status: 400, body: { error: "moad.records_required", accepted: 0, rejected: 0, errors: [] as RecordError[] } };
  }
  if (records.length > 5000) return { status: 413, body: { error: "moad.batch_too_large", max: 5000 } };
  const ministries = new Set((await db().query("SELECT id FROM orgs WHERE kind = 'MINISTRY'")).rows.map(r => r.id));
  const errors: RecordError[] = [];
  const valid: PersonnelRecord[] = [];
  const seen = new Set<string>();
  records.forEach((r: any, index: number) => {
    const nid = typeof r?.nationalId === "string" ? r.nationalId : null;
    const err = (field: string, code: string) => errors.push({ index, nationalId: nid, field, code });
    const before = errors.length;
    if (!nid || !/^\d{11}$/.test(nid)) err("nationalId", "moad.national_id_format");
    else if (seen.has(nid)) err("nationalId", "moad.duplicate_in_batch");
    if (typeof r?.fullNameAr !== "string" || !/[؀-ۿ]/.test(r.fullNameAr)) err("fullNameAr", "moad.arabic_name_required");
    if (typeof r?.positionId !== "string" || !r.positionId.trim()) err("positionId", "moad.position_required");
    if (!ministries.has(r?.ministryId)) err("ministryId", "moad.unknown_ministry");
    if (typeof r?.grade !== "string" || !/^[1-5][A-Z]?$/.test(r.grade)) err("grade", "moad.grade_format");
    if (!STATUSES.includes(r?.status)) err("status", "moad.status_invalid");
    if (errors.length === before) { valid.push(r); seen.add(nid!); }
  });
  if (valid.length) {
    await tx(async c => {
      for (const r of valid) {
        await c.query(
          `INSERT INTO moad_registry (national_id, full_name_ar, full_name_en, position_id, ministry_id, grade, status, correlation_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (national_id) DO UPDATE SET full_name_ar = EXCLUDED.full_name_ar, full_name_en = EXCLUDED.full_name_en, position_id = EXCLUDED.position_id,
             ministry_id = EXCLUDED.ministry_id, grade = EXCLUDED.grade, status = EXCLUDED.status, received_at = now(), correlation_id = EXCLUDED.correlation_id`,
          [r.nationalId, r.fullNameAr, r.fullNameEn ?? null, r.positionId, r.ministryId, r.grade, r.status, correlationId]);
      }
      await audit(c, { actor: `api:${clientId}`, action: "moad.personnel_received", entity: "integration", entityId: correlationId, data: { accepted: valid.length, rejected: records.length - valid.length } });
    });
  }
  const status = errors.length === 0 ? 200 : valid.length ? 207 : 422;
  return { status, businessRef: `MOAD-${valid.length}/${records.length}`, body: { correlationId, accepted: valid.length, rejected: records.length - valid.length, errors } };
}

/**
 * Indicator 5: share of active payroll employees who match an ACTIVE MoAD
 * registry record in the same ministry. Mismatches are listed for follow-up.
 */
export async function payrollMatch() {
  const rows = (await db().query(
    `SELECT p.employee_no, p.national_id, p.full_name_ar, p.ministry_id, m.status AS moad_status, m.ministry_id AS moad_ministry,
            CASE WHEN m.national_id IS NULL THEN 'NOT_IN_REGISTRY'
                 WHEN m.status <> 'ACTIVE' THEN 'NOT_ACTIVE_IN_REGISTRY'
                 WHEN m.ministry_id <> p.ministry_id THEN 'DIFFERENT_MINISTRY'
                 ELSE 'MATCHED' END AS result
       FROM payroll_employees p LEFT JOIN moad_registry m ON m.national_id = p.national_id
      WHERE p.active ORDER BY p.employee_no`)).rows;
  const matched = rows.filter(r => r.result === "MATCHED").length;
  return { total: rows.length, matched, ratio: rows.length ? matched / rows.length : null, exceptions: rows.filter(r => r.result !== "MATCHED") };
}

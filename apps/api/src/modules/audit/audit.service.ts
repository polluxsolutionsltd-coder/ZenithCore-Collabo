import { Db, db } from "../../db/index.js";
import { canonical, sha256 } from "../../lib/security.js";

const GENESIS = "0".repeat(64);
const AUDIT_LOCK = 4207001; // advisory lock id serialising the hash chain

export interface AuditEntry {
  actor: string;
  action: string;
  entity: string;
  entityId: string | number;
  data?: Record<string, any>;
}

function entryHash(prev: string, ts: string, e: { actor: string; action: string; entity: string; entity_id: string; data: any }) {
  return sha256(prev + "|" + ts + "|" + canonical({ actor: e.actor, action: e.action, entity: e.entity, entity_id: e.entity_id, data: e.data }));
}

/** Appends to the hash-chained audit log. Must run inside the caller's transaction. */
export async function audit(c: Db, e: AuditEntry) {
  await c.query("SELECT pg_advisory_xact_lock($1)", [AUDIT_LOCK]);
  const last = await c.query("SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1");
  const prev = last.rows[0]?.hash ?? GENESIS;
  const ts = new Date().toISOString();
  const row = { actor: e.actor, action: e.action, entity: e.entity, entity_id: String(e.entityId), data: e.data ?? {} };
  const hash = entryHash(prev, ts, row);
  await c.query(
    "INSERT INTO audit_log (ts, actor, action, entity, entity_id, data, prev_hash, hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    [ts, row.actor, row.action, row.entity, row.entity_id, row.data, prev, hash],
  );
}

export async function listAudit(entity?: string, entityId?: string, limit = 200) {
  const where: string[] = [];
  const vals: any[] = [];
  if (entity) { vals.push(entity); where.push(`entity = $${vals.length}`); }
  if (entityId) { vals.push(entityId); where.push(`entity_id = $${vals.length}`); }
  vals.push(Math.min(limit, 1000));
  const r = await db().query(
    `SELECT id, ts, actor, action, entity, entity_id, data, hash FROM audit_log ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT $${vals.length}`,
    vals,
  );
  return r.rows;
}

/** Recomputes the whole chain; reports the first broken entry if any. */
export async function verifyChain() {
  const r = await db().query("SELECT id, ts, actor, action, entity, entity_id, data, prev_hash, hash FROM audit_log ORDER BY id");
  let prev = GENESIS;
  for (const row of r.rows) {
    const ts = new Date(row.ts).toISOString();
    if (row.prev_hash !== prev || entryHash(prev, ts, row) !== row.hash) {
      return { valid: false, entries: r.rows.length, brokenAt: Number(row.id) };
    }
    prev = row.hash;
  }
  return { valid: true, entries: r.rows.length, lastHash: prev };
}

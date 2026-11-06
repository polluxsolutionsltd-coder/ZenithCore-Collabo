import { Db, db } from "../../db/index.js";
import { AuthUser } from "../../lib/http.js";

/** Notification keys are translated by the client; params fill the placeholders. */
export async function notify(c: Db, n: { userId?: number; role?: string; orgId?: string; key: string; params?: any; documentId?: number }) {
  await c.query(
    "INSERT INTO notifications (recipient_user_id, recipient_role, recipient_org_id, key, params, document_id) VALUES ($1,$2,$3,$4,$5,$6)",
    [n.userId ?? null, n.role ?? null, n.orgId ?? null, n.key, n.params ?? {}, n.documentId ?? null],
  );
}

const MINE = `(recipient_user_id = $1 OR (recipient_user_id IS NULL AND recipient_role = $2 AND (recipient_org_id IS NULL OR recipient_org_id = $3)))`;

export async function listNotifications(u: AuthUser) {
  const r = await db().query(
    `SELECT id, key, params, document_id, created_at, ($1 = ANY(read_by)) AS read FROM notifications WHERE ${MINE} ORDER BY id DESC LIMIT 50`,
    [u.id, u.role, u.orgId],
  );
  return r.rows;
}

export async function markRead(u: AuthUser, id: number) {
  await db().query(`UPDATE notifications SET read_by = array_append(read_by, $1) WHERE id = $4 AND ${MINE} AND NOT ($1 = ANY(read_by))`, [u.id, u.role, u.orgId, id]);
}

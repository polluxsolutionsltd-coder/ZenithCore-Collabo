/**
 * Integration gateway: partner authentication, rate limiting, idempotency and
 * the message log behind the monitoring console. Every message in or out of
 * ZenithCore is recorded with its correlation ID.
 */
import http from "node:http";
import { Db, db } from "../../db/index.js";
import { AppError, badRequest, conflict, notFound, unauthorized } from "../../lib/http.js";
import { canonical, sha256 } from "../../lib/security.js";

export interface ApiClient { id: string; name: string; scopes: string[]; rate_per_minute: number }

/** Authenticates a partner system by its API key (only the SHA-256 hash is stored). */
export async function clientFromKey(req: http.IncomingMessage, scope: string): Promise<ApiClient> {
  const key = req.headers["x-api-key"];
  if (typeof key !== "string" || key.length < 16) throw unauthorized("integration.api_key_required");
  const r = await db().query("SELECT id, name, scopes, rate_per_minute FROM api_clients WHERE key_hash = $1 AND active", [sha256(key)]);
  const client = r.rows[0] as ApiClient | undefined;
  if (!client) throw unauthorized("integration.api_key_invalid");
  if (!client.scopes.includes(scope)) throw new AppError(403, "integration.scope_missing");
  rateLimit(client);
  return client;
}

/** Fixed-window limiter per client (per process; a shared store would be used behind a load balancer). */
const windows = new Map<string, { start: number; count: number }>();
function rateLimit(client: ApiClient) {
  const now = Date.now();
  const w = windows.get(client.id);
  if (!w || now - w.start >= 60_000) { windows.set(client.id, { start: now, count: 1 }); return; }
  if (++w.count > client.rate_per_minute) throw new AppError(429, "integration.rate_limited", undefined, { retryAfterSeconds: Math.ceil((w.start + 60_000 - now) / 1000) });
}
export const resetRateLimits = () => windows.clear();

/**
 * Runs an inbound partner request exactly once per Idempotency-Key.
 * Same key + same body → the stored response is replayed.
 * Same key + different body → 409, nothing is processed.
 */
export async function idempotentInbound<T>(p: {
  client: ApiClient; msgType: string; key: string | undefined; body: any; correlationId: string; res: http.ServerResponse;
  run: () => Promise<{ status: number; body: T; businessRef?: string }>;
}): Promise<{ status: number; body: any; replay: boolean }> {
  if (!p.key || p.key.length < 8 || p.key.length > 128) throw badRequest("integration.idempotency_key_required");
  const hash = sha256(canonical(p.body));
  const started = Date.now();
  const ins = await db().query(
    `INSERT INTO integration_messages (direction, partner, msg_type, correlation_id, idempotency_key, request_hash, status, attempts, request)
     VALUES ('IN', $1, $2, $3, $4, $5, 'PROCESSING', 1, $6)
     ON CONFLICT (partner, msg_type, idempotency_key) WHERE direction = 'IN' AND idempotency_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [p.client.id, p.msgType, p.correlationId, p.key, hash, JSON.stringify(p.body)]);
  if (!ins.rows.length) {
    const prev = (await db().query(
      "SELECT id, request_hash, status, http_status, response, correlation_id FROM integration_messages WHERE direction = 'IN' AND partner = $1 AND msg_type = $2 AND idempotency_key = $3",
      [p.client.id, p.msgType, p.key])).rows[0];
    if (prev.request_hash !== hash) throw conflict("integration.idempotency_conflict", { originalCorrelationId: prev.correlation_id });
    if (prev.status === "PROCESSING") throw conflict("integration.in_progress");
    p.res.setHeader("idempotent-replay", "true");
    p.res.setHeader("x-original-correlation-id", prev.correlation_id);
    await db().query("UPDATE integration_messages SET attempts = attempts + 1, updated_at = now() WHERE id = $1", [prev.id]);
    return { status: prev.http_status, body: JSON.parse(prev.response), replay: true };
  }
  const id = ins.rows[0].id;
  try {
    const out = await p.run();
    await db().query("UPDATE integration_messages SET status = $2, http_status = $3, response = $4, business_ref = $5, duration_ms = $6, updated_at = now() WHERE id = $1",
      [id, out.status === 200 ? "PROCESSED" : out.status < 300 ? "PARTIAL" : "REJECTED", out.status, JSON.stringify(out.body), out.businessRef ?? null, Date.now() - started]);
    return { status: out.status, body: out.body, replay: false };
  } catch (e: any) {
    const status = e instanceof AppError ? e.status : 500;
    await db().query("UPDATE integration_messages SET status = 'FAILED', http_status = $2, response = $3, last_error = $4, duration_ms = $5, updated_at = now() WHERE id = $1",
      [id, status, JSON.stringify({ error: e instanceof AppError ? e.code : "server.error", details: e?.details }), String(e?.message ?? e), Date.now() - started]);
    throw e;
  }
}

/** Records an outbound exchange (one row per business message, updated on every attempt). */
export async function startOutbound(c: Db, p: { partner: string; msgType: string; correlationId: string; businessRef: string; request: string }) {
  return (await c.query(
    `INSERT INTO integration_messages (direction, partner, msg_type, correlation_id, status, request, business_ref) VALUES ('OUT', $1, $2, $3, 'SENDING', $4, $5) RETURNING id`,
    [p.partner, p.msgType, p.correlationId, p.request, p.businessRef])).rows[0].id as number;
}

export async function updateOutbound(id: number, f: { status: string; httpStatus?: number | null; response?: string | null; error?: string | null; attempts?: number; durationMs?: number; nextAttemptAt?: Date | null }) {
  await db().query(
    `UPDATE integration_messages SET status = $2, http_status = COALESCE($3, http_status), response = COALESCE($4, response), last_error = $5,
            attempts = COALESCE($6, attempts), duration_ms = COALESCE($7, duration_ms), next_attempt_at = $8, updated_at = now() WHERE id = $1`,
    [id, f.status, f.httpStatus ?? null, f.response ?? null, f.error ?? null, f.attempts ?? null, f.durationMs ?? null, f.nextAttemptAt ?? null]);
}

export async function listMessages(q: { status?: string; partner?: string; direction?: string; correlationId?: string; limit?: number }) {
  const where: string[] = [], vals: any[] = [];
  const add = (sql: string, v: any) => { vals.push(v); where.push(sql.replace("?", "$" + vals.length)); };
  if (q.status) add("status = ?", q.status);
  if (q.partner) add("partner = ?", q.partner);
  if (q.direction) add("direction = ?", q.direction);
  if (q.correlationId) add("correlation_id = ?", q.correlationId);
  vals.push(Math.min(q.limit ?? 100, 500));
  return (await db().query(
    `SELECT id, direction, partner, msg_type, correlation_id, idempotency_key, status, http_status, attempts, last_error, business_ref, duration_ms, created_at, updated_at
       FROM integration_messages ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT $${vals.length}`, vals)).rows;
}

export async function getMessage(id: number) {
  const r = (await db().query("SELECT * FROM integration_messages WHERE id = $1", [id])).rows[0];
  if (!r) throw notFound();
  return r;
}

export async function summary() {
  const rows = (await db().query(
    `SELECT partner, direction, status, COUNT(*)::int AS n, COALESCE(AVG(duration_ms), 0)::int AS avg_ms
       FROM integration_messages WHERE created_at > now() - interval '7 days' GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`)).rows;
  const deadLetters = (await db().query("SELECT COUNT(*)::int AS n FROM integration_messages WHERE status = 'DEAD_LETTER'")).rows[0].n;
  return { rows, deadLetters };
}

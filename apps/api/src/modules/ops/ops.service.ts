/**
 * D5 – operational monitoring: a deep health check for load balancers and
 * the operations team, and Prometheus-format metrics.
 */
import { db } from "../../db/index.js";
import { cbsUrl } from "../payments/cbs.client.js";

const started = Date.now();
const requests = new Map<string, number>();           // "method status" → count
const buckets = [50, 100, 250, 500, 1000, 2500, 5000];
const latency = new Array(buckets.length + 1).fill(0);
let latencySum = 0, latencyCount = 0;

/** Called by the server for every API request. The route pattern (not the raw path) keeps cardinality low. */
export function recordRequest(method: string, status: number, ms: number) {
  const k = `${method} ${Math.floor(status / 100)}xx`;
  requests.set(k, (requests.get(k) ?? 0) + 1);
  let i = buckets.findIndex(b => ms <= b);
  if (i < 0) i = buckets.length;
  latency[i]++; latencySum += ms; latencyCount++;
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ok: boolean; ms: number; value?: T; error?: string }> {
  const t = Date.now();
  try { return { ok: true, ms: Date.now() - t, value: await fn() }; } catch (e: any) { return { ok: false, ms: Date.now() - t, error: String(e?.message ?? e) }; }
}

/** `ready` is false only when the database is unreachable; the CBS link and dead letters degrade, they do not fail. */
export async function deepHealth() {
  const database = await timed(async () => (await db().query("SELECT 1 AS ok")).rows[0].ok);
  const cbs = await timed(async () => {
    const r = await fetch(`${cbsUrl()}/iso20022/payments/health-check/status`, { signal: AbortSignal.timeout(2000) });
    return r.status;
  });
  const deadLetters = database.ok ? (await db().query("SELECT COUNT(*)::int AS n FROM integration_messages WHERE status = 'DEAD_LETTER'")).rows[0].n : null;
  const migrations = database.ok ? (await db().query("SELECT MAX(name) AS v FROM schema_migrations")).rows[0].v : null;
  const status = !database.ok ? "down" : !cbs.ok || deadLetters ? "degraded" : "ok";
  return {
    status, ready: database.ok, uptimeSeconds: Math.round((Date.now() - started) / 1000), version: process.env.npm_package_version ?? "4.0.0-dev",
    checks: { database: { ok: database.ok, ms: database.ms, error: database.error }, cbs: { ok: cbs.ok, ms: cbs.ms, error: cbs.error }, deadLetters, schema: migrations },
  };
}

export async function metrics(): Promise<string> {
  const out: string[] = [];
  const line = (name: string, help: string, type: string, rows: [string, number][]) => {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...rows.map(([l, v]) => `${name}${l} ${v}`));
  };
  line("zc_uptime_seconds", "Process uptime", "gauge", [["", Math.round((Date.now() - started) / 1000)]]);
  line("zc_http_requests_total", "API requests by method and status class", "counter",
    [...requests.entries()].map(([k, v]) => { const [m, s] = k.split(" "); return [`{method="${m}",status="${s}"}`, v]; }));
  let cum = 0;
  const rows: [string, number][] = buckets.map((b, i) => { cum += latency[i]; return [`{le="${b / 1000}"}`, cum]; });
  rows.push([`{le="+Inf"}`, latencyCount]);
  out.push("# HELP zc_http_request_duration_seconds API request duration", "# TYPE zc_http_request_duration_seconds histogram",
    ...rows.map(([l, v]) => `zc_http_request_duration_seconds_bucket${l} ${v}`),
    `zc_http_request_duration_seconds_sum ${(latencySum / 1000).toFixed(3)}`, `zc_http_request_duration_seconds_count ${latencyCount}`);
  try {
    const msgs = (await db().query("SELECT partner, status, COUNT(*)::int AS n FROM integration_messages GROUP BY 1, 2")).rows;
    line("zc_integration_messages", "Integration messages by partner and status", "gauge", msgs.map(m => [`{partner="${m.partner}",status="${m.status}"}`, m.n]));
    const docs = (await db().query("SELECT status, COUNT(*)::int AS n FROM documents GROUP BY 1")).rows;
    line("zc_documents", "Payment requests by status", "gauge", docs.map(d => [`{status="${d.status}"}`, d.n]));
    const pool = db() as any;
    line("zc_db_pool_connections", "Database pool connections", "gauge", [["{state=\"total\"}", pool.totalCount ?? 0], ["{state=\"idle\"}", pool.idleCount ?? 0]]);
    line("zc_db_up", "Database reachable", "gauge", [["", 1]]);
  } catch {
    line("zc_db_up", "Database reachable", "gauge", [["", 0]]);
  }
  return out.join("\n") + "\n";
}

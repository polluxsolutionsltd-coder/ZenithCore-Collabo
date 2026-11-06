import { createRequire } from "node:module";
import { Pool, PoolClient, QueryResult } from "../lib/pg/pool.js";

export type Db = Pick<PoolClient, "query">;

/** What the rest of the code needs from a pool: met by the built-in client and by node-postgres. */
export interface DbPool {
  query<T = any>(text: string, values?: any[]): Promise<QueryResult<T>>;
  /** Several statements in one text, no parameters (migrations). */
  simpleQuery(text: string): Promise<QueryResult>;
  connect(): Promise<PoolClient>;
  end(): Promise<void>;
}

export const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://zc:zc@localhost:5432/zenithcore";

/**
 * DB_DRIVER selects the PostgreSQL driver:
 *   builtin (default) – the small client in lib/pg, no dependencies
 *   pg                – node-postgres (`npm install pg`), configured to return the same JS types
 */
export const DB_DRIVER = (process.env.DB_DRIVER ?? "builtin").toLowerCase();

let pool: DbPool | null = null;

export function db(): DbPool {
  if (!pool) {
    const max = Number(process.env.DB_POOL_MAX ?? 10);
    pool = DB_DRIVER === "pg" ? nodePostgres(max) : new Pool({ connectionString: DATABASE_URL, max });
  }
  return pool;
}

function nodePostgres(max: number): DbPool {
  let pg: any;
  try { pg = createRequire(import.meta.url)("pg"); }
  catch { throw new Error("DB_DRIVER=pg but the 'pg' package is not installed. Run `npm install pg` or unset DB_DRIVER."); }
  // Same results as the built-in client: DATE stays 'YYYY-MM-DD'; timestamps are UTC.
  pg.types.setTypeParser(1082, (v: string) => v);
  pg.types.setTypeParser(1114, (v: string) => new Date(v.replace(" ", "T") + "Z"));
  const p = new pg.Pool({ connectionString: DATABASE_URL, max, options: "-c TimeZone=UTC" });
  p.on("error", () => undefined); // an idle connection dropped by the server is discarded, not fatal
  return {
    query: (text, values) => p.query(text, values),
    simpleQuery: text => p.query(text),
    connect: () => p.connect(),
    end: () => p.end(),
  };
}

/** Run `fn` inside a transaction; rolls back on any error. */
export async function tx<T>(fn: (c: Db) => Promise<T>): Promise<T> {
  const c = await db().connect();
  try {
    await c.query("BEGIN");
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

export async function closeDb() {
  if (pool) { await pool.end(); pool = null; }
}

/** Waits for the database at start-up (e.g. while it is still starting after a reboot). */
export async function waitForDb(opts: { attempts?: number; delayMs?: number; log?: (m: string) => void } = {}) {
  const attempts = opts.attempts ?? Number(process.env.DB_START_ATTEMPTS ?? 30);
  const delay = opts.delayMs ?? 2000;
  for (let i = 1; ; i++) {
    try { await db().query("SELECT 1"); return; }
    catch (e: any) {
      if (i >= attempts) throw e;
      opts.log?.(`Database not reachable (${e?.code ?? e?.message ?? e}); retry ${i}/${attempts - 1} in ${delay / 1000}s`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

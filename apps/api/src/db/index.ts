import { Pool, PoolClient } from "../lib/pg/pool.js";

export type Db = Pick<PoolClient, "query">;

export const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://zc:zc@localhost:5432/zenithcore";

let pool: Pool | null = null;

export function db(): Pool {
  if (!pool) pool = new Pool({ connectionString: DATABASE_URL, max: Number(process.env.DB_POOL_MAX ?? 10) });
  return pool;
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

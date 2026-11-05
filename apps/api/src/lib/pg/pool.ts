import { Connection, ConnectionConfig, QueryResult } from "./connection.js";

export type { QueryResult };

export interface PoolClient {
  query<T = any>(text: string, values?: any[]): Promise<QueryResult<T>>;
  release(): void;
}

/** Small connection pool with the same shape as `pg.Pool`. */
export class Pool {
  private idle: Connection[] = [];
  private waiting: Array<(c: Connection) => void> = [];
  private total = 0;
  private cfg: ConnectionConfig;
  private max: number;

  constructor(opts: { connectionString: string; max?: number }) {
    const u = new URL(opts.connectionString);
    this.cfg = {
      host: u.hostname || "localhost",
      port: u.port ? parseInt(u.port, 10) : 5432,
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: u.pathname.replace(/^\//, ""),
    };
    this.max = opts.max ?? 10;
  }

  private async acquire(): Promise<Connection> {
    while (this.idle.length) {
      const c = this.idle.pop()!;
      if (!c.isClosed) return c;
      this.total--;
    }
    if (this.total < this.max) {
      this.total++;
      const c = new Connection(this.cfg);
      try { await c.connect(); } catch (e) { this.total--; throw e; }
      return c;
    }
    return new Promise(res => this.waiting.push(res));
  }

  private giveBack(c: Connection) {
    if (c.isClosed) { this.total--; return; }
    const w = this.waiting.shift();
    if (w) w(c); else this.idle.push(c);
  }

  async query<T = any>(text: string, values: any[] = []): Promise<QueryResult<T>> {
    const c = await this.acquire();
    try { return await c.query<T>(text, values); } finally { this.giveBack(c); }
  }

  async simpleQuery(text: string): Promise<QueryResult> {
    const c = await this.acquire();
    try { return await c.simpleQuery(text); } finally { this.giveBack(c); }
  }

  async connect(): Promise<PoolClient> {
    const c = await this.acquire();
    let released = false;
    return {
      query: (t, v) => c.query(t, v),
      release: () => { if (!released) { released = true; this.giveBack(c); } },
    };
  }

  async end() {
    await Promise.all(this.idle.map(c => c.end()));
    this.idle = [];
    this.total = 0;
  }
}

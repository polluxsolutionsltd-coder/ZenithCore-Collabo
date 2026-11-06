/**
 * Minimal PostgreSQL wire-protocol client (protocol 3.0).
 *
 * Supports SCRAM-SHA-256, MD5 and trust authentication, the simple query
 * protocol (for migrations) and the extended protocol with text parameters
 * (for application queries). Its public surface mirrors node-postgres
 * (`query(text, values) -> { rows, rowCount }`), so the team can switch to the
 * `pg` package without touching application code.
 */
import net from "node:net";
import crypto from "node:crypto";

export interface QueryResult<T = any> {
  rows: T[];
  rowCount: number;
  command: string;
}

export interface ConnectionConfig {
  host: string;
  port: number;
  user: string;
  password?: string;
  database: string;
}

export class PgError extends Error {
  code?: string;
  detail?: string;
  constructor(fields: Record<string, string>) {
    super(fields.M || "PostgreSQL error");
    this.code = fields.C;
    this.detail = fields.D;
  }
}

type Field = { name: string; typeOid: number };

/** Parses a one-dimensional PostgreSQL array literal, e.g. {a,"b c",NULL}. */
export function parseArray(v: string, item: (x: string) => any = x => x): any[] {
  const out: any[] = [];
  if (v.length < 2) return out;
  let i = 1, cur = "", quoted = false, wasQuoted = false;
  const push = () => { out.push(!wasQuoted && cur === "NULL" ? null : item(cur)); cur = ""; wasQuoted = false; };
  if (v === "{}") return out;
  for (; i < v.length - 1; i++) {
    const ch = v[i];
    if (quoted) {
      if (ch === "\\") cur += v[++i];
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') { quoted = true; wasQuoted = true; }
    else if (ch === ",") push();
    else cur += ch;
  }
  push();
  return out;
}

// Text-format parsers by type OID. NUMERIC and INT8 stay strings (as in `pg`).
const PARSERS: Record<number, (v: string) => any> = {
  16: v => v === "t",                 // bool
  21: v => parseInt(v, 10),           // int2
  23: v => parseInt(v, 10),           // int4
  26: v => parseInt(v, 10),           // oid
  700: v => parseFloat(v),            // float4
  701: v => parseFloat(v),            // float8
  114: v => JSON.parse(v),            // json
  3802: v => JSON.parse(v),           // jsonb
  1082: v => v,                       // date (keep YYYY-MM-DD)
  1114: v => new Date(v.replace(" ", "T") + "Z"),                               // timestamp
  1184: v => new Date(v.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00")),      // timestamptz
  1009: v => parseArray(v),                                   // text[]
  1015: v => parseArray(v),                                   // varchar[]
  1007: v => parseArray(v, x => parseInt(x, 10)),             // int4[]
};

function cstr(s: string): Buffer {
  return Buffer.concat([Buffer.from(s, "utf8"), Buffer.from([0])]);
}

function msg(type: string | null, body: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeInt32BE(body.length + 4);
  return type ? Buffer.concat([Buffer.from(type), len, body]) : Buffer.concat([len, body]);
}

function int16(n: number): Buffer { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; }
function int32(n: number): Buffer { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; }

/** JS array -> PostgreSQL array literal (same behaviour as node-postgres). */
function arrayLiteral(a: any[]): string {
  return "{" + a.map(e => {
    if (e === null || e === undefined) return "NULL";
    if (Array.isArray(e)) return arrayLiteral(e);
    const s = e instanceof Date ? e.toISOString() : typeof e === "object" ? JSON.stringify(e) : String(e);
    return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  }).join(",") + "}";
}

function serialize(v: any): Buffer | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Buffer.from(v.toISOString(), "utf8");
  if (Array.isArray(v)) return Buffer.from(arrayLiteral(v), "utf8");
  if (typeof v === "object") return Buffer.from(JSON.stringify(v), "utf8");
  if (typeof v === "boolean") return Buffer.from(v ? "true" : "false");
  return Buffer.from(String(v), "utf8");
}

export class Connection {
  private socket!: net.Socket;
  private buf = Buffer.alloc(0);
  private waiters: Array<(m: { type: string; body: Buffer }) => void> = [];
  private inbox: Array<{ type: string; body: Buffer }> = [];
  private closed = false;
  private busy: Promise<any> = Promise.resolve();

  constructor(private cfg: ConnectionConfig) {}

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.socket = net.createConnection({ host: this.cfg.host, port: this.cfg.port }, resolve);
      this.socket.once("error", reject);
    });
    this.socket.on("data", d => this.onData(d as Buffer));
    this.socket.on("close", () => { this.closed = true; });
    this.socket.on("error", () => { this.closed = true; });

    const params = Buffer.concat([cstr("user"), cstr(this.cfg.user), cstr("database"), cstr(this.cfg.database),
      cstr("client_encoding"), cstr("UTF8"), cstr("TimeZone"), cstr("UTC"), Buffer.from([0])]);
    this.socket.write(msg(null, Buffer.concat([int32(196608), params])));
    await this.authenticate();
  }

  get isClosed() { return this.closed; }

  private onData(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 5) {
      const len = this.buf.readInt32BE(1);
      if (this.buf.length < len + 1) break;
      const m = { type: String.fromCharCode(this.buf[0]), body: this.buf.subarray(5, len + 1) };
      this.buf = this.buf.subarray(len + 1);
      if (m.type === "N" || m.type === "S" || m.type === "A") continue; // notices, parameter status, notifications
      const w = this.waiters.shift();
      if (w) w(m); else this.inbox.push(m);
    }
  }

  private next(): Promise<{ type: string; body: Buffer }> {
    const m = this.inbox.shift();
    if (m) return Promise.resolve(m);
    if (this.closed) return Promise.reject(new Error("Connection closed"));
    return new Promise(res => this.waiters.push(res));
  }

  private static errorFields(body: Buffer): Record<string, string> {
    const f: Record<string, string> = {};
    let i = 0;
    while (i < body.length && body[i] !== 0) {
      const code = String.fromCharCode(body[i]);
      const end = body.indexOf(0, i + 1);
      f[code] = body.subarray(i + 1, end).toString("utf8");
      i = end + 1;
    }
    return f;
  }

  private async authenticate() {
    let clientFirstBare = "", nonce = "", serverSignature = "";
    for (;;) {
      const m = await this.next();
      if (m.type === "E") throw new PgError(Connection.errorFields(m.body));
      if (m.type === "R") {
        const code = m.body.readInt32BE(0);
        if (code === 0) continue; // AuthenticationOk
        if (code === 3) { this.socket.write(msg("p", cstr(this.cfg.password ?? ""))); continue; }
        if (code === 5) {
          const salt = m.body.subarray(4, 8);
          const inner = crypto.createHash("md5").update((this.cfg.password ?? "") + this.cfg.user).digest("hex");
          const outer = "md5" + crypto.createHash("md5").update(Buffer.concat([Buffer.from(inner), salt])).digest("hex");
          this.socket.write(msg("p", cstr(outer)));
          continue;
        }
        if (code === 10) { // SASL: start SCRAM-SHA-256
          nonce = crypto.randomBytes(18).toString("base64");
          clientFirstBare = `n=,r=${nonce}`;
          const first = Buffer.from("n,," + clientFirstBare, "utf8");
          this.socket.write(msg("p", Buffer.concat([cstr("SCRAM-SHA-256"), int32(first.length), first])));
          continue;
        }
        if (code === 11) { // SASL continue
          const serverFirst = m.body.subarray(4).toString("utf8");
          const attrs = Object.fromEntries(serverFirst.split(",").map(p => [p[0], p.slice(2)]));
          if (!attrs.r.startsWith(nonce)) throw new Error("SCRAM nonce mismatch");
          const salted = crypto.pbkdf2Sync(this.cfg.password ?? "", Buffer.from(attrs.s, "base64"), parseInt(attrs.i, 10), 32, "sha256");
          const clientKey = crypto.createHmac("sha256", salted).update("Client Key").digest();
          const storedKey = crypto.createHash("sha256").update(clientKey).digest();
          const withoutProof = `c=biws,r=${attrs.r}`;
          const authMessage = `${clientFirstBare},${serverFirst},${withoutProof}`;
          const sig = crypto.createHmac("sha256", storedKey).update(authMessage).digest();
          const proof = Buffer.from(clientKey.map((b, i) => b ^ sig[i]));
          const serverKey = crypto.createHmac("sha256", salted).update("Server Key").digest();
          serverSignature = crypto.createHmac("sha256", serverKey).update(authMessage).digest("base64");
          this.socket.write(msg("p", Buffer.from(`${withoutProof},p=${proof.toString("base64")}`, "utf8")));
          continue;
        }
        if (code === 12) { // SASL final
          const v = m.body.subarray(4).toString("utf8");
          if (v !== `v=${serverSignature}`) throw new Error("SCRAM server signature mismatch");
          continue;
        }
        throw new Error(`Unsupported authentication method ${code}`);
      }
      if (m.type === "K") continue;
      if (m.type === "Z") return;
    }
  }

  /** Serialise calls on one connection. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.busy.then(fn, fn);
    this.busy = run.catch(() => undefined);
    return run;
  }

  /** Simple query protocol: may contain several statements; no parameters. */
  simpleQuery(text: string): Promise<QueryResult> {
    return this.exclusive(async () => {
      this.socket.write(msg("Q", cstr(text)));
      return this.collect();
    });
  }

  /** Extended protocol with text-format parameters ($1, $2 …). */
  query<T = any>(text: string, values: any[] = []): Promise<QueryResult<T>> {
    return this.exclusive(async () => {
      const params = values.map(serialize);
      const bind = Buffer.concat([
        cstr(""), cstr(""), int16(0), int16(params.length),
        ...params.map(p => (p === null ? int32(-1) : Buffer.concat([int32(p.length), p]))),
        int16(0),
      ]);
      this.socket.write(Buffer.concat([
        msg("P", Buffer.concat([cstr(""), cstr(text), int16(0)])),
        msg("B", bind),
        msg("D", Buffer.concat([Buffer.from("P"), cstr("")])),
        msg("E", Buffer.concat([cstr(""), int32(0)])),
        msg("S", Buffer.alloc(0)),
      ]));
      return this.collect<T>();
    });
  }

  private async collect<T>(): Promise<QueryResult<T>> {
    let fields: Field[] = [];
    const rows: any[] = [];
    let command = "", rowCount = 0, error: PgError | null = null;
    for (;;) {
      const m = await this.next();
      switch (m.type) {
        case "T": {
          const n = m.body.readInt16BE(0);
          let i = 2;
          fields = [];
          for (let k = 0; k < n; k++) {
            const end = m.body.indexOf(0, i);
            const name = m.body.subarray(i, end).toString("utf8");
            i = end + 1;
            const typeOid = m.body.readInt32BE(i + 6);
            i += 18;
            fields.push({ name, typeOid });
          }
          break;
        }
        case "D": {
          const n = m.body.readInt16BE(0);
          let i = 2;
          const row: any = {};
          for (let k = 0; k < n; k++) {
            const len = m.body.readInt32BE(i);
            i += 4;
            if (len === -1) { row[fields[k].name] = null; continue; }
            const raw = m.body.subarray(i, i + len).toString("utf8");
            i += len;
            const p = PARSERS[fields[k].typeOid];
            row[fields[k].name] = p ? p(raw) : raw;
          }
          rows.push(row);
          break;
        }
        case "C": {
          command = m.body.subarray(0, m.body.length - 1).toString("utf8");
          const last = command.split(" ").pop();
          rowCount = last && /^\d+$/.test(last) ? parseInt(last, 10) : rows.length;
          break;
        }
        case "E": error = new PgError(Connection.errorFields(m.body)); break;
        case "Z": if (error) throw error; return { rows, rowCount, command };
        default: break; // ParseComplete, BindComplete, NoData, EmptyQuery
      }
    }
  }

  async end() {
    if (this.closed) return;
    try { this.socket.write(msg("X", Buffer.alloc(0))); } catch { /* ignore */ }
    this.socket.end();
    this.closed = true;
  }
}

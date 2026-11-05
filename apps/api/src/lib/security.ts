import crypto from "node:crypto";

const SECRET = process.env.JWT_SECRET ?? "dev-only-secret-change-me";
const TTL_SECONDS = Number(process.env.JWT_TTL_SECONDS ?? 8 * 3600);

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** HS256 JSON Web Token. */
export function signToken(payload: Record<string, any>): string {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ ...payload, iat: now, exp: now + TTL_SECONDS }));
  const sig = b64url(crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest());
  return `${head}.${body}.${sig}`;
}

export function verifyToken(token: string): Record<string, any> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const expected = b64url(crypto.createHmac("sha256", SECRET).update(`${parts[0]}.${parts[1]}`).digest());
  const a = Buffer.from(parts[2]), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (typeof p.exp !== "number" || p.exp < Math.floor(Date.now() / 1000)) return null;
    return p;
  } catch { return null; }
}

/** scrypt password hash: scrypt$N$salt$hash */
export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 32, { N: 16384 });
  return `scrypt$16384$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function checkPassword(pw: string, stored: string): boolean {
  const [alg, n, salt, hash] = stored.split("$");
  if (alg !== "scrypt") return false;
  const h = crypto.scryptSync(pw, Buffer.from(salt, "base64"), 32, { N: Number(n) });
  const want = Buffer.from(hash, "base64");
  return h.length === want.length && crypto.timingSafeEqual(h, want);
}

export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** Deterministic JSON (sorted keys) so hashes are reproducible. */
export function canonical(v: any): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  return "{" + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
}

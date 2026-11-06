/**
 * Electronic signature of approvals (Law 3/2014 on electronic transactions).
 *
 * Every approval decision is signed with the acting user's Ed25519 key over
 * a canonical description of what was decided (document, step, decision,
 * amount, currency, who, on whose behalf, when). Anyone with read access can
 * verify the signatures; changing a signed amount or decision afterwards
 * makes the signature fail.
 *
 * DEMO NOTE: keys are generated and held by the server, encrypted with
 * SIGNING_SECRET. In production the private key would live on a smart card or
 * HSM with a certificate from the authority designated under Law 3/2014.
 */
import crypto from "node:crypto";
import { Db, db } from "../../db/index.js";
import { canonical, sha256 } from "../../lib/security.js";

const secretKey = () => crypto.createHash("sha256").update(process.env.SIGNING_SECRET ?? process.env.JWT_SECRET ?? "dev-signing-secret").digest();

function encrypt(pem: string) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", secretKey(), iv);
  const enc = Buffer.concat([c.update(pem, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString("base64")).join(".");
}
function decrypt(blob: string) {
  const [iv, tag, enc] = blob.split(".").map(x => Buffer.from(x, "base64"));
  const d = crypto.createDecipheriv("aes-256-gcm", secretKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}

/** The user's signing key, created on first use. */
export async function keyFor(c: Db, userId: number) {
  const r = (await c.query("SELECT * FROM user_keys WHERE user_id = $1", [userId])).rows[0];
  if (r) return r;
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = publicKey.export({ type: "spki", format: "pem" }).toString();
  const priv = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const fingerprint = sha256(pub).slice(0, 16).toUpperCase();
  await c.query("INSERT INTO user_keys (user_id, public_key, private_key_enc, fingerprint) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id) DO NOTHING",
    [userId, pub, encrypt(priv), fingerprint]);
  return (await c.query("SELECT * FROM user_keys WHERE user_id = $1", [userId])).rows[0];
}

/** What an approval signature covers. Amounts as fixed 2-decimal strings so the payload is exact. */
export function approvalPayload(a: { id: number; document_id: number; document_ref: string; step: string; decision: string; amount: any; currency: string; actor_id: number; on_behalf_of: number | null; reason: string | null; signed_at: string }) {
  return canonical({
    type: "approval", approvalId: a.id, documentId: a.document_id, documentRef: a.document_ref, step: a.step, decision: a.decision,
    amount: a.amount === null || a.amount === undefined ? null : Number(a.amount).toFixed(2), currency: a.currency,
    actorId: a.actor_id, onBehalfOf: a.on_behalf_of ?? null, reason: a.reason ?? null, signedAt: a.signed_at,
  });
}

const APPROVAL_ROW = `SELECT a.id, a.document_id, d.ref AS document_ref, a.step, a.decision, a.amount, d.currency, a.actor_id, a.on_behalf_of, a.reason,
       a.signature, a.signed_at, a.key_fingerprint, u.username
  FROM approvals a JOIN documents d ON d.id = a.document_id JOIN users u ON u.id = a.actor_id`;

const iso = (v: any) => (v instanceof Date ? v.toISOString() : v);

/** Signs an approval row just inserted in this transaction. */
export async function signApproval(c: Db, approvalId: number) {
  const row = (await c.query(`${APPROVAL_ROW} WHERE a.id = $1`, [approvalId])).rows[0];
  const key = await keyFor(c, row.actor_id);
  const signedAt = new Date().toISOString();
  const payload = approvalPayload({ ...row, signed_at: signedAt });
  const signature = crypto.sign(null, Buffer.from(payload), crypto.createPrivateKey(decrypt(key.private_key_enc))).toString("base64");
  await c.query("UPDATE approvals SET signature = $2, signed_at = $3, key_fingerprint = $4 WHERE id = $1", [approvalId, signature, signedAt, key.fingerprint]);
  return { signature, fingerprint: key.fingerprint };
}

/** Signs any other decision (e.g. a virement); returns the signature and the exact payload signed. */
export async function signDecision(c: Db, userId: number, content: Record<string, any>) {
  const key = await keyFor(c, userId);
  const payload = canonical({ ...content, signerId: userId, signedAt: new Date().toISOString() });
  const signature = crypto.sign(null, Buffer.from(payload), crypto.createPrivateKey(decrypt(key.private_key_enc))).toString("base64");
  return { signature, payload, fingerprint: key.fingerprint };
}

export async function verifyDecision(c: Db, userId: number, payload: string, signature: string) {
  const key = (await c.query("SELECT public_key FROM user_keys WHERE user_id = $1", [userId])).rows[0];
  if (!key) return false;
  return crypto.verify(null, Buffer.from(payload), crypto.createPublicKey(key.public_key), Buffer.from(signature, "base64"));
}

async function verifyRows(rows: any[]) {
  const keys = new Map<number, crypto.KeyObject>();
  for (const k of (await db().query("SELECT user_id, public_key FROM user_keys")).rows) keys.set(k.user_id, crypto.createPublicKey(k.public_key));
  return rows.map(r => {
    if (!r.signature) return { id: r.id, step: r.step, decision: r.decision, user: r.username, signed: false, valid: null, fingerprint: null, signedAt: null };
    const pub = keys.get(r.actor_id);
    const payload = approvalPayload({ ...r, signed_at: iso(r.signed_at) });
    const valid = !!pub && crypto.verify(null, Buffer.from(payload), pub, Buffer.from(r.signature, "base64"));
    return { id: r.id, step: r.step, decision: r.decision, user: r.username, signed: true, valid, fingerprint: r.key_fingerprint, signedAt: iso(r.signed_at) };
  });
}

/** Verifies every signature on one document, from the data as it stands now. */
export async function verifyDocumentSignatures(documentId: number) {
  return verifyRows((await db().query(`${APPROVAL_ROW} WHERE a.document_id = $1 ORDER BY a.id`, [documentId])).rows);
}

/** Verifies all approval signatures (auditor's integrity check). */
export async function verifyAllSignatures() {
  const res = await verifyRows((await db().query(`${APPROVAL_ROW} ORDER BY a.id`)).rows);
  const invalid = res.filter(r => r.signed && !r.valid);
  return { total: res.length, signed: res.filter(r => r.signed).length, valid: res.filter(r => r.valid).length, unsigned: res.filter(r => !r.signed).length, invalid: invalid.length, invalidIds: invalid.map(r => r.id) };
}

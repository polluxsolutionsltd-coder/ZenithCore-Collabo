/**
 * Outbound link to the Central Bank of Syria (ISO 20022).
 *
 * Safety rule: after a timeout or connection error the client always asks
 * the bank for the payment's status before sending again, and a resend keeps
 * the same EndToEndId, so a payment can never be made twice.
 */
import crypto from "node:crypto";
import { pacs008, readPacs002, CreditTransfer } from "../../../../cbs-sandbox/src/iso20022.js";

export const cbsUrl = () => process.env.CBS_URL ?? "http://localhost:8090";
const timeoutMs = () => Number(process.env.CBS_TIMEOUT_MS ?? 5000);
export const maxAttempts = () => Number(process.env.CBS_MAX_ATTEMPTS ?? 3);
const backoffMs = () => Number(process.env.CBS_BACKOFF_MS ?? 1000);

export type Outcome =
  | { kind: "final"; status: "ACSC" | "RJCT"; reason: string | null; settledAt: string | null; httpStatus: number; response: string }
  | { kind: "unknown"; error: string; httpStatus: number | null };

async function call(method: string, path: string, body?: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
  const r = await fetch(cbsUrl() + path, { method, body, headers, signal: AbortSignal.timeout(timeoutMs()) });
  return { status: r.status, text: await r.text() };
}

function parse(status: number, text: string): Outcome {
  const s = readPacs002(text);
  if (s.status === "ACSC" || s.status === "RJCT") return { kind: "final", status: s.status, reason: s.reason, settledAt: s.settledAt, httpStatus: status, response: text };
  return { kind: "unknown", error: `Unexpected response (${status})`, httpStatus: status };
}

/** Asks CBS for the status of a payment. null = CBS has never seen it. */
export async function queryStatus(endToEndId: string, correlationId: string): Promise<Outcome | null> {
  try {
    const r = await call("GET", `/iso20022/payments/${encodeURIComponent(endToEndId)}/status`, undefined, { "x-correlation-id": correlationId });
    if (r.status === 404) return null;
    return parse(r.status, r.text);
  } catch (e: any) {
    return { kind: "unknown", error: `Status query failed: ${e?.name === "TimeoutError" ? "timeout" : e?.message ?? e}`, httpStatus: null };
  }
}

/** Sends one attempt. A fresh MsgId per attempt; the EndToEndId never changes. */
export async function sendOnce(t: Omit<CreditTransfer, "msgId">, correlationId: string): Promise<{ outcome: Outcome; request: string }> {
  const request = pacs008({ ...t, msgId: "ZC-" + crypto.randomUUID().replace(/-/g, "").slice(0, 20) });
  try {
    const r = await call("POST", "/iso20022/pacs.008", request, { "content-type": "application/xml", "x-correlation-id": correlationId });
    return { outcome: parse(r.status, r.text), request };
  } catch (e: any) {
    return { outcome: { kind: "unknown", error: e?.name === "TimeoutError" ? `No answer within ${timeoutMs()} ms` : `Connection error: ${e?.cause?.code ?? e?.message ?? e}`, httpStatus: null }, request };
  }
}

export const backoff = (attempt: number) => backoffMs() * 2 ** (attempt - 1);
export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/*
 * Low-connectivity support (D5). Payment requests and receipts captured while
 * the connection is down are queued in the browser with a client reference.
 * When the connection returns they are sent; the server recognises the client
 * reference, so a resend after a dropped answer never creates a duplicate.
 */
import { ApiError, post } from "./api";

export interface QueuedItem { clientRef: string; kind: "document" | "receipt"; path: string; body: any; queuedAt: string; lastError?: string }

const KEY = "zc.outbox";
const listeners = new Set<() => void>();

function read(): QueuedItem[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "[]"); } catch { return []; }
}
function write(items: QueuedItem[]) {
  try { localStorage.setItem(KEY, JSON.stringify(items)); } catch { /* storage full or blocked: items stay in memory for this page */ }
  listeners.forEach(f => f());
}

export const outbox = () => read();
export function onOutboxChange(f: () => void) { listeners.add(f); return () => { listeners.delete(f); }; }

export const newClientRef = () =>
  "zc-" + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

/** A network failure (as opposed to an answer from the server). */
export const isOffline = (e: any) => !navigator.onLine || (e instanceof TypeError) || (e instanceof ApiError && e.status === 0);

/** Sends now if possible; otherwise queues. Returns the server answer, or null when queued. */
export async function sendOrQueue(kind: QueuedItem["kind"], path: string, body: any): Promise<any | null> {
  const item = { ...body, clientRef: body.clientRef ?? newClientRef() };
  if (navigator.onLine) {
    try { return await post(path, item); } catch (e) { if (!isOffline(e)) throw e; }
  }
  write([...read(), { clientRef: item.clientRef, kind, path, body: item, queuedAt: new Date().toISOString() }]);
  return null;
}

let syncing = false;
/** Sends everything queued, oldest first. Items the server rejects stay queued with the reason shown. */
export async function syncOutbox(): Promise<{ sent: number; failed: number }> {
  if (syncing || !navigator.onLine) return { sent: 0, failed: 0 };
  syncing = true;
  let sent = 0, failed = 0;
  try {
    for (const item of read()) {
      try {
        await post(item.path, item.body);
        write(read().filter(x => x.clientRef !== item.clientRef));
        sent++;
      } catch (e: any) {
        if (isOffline(e)) break;
        write(read().map(x => (x.clientRef === item.clientRef ? { ...x, lastError: e.code ?? "error.generic" } : x)));
        failed++;
      }
    }
  } finally { syncing = false; }
  return { sent, failed };
}

export function discard(clientRef: string) { write(read().filter(x => x.clientRef !== clientRef)); }

/** Registers the service worker that keeps the application shell available offline. */
export function registerServiceWorker() {
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js").catch(() => undefined);
  }
  window.addEventListener("online", () => { syncOutbox(); });
}

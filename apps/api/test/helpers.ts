import { AddressInfo } from "node:net";
import http from "node:http";

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://zc:zc@localhost:5432/zenithcore_test";
process.env.JWT_SECRET = "test-secret";
process.env.DEMO_MODE = "1";

export async function startApp() {
  const { seed, SAMPLE_SUPPLIER } = await import("../src/db/seed.js");
  const { createServer } = await import("../src/server.js");
  const { closeDb } = await import("../src/db/index.js");
  await seed({ password: "pw" });
  const server: http.Server = createServer();
  await new Promise<void>(r => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const tokens: Record<string, string> = {};
  async function as(user: string) {
    if (!tokens[user]) {
      const r = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: user, password: "pw" }) });
      if (r.status !== 200) throw new Error(`login ${user} -> ${r.status}`);
      tokens[user] = (await r.json()).token;
    }
    const call = async (method: string, path: string, body?: any) => {
      const r = await fetch(base + path, { method, headers: { "content-type": "application/json", authorization: `Bearer ${tokens[user]}` }, body: body ? JSON.stringify(body) : undefined });
      const text = await r.text();
      return { status: r.status, body: text ? JSON.parse(text) : null };
    };
    return { get: (p: string) => call("GET", p), post: (p: string, b: any = {}) => call("POST", p, b) };
  }

  async function stop() {
    await new Promise<void>(r => server.close(() => r()));
    await closeDb();
  }
  return { base, as, stop, supplier: SAMPLE_SUPPLIER };
}

/** Starts the CBS sandbox on a free port with fast timings and points the API at it. Call before startApp(). */
export async function startCbs() {
  process.env.CBS_TIMEOUT_MS = "300";
  process.env.CBS_BACKOFF_MS = "20";
  process.env.CBS_MAX_ATTEMPTS = "3";
  const { createSandbox } = await import("../../cbs-sandbox/src/sandbox.js");
  const sb = createSandbox({ timeoutDelayMs: 600 });
  await new Promise<void>(r => sb.server.listen(0, r));
  const url = `http://127.0.0.1:${(sb.server.address() as AddressInfo).port}`;
  process.env.CBS_URL = url;
  const ctl = (path: string, body: any = {}) => fetch(url + path, { method: "POST", body: JSON.stringify(body) }).then(r => r.json());
  return {
    url,
    fault: (mode: string, count = 1) => ctl("/sandbox/fault", { mode, count }),
    credit: (amount: number, remittance: string, account = "SY-CBS-TSA-0001") => ctl("/sandbox/credit", { amount, remittance, account }),
    state: () => fetch(url + "/sandbox/state").then(r => r.json()),
    stop: () => new Promise<void>(r => { sb.server.closeAllConnections(); sb.server.close(() => r()); }),
  };
}

/** Takes a new payment request through D1 to AUTHORISED and returns the document view. */
export async function authorised(app: Awaited<ReturnType<typeof startApp>>, amount: number, iban?: string) {
  const su = await app.as("su.health");
  const c = await su.post("/api/documents", { budgetLineId: "0203-01-2221", supplierName: app.supplier.name, supplierIban: iban ?? app.supplier.iban, description: "Medical supplies batch", amount });
  if (c.status !== 200) throw new Error(JSON.stringify(c.body));
  const id = c.body.id;
  await su.post(`/api/documents/${id}/submit`);
  await (await app.as("min.health")).post(`/api/documents/${id}/actions/approve`);
  if (amount >= 500_000) await (await app.as("fc.health")).post(`/api/documents/${id}/actions/grant_visa`);
  await (await app.as("rto.damascus")).post(`/api/documents/${id}/actions/approve`);
  const a = await (await app.as("treasury.hq")).post(`/api/documents/${id}/actions/authorise`);
  if (a.body.status !== "AUTHORISED") throw new Error(JSON.stringify(a.body));
  return (await (await app.as("treasury.hq")).get(`/api/documents/${id}`)).body;
}

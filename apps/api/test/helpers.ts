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

/**
 * Central Bank of Syria – payment sandbox (simulation for testing and demonstration).
 *
 * Accepts pacs.008 credit transfers from the Treasury, answers with pacs.002,
 * publishes pacs.004 returns and camt.053 statements, and lets an operator
 * inject faults (timeout, rejection, return) from /sandbox.
 */
import http from "node:http";
import crypto from "node:crypto";
import { camt053, ibanValid, pacs002, pacs004, readPacs008, StatementEntry } from "./iso20022.js";

type Fault = "none" | "timeout" | "reject" | "return";
interface Payment { msgId: string; endToEndId: string; amount: number; currency: string; account: string; creditorIban: string; creditorName: string; status: "ACSC" | "RJCT"; reason?: string; settledAt?: string; bookingDate?: string }
interface Return { seq: number; endToEndId: string; amount: number; currency: string; reason: string; at: string; account: string }
interface Credit { id: string; account: string; amount: number; remittance: string; bookingDate: string }

export interface SandboxOptions { timeoutDelayMs?: number; openingBalance?: number }

export function createSandbox(opts: SandboxOptions = {}) {
  const delay = opts.timeoutDelayMs ?? Number(process.env.SANDBOX_TIMEOUT_DELAY_MS ?? 8000);
  let state = fresh();
  function fresh() {
    return {
      payments: new Map<string, Payment>(),
      msgIds: new Set<string>(),
      returns: [] as Return[],
      credits: [] as Credit[],
      fault: { mode: "none" as Fault, remaining: 0 },
      log: [] as Array<{ at: string; event: string; ref: string; detail: string }>,
      opening: opts.openingBalance ?? 500_000_000,
    };
  }
  const log = (event: string, ref: string, detail = "") => {
    state.log.unshift({ at: new Date().toISOString(), event, ref, detail });
    state.log = state.log.slice(0, 200);
  };
  const takeFault = (): Fault => {
    if (state.fault.mode === "none" || state.fault.remaining <= 0) return "none";
    state.fault.remaining--;
    const m = state.fault.mode;
    if (state.fault.remaining === 0) state.fault.mode = "none";
    return m;
  };
  const statusXml = (p: Payment) => pacs002({ msgId: "CBS-" + crypto.randomUUID().slice(0, 12), originalMsgId: p.msgId, endToEndId: p.endToEndId, status: p.status, reason: p.reason, settledAt: p.settledAt });
  const today = () => new Date().toISOString().slice(0, 10);

  async function onTransfer(body: string, res: http.ServerResponse) {
    const t = readPacs008(body);
    if (!t) { res.writeHead(400, { "content-type": "text/plain" }); return res.end("Malformed pacs.008"); }
    if (state.msgIds.has(t.msgId)) {
      log("duplicate_message", t.endToEndId, t.msgId);
      res.writeHead(409, { "content-type": "application/xml" });
      return res.end(pacs002({ msgId: "CBS-DUP", originalMsgId: t.msgId, endToEndId: t.endToEndId, status: "RJCT", reason: "DUPL" }));
    }
    state.msgIds.add(t.msgId);
    const existing = state.payments.get(t.endToEndId);
    if (existing && existing.status === "ACSC") {
      log("duplicate_payment_blocked", t.endToEndId, "already settled");
      res.writeHead(200, { "content-type": "application/xml" });
      return res.end(pacs002({ msgId: "CBS-DUP", originalMsgId: t.msgId, endToEndId: t.endToEndId, status: "RJCT", reason: "AM05" }));
    }
    const fault = takeFault();
    const p: Payment = { msgId: t.msgId, endToEndId: t.endToEndId, amount: t.amount, currency: t.currency, account: t.debtorAccount, creditorIban: t.creditorIban, creditorName: t.creditorName, status: "ACSC" };
    if (t.currency !== "SYP") { p.status = "RJCT"; p.reason = "AM03"; }
    else if (!ibanValid(t.creditorIban)) { p.status = "RJCT"; p.reason = "AC01"; }
    else if (fault === "reject") { p.status = "RJCT"; p.reason = "AC04"; }
    if (p.status === "ACSC") { p.settledAt = new Date().toISOString(); p.bookingDate = today(); }
    state.payments.set(t.endToEndId, p);
    log(p.status === "ACSC" ? "settled" : "rejected", t.endToEndId, p.reason ?? `${t.amount} ${t.currency}`);
    if (fault === "return" && p.status === "ACSC") {
      state.returns.push({ seq: state.returns.length + 1, endToEndId: p.endToEndId, amount: p.amount, currency: p.currency, reason: "AC03", at: new Date().toISOString(), account: p.account });
      log("return_scheduled", t.endToEndId, "AC03 invalid creditor account");
    }
    if (fault === "timeout") {
      log("timeout_injected", t.endToEndId, `answer delayed ${delay} ms (payment was settled)`);
      await new Promise(r => setTimeout(r, delay));
    }
    if (res.destroyed) return;
    res.writeHead(200, { "content-type": "application/xml" });
    res.end(statusXml(p));
  }

  function statement(account: string, date: string) {
    const entries: StatementEntry[] = [];
    for (const p of state.payments.values()) {
      if (p.status === "ACSC" && p.account === account && p.bookingDate === date) entries.push({ amount: p.amount, currency: p.currency, direction: "DBIT", bookingDate: date, endToEndId: p.endToEndId, remittance: p.creditorName });
    }
    for (const r of state.returns) {
      if (r.account === account && r.at.slice(0, 10) === date) entries.push({ amount: r.amount, currency: r.currency, direction: "CRDT", bookingDate: date, endToEndId: r.endToEndId, remittance: `RETURN ${r.reason}` });
    }
    for (const c of state.credits) {
      if (c.account === account && c.bookingDate === date) entries.push({ amount: c.amount, currency: "SYP", direction: "CRDT", bookingDate: date, remittance: c.remittance });
    }
    const net = entries.reduce((s, e) => s + (e.direction === "CRDT" ? e.amount : -e.amount), 0);
    return camt053({ msgId: "CBS-STMT-" + crypto.randomUUID().slice(0, 8), statementId: `${account}-${date}`, account, date, opening: state.opening, closing: state.opening + net, entries });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const json = (s: number, o: any) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    try {
      if (req.method === "POST" && url.pathname === "/iso20022/pacs.008") return await onTransfer(body, res);
      let m = /^\/iso20022\/payments\/([^/]+)\/status$/.exec(url.pathname);
      if (req.method === "GET" && m) {
        const p = state.payments.get(decodeURIComponent(m[1]));
        if (!p) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("Unknown EndToEndId"); }
        res.writeHead(200, { "content-type": "application/xml" }); return res.end(statusXml(p));
      }
      if (req.method === "GET" && url.pathname === "/iso20022/pacs.004") {
        const after = Number(url.searchParams.get("after") ?? 0);
        res.writeHead(200, { "content-type": "application/xml" });
        return res.end(pacs004("CBS-RTR-" + Date.now(), state.returns.filter(r => r.seq > after)));
      }
      if (req.method === "GET" && url.pathname === "/iso20022/camt.053") {
        res.writeHead(200, { "content-type": "application/xml" });
        return res.end(statement(url.searchParams.get("account") ?? "", url.searchParams.get("date") ?? today()));
      }
      // operator controls
      if (req.method === "POST" && url.pathname === "/sandbox/fault") {
        const o = JSON.parse(body || "{}");
        if (!["none", "timeout", "reject", "return"].includes(o.mode)) return json(400, { error: "mode must be none|timeout|reject|return" });
        state.fault = { mode: o.mode, remaining: o.mode === "none" ? 0 : Number(o.count ?? 1) };
        log("fault_set", o.mode, `next ${state.fault.remaining} transfer(s)`);
        return json(200, state.fault);
      }
      if (req.method === "POST" && url.pathname === "/sandbox/credit") {
        const o = JSON.parse(body || "{}");
        const c: Credit = { id: crypto.randomUUID(), account: o.account ?? "SY-CBS-TSA-0001", amount: Number(o.amount), remittance: o.remittance ?? "Revenue collection", bookingDate: today() };
        state.credits.push(c); log("credit", c.account, `${c.amount} ${c.remittance}`);
        return json(200, c);
      }
      if (req.method === "POST" && url.pathname === "/sandbox/reset") { state = fresh(); return json(200, { ok: true }); }
      if (req.method === "GET" && url.pathname === "/sandbox/state") {
        return json(200, { fault: state.fault, payments: [...state.payments.values()], returns: state.returns, credits: state.credits, log: state.log });
      }
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/sandbox")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(CONTROL_PAGE);
      }
      json(404, { error: "not_found" });
    } catch (e: any) {
      json(500, { error: String(e?.message ?? e) });
    }
  });
  return { server, reset: () => { state = fresh(); } };
}

const CONTROL_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CBS Sandbox</title>
<style>body{font:14px system-ui,sans-serif;margin:0;background:#F2F5FA;color:#1E2E4F}main{max-width:980px;margin:0 auto;padding:16px;display:grid;gap:14px}
.p{background:#fff;border:1px solid #D3DCEA;border-radius:10px;padding:14px}button{border:1px solid #D3DCEA;background:#fff;border-radius:8px;padding:8px 12px;cursor:pointer;font-weight:600;margin:2px}
button.on{background:#167783;color:#fff;border-color:#167783}table{width:100%;border-collapse:collapse;font-size:13px}td,th{text-align:left;padding:6px;border-bottom:1px solid #E7EDF5}
h1{font-size:18px;margin:0}small{color:#56678A}</style></head><body><main>
<div class="p"><h1>Central Bank of Syria – payment sandbox</h1><small>Simulation for testing and demonstration only. ISO 20022 pacs.008 / pacs.002 / pacs.004 / camt.053.</small></div>
<div class="p"><b>Fault for the next transfer:</b><br><span id="f"></span></div>
<div class="p"><b>Payments</b><table id="pay"></table></div><div class="p"><b>Event log</b><table id="log"></table></div></main>
<script>
const modes=["none","timeout","reject","return"];
async function setF(m){await fetch("/sandbox/fault",{method:"POST",body:JSON.stringify({mode:m,count:1})});load()}
async function load(){const s=await (await fetch("/sandbox/state")).json();
document.getElementById("f").innerHTML=modes.map(m=>'<button class="'+(s.fault.mode===m?"on":"")+'" onclick="setF(\\''+m+'\\')">'+m+'</button>').join("");
document.getElementById("pay").innerHTML="<tr><th>EndToEndId</th><th>Amount</th><th>Status</th><th>Reason</th></tr>"+s.payments.map(p=>"<tr><td>"+p.endToEndId+"</td><td>"+p.amount.toLocaleString()+" "+p.currency+"</td><td>"+p.status+"</td><td>"+(p.reason||"")+"</td></tr>").join("");
document.getElementById("log").innerHTML=s.log.slice(0,30).map(l=>"<tr><td>"+l.at.slice(11,19)+"</td><td>"+l.event+"</td><td>"+l.ref+"</td><td>"+l.detail+"</td></tr>").join("")}
load();setInterval(load,2000);
</script></body></html>`;

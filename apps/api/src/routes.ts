import { Router, badRequest, forbidden, send } from "./lib/http.js";
import { tx } from "./db/index.js";
import { demoUsers, profile } from "./modules/auth/auth.service.js";
import { listLines } from "./modules/budget/budget.service.js";
import { actOnDocument, amendDocument, createDocument, getDocument, listDocuments, submitDocument, Action } from "./modules/documents/documents.service.js";
import { listNotifications, markRead } from "./modules/notifications/notifications.service.js";
import { listAudit, verifyChain } from "./modules/audit/audit.service.js";
import { listRules, setRule, RULE_KEYS } from "./modules/rules/rules.service.js";
import { computeIndicators } from "./modules/indicators/indicators.service.js";
import { clientFromKey, getMessage, idempotentInbound, listMessages, summary } from "./modules/integration/gateway.service.js";
import { ingestPersonnel, payrollMatch } from "./modules/moad/moad.service.js";
import { getPaymentOrder, listPaymentOrders, pollReturns, reissuePaymentOrder, sendPaymentOrder } from "./modules/payments/payments.service.js";
import { completeReconciliation, explainLine, getReconciliation, importStatement, listBankAccounts, quarterOf } from "./modules/reconciliation/reconciliation.service.js";
import { cbsUrl } from "./modules/payments/cbs.client.js";

import { changePassword, createUser, listOrgs, listUsers, login, updateUser } from "./modules/users/users.service.js";
import { createDelegation, listDelegations, revokeDelegation } from "./modules/delegation/delegation.service.js";
import { auditSearch, budgetExecution, exceptions, paymentsReport, toCsv } from "./modules/reports/reports.service.js";
import { cancelReceipt, issueReceipt, listReceipts, revenueSharing, revenueCodes, verifyReceipt } from "./modules/receipts/receipts.service.js";
import { answerTicket, listTickets, publicBudget, publicRateLimit, questionStatus, submitQuestion } from "./modules/helpdesk/helpdesk.service.js";
import { approveRun, calculateRun, getRun, listEmployees, listRuns, recordBiometric } from "./modules/payroll/payroll.service.js";
import { deepHealth, metrics } from "./modules/ops/ops.service.js";
import { decideVirement, listVirements, requestVirement } from "./modules/virements/virements.service.js";
import { verifyAllSignatures, verifyDocumentSignatures } from "./modules/esign/esign.service.js";
import { rateTable, redenomination } from "./modules/currency/currency.service.js";
import { load } from "./modules/loaders/loaders.service.js";
import http from "node:http";

const MONITOR = ["ADMIN", "AUDITOR", "TREASURY_HQ"];
const clientIp = (req: http.IncomingMessage) =>
  (process.env.TRUST_PROXY === "1" ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() : "") || req.socket.remoteAddress || "?";
/** Sends rows as JSON, or as a CSV download when ?format=csv. */
function maybeCsv(ctx: any, rows: any[], name: string, columns: string[]) {
  if (ctx.query.get("format") !== "csv") return rows;
  ctx.res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}.csv"` });
  ctx.res.end(toCsv(rows, columns));
}

const ACTIONS: Action[] = ["approve", "reject", "grant_visa", "refuse_visa", "authorise"];
const id = (s: string) => { const n = Number(s); if (!Number.isInteger(n) || n <= 0) throw badRequest("request.invalid_id"); return n; };

export function buildRoutes(): Router {
  const r = new Router();

  r.get("/api/health", () => ({ ok: true, product: "ZenithCore FMIS", version: process.env.npm_package_version ?? "4.0.0-dev" }), { auth: false });

  // Auth
  r.post("/api/auth/login", ctx => login(ctx.body.username, ctx.body.password), { auth: false });
  r.get("/api/me", ctx => profile(ctx.user!.id));
  r.get("/api/demo-users", () => {
    if (process.env.DEMO_MODE !== "1") throw forbidden();
    return demoUsers();
  }, { auth: false });

  // Budget
  r.get("/api/budget-lines", ctx => listLines(ctx.user!));

  // Payment requests (D1)
  r.get("/api/documents", ctx => listDocuments(ctx.user!, ctx.query.get("scope") ?? "all"));
  r.post("/api/documents", ctx => createDocument(ctx.user!, ctx.body));
  r.get("/api/documents/:id", ctx => getDocument(ctx.user!, id(ctx.params.id)));
  r.post("/api/documents/:id/submit", ctx => submitDocument(ctx.user!, id(ctx.params.id), ctx.body.version));
  r.post("/api/documents/:id/amend", ctx => amendDocument(ctx.user!, id(ctx.params.id), ctx.body));
  r.post("/api/documents/:id/actions/:action", ctx => {
    const action = ctx.params.action as Action;
    if (!ACTIONS.includes(action)) throw badRequest("document.unknown_action");
    return actOnDocument(ctx.user!, id(ctx.params.id), action, ctx.body);
  });

  // Notifications
  r.get("/api/notifications", ctx => listNotifications(ctx.user!));
  r.post("/api/notifications/:id/read", async ctx => { await markRead(ctx.user!, id(ctx.params.id)); return { ok: true }; });

  // Audit (auditors and admins see all; others see the trail of a document they can open)
  r.get("/api/audit", async ctx => {
    const u = ctx.user!;
    const entity = ctx.query.get("entity") ?? undefined, entityId = ctx.query.get("entityId") ?? undefined;
    if (!["AUDITOR", "ADMIN"].includes(u.role)) {
      if (entity !== "document" || !entityId) throw forbidden();
      await getDocument(u, id(entityId)); // throws if not visible
    }
    return listAudit(entity, entityId);
  });
  r.get("/api/audit/verify", () => verifyChain(), { roles: ["AUDITOR", "ADMIN"] });

  // Syria-specific: electronic signatures (Law 3/2014), virements (Decree 54/2006), currencies, legacy data in old pounds
  r.get("/api/signatures/verify", () => verifyAllSignatures(), { roles: ["AUDITOR", "ADMIN"] });
  r.get("/api/documents/:id/signatures", async ctx => { await getDocument(ctx.user!, id(ctx.params.id)); return verifyDocumentSignatures(id(ctx.params.id)); });
  r.get("/api/virements", ctx => listVirements(ctx.user!));
  r.post("/api/virements", ctx => requestVirement(ctx.user!, ctx.body));
  r.post("/api/virements/:id/decision", ctx => decideVirement(ctx.user!, id(ctx.params.id), ctx.body));
  r.get("/api/currency", async () => ({ redenomination: await redenomination(), rates: await rateTable() }));
  r.post("/api/loaders/:kind", ctx => {
    if (!["budget", "employees"].includes(ctx.params.kind)) throw badRequest("load.unknown_kind");
    if (typeof ctx.body.csv !== "string" || ctx.body.csv.length > 5_000_000) throw badRequest("load.csv_required");
    return load(ctx.params.kind as any, ctx.body.csv, { commit: !!ctx.body.commit, oldPounds: !!ctx.body.oldPounds, actor: ctx.user!.username });
  }, { roles: ["ADMIN"] });

  // Rules (configuration)
  r.get("/api/rules", async () => ({ keys: Object.fromEntries(Object.entries(RULE_KEYS).map(([k, v]) => [k, v.describe])), rules: await listRules() }));
  r.post("/api/rules", ctx => tx(c => setRule(c, ctx.user!.username, ctx.body)), { roles: ["ADMIN"] });

  // D2 – inbound partner API (API key + Idempotency-Key + correlation ID; no user session)
  r.post("/api/v1/moad/personnel", async ctx => {
    const client = await clientFromKey(ctx.req, "moad.personnel.write");
    const out = await idempotentInbound({
      client, msgType: "moad.personnel", key: ctx.req.headers["idempotency-key"] as string | undefined, body: ctx.body,
      correlationId: ctx.correlationId, res: ctx.res, run: () => ingestPersonnel(client.id, ctx.correlationId, ctx.body),
    });
    send(ctx.res, out.status, out.body);
  }, { auth: false });

  // D2 – monitoring console
  r.get("/api/integration/messages", ctx => listMessages({
    status: ctx.query.get("status") ?? undefined, partner: ctx.query.get("partner") ?? undefined,
    direction: ctx.query.get("direction") ?? undefined, correlationId: ctx.query.get("correlationId") ?? undefined,
  }), { roles: MONITOR });
  r.get("/api/integration/messages/:id", ctx => getMessage(id(ctx.params.id)), { roles: MONITOR });
  r.get("/api/integration/summary", () => summary(), { roles: MONITOR });
  r.post("/api/integration/messages/:id/retry", async ctx => {
    const m = await getMessage(id(ctx.params.id));
    if (m.status !== "DEAD_LETTER" || m.msg_type !== "pacs.008") throw badRequest("integration.not_retryable");
    const po = (await listPaymentOrders(ctx.user!)).find((p: any) => p.ref === m.business_ref);
    if (!po) throw badRequest("integration.not_retryable");
    return sendPaymentOrder(ctx.user!, po.id, ctx.correlationId);
  }, { roles: ["ADMIN", "TREASURY_HQ"] });
  r.get("/api/moad/match", () => payrollMatch(), { roles: ["ADMIN", "AUDITOR", "TREASURY_HQ"] });
  r.get("/api/config", () => ({ demoMode: process.env.DEMO_MODE === "1", cbsSandboxUrl: process.env.DEMO_MODE === "1" ? (process.env.CBS_PUBLIC_URL ?? cbsUrl()) + "/sandbox" : null }));

  // D3 – payment execution and reconciliation
  r.get("/api/payment-orders", ctx => listPaymentOrders(ctx.user!, ctx.query.get("status") ?? undefined));
  r.get("/api/payment-orders/:id", ctx => getPaymentOrder(ctx.user!, id(ctx.params.id)));
  r.post("/api/payment-orders/:id/send", ctx => sendPaymentOrder(ctx.user!, id(ctx.params.id), ctx.correlationId));
  r.post("/api/payment-orders/:id/reissue", ctx => reissuePaymentOrder(ctx.user!, id(ctx.params.id), ctx.body));
  r.post("/api/payments/poll-returns", ctx => pollReturns(ctx.user!.username, ctx.correlationId), { roles: ["ADMIN", "TREASURY_HQ"] });
  r.get("/api/bank-accounts", () => listBankAccounts(), { roles: ["ADMIN", "AUDITOR", "TREASURY_HQ", "REGIONAL_TREASURY"] });
  r.post("/api/reconciliation/import", ctx => importStatement(ctx.user!, ctx.body, ctx.correlationId));
  r.get("/api/reconciliation", ctx => getReconciliation(ctx.user!, ctx.query.get("accountId") ?? "", ctx.query.get("period") ?? quarterOf(new Date().toISOString().slice(0, 10)).period));
  r.post("/api/reconciliation/lines/:id/explain", ctx => explainLine(ctx.user!, id(ctx.params.id), ctx.body.note));
  r.post("/api/reconciliation/complete", ctx => completeReconciliation(ctx.user!, ctx.body.accountId, ctx.body.period));

  // D4 – users, roles and delegation
  r.post("/api/me/password", ctx => changePassword(ctx.user!, ctx.body.current, ctx.body.next));
  r.get("/api/users", () => listUsers(), { roles: ["ADMIN", "AUDITOR"] });
  r.get("/api/orgs", () => listOrgs(), { roles: ["ADMIN", "AUDITOR"] });
  r.post("/api/users", ctx => createUser(ctx.user!, ctx.body), { roles: ["ADMIN"] });
  r.post("/api/users/:id", ctx => updateUser(ctx.user!, id(ctx.params.id), ctx.body), { roles: ["ADMIN"] });
  r.get("/api/delegations", ctx => listDelegations(ctx.user!));
  r.post("/api/delegations", ctx => createDelegation(ctx.user!, ctx.body));
  r.post("/api/delegations/:id/revoke", ctx => revokeDelegation(ctx.user!, id(ctx.params.id)));

  // D4 – reports and the auditor's workspace
  r.get("/api/reports/budget-execution", async ctx => maybeCsv(ctx, await budgetExecution(ctx.user!), "budget-execution",
    ["line", "ministry_id", "spending_unit_id", "economic", "programme", "name_en", "name_ar", "allotment", "in_approval", "authorised", "paid", "available", "execution"]));
  r.get("/api/reports/payments", async ctx => {
    const today = new Date().toISOString().slice(0, 10);
    return maybeCsv(ctx, await paymentsReport(ctx.user!, ctx.query.get("from") ?? `${today.slice(0, 4)}-01-01`, ctx.query.get("to") ?? today), "payments",
      ["ref", "request", "spending_unit_id", "budget_line_id", "beneficiary_name", "beneficiary_iban", "amount", "status", "cbs_status", "cbs_reason", "end_to_end_id", "created_at", "settled_at", "returned_at"]);
  });
  r.get("/api/audit/search", async ctx => maybeCsv(ctx, await auditSearch({
    actor: ctx.query.get("actor") ?? undefined, action: ctx.query.get("action") ?? undefined, entity: ctx.query.get("entity") ?? undefined,
    from: ctx.query.get("from") ?? undefined, to: ctx.query.get("to") ?? undefined,
  }), "audit-trail", ["id", "ts", "actor", "action", "entity", "entity_id", "data", "hash"]), { roles: ["AUDITOR", "ADMIN"] });
  r.get("/api/audit/exceptions", () => exceptions(), { roles: ["AUDITOR", "ADMIN"] });

  // Official receipts
  r.get("/api/revenue-codes", () => revenueCodes());
  r.get("/api/receipts/sharing", ctx => revenueSharing(ctx.user!));
  r.get("/api/receipts", ctx => listReceipts(ctx.user!));
  r.post("/api/receipts", ctx => issueReceipt(ctx.user!, ctx.body));
  r.post("/api/receipts/:id/cancel", ctx => cancelReceipt(ctx.user!, id(ctx.params.id), ctx.body.reason));

  // Citizen's Budget Helpdesk – staff side
  r.get("/api/helpdesk/tickets", ctx => listTickets(ctx.user!, ctx.query.get("status") ?? undefined));
  r.post("/api/helpdesk/tickets/:id/answer", ctx => answerTicket(ctx.user!, id(ctx.params.id), ctx.body.answer));

  // Public portal (no sign-in): budget data, helpdesk, receipt verification
  r.get("/api/public/budget", () => publicBudget(), { auth: false });
  r.post("/api/public/helpdesk", ctx => { publicRateLimit(clientIp(ctx.req)); return submitQuestion(ctx.body); }, { auth: false });
  r.post("/api/public/helpdesk/status", ctx => { publicRateLimit("status:" + clientIp(ctx.req), 60); return questionStatus(ctx.body.ref, ctx.body.accessCode); }, { auth: false });
  r.post("/api/public/receipts/verify", ctx => { publicRateLimit("verify:" + clientIp(ctx.req), 60); return verifyReceipt(ctx.body.ref, ctx.body.code); }, { auth: false });

  // Payroll (lean) and biometric enrolment
  r.get("/api/payroll/runs", ctx => listRuns(ctx.user!));
  r.post("/api/payroll/runs", ctx => calculateRun(ctx.user!, ctx.body));
  r.get("/api/payroll/runs/:id", ctx => getRun(ctx.user!, id(ctx.params.id)));
  r.post("/api/payroll/runs/:id/approve", ctx => approveRun(ctx.user!, id(ctx.params.id)));
  r.get("/api/payroll/employees", ctx => listEmployees(ctx.user!));
  r.post("/api/payroll/employees/:no/biometric", ctx => recordBiometric(ctx.user!, ctx.params.no, ctx.body));

  // D5 – operations
  r.get("/api/health/deep", async ctx => {
    const h = await deepHealth();
    if (!h.ready) ctx.res.statusCode = 503;
    send(ctx.res, h.ready ? 200 : 503, h);
  }, { auth: false });
  r.get("/api/metrics", async ctx => {
    const token = process.env.METRICS_TOKEN;
    if (token && ctx.req.headers.authorization !== `Bearer ${token}`) throw forbidden();
    if (!token && process.env.NODE_ENV === "production") throw forbidden();
    ctx.res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
    ctx.res.end(await metrics());
  }, { auth: false });

  // Results indicators
  r.get("/api/indicators", () => computeIndicators());

  return r;
}

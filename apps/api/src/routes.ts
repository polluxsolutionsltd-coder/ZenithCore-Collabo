import { Router, badRequest, forbidden, send } from "./lib/http.js";
import { tx } from "./db/index.js";
import { demoUsers, login, profile } from "./modules/auth/auth.service.js";
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

const MONITOR = ["ADMIN", "AUDITOR", "TREASURY_HQ"];

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

  // Results indicators
  r.get("/api/indicators", () => computeIndicators());

  return r;
}

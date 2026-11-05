import { Router, badRequest, forbidden } from "./lib/http.js";
import { tx } from "./db/index.js";
import { demoUsers, login, profile } from "./modules/auth/auth.service.js";
import { listLines } from "./modules/budget/budget.service.js";
import { actOnDocument, amendDocument, createDocument, getDocument, listDocuments, submitDocument, Action } from "./modules/documents/documents.service.js";
import { listNotifications, markRead } from "./modules/notifications/notifications.service.js";
import { listAudit, verifyChain } from "./modules/audit/audit.service.js";
import { listRules, setRule, RULE_KEYS } from "./modules/rules/rules.service.js";
import { computeIndicators } from "./modules/indicators/indicators.service.js";

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

  // Results indicators
  r.get("/api/indicators", () => computeIndicators());

  return r;
}

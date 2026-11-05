import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppError, Ctx, readJson, send, newCorrelationId, forbidden, unauthorized } from "./lib/http.js";
import { userFromToken } from "./modules/auth/auth.service.js";
import { buildRoutes } from "./routes.js";
import { recordRequest } from "./modules/ops/ops.service.js";
import { db } from "./db/index.js";

const WEB_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string) {
  let file = path.join(WEB_DIST, decodeURIComponent(pathname));
  if (!file.startsWith(WEB_DIST)) { res.writeHead(400); return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(WEB_DIST, "index.html");
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end("Web app not built. Run: npm run build:web"); }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "x-content-type-options": "nosniff" });
  fs.createReadStream(file).pipe(res);
}

export function createServer() {
  const router = buildRoutes();
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const correlationId = (req.headers["x-correlation-id"] as string) || newCorrelationId();
    res.setHeader("x-correlation-id", correlationId);
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader("content-security-policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if (process.env.HSTS === "1") res.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
    if (!url.pathname.startsWith("/api/")) return serveStatic(req, res, url.pathname);

    const started = Date.now();
    try {
      const hit = router.match(req.method ?? "GET", url.pathname);
      if (!hit) return send(res, 404, { error: "not_found" });
      const ctx: Ctx = { req, res, params: hit.params, query: url.searchParams, body: {}, correlationId };
      if (req.method === "POST" || req.method === "PUT") ctx.body = await readJson(req);
      ctx.user = userFromToken(req.headers.authorization);
      if (ctx.user) { // a deactivated account or a changed role ends existing sessions
        const live = (await db().query("SELECT active, role, org_id FROM users WHERE id = $1", [ctx.user.id])).rows[0];
        if (!live?.active || live.role !== ctx.user.role || live.org_id !== ctx.user.orgId) ctx.user = undefined;
      }
      if (hit.route.auth && !ctx.user) throw unauthorized();
      if (hit.route.roles && !hit.route.roles.includes(ctx.user!.role)) throw forbidden();
      const out = await hit.route.handler(ctx);
      if (!res.headersSent) send(res, 200, out ?? { ok: true });
    } catch (e: any) {
      if (e instanceof AppError) send(res, e.status, { error: e.code, details: e.details });
      else { console.error(`[${correlationId}]`, e); send(res, 500, { error: "server.error", correlationId }); }
    } finally {
      recordRequest(req.method ?? "GET", res.statusCode, Date.now() - started);
      if (process.env.LOG_REQUESTS === "1") console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms ${correlationId}`);
    }
  });
}

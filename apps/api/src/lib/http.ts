import http from "node:http";
import crypto from "node:crypto";

/** Error carrying an HTTP status and a stable, translatable code. */
export class AppError extends Error {
  constructor(public status: number, public code: string, message?: string, public details?: any) {
    super(message ?? code);
  }
}
export const badRequest = (code: string, details?: any) => new AppError(400, code, code, details);
export const unauthorized = (code = "auth.required") => new AppError(401, code);
export const forbidden = (code = "auth.forbidden") => new AppError(403, code);
export const notFound = (code = "not_found") => new AppError(404, code);
export const conflict = (code: string, details?: any) => new AppError(409, code, code, details);

export interface AuthUser {
  id: number;
  username: string;
  role: string;
  orgId: string;
  name: string;
}

export interface Ctx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: any;
  user?: AuthUser;
  correlationId: string;
}

export type Handler = (ctx: Ctx) => Promise<any> | any;

type Route = { method: string; pattern: RegExp; keys: string[]; handler: Handler; auth: boolean; roles?: string[] };

/** Tiny router: `/api/documents/:id` style paths, optional auth and role checks. */
export class Router {
  routes: Route[] = [];

  add(method: string, path: string, handler: Handler, opts: { auth?: boolean; roles?: string[] } = {}) {
    const keys: string[] = [];
    const pattern = new RegExp("^" + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "$");
    this.routes.push({ method, pattern, keys, handler, auth: opts.auth ?? true, roles: opts.roles });
  }
  get(p: string, h: Handler, o?: { auth?: boolean; roles?: string[] }) { this.add("GET", p, h, o); }
  post(p: string, h: Handler, o?: { auth?: boolean; roles?: string[] }) { this.add("POST", p, h, o); }
  put(p: string, h: Handler, o?: { auth?: boolean; roles?: string[] }) { this.add("PUT", p, h, o); }

  match(method: string, path: string) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.pattern.exec(path);
      if (m) return { route: r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
    }
    return null;
  }
}

export async function readJson(req: http.IncomingMessage, limit = 2_000_000): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new AppError(413, "request.too_large");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw badRequest("request.invalid_json"); }
}

export function send(res: http.ServerResponse, status: number, body: any, headers: Record<string, string> = {}) {
  const data = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(data);
}

export const newCorrelationId = () => crypto.randomUUID();

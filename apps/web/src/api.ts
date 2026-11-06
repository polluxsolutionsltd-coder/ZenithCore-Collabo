/* Thin API client. Errors carry the server's stable code so the UI can translate them. */
export class ApiError extends Error {
  constructor(public status: number, public code: string, public details?: any, public correlationId?: string) { super(code); }
}

const TOKEN_KEY = "zc.token";
export const session: { token: string | null; mustChange: boolean } = {
  get token() { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set token(v: string | null) { try { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } },
  /** set after signing in with a temporary password, until it is changed */
  get mustChange() { try { return localStorage.getItem("zc.mustChange") === "1"; } catch { return false; } },
  set mustChange(v: boolean) { try { v ? localStorage.setItem("zc.mustChange", "1") : localStorage.removeItem("zc.mustChange"); } catch { /* ignore */ } },
};

export async function api<T = any>(method: string, path: string, body?: any): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (session.token) headers.authorization = `Bearer ${session.token}`;
  const r = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) {
    if (r.status === 401) { session.token = null; window.dispatchEvent(new Event("zc:logout")); }
    throw new ApiError(r.status, data?.error ?? "error.generic", data?.details, r.headers.get("x-correlation-id") ?? undefined);
  }
  return data as T;
}

export const get = <T = any>(p: string) => api<T>("GET", p);
export const post = <T = any>(p: string, b: any = {}) => api<T>("POST", p, b);

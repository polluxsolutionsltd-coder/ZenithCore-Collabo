import React, { useState } from "react";
import { SignatureSweep } from "./Syria";
import { get, post, session } from "../api";
import { useI18n } from "../i18n";
import { ErrorNote, Field, Loading, useAsync } from "../components/common";

const today = () => new Date().toISOString().slice(0, 10);

/** Downloads an authenticated CSV export. */
export async function downloadCsv(path: string, name: string) {
  const r = await fetch(path + (path.includes("?") ? "&" : "?") + "format=csv", { headers: { authorization: `Bearer ${session.token}` } });
  if (!r.ok) throw new Error(String(r.status));
  const url = URL.createObjectURL(await r.blob());
  const a = Object.assign(document.createElement("a"), { href: url, download: `${name}-${today()}.csv` });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------------- Workflow route (D4) ---------------- */
export function WorkflowCard({ canEdit, onSaved }: { canEdit: boolean; onSaved: () => void }) {
  const { t } = useI18n();
  const [ministry, setMinistry] = useState("MIN-0203");
  const [steps, setSteps] = useState<string[]>(["MINISTRY", "VISA", "RTO", "HQ"]);
  const [from, setFrom] = useState(today());
  const [note, setNote] = useState("");
  const [error, setError] = useState<any>(null);
  const [ok, setOk] = useState(false);
  const toggle = (s: string) => setSteps(steps.includes(s) ? steps.filter(x => x !== s) : ["MINISTRY", "VISA", "RTO", "HQ"].filter(x => x === s || steps.includes(x)));
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null); setOk(false);
    try { await post("/api/rules", { key: "WORKFLOW_ROUTE", scope: ministry, value: { steps }, effectiveFrom: from, note }); setOk(true); onSaved(); } catch (err) { setError(err); }
  };
  return (
    <div className="panel stack">
      <div className="eyebrow">{t("wf.title")}</div>
      <p className="muted">{t("wf.help")}</p>
      <form className="stack" onSubmit={save}>
        <div className="ctrl">
          <select aria-label={t("field.ministry")} value={ministry} onChange={e => setMinistry(e.target.value)} disabled={!canEdit}>
            <option value="MIN-0203">MIN-0203</option><option value="MIN-0410">MIN-0410</option>
          </select>
        </div>
        <ol className="wf-steps">
          {["MINISTRY", "VISA", "RTO", "HQ"].map((s, i) => (
            <li key={s}>
              <label><input type="checkbox" checked={steps.includes(s)} disabled={!canEdit || s === "HQ"} onChange={() => toggle(s)} /> {i + 1}. {t(`step.${s}`)}</label>
            </li>
          ))}
        </ol>
        {canEdit && <>
          <div className="ctrl">
            <Field label={t("rules.from")}><input type="date" value={from} onChange={e => setFrom(e.target.value)} /></Field>
            <Field label={t("wf.note")}><input value={note} onChange={e => setNote(e.target.value)} /></Field>
          </div>
          <div className="ctrl"><button className="btn primary">{t("common.save")}</button></div>
        </>}
        {ok && <div className="note ok" role="status">{t("wf.saved")}</div>}
        <ErrorNote error={error} />
      </form>
    </div>
  );
}

/* ---------------- Delegation (D4) ---------------- */
export function DelegationsPage({ me }: { me: any }) {
  const { t, lang } = useI18n();
  const list = useAsync(() => get<any[]>("/api/delegations"), []);
  const [f, setF] = useState({ toUsername: "", startsOn: today(), endsOn: today(), reason: "", fromUsername: "" });
  const [error, setError] = useState<any>(null);
  const canDelegate = ["MINISTRY_APPROVER", "FIN_CONTROLLER", "REGIONAL_TREASURY", "TREASURY_HQ", "ADMIN"].includes(me.role);
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null);
    try { await post("/api/delegations", { ...f, fromUsername: f.fromUsername || undefined }); setF({ ...f, toUsername: "", reason: "" }); list.reload(); } catch (err) { setError(err); }
  };
  const revoke = (id: number) => post(`/api/delegations/${id}/revoke`).then(list.reload).catch(setError);
  const who = (d: any, p: "from" | "to") => `${lang === "ar" ? d[`${p}_ar`] : d[`${p}_en`]} (${d[`${p}_username`]})`;
  return (
    <section className="view">
      <h1>{t("del.title")}</h1>
      <p className="muted">{t("del.help")}</p>
      {canDelegate && (
        <form className="panel form" onSubmit={save}>
          {me.role === "ADMIN" && <Field label={t("del.from")}><input dir="ltr" value={f.fromUsername} onChange={e => setF({ ...f, fromUsername: e.target.value })} /></Field>}
          <Field label={t("del.to")}><input dir="ltr" required value={f.toUsername} onChange={e => setF({ ...f, toUsername: e.target.value })} /></Field>
          <div className="grid2">
            <Field label={t("del.starts")}><input type="date" value={f.startsOn} onChange={e => setF({ ...f, startsOn: e.target.value })} /></Field>
            <Field label={t("del.ends")}><input type="date" value={f.endsOn} onChange={e => setF({ ...f, endsOn: e.target.value })} /></Field>
          </div>
          <Field label={t("del.reason")}><textarea value={f.reason} onChange={e => setF({ ...f, reason: e.target.value })} /></Field>
          <ErrorNote error={error} />
          <div className="ctrl"><button className="btn primary">{t("del.create")}</button></div>
        </form>
      )}
      {list.loading && !list.data ? <Loading /> : (
        <div className="tbl"><table>
          <thead><tr><th>{t("del.from")}</th><th>{t("del.to")}</th><th>{t("del.period")}</th><th>{t("del.reason")}</th><th>{t("pay.status")}</th><th></th></tr></thead>
          <tbody>{(list.data ?? []).map(d => (
            <tr key={d.id}>
              <td>{who(d, "from")}<div className="small muted">{t(`role.${d.from_role}`)}</div></td>
              <td>{who(d, "to")}</td>
              <td className="nowrap">{d.starts_on} → {d.ends_on}</td>
              <td>{d.reason}</td>
              <td><span className={`chip ${d.revoked_at ? "quiet" : d.active ? "ok" : "warn"}`}>{t(d.revoked_at ? "del.revoked" : d.active ? "del.active" : "del.scheduled")}</span></td>
              <td>{!d.revoked_at && (d.from_username === me.username || me.role === "ADMIN") && <button className="btn" onClick={() => revoke(d.id)}>{t("del.revoke")}</button>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </section>
  );
}

/* ---------------- Users and roles (D4) ---------------- */
const ROLES = ["SPENDING_UNIT", "MINISTRY_APPROVER", "FIN_CONTROLLER", "REGIONAL_TREASURY", "TREASURY_HQ", "ADMIN", "AUDITOR", "REVENUE_OFFICER", "HELPDESK", "HR_OFFICER"];

export function UsersPage({ canEdit }: { canEdit: boolean }) {
  const { t, name, lang } = useI18n();
  const users = useAsync(() => get<any[]>("/api/users"), []);
  const orgs = useAsync(() => get<any[]>("/api/orgs"), []);
  const [f, setF] = useState({ username: "", role: "MINISTRY_APPROVER", orgId: "MIN-0203", fullNameEn: "", fullNameAr: "" });
  const [error, setError] = useState<any>(null);
  const [secret, setSecret] = useState<{ username: string; pw: string } | null>(null);
  const create = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null); setSecret(null);
    try { const r = await post("/api/users", f); setSecret({ username: r.username, pw: r.temporaryPassword }); setF({ ...f, username: "", fullNameEn: "", fullNameAr: "" }); users.reload(); } catch (err) { setError(err); }
  };
  const update = async (u: any, body: any) => {
    setError(null); setSecret(null);
    try { const r = await post(`/api/users/${u.id}`, body); if (r.temporaryPassword) setSecret({ username: u.username, pw: r.temporaryPassword }); users.reload(); } catch (err) { setError(err); }
  };
  return (
    <section className="view">
      <h1>{t("users.title")}</h1>
      <p className="muted">{t("users.help")}</p>
      {secret && <div className="note ok" role="status">{t("users.temp_password", { user: secret.username })} <b className="mono" dir="ltr">{secret.pw}</b></div>}
      <ErrorNote error={error} />
      {canEdit && (
        <form className="panel form" onSubmit={create}>
          <div className="eyebrow">{t("users.new")}</div>
          <div className="grid2">
            <Field label={t("login.username")}><input dir="ltr" required value={f.username} onChange={e => setF({ ...f, username: e.target.value })} /></Field>
            <Field label={t("users.role")}><select value={f.role} onChange={e => setF({ ...f, role: e.target.value })}>{ROLES.map(r => <option key={r} value={r}>{t(`role.${r}`)}</option>)}</select></Field>
            <Field label={t("users.org")}><select value={f.orgId} onChange={e => setF({ ...f, orgId: e.target.value })}>{(orgs.data ?? []).map(o => <option key={o.id} value={o.id}>{o.id} · {name(o)}</option>)}</select></Field>
            <Field label={t("users.name_en")}><input dir="ltr" required value={f.fullNameEn} onChange={e => setF({ ...f, fullNameEn: e.target.value })} /></Field>
            <Field label={t("users.name_ar")}><input dir="rtl" lang="ar" required value={f.fullNameAr} onChange={e => setF({ ...f, fullNameAr: e.target.value })} /></Field>
          </div>
          <div className="ctrl"><button className="btn primary">{t("users.create")}</button></div>
        </form>
      )}
      {users.loading && !users.data ? <Loading /> : (
        <div className="tbl"><table>
          <thead><tr><th>{t("login.username")}</th><th>{t("users.name")}</th><th>{t("users.role")}</th><th>{t("users.org")}</th><th>{t("pay.status")}</th>{canEdit && <th></th>}</tr></thead>
          <tbody>{(users.data ?? []).map(u => {
            const locked = u.locked_until && new Date(u.locked_until) > new Date();
            return (
              <tr key={u.id}>
                <td className="mono" dir="ltr">{u.username}</td>
                <td>{lang === "ar" ? u.full_name_ar : u.full_name_en}</td>
                <td>{t(`role.${u.role}`)}</td>
                <td>{name(u, "org_")}</td>
                <td><span className={`chip ${!u.active ? "quiet" : locked ? "bad" : "ok"}`}>{t(!u.active ? "users.inactive" : locked ? "users.locked" : "users.active")}</span>{u.must_change_password && <div className="small muted">{t("users.must_change")}</div>}</td>
                {canEdit && <td className="ctrl">
                  <button className="btn" onClick={() => update(u, { active: !u.active })}>{t(u.active ? "users.deactivate" : "users.activate")}</button>
                  <button className="btn" onClick={() => update(u, { resetPassword: true })}>{t("users.reset")}</button>
                  {locked && <button className="btn" onClick={() => update(u, { unlock: true })}>{t("users.unlock")}</button>}
                </td>}
              </tr>
            );
          })}</tbody>
        </table></div>
      )}
    </section>
  );
}

export function ChangePassword({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const [f, setF] = useState({ current: "", next: "", again: "" });
  const [error, setError] = useState<any>(null);
  const [mismatch, setMismatch] = useState(false);
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null);
    if (f.next !== f.again) { setMismatch(true); return; }
    setMismatch(false);
    try { await post("/api/me/password", { current: f.current, next: f.next }); onDone(); } catch (err) { setError(err); }
  };
  return (
    <section className="view narrow">
      <h1>{t("pw.title")}</h1>
      <p className="muted">{t("pw.help")}</p>
      <form className="panel form" onSubmit={save}>
        <Field label={t("pw.current")}><input type="password" autoComplete="current-password" dir="ltr" value={f.current} onChange={e => setF({ ...f, current: e.target.value })} required /></Field>
        <Field label={t("pw.next")} hint={t("pw.rule")}><input type="password" autoComplete="new-password" dir="ltr" value={f.next} onChange={e => setF({ ...f, next: e.target.value })} required /></Field>
        <Field label={t("pw.again")}><input type="password" autoComplete="new-password" dir="ltr" value={f.again} onChange={e => setF({ ...f, again: e.target.value })} required /></Field>
        {mismatch && <div className="note bad" role="alert">{t("pw.mismatch")}</div>}
        <ErrorNote error={error} />
        <div className="ctrl"><button className="btn primary">{t("common.save")}</button></div>
      </form>
    </section>
  );
}

/* ---------------- Reports (D4) ---------------- */
export function ReportsPage({ role }: { role: string }) {
  const { t, money, pct, name } = useI18n();
  const rep = useAsync(() => get<any[]>("/api/reports/budget-execution"), []);
  const [error, setError] = useState<any>(null);
  const rows = rep.data ?? [];
  const tot = rows.reduce((s, r) => ({ allotment: s.allotment + r.allotment, in_approval: s.in_approval + r.in_approval, authorised: s.authorised + r.authorised, paid: s.paid + r.paid, available: s.available + r.available }),
    { allotment: 0, in_approval: 0, authorised: 0, paid: 0, available: 0 });
  return (
    <section className="view">
      <h1>{t("rep.title")}</h1>
      <p className="muted">{t("rep.help")}</p>
      <div className="ctrl">
        <button className="btn" onClick={() => downloadCsv("/api/reports/budget-execution", "budget-execution").catch(setError)}>{t("rep.csv_budget")}</button>
        {["TREASURY_HQ", "REGIONAL_TREASURY", "ADMIN", "AUDITOR"].includes(role) && <button className="btn" onClick={() => downloadCsv("/api/reports/payments", "payments").catch(setError)}>{t("rep.csv_payments")}</button>}
      </div>
      <ErrorNote error={error || rep.error} />
      {rep.loading && !rep.data ? <Loading /> : (
        <div className="tbl"><table>
          <thead><tr><th>{t("field.line")}</th><th className="n">{t("rep.allotment")}</th><th className="n">{t("rep.in_approval")}</th><th className="n">{t("rep.authorised")}</th><th className="n">{t("rep.paid")}</th><th className="n">{t("rep.available")}</th><th className="n">{t("rep.execution")}</th></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.line}><td><span className="mono">{r.line}</span><div className="small">{name(r)}</div></td>
                <td className="n">{money(r.allotment)}</td><td className="n">{money(r.in_approval)}</td><td className="n">{money(r.authorised)}</td><td className="n">{money(r.paid)}</td><td className="n">{money(r.available)}</td><td className="n">{pct(r.execution)}</td></tr>
            ))}
            <tr className="total"><td><b>{t("rep.total")}</b></td><td className="n">{money(tot.allotment)}</td><td className="n">{money(tot.in_approval)}</td><td className="n">{money(tot.authorised)}</td><td className="n">{money(tot.paid)}</td><td className="n">{money(tot.available)}</td><td className="n">{pct(tot.allotment ? tot.paid / tot.allotment : 0)}</td></tr>
          </tbody>
        </table></div>
      )}
    </section>
  );
}

/* ---------------- Auditor's workspace (D4) ---------------- */
export function AuditWorkspace() {
  const { t, date, money } = useI18n();
  const [q, setQ] = useState({ actor: "", action: "", entity: "", from: "", to: "" });
  const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]).toString();
  const list = useAsync(() => get<any[]>(`/api/audit/search${qs ? "?" + qs : ""}`), [qs]);
  const ex = useAsync(() => get("/api/audit/exceptions"), []);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<any>(null);
  const verify = () => get("/api/audit/verify").then(setResult).catch(setError);
  const set = (k: string) => (e: any) => setQ({ ...q, [k]: e.target.value });
  const E = ex.data;
  return (
    <section className="view">
      <h1>{t("aud.title")}</h1>
      <p className="muted">{t("aud.help")}</p>
      <div className="ctrl">
        <button className="btn primary" onClick={verify}>{t("audit.verify")}</button>
        <button className="btn" onClick={() => downloadCsv(`/api/audit/search${qs ? "?" + qs : ""}`, "audit-trail").catch(setError)}>{t("aud.csv")}</button>
      </div>
      {result && <div className={`note ${result.valid ? "ok" : "bad"}`} role="status">{result.valid ? t("audit.valid", { n: result.entries }) : t("audit.broken", { id: result.brokenAt })}</div>}
      <SignatureSweep />
      <ErrorNote error={error || list.error} />
      {E && (
        <div className="ex-grid">
          {([["aud.ex_delegated", E.delegatedDecisions.length], ["aud.ex_no_visa", E.noVisaAboveThreshold.length], ["aud.ex_receipts", E.cancelledReceipts.length],
            ["aud.ex_payroll", E.payrollExclusions.length], ["aud.ex_returns", E.returnedPayments.length]] as [string, number][]).map(([k, n]) => (
            <div key={k} className={`panel ex ${n ? "warn" : ""}`}><b>{n}</b><span>{t(k)}</span></div>
          ))}
        </div>
      )}
      {E?.delegatedDecisions.length > 0 && <div className="panel">
        <div className="eyebrow">{t("aud.ex_delegated")}</div>
        <ul className="plain">{E.delegatedDecisions.map((d: any, i: number) => <li key={i}><span className="mono">{d.ref}</span> · {t(`step.${d.step}`)} · {t(`decision.${d.decision}`)} · <span dir="ltr">{d.actor} → {d.on_behalf_of}</span> · {date(d.created_at)}</li>)}</ul>
      </div>}
      {E?.cancelledReceipts.length > 0 && <div className="panel">
        <div className="eyebrow">{t("aud.ex_receipts")}</div>
        <ul className="plain">{E.cancelledReceipts.map((r: any) => <li key={r.ref}><span className="mono">{r.ref}</span> · {money(r.amount)} · {r.cancel_reason}</li>)}</ul>
      </div>}
      <div className="panel stack">
        <div className="eyebrow">{t("aud.search")}</div>
        <div className="ctrl">
          <input aria-label={t("audit.who")} placeholder={t("audit.who")} dir="ltr" value={q.actor} onChange={set("actor")} />
          <input aria-label={t("audit.what")} placeholder={t("audit.what")} dir="ltr" value={q.action} onChange={set("action")} />
          <select aria-label={t("audit.entity")} value={q.entity} onChange={set("entity")}>
            <option value="">{t("pay.all")}</option>
            {["document", "payment_order", "receipt", "delegation", "user", "rule", "payroll_run", "helpdesk_ticket", "bank_account", "integration"].map(x => <option key={x}>{x}</option>)}
          </select>
          <label className="inline">{t("aud.from")} <input type="date" value={q.from} onChange={set("from")} /></label>
          <label className="inline">{t("aud.to")} <input type="date" value={q.to} onChange={set("to")} /></label>
        </div>
        {list.loading && !list.data ? <Loading /> : (
          <div className="tbl"><table>
            <thead><tr><th>#</th><th>{t("audit.when")}</th><th>{t("audit.who")}</th><th>{t("audit.what")}</th><th>{t("audit.entity")}</th><th>{t("aud.data")}</th></tr></thead>
            <tbody>{(list.data ?? []).map(e => <tr key={e.id}><td>{e.id}</td><td className="nowrap">{date(e.ts)}</td><td className="mono">{e.actor}</td><td className="mono">{e.action}</td><td className="mono">{e.entity} {e.entity_id}</td><td className="mono small" dir="ltr">{JSON.stringify(e.data).slice(0, 120)}</td></tr>)}</tbody>
          </table></div>
        )}
      </div>
    </section>
  );
}

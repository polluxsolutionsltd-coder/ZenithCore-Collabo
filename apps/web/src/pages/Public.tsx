import React, { useState } from "react";
import { get, post } from "../api";
import { useI18n } from "../i18n";
import { Lang } from "../i18n/messages";
import { ErrorNote, Field, Loading, useAsync } from "../components/common";

/** Transparency Portal and Citizen's Budget Helpdesk – open to everyone, no account needed. */
export function PublicPortal() {
  const { t, money, pct, lang, setLang, name, date } = useI18n();
  const budget = useAsync(() => get("/api/public/budget"), []);
  const [q, setQ] = useState({ category: "BUDGET", question: "", contact: "", website: "" });
  const [asked, setAsked] = useState<any>(null);
  const [askError, setAskError] = useState<any>(null);
  const [st, setSt] = useState({ ref: "", accessCode: "" });
  const [status, setStatus] = useState<any>(null);
  const [stError, setStError] = useState<any>(null);
  const [rc, setRc] = useState({ ref: "", code: "" });
  const [verified, setVerified] = useState<any>(null);
  const [rcError, setRcError] = useState<any>(null);

  const ask = async (e: React.FormEvent) => {
    e.preventDefault(); setAskError(null);
    try { setAsked(await post("/api/public/helpdesk", { ...q, lang })); setQ({ ...q, question: "", contact: "" }); } catch (err) { setAskError(err); }
  };
  const follow = async (e: React.FormEvent) => {
    e.preventDefault(); setStError(null); setStatus(null);
    try { setStatus(await post("/api/public/helpdesk/status", st)); } catch (err) { setStError(err); }
  };
  const verify = async (e: React.FormEvent) => {
    e.preventDefault(); setRcError(null); setVerified(null);
    try { setVerified(await post("/api/public/receipts/verify", rc)); } catch (err) { setRcError(err); }
  };
  const B = budget.data;
  return (
    <div className="app public">
      <a className="skip" href="#portal-main">{t("a11y.skip")}</a>
      <header className="top">
        <div className="wrap bar">
          <a className="brand" href="#/public"><img src="logo-mark.png" alt="" width={40} height={38} /><span><b>{t("pub.title")}</b><small>{t("pub.subtitle")}</small></span></a>
          <div className="tools">
            <div className="langs" role="group" aria-label="Language">
              {(["ar", "en", "fr"] as Lang[]).map(l => <button key={l} lang={l} aria-pressed={lang === l} onClick={() => setLang(l)}>{t(`lang.${l}`)}</button>)}
            </div>
            <a className="btn ghost" href="#/inbox">{t("pub.staff")}</a>
          </div>
        </div>
      </header>
      <main id="portal-main" className="wrap main" tabIndex={-1}>
        <section className="view">
          <h1>{t("pub.budget", { year: String(B?.year ?? "") })}</h1>
          <p className="muted">{t("pub.budget_help")}</p>
          {budget.loading ? <Loading /> : B && (
            <div className="grid2">
              <div className="tbl"><table>
                <caption className="sr-only">{t("pub.budget", { year: String(B.year) })}</caption>
                <thead><tr><th>{t("field.ministry")}</th><th className="n">{t("rep.allotment")}</th><th className="n">{t("rep.paid")}</th><th className="n">{t("rep.execution")}</th></tr></thead>
                <tbody>{B.ministries.map((m: any) => (
                  <tr key={m.ministry_id}><td>{name(m)}</td><td className="n">{money(m.allotment)}</td><td className="n">{money(m.paid)}</td>
                    <td className="n"><span className="bar-cell"><span style={{ width: `${Math.min(100, (m.paid / (m.allotment || 1)) * 100)}%` }} /></span>{pct(m.paid / (m.allotment || 1))}</td></tr>
                ))}</tbody>
              </table></div>
              <div className="tbl"><table>
                <thead><tr><th>{t("pub.revenue")}</th><th className="n">{t("pub.collected")}</th></tr></thead>
                <tbody>{B.revenue.map((r: any) => <tr key={r.code}><td><span className="mono">{r.code}</span> · {name(r)}</td><td className="n">{money(r.collected)}</td></tr>)}</tbody>
              </table></div>
            </div>
          )}
          {B && <p className="small muted">{t("pub.updated", { date: date(B.updatedAt) })} · <span className="chip quiet">{t("app.sample")}</span></p>}
        </section>

        <div className="grid2">
          <section className="panel stack" aria-labelledby="ask-h">
            <h2 id="ask-h">{t("pub.ask")}</h2>
            <p className="muted">{t("pub.ask_help")}</p>
            {asked ? (
              <div className="note ok" role="status">
                {t("pub.asked", { ref: asked.ref })}<br />{t("pub.code")}: <b className="mono" dir="ltr">{asked.accessCode}</b>
                <div className="small">{t("pub.keep_code")}</div>
                <button className="btn" onClick={() => setAsked(null)}>{t("pub.ask_another")}</button>
              </div>
            ) : (
              <form className="form" onSubmit={ask}>
                <Field label={t("pub.category")}><select value={q.category} onChange={e => setQ({ ...q, category: e.target.value })}>{["BUDGET", "PAYMENT", "REVENUE", "PORTAL", "OTHER"].map(c => <option key={c} value={c}>{t(`hd.cat_${c}`)}</option>)}</select></Field>
                <Field label={t("pub.question")}><textarea required minLength={10} maxLength={2000} value={q.question} onChange={e => setQ({ ...q, question: e.target.value })} /></Field>
                <Field label={t("pub.contact")} hint={t("pub.contact_hint")}><input value={q.contact} onChange={e => setQ({ ...q, contact: e.target.value })} /></Field>
                <input className="hp" tabIndex={-1} autoComplete="off" aria-hidden="true" value={q.website} onChange={e => setQ({ ...q, website: e.target.value })} name="website" />
                <ErrorNote error={askError} />
                <div className="ctrl"><button className="btn primary">{t("pub.send")}</button></div>
              </form>
            )}
          </section>
          <div className="stack">
            <section className="panel stack" aria-labelledby="follow-h">
              <h2 id="follow-h">{t("pub.follow")}</h2>
              <form className="form" onSubmit={follow}>
                <div className="grid2">
                  <Field label={t("pub.ref")}><input dir="ltr" required value={st.ref} onChange={e => setSt({ ...st, ref: e.target.value })} /></Field>
                  <Field label={t("pub.code")}><input dir="ltr" required value={st.accessCode} onChange={e => setSt({ ...st, accessCode: e.target.value })} /></Field>
                </div>
                <ErrorNote error={stError} />
                <div className="ctrl"><button className="btn">{t("pub.check")}</button></div>
              </form>
              {status && <div className={`note ${status.status === "OPEN" ? "warn" : "ok"}`} role="status">
                <b>{t(`hd.status_${status.status}`)}</b>{status.answer && <p>{status.answer}</p>}
                {status.status === "OPEN" && <div className="small">{t("hd.due", { date: date(status.due_at) })}</div>}
              </div>}
            </section>
            <section className="panel stack" aria-labelledby="rc-h">
              <h2 id="rc-h">{t("pub.verify")}</h2>
              <p className="muted">{t("pub.verify_help")}</p>
              <form className="form" onSubmit={verify}>
                <div className="grid2">
                  <Field label={t("rc.receipt")}><input dir="ltr" required placeholder="RC-2026-001000" value={rc.ref} onChange={e => setRc({ ...rc, ref: e.target.value })} /></Field>
                  <Field label={t("rc.verify_code")}><input dir="ltr" required value={rc.code} onChange={e => setRc({ ...rc, code: e.target.value })} /></Field>
                </div>
                <ErrorNote error={rcError} />
                <div className="ctrl"><button className="btn">{t("pub.check")}</button></div>
              </form>
              {verified && (verified.valid ? (
                <div className={`note ${verified.receipt.status === "ISSUED" ? "ok" : "bad"}`} role="status">
                  <b>{verified.receipt.status === "ISSUED" ? t("pub.genuine") : t("rc.cancelled")}</b>
                  <div>{verified.receipt.ref} · {money(verified.receipt.amount)} · {name(verified.receipt, "code_")}</div>
                  <div className="small">{name(verified.receipt, "office_")} · {date(verified.receipt.issued_at)}</div>
                </div>
              ) : <div className="note bad" role="status">{t("pub.not_genuine")}</div>)}
            </section>
          </div>
        </div>
      </main>
      <footer className="wrap foot"><span className="zc-powered"><img src="logo-mark.png" alt="" width={18} height={17} /> {t("app.powered")} <span dir="ltr">ZenithCore FMIS 4.0</span></span> · Millenium Instrumentation Ltd · <span className="chip quiet">{t("app.sample")}</span></footer>
    </div>
  );
}

/*
 * Syria-specific screens (Milestone 4):
 *  - Virements between budget lines, approved at the level the law sets (Decree 54/2006)
 *  - Legacy data load with conversion from old to new pounds (Decree 293/2025)
 *  - Electronic-signature sweep for the auditor (Law 3/2014)
 * Values in the seeded rules are samples until confirmed by a Syrian adviser.
 */
import React, { useState } from "react";
import { get, post } from "../api";
import { useI18n } from "../i18n";
import { ErrorNote, Field, Loading, useAsync } from "../components/common";

export function SyriaBadge() {
  const { t } = useI18n();
  return <span className="chip syria" title={t("sy.badge_hint")}>{t("sy.badge")}</span>;
}

/* ---------------- Virements ---------------- */
export function VirementsPage({ role }: { role: string }) {
  const { t, money, date, name, pct } = useI18n();
  const list = useAsync(() => get<any[]>("/api/virements"), []);
  const lines = useAsync(() => get<any[]>("/api/budget-lines"), []);
  const rules = useAsync(() => get<any>("/api/rules"), []);
  const canRequest = ["SPENDING_UNIT", "MINISTRY_APPROVER"].includes(role);
  const [f, setF] = useState({ fromLine: "", toLine: "", amount: "", reason: "" });
  const [reasons, setReasons] = useState<Record<number, string>>({});
  const [error, setError] = useState<any>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const lim = rules.data?.rules?.filter((r: any) => r.key === "VIREMENT_LIMITS" && !r.effective_to).slice(-1)[0]?.value;

  const request = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null); setMsg(null);
    try {
      const r = await post<any>("/api/virements", { ...f, amount: Number(f.amount) });
      setMsg(t("vr.requested", { ref: r.ref, level: t(`vr.level_${r.level}`), why: t(`vr.why_${r.levelReason}`) }));
      setF({ fromLine: "", toLine: "", amount: "", reason: "" });
      list.reload(); lines.reload();
    } catch (err) { setError(err); }
  };
  const decide = async (id: number, decision: string) => {
    setError(null); setMsg(null);
    try { await post(`/api/virements/${id}/decision`, { decision, reason: reasons[id] ?? "" }); list.reload(); lines.reload(); } catch (err) { setError(err); }
  };
  const own = (lines.data ?? []);
  const lineLabel = (l: any) => `${l.id} · ${name(l)} (${money(l.available, l.currency)})`;

  return (
    <section className="view">
      <div className="row-between"><h1>{t("vr.title")}</h1><SyriaBadge /></div>
      <p className="muted">{t("vr.help")}</p>
      {lim && <div className="note syria small" data-testid="vr-limits">{t("vr.limits", { amount: money(lim.ministryMaxAmount), share: pct(lim.ministryMaxShare), chapters: lim.protectedChapters.join(", ") })}</div>}
      {canRequest && (
        <form className="panel form" onSubmit={request}>
          <div className="eyebrow">{t("vr.new")}</div>
          <div className="grid2">
            <Field label={t("vr.from")}><select required value={f.fromLine} onChange={e => setF({ ...f, fromLine: e.target.value })}><option value="" />{own.map(l => <option key={l.id} value={l.id}>{lineLabel(l)}</option>)}</select></Field>
            <Field label={t("vr.to")}><select required value={f.toLine} onChange={e => setF({ ...f, toLine: e.target.value })}><option value="" />{own.filter(l => l.id !== f.fromLine).map(l => <option key={l.id} value={l.id}>{lineLabel(l)}</option>)}</select></Field>
            <Field label={t("pay.amount")}><input required inputMode="decimal" dir="ltr" value={f.amount} onChange={e => setF({ ...f, amount: e.target.value })} /></Field>
            <Field label={t("vr.reason")} hint={t("vr.reason_hint")}><input required value={f.reason} onChange={e => setF({ ...f, reason: e.target.value })} /></Field>
          </div>
          <div className="ctrl"><button className="btn primary">{t("vr.submit")}</button></div>
        </form>
      )}
      {msg && <div className="note ok" role="status">{msg}</div>}
      <ErrorNote error={error || list.error} />
      {list.loading && !list.data ? <Loading /> : !(list.data ?? []).length ? <p className="muted">{t("common.none")}</p> : (
        <div className="stack">
          {list.data!.map(v => (
            <article key={v.id} className="panel stack" data-testid={`vr-${v.ref}`}>
              <div className="row-between">
                <div><b className="mono">{v.ref}</b> · <b>{money(v.amount, v.currency)}</b></div>
                <div className="ctrl">
                  <span className={`chip ${v.level === "MOF" ? "warn" : "quiet"}`}>{t(`vr.level_${v.level}`)}</span>
                  <span className={`chip ${v.status === "APPROVED" ? "ok" : v.status === "REJECTED" ? "bad" : "warn"}`}>{t(`vr.status_${v.status}`)}</span>
                  {v.signed && (v.signatureValid ? <span className="chip ok">✓ {t("sig.valid")}</span> : <span className="chip bad">✕ {t("sig.invalid")}</span>)}
                </div>
              </div>
              <dl className="facts">
                <dt>{t("vr.from")}</dt><dd><span className="mono">{v.from_line}</span> · {name(v, "from_")}</dd>
                <dt>{t("vr.to")}</dt><dd><span className="mono">{v.to_line}</span> · {name(v, "to_")}</dd>
                <dt>{t("vr.reason")}</dt><dd>{v.reason}</dd>
                <dt>{t("vr.why")}</dt><dd>{t(`vr.why_${v.level_reason}`)}</dd>
                <dt>{t("vr.requested_by")}</dt><dd><span className="mono">{v.requested_by}</span> · {date(v.requested_at)}</dd>
                {v.decided_at && <><dt>{t("vr.decided_by")}</dt><dd><span className="mono">{v.decided_by_name}</span> · {date(v.decided_at)}{v.decision_reason && ` · ${v.decision_reason}`}</dd></>}
              </dl>
              {v.actions.length > 0 && <>
                <Field label={t("vr.decision_reason")}><input value={reasons[v.id] ?? ""} onChange={e => setReasons({ ...reasons, [v.id]: e.target.value })} /></Field>
                <div className="ctrl">
                  <button className="btn primary" onClick={() => decide(v.id, "approve")}>✒ {t("vr.approve")}</button>
                  <button className="btn danger" onClick={() => decide(v.id, "reject")}>{t("vr.reject")}</button>
                </div>
              </>}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

/* ---------------- Legacy data load (old → new pounds) ---------------- */
export function DataLoadPage() {
  const { t, money, num } = useI18n();
  const cur = useAsync(() => get<any>("/api/currency"), []);
  const [kind, setKind] = useState("budget");
  const [csv, setCsv] = useState("");
  const [oldPounds, setOldPounds] = useState(true);
  const [res, setRes] = useState<any>(null);
  const [error, setError] = useState<any>(null);
  const run = async (commit: boolean) => {
    setError(null);
    try { setRes(await post("/api/loaders/" + kind, { csv, commit, oldPounds })); } catch (err) { setError(err); setRes(null); }
  };
  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => { const file = e.target.files?.[0]; if (file) setCsv(await file.text()); };
  const rd = cur.data?.redenomination;
  return (
    <section className="view">
      <div className="row-between"><h1>{t("ld.title")}</h1><SyriaBadge /></div>
      <p className="muted">{t("ld.help")}</p>
      {rd && <div className="note syria small" data-testid="redenomination">{t("ld.decree", { decree: rd.decree, date: rd.effectiveDate, factor: rd.factor, until: rd.oldNotesLegalTenderUntil ?? "—" })}</div>}
      <div className="panel form">
        <div className="grid2">
          <Field label={t("ld.kind")}><select value={kind} onChange={e => { setKind(e.target.value); setRes(null); }}><option value="budget">{t("ld.kind_budget")}</option><option value="employees">{t("ld.kind_employees")}</option></select></Field>
          <Field label={t("ld.file")}><input type="file" accept=".csv,text/csv" onChange={onFile} /></Field>
        </div>
        <Field label={t("ld.csv")}><textarea rows={6} dir="ltr" className="mono" value={csv} onChange={e => setCsv(e.target.value)} /></Field>
        <label className="check"><input type="checkbox" checked={oldPounds} onChange={e => setOldPounds(e.target.checked)} /> {t("ld.old_pounds", { factor: rd?.factor ?? 100 })}</label>
        <div className="ctrl">
          <button className="btn" onClick={() => run(false)} disabled={!csv}>{t("ld.check")}</button>
          <button className="btn primary" onClick={() => run(true)} disabled={!csv || !res || res.errors.length > 0}>{t("ld.commit")}</button>
        </div>
      </div>
      <ErrorNote error={error} />
      {res && (
        <div className="panel stack" data-testid="load-result">
          <div className={`note ${res.errors.length ? "bad" : "ok"}`} role="status">
            {res.committed ? t("ld.committed", { n: res.valid }) : res.errors.length ? t("ld.has_errors", { n: res.errors.length }) : t("ld.ready", { n: res.valid })}
          </div>
          {res.conversion && (
            <div className="tbl"><table>
              <caption className="eyebrow">{t("ld.controls")}</caption>
              <thead><tr><th>{t("ld.field")}</th><th className="n">{t("ld.old_total")}</th><th className="n">{t("ld.expected")}</th><th className="n">{t("ld.new_total")}</th><th className="n">{t("ld.rounding")}</th></tr></thead>
              <tbody>{res.conversion.controls.map((c: any) => (
                <tr key={c.field}><td className="mono">{c.field}</td><td className="n">{num(c.oldTotal)} {t("ld.old_unit")}</td><td className="n">{num(c.expected, 2)}</td><td className="n"><b>{num(c.newTotal, 2)} {t("common.syp")}</b></td><td className="n">{num(c.rounding, 2)}</td></tr>
              ))}</tbody>
            </table></div>
          )}
          {res.errors.length > 0 && (
            <div className="tbl"><table>
              <thead><tr><th>{t("ld.line")}</th><th>{t("ld.field")}</th><th>{t("ld.problem")}</th></tr></thead>
              <tbody>{res.errors.map((e: any, i: number) => <tr key={i}><td className="n">{e.line}</td><td className="mono">{e.field}</td><td>{t(`error.${e.code}`) === `error.${e.code}` ? e.code : t(`error.${e.code}`)}</td></tr>)}</tbody>
            </table></div>
          )}
        </div>
      )}
    </section>
  );
}

/* ---------------- Signature sweep (auditor) ---------------- */
export function SignatureSweep() {
  const { t } = useI18n();
  const [r, setR] = useState<any>(null);
  const [error, setError] = useState<any>(null);
  const run = async () => { setError(null); try { setR(await get("/api/signatures/verify")); } catch (err) { setError(err); } };
  return (
    <div className="panel stack" data-testid="sig-sweep">
      <div className="row-between"><div className="eyebrow">{t("sig.sweep_title")}</div><SyriaBadge /></div>
      <p className="small muted">{t("sig.sweep_help")}</p>
      <div className="ctrl"><button className="btn primary" onClick={run}>✒ {t("sig.sweep")}</button></div>
      <ErrorNote error={error} />
      {r && <div className={`note ${r.invalid ? "bad" : "ok"}`} role="status">
        {r.invalid ? t("sig.sweep_bad", { n: r.invalid, ids: r.invalidIds.join(", ") }) : t("sig.sweep_ok", { valid: r.valid, total: r.total, unsigned: r.unsigned })}
      </div>}
    </div>
  );
}

import React, { useState } from "react";
import { get, post } from "../api";
import { useI18n } from "../i18n";
import { ErrorNote, Field, Loading, useAsync } from "../components/common";
import { sendOrQueue } from "../offline";

/* ---------------- Official receipts ---------------- */
function PrintableReceipt({ r, onClose }: { r: any; onClose: () => void }) {
  const { t, money, date, name } = useI18n();
  return (
    <div className="receipt panel" role="region" aria-label={t("rc.receipt")}>
      <div className="receipt-head">
        <img src="logo-mark.png" alt="" width={42} height={40} />
        <div><b>{t("rc.official")}</b><div className="small">{name(r, "office_")}</div></div>
        <b className="mono">{r.ref}</b>
      </div>
      <dl className="facts">
        <dt>{t("rc.payer")}</dt><dd>{r.payer_name}{r.payer_id && <span className="mono"> · {r.payer_id}</span>}</dd>
        <dt>{t("rc.code")}</dt><dd><span className="mono">{r.revenue_code}</span> · {name(r, "code_")}</dd>
        <dt>{t("pay.amount")}</dt><dd><b>{money(r.amount)}</b></dd>
        {Number(r.governorate_amount) > 0 && <><dt>{t("rc.split")}</dt><dd>{t("rc.split_value", { central: money(r.central_amount), gov: money(r.governorate_amount), g: t(`gov.${r.governorate}`) })}</dd></>}
        <dt>{t("rc.method")}</dt><dd>{t(`rc.${r.method}`)}</dd>
        <dt>{t("rc.issued")}</dt><dd>{date(r.issued_at)} · <span className="mono">{r.issued_by}</span></dd>
        <dt>{t("rc.verify_code")}</dt><dd><b className="mono" dir="ltr">{r.verify_code}</b></dd>
      </dl>
      <p className="small muted">{t("rc.verify_hint")}</p>
      {r.status === "CANCELLED" && <div className="note bad">{t("rc.cancelled")}: {r.cancel_reason}</div>}
      <div className="ctrl no-print"><button className="btn primary" onClick={() => window.print()}>{t("rc.print")}</button><button className="btn ghost" onClick={onClose}>{t("int.close")}</button></div>
    </div>
  );
}

export function ReceiptsPage({ role }: { role: string }) {
  const { t, money, date, name } = useI18n();
  const codes = useAsync(() => get<any[]>("/api/revenue-codes"), []);
  const list = useAsync(() => get<any[]>("/api/receipts"), []);
  const [f, setF] = useState({ revenueCode: "1101", payerName: "", payerId: "", amount: "", method: "CASH" });
  const [error, setError] = useState<any>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [open, setOpen] = useState<any>(null);
  const [cancelling, setCancelling] = useState<{ id: number; reason: string } | null>(null);
  const issue = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null); setMsg(null);
    try {
      const r = await sendOrQueue("receipt", "/api/receipts", { ...f, amount: Number(f.amount) });
      setMsg(r ? t("rc.issued_ok", { ref: r.ref }) : t("offline.queued"));
      setF({ ...f, payerName: "", payerId: "", amount: "" });
      list.reload();
    } catch (err) { setError(err); }
  };
  const cancel = async () => {
    if (!cancelling) return;
    setError(null);
    try { await post(`/api/receipts/${cancelling.id}/cancel`, { reason: cancelling.reason }); setCancelling(null); list.reload(); } catch (err) { setError(err); }
  };
  return (
    <section className="view">
      <h1>{t("rc.title")}</h1>
      <p className="muted">{t("rc.help")}</p>
      {role === "REVENUE_OFFICER" && (
        <form className="panel form no-print" onSubmit={issue}>
          <div className="eyebrow">{t("rc.new")}</div>
          <div className="grid2">
            <Field label={t("rc.code")}><select value={f.revenueCode} onChange={e => setF({ ...f, revenueCode: e.target.value })}>{(codes.data ?? []).map(c => <option key={c.code} value={c.code}>{c.code} · {name(c)}</option>)}</select></Field>
            <Field label={t("rc.method")}><select value={f.method} onChange={e => setF({ ...f, method: e.target.value })}>{["CASH", "BANK_TRANSFER", "CHEQUE"].map(m => <option key={m} value={m}>{t(`rc.${m}`)}</option>)}</select></Field>
            <Field label={t("rc.payer")}><input required value={f.payerName} onChange={e => setF({ ...f, payerName: e.target.value })} /></Field>
            <Field label={t("rc.payer_id")}><input dir="ltr" value={f.payerId} onChange={e => setF({ ...f, payerId: e.target.value })} /></Field>
            <Field label={t("pay.amount")}><input required inputMode="decimal" dir="ltr" value={f.amount} onChange={e => setF({ ...f, amount: e.target.value })} /></Field>
          </div>
          {msg && <div className="note ok" role="status">{msg}</div>}
          <ErrorNote error={error} />
          <div className="ctrl"><button className="btn primary">{t("rc.issue")}</button></div>
        </form>
      )}
      {open && <PrintableReceipt r={open} onClose={() => setOpen(null)} />}
      {cancelling && (
        <div className="panel stack no-print">
          <Field label={t("rc.cancel_reason")}><textarea value={cancelling.reason} onChange={e => setCancelling({ ...cancelling, reason: e.target.value })} /></Field>
          <div className="ctrl"><button className="btn danger" onClick={cancel}>{t("rc.cancel")}</button><button className="btn ghost" onClick={() => setCancelling(null)}>{t("common.cancel")}</button></div>
        </div>
      )}
      {list.loading && !list.data ? <Loading /> : (
        <div className="tbl no-print"><table>
          <thead><tr><th>{t("rc.receipt")}</th><th>{t("rc.payer")}</th><th>{t("rc.code")}</th><th className="n">{t("pay.amount")}</th><th className="n">{t("rc.gov_share")}</th><th>{t("rc.issued")}</th><th>{t("pay.status")}</th><th></th></tr></thead>
          <tbody>{(list.data ?? []).map(r => (
            <tr key={r.id}>
              <td className="mono">{r.ref}</td><td>{r.payer_name}</td><td><span className="mono">{r.revenue_code}</span></td><td className="n">{money(r.amount)}</td>
              <td className="n">{Number(r.governorate_amount) > 0 ? money(r.governorate_amount) : "—"}</td>
              <td className="nowrap">{date(r.issued_at)}</td>
              <td><span className={`chip ${r.status === "ISSUED" ? "ok" : "bad"}`}>{t(`rc.status_${r.status}`)}</span></td>
              <td className="ctrl"><button className="btn" onClick={() => setOpen(r)}>{t("rc.view")}</button>
                {r.status === "ISSUED" && ["REVENUE_OFFICER", "ADMIN"].includes(role) && <button className="btn" onClick={() => setCancelling({ id: r.id, reason: "" })}>{t("rc.cancel")}</button>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {role !== "REVENUE_OFFICER" && <SharingReport />}
    </section>
  );
}

/** Revenue sharing with the governorates (REVENUE_SHARING rule, by revenue code). */
function SharingReport() {
  const { t, money, name } = useI18n();
  const rep = useAsync(() => get<any[]>("/api/receipts/sharing"), []);
  if (!rep.data) return null;
  return (
    <div className="panel stack no-print" data-testid="sharing">
      <div className="row-between"><div className="eyebrow">{t("rc.sharing_title")}</div><span className="chip syria">{t("sy.badge")}</span></div>
      <p className="small muted">{t("rc.sharing_help")}</p>
      <div className="tbl"><table>
        <thead><tr><th>{t("rc.governorate")}</th><th>{t("rc.code")}</th><th className="n">{t("rc.count")}</th><th className="n">{t("rc.collected")}</th><th className="n">{t("rc.central")}</th><th className="n">{t("rc.gov_share")}</th></tr></thead>
        <tbody>{rep.data.map(r => (
          <tr key={`${r.governorate}-${r.revenue_code}`}><td>{r.governorate ? t(`gov.${r.governorate}`) : "—"}</td><td><span className="mono">{r.revenue_code}</span> · {name(r)}</td><td className="n">{r.receipts}</td>
            <td className="n">{money(r.collected)}</td><td className="n">{money(r.central)}</td><td className="n"><b>{money(r.governorate_share)}</b></td></tr>
        ))}</tbody>
      </table></div>
    </div>
  );
}

/* ---------------- Citizen's Budget Helpdesk (staff) ---------------- */
export function HelpdeskPage({ canAnswer }: { canAnswer: boolean }) {
  const { t, date } = useI18n();
  const [status, setStatus] = useState("OPEN");
  const list = useAsync(() => get<any[]>(`/api/helpdesk/tickets${status ? "?status=" + status : ""}`), [status]);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [error, setError] = useState<any>(null);
  const answer = async (id: number) => {
    setError(null);
    try { await post(`/api/helpdesk/tickets/${id}/answer`, { answer: answers[id] ?? "" }); list.reload(); } catch (err) { setError(err); }
  };
  return (
    <section className="view">
      <h1>{t("hd.title")}</h1>
      <p className="muted">{t("hd.help")}</p>
      <div className="ctrl">
        <select aria-label={t("pay.status")} value={status} onChange={e => setStatus(e.target.value)}>
          <option value="">{t("pay.all")}</option>{["OPEN", "ANSWERED"].map(s => <option key={s} value={s}>{t(`hd.status_${s}`)}</option>)}
        </select>
      </div>
      <ErrorNote error={error || list.error} />
      {list.loading && !list.data ? <Loading /> : !(list.data ?? []).length ? <p className="muted">{t("common.none")}</p> : (
        <div className="stack">
          {(list.data ?? []).map(q => (
            <article key={q.id} className="panel stack">
              <div className="row-between">
                <div><b className="mono">{q.ref}</b> · {t(`hd.cat_${q.category}`)} · <span className="chip quiet">{q.lang}</span></div>
                <span className={`chip ${q.status !== "OPEN" ? "ok" : q.overdue ? "bad" : "warn"}`}>{q.status === "OPEN" ? (q.overdue ? t("hd.overdue") : t("hd.due", { date: date(q.due_at) })) : t(`hd.status_${q.status}`)}</span>
              </div>
              <p lang={q.lang} dir={q.lang === "ar" ? "rtl" : "ltr"}>{q.question}</p>
              {q.answer && <div className="note ok"><b>{t("hd.answer")}:</b> {q.answer}<div className="small muted">{q.answered_by} · {date(q.answered_at)}</div></div>}
              {q.status === "OPEN" && canAnswer && <>
                <Field label={t("hd.answer")}><textarea value={answers[q.id] ?? ""} onChange={e => setAnswers({ ...answers, [q.id]: e.target.value })} /></Field>
                <div className="ctrl"><button className="btn primary" onClick={() => answer(q.id)}>{t("hd.send")}</button></div>
              </>}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

/* ---------------- Payroll and biometric enrolment ---------------- */
export function PayrollPage({ role }: { role: string }) {
  const { t, money, date, name, num, pct } = useI18n();
  const runs = useAsync(() => get<any[]>("/api/payroll/runs"), []);
  const emps = useAsync(() => get<any[]>("/api/payroll/employees"), []);
  const [sel, setSel] = useState<number | null>(null);
  const run = useAsync(() => (sel ? get(`/api/payroll/runs/${sel}`) : Promise.resolve(null)), [sel]);
  const [f, setF] = useState({ period: new Date().toISOString().slice(0, 7), ministryId: "MIN-0203" });
  const [error, setError] = useState<any>(null);
  const act = async (fn: () => Promise<any>) => { setError(null); try { await fn(); runs.reload(); run.reload(); emps.reload(); } catch (err) { setError(err); } };
  const enrolled = (emps.data ?? []).filter(e => e.biometric_enrolled).length;
  return (
    <section className="view">
      <h1>{t("pr.title")}</h1>
      <p className="muted">{t("pr.help")}</p>
      {["HR_OFFICER", "ADMIN"].includes(role) && (
        <div className="ctrl">
          <input type="month" aria-label={t("pr.period")} value={f.period} onChange={e => setF({ ...f, period: e.target.value })} />
          <select aria-label={t("field.ministry")} value={f.ministryId} onChange={e => setF({ ...f, ministryId: e.target.value })}><option>MIN-0203</option><option>MIN-0410</option></select>
          <button className="btn primary" onClick={() => act(async () => setSel((await post("/api/payroll/runs", f)).id))}>{t("pr.calculate")}</button>
        </div>
      )}
      <ErrorNote error={error || runs.error} />
      <div className="grid2">
        <div className="tbl"><table>
          <thead><tr><th>{t("pr.period")}</th><th>{t("field.ministry")}</th><th className="n">{t("pr.employees")}</th><th className="n">{t("pr.excluded")}</th><th className="n">{t("pr.total")}</th><th>{t("pay.status")}</th></tr></thead>
          <tbody>{(runs.data ?? []).map(r => (
            <tr key={r.id} className={`clickable ${sel === r.id ? "selected" : ""}`} onClick={() => setSel(r.id)} tabIndex={0} onKeyDown={e => e.key === "Enter" && setSel(r.id)}>
              <td className="mono">{r.period}</td><td>{name(r)}</td><td className="n">{r.employees}</td><td className="n">{r.excluded}</td><td className="n">{money(r.total_net)}</td>
              <td><span className={`chip ${r.status === "APPROVED" ? "ok" : "warn"}`}>{t(`pr.status_${r.status}`)}</span></td>
            </tr>
          ))}</tbody>
        </table></div>
        {run.data ? (
          <div className="panel stack">
            <div className="row-between"><b className="mono">{run.data.period} · {run.data.ministry_id}</b>
              {run.data.status === "CALCULATED" && role === "TREASURY_HQ" && <button className="btn primary" onClick={() => act(() => post(`/api/payroll/runs/${run.data.id}/approve`))}>{t("pr.approve")}</button>}</div>
            <div className="small muted">{t("pr.prepared", { who: run.data.created_by })}{run.data.approved_by && ` · ${t("pr.approved_by", { who: run.data.approved_by })}`}</div>
            <dl className="facts">
              <dt>{t("pr.gross")}</dt><dd>{money(run.data.total_gross)}</dd>
              <dt>{t("pr.tax")}</dt><dd>{money(run.data.total_tax)}</dd>
              <dt>{t("pr.net")}</dt><dd><b>{money(run.data.total_net)}</b></dd>
            </dl>
            {run.data.tax_rule && <div className="note syria small" data-testid="tax-rule"><span className="chip syria">{t("sy.badge")}</span> {t("pr.tax_rule", { exemption: run.data.tax_rule.exemption, bands: run.data.tax_rule.brackets.map((b: any) => `${b.upTo === null ? "∞" : num(b.upTo)} @ ${pct(b.rate)}`).join(" · ") })}</div>}
            <div className="tbl"><table>
              <thead><tr><th>{t("int.employee")}</th><th className="n">{t("pr.gross")}</th><th className="n">{t("pr.tax")}</th><th className="n">{t("pr.net")}</th><th>{t("pay.status")}</th></tr></thead>
              <tbody>{run.data.lines.map((l: any) => (
                <tr key={l.employee_no}><td><span className="mono">{l.employee_no}</span> · <span lang="ar">{l.full_name_ar}</span></td><td className="n">{money(l.gross)}</td><td className="n">{money(l.tax)}</td><td className="n">{money(l.net)}</td>
                  <td>{l.included ? <span className="chip ok">{t("pr.included")}</span> : <span className="chip bad">{t(`moad.${l.exclusion}`)}</span>}</td></tr>
              ))}</tbody>
            </table></div>
          </div>
        ) : <div className="panel muted">{t("pr.pick")}</div>}
      </div>
      <div className="panel stack">
        <div className="eyebrow">{t("pr.biometric")}</div>
        <p>{t("pr.enrolled", { n: enrolled, total: (emps.data ?? []).length })}</p>
        <div className="tbl"><table>
          <thead><tr><th>{t("int.employee")}</th><th>{t("field.ministry")}</th><th>{t("pr.biometric")}</th></tr></thead>
          <tbody>{(emps.data ?? []).filter(e => !e.biometric_enrolled).map(e => (
            <tr key={e.employee_no}><td><span className="mono">{e.employee_no}</span> · <span lang="ar">{e.full_name_ar}</span></td><td>{e.ministry_id}</td>
              <td>{role === "HR_OFFICER" ? <button className="btn" onClick={() => act(() => post(`/api/payroll/employees/${e.employee_no}/biometric`, { deviceRef: "BIO-" + e.employee_no.slice(-5) }))}>{t("pr.enrol")}</button> : <span className="chip warn">{t("pr.not_enrolled")}</span>}</td></tr>
          ))}</tbody>
        </table></div>
      </div>
    </section>
  );
}

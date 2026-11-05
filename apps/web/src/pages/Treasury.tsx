import React, { useEffect, useState } from "react";
import { get, post } from "../api";
import { useI18n } from "../i18n";
import { ErrorNote, Field, Loading, StatusChip, useAsync } from "../components/common";

/** Link to the CBS sandbox control page (demo mode only). */
function SandboxLink() {
  const { t } = useI18n();
  const cfg = useAsync(() => get("/api/config"), []);
  if (!cfg.data?.cbsSandboxUrl) return null;
  return <a className="btn" href={cfg.data.cbsSandboxUrl} target="_blank" rel="noreferrer">{t("pay.sandbox")} ↗</a>;
}

export function ReasonText({ code }: { code: string | null }) {
  const { t } = useI18n();
  if (!code) return null;
  const k = `reason.${code}`;
  const txt = t(k);
  return <span><span className="mono">{code}</span>{txt !== k && ` – ${txt}`}</span>;
}

/** Send / reissue controls for one payment order (Treasury HQ). */
export function PaymentOrderActions({ po, onDone }: { po: any; onDone: (po?: any) => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ reason: "", beneficiaryIban: po.beneficiary_iban ?? "" });
  const run = async (fn: () => Promise<any>) => {
    setBusy(true); setError(null);
    try { onDone(await fn()); setOpen(false); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <div>
      <div className="ctrl">
        {["ISSUED", "SEND_FAILED"].includes(po.status) && (
          <button className="btn primary" disabled={busy} onClick={() => run(() => post(`/api/payment-orders/${po.id}/send`))}>{busy ? t("pay.sending") : t("pay.send")}</button>
        )}
        {["REJECTED", "RETURNED"].includes(po.status) && !open && <button className="btn" onClick={() => setOpen(true)}>{t("pay.reissue")}</button>}
      </div>
      {open && (
        <form className="stack" onSubmit={e => { e.preventDefault(); run(() => post(`/api/payment-orders/${po.id}/reissue`, f)); }}>
          <div className="eyebrow">{t("pay.reissue_title")}</div>
          <Field label={t("pay.new_iban")}><input dir="ltr" className="mono" value={f.beneficiaryIban} onChange={e => setF({ ...f, beneficiaryIban: e.target.value })} /></Field>
          <Field label={t("pay.reissue_reason")}><textarea value={f.reason} onChange={e => setF({ ...f, reason: e.target.value })} /></Field>
          <div className="ctrl"><button className="btn primary" disabled={busy}>{t("pay.reissue")}</button><button type="button" className="btn ghost" onClick={() => setOpen(false)}>{t("common.cancel")}</button></div>
        </form>
      )}
      <ErrorNote error={error} />
    </div>
  );
}

function PaymentOrderDetail({ id, onChange }: { id: number; onChange: () => void; key?: any }) {
  const { t, money, date } = useI18n();
  const po = useAsync(() => get(`/api/payment-orders/${id}`), [id]);
  if (po.loading && !po.data) return <Loading />;
  if (po.error) return <ErrorNote error={po.error} />;
  const d = po.data;
  return (
    <div className="panel stack">
      <div className="row-between">
        <div><b className="mono">{d.ref}</b> · {money(d.amount)} <StatusChip status={d.status} /></div>
        <a href={`#/documents/${d.document_id}`}>{d.document_ref}</a>
      </div>
      <dl className="facts">
        <dt>{t("pay.beneficiary")}</dt><dd>{d.beneficiary_name}</dd>
        <dt>{t("field.iban")}</dt><dd className="mono" dir="ltr">{d.beneficiary_iban}</dd>
        <dt>{t("doc.debit_account")}</dt><dd className="mono">{d.debit_account}</dd>
        <dt>{t("pay.e2e")}</dt><dd className="mono" dir="ltr">{d.end_to_end_id ?? "—"}</dd>
        {d.cbs_reason && <><dt>{t("pay.reason")}</dt><dd><ReasonText code={d.cbs_reason} /></dd></>}
        {d.replaces_id && <><dt>{t("pay.ref")}</dt><dd>{t("pay.replaces", { id: d.replaces_id })}</dd></>}
      </dl>
      <PaymentOrderActions po={d} onDone={() => { po.reload(); onChange(); }} />
      {d.messages.length > 0 && <>
        <div className="eyebrow">{t("pay.messages")}</div>
        <div className="tbl"><table>
          <thead><tr><th>{t("int.type")}</th><th>{t("int.status")}</th><th>{t("int.attempts")}</th><th>{t("int.corr")}</th><th>{t("int.error")}</th></tr></thead>
          <tbody>{d.messages.map((m: any) => <tr key={m.id}><td className="mono">{m.msg_type}</td><td className="mono">{m.status}</td><td className="n">{m.attempts}</td><td className="mono small">{m.correlation_id.slice(0, 13)}…</td><td className="small">{m.last_error ?? ""}</td></tr>)}</tbody>
        </table></div>
      </>}
      {d.ledger.length > 0 && <>
        <div className="eyebrow">{t("pay.ledger")}</div>
        <div className="tbl"><table>
          <thead><tr><th>{t("audit.when")}</th><th>{t("pay.account")}</th><th className="n">{t("pay.debit")}</th><th className="n">{t("pay.credit")}</th><th></th></tr></thead>
          <tbody>{d.ledger.map((l: any, i: number) => <tr key={i}><td className="nowrap">{date(l.posted_at)}</td><td className="mono">{l.account}</td><td className="n">{l.debit ? money(l.debit) : ""}</td><td className="n">{l.credit ? money(l.credit) : ""}</td><td className="small">{l.memo}</td></tr>)}</tbody>
        </table></div>
      </>}
    </div>
  );
}

export function PaymentsPage() {
  const { t, money } = useI18n();
  const [status, setStatus] = useState("");
  const [sel, setSel] = useState<number | null>(null);
  const list = useAsync(() => get<any[]>(`/api/payment-orders${status ? `?status=${status}` : ""}`), [status]);
  const [polled, setPolled] = useState<any>(null);
  const [error, setError] = useState<any>(null);
  const poll = () => { setError(null); post("/api/payments/poll-returns").then(r => { setPolled(r); list.reload(); }).catch(setError); };
  return (
    <section className="view">
      <h1>{t("pay.title")}</h1>
      <p className="muted">{t("pay.subtitle")}</p>
      <div className="ctrl">
        <select aria-label={t("pay.status")} value={status} onChange={e => setStatus(e.target.value)}>
          <option value="">{t("pay.all")}</option>
          {["ISSUED", "SETTLED", "REJECTED", "RETURNED", "SEND_FAILED"].map(s => <option key={s} value={s}>{t(`status.${s}`)}</option>)}
        </select>
        <button className="btn" onClick={poll}>{t("pay.poll")}</button>
        <SandboxLink />
      </div>
      {polled && <div className="note ok" role="status">{t("pay.poll_result", { n: polled.returned.length })}</div>}
      <ErrorNote error={error || list.error} />
      <div className="grid2">
        {list.loading && !list.data ? <Loading /> : (
          <div className="tbl"><table>
            <thead><tr><th>{t("pay.ref")}</th><th>{t("pay.beneficiary")}</th><th className="n">{t("pay.amount")}</th><th>{t("pay.status")}</th></tr></thead>
            <tbody>{(list.data ?? []).map(p => (
              <tr key={p.id} className={`clickable ${sel === p.id ? "selected" : ""}`} onClick={() => setSel(p.id)} tabIndex={0} onKeyDown={e => e.key === "Enter" && setSel(p.id)}>
                <td className="mono">{p.ref}</td><td>{p.beneficiary_name}</td><td className="n">{money(p.amount)}</td><td><StatusChip status={p.status} /></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        {sel ? <PaymentOrderDetail key={sel} id={sel} onChange={list.reload} /> : <div className="panel muted">{t("common.none")}</div>}
      </div>
    </section>
  );
}

const thisQuarter = () => { const d = new Date(); return `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`; };

export function ReconciliationPage({ canEdit }: { canEdit: boolean }) {
  const { t, money, date, name } = useI18n();
  const accounts = useAsync(() => get<any[]>("/api/bank-accounts"), []);
  const [acct, setAcct] = useState("SY-CBS-TSA-0001");
  const [period, setPeriod] = useState(thisQuarter());
  const view = useAsync(() => get(`/api/reconciliation?accountId=${acct}&period=${period}`), [acct, period]);
  const cfg = useAsync(() => get("/api/config"), []);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<any>(null);
  const [notes, setNotes] = useState<Record<number, string>>({});
  const act = async (fn: () => Promise<any>, after?: (r: any) => string | null) => {
    setError(null); setMsg(null);
    try { const r = await fn(); setMsg(after ? after(r) : null); view.reload(); } catch (e) { setError(e); }
  };
  const periods = (() => { const out: string[] = []; const d = new Date(); let y = d.getFullYear(), q = Math.floor(d.getMonth() / 3) + 1; for (let i = 0; i < 4; i++) { out.push(`${y}-Q${q}`); if (--q === 0) { q = 4; y--; } } return out; })();
  const v = view.data;
  const rec = v?.reconciliation;
  return (
    <section className="view">
      <h1>{t("rec.title")}</h1>
      <p className="muted">{t("rec.subtitle")}</p>
      <div className="ctrl">
        <select aria-label={t("rec.account")} value={acct} onChange={e => setAcct(e.target.value)}>
          {(accounts.data ?? []).map(a => <option key={a.id} value={a.id}>{a.id} · {name(a)}</option>)}
        </select>
        <select aria-label={t("rec.period")} value={period} onChange={e => setPeriod(e.target.value)}>
          {periods.map(p => <option key={p}>{p}</option>)}
        </select>
        {canEdit && period === thisQuarter() && !rec?.completed_at && <>
          <button className="btn primary" onClick={() => act(() => post("/api/reconciliation/import", { accountId: acct }), r => t("rec.imported", r))}>{t("rec.import")}</button>
          {cfg.data?.demoMode && <SandboxLink />}
        </>}
      </div>
      {msg && <div className="note ok" role="status">{msg}</div>}
      {rec?.completed_at && <div className="note ok" role="status">{t("rec.completed", { date: date(rec.completed_at), who: rec.completed_by })}</div>}
      <ErrorNote error={error || view.error} />
      {view.loading && !v ? <Loading /> : v && (
        <>
          {v.lines.length === 0 ? <p className="muted">{t("rec.none")}</p> : (
            <div className="tbl"><table>
              <thead><tr><th>{t("rec.date")}</th><th>{t("rec.direction")}</th><th className="n">{t("pay.amount")}</th><th>{t("pay.e2e")}</th><th>{t("rec.details")}</th><th>{t("rec.match")}</th></tr></thead>
              <tbody>{v.lines.map((l: any) => (
                <tr key={l.id}>
                  <td>{l.booking_date}</td><td>{t(`rec.${l.direction}`)}</td><td className="n">{money(l.amount)}</td>
                  <td className="mono small" dir="ltr">{l.end_to_end_id ?? "—"}</td>
                  <td>{l.po_ref ? <span className="mono">{l.po_ref}</span> : l.remittance}{l.note && <div className="small muted">{l.note}</div>}</td>
                  <td>
                    <span className={`chip ${l.match_status === "UNMATCHED" ? "bad" : "ok"}`}>{t(`rec.${l.match_status}`)}</span>
                    {canEdit && l.match_status === "UNMATCHED" && !rec?.completed_at && (
                      <div className="ctrl" style={{ marginTop: 6 }}>
                        <input aria-label={t("rec.note")} placeholder={t("rec.note")} value={notes[l.id] ?? ""} onChange={e => setNotes({ ...notes, [l.id]: e.target.value })} />
                        <button className="btn" onClick={() => act(() => post(`/api/reconciliation/lines/${l.id}/explain`, { note: notes[l.id] ?? "" }))}>{t("rec.explain")}</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
          {v.bookOnly.length > 0 && <div className="panel">
            <div className="eyebrow">{t("rec.in_transit")}</div>
            <ul className="plain">{v.bookOnly.map((b: any) => <li key={b.id}><span className="mono">{b.ref}</span> · {money(b.amount)}</li>)}</ul>
          </div>}
          {canEdit && rec && !rec.completed_at && (
            <div className="ctrl"><button className="btn primary" onClick={() => act(() => post("/api/reconciliation/complete", { accountId: acct, period }))}>{t("rec.complete")}</button></div>
          )}
        </>
      )}
    </section>
  );
}

export function IntegrationPage({ canRetry }: { canRetry: boolean }) {
  const { t, date } = useI18n();
  const [filter, setFilter] = useState({ partner: "", status: "" });
  const qs = new URLSearchParams(Object.entries(filter).filter(([, v]) => v) as [string, string][]).toString();
  const list = useAsync(() => get<any[]>(`/api/integration/messages${qs ? "?" + qs : ""}`), [qs]);
  const sum = useAsync(() => get("/api/integration/summary"), []);
  const match = useAsync(() => get("/api/moad/match"), []);
  const [open, setOpen] = useState<any>(null);
  const [error, setError] = useState<any>(null);
  useEffect(() => { const h = setInterval(() => { list.reload(); sum.reload(); }, 10000); return () => clearInterval(h); }, [list.reload, sum.reload]);
  const show = (id: number) => get(`/api/integration/messages/${id}`).then(setOpen).catch(setError);
  const retry = (id: number) => { setError(null); post(`/api/integration/messages/${id}/retry`).then(() => { setOpen(null); list.reload(); sum.reload(); }).catch(setError); };
  const tone = (s: string) => (["PROCESSED", "DELIVERED"].includes(s) ? "ok" : ["DEAD_LETTER", "FAILED", "REJECTED", "REJECTED_BY_PARTNER"].includes(s) ? "bad" : "warn");
  return (
    <section className="view">
      <h1>{t("int.title")}</h1>
      <p className="muted">{t("int.subtitle")}</p>
      {sum.data && <div className={`note ${sum.data.deadLetters ? "bad" : "ok"}`} role="status">{sum.data.deadLetters ? t("int.dead", { n: sum.data.deadLetters }) : t("int.no_dead")}</div>}
      <div className="ctrl">
        <select aria-label={t("int.partner")} value={filter.partner} onChange={e => setFilter({ ...filter, partner: e.target.value })}>
          <option value="">{t("pay.all")}</option><option value="CBS">CBS</option><option value="MOAD">MoAD</option>
        </select>
        <select aria-label={t("int.status")} value={filter.status} onChange={e => setFilter({ ...filter, status: e.target.value })}>
          <option value="">{t("pay.all")}</option>
          {["PROCESSED", "PARTIAL", "REJECTED", "FAILED", "DELIVERED", "RETRYING", "DEAD_LETTER", "REJECTED_BY_PARTNER"].map(s => <option key={s}>{s}</option>)}
        </select>
      </div>
      <ErrorNote error={error || list.error} />
      {list.loading && !list.data ? <Loading /> : (
        <div className="tbl"><table>
          <thead><tr><th>{t("int.when")}</th><th>{t("int.direction")}</th><th>{t("int.partner")}</th><th>{t("int.type")}</th><th>{t("int.ref")}</th><th>{t("int.status")}</th><th className="n">{t("int.attempts")}</th><th className="n">{t("int.duration")}</th><th>{t("int.corr")}</th></tr></thead>
          <tbody>{(list.data ?? []).map(m => (
            <tr key={m.id} className="clickable" onClick={() => show(m.id)} tabIndex={0} onKeyDown={e => e.key === "Enter" && show(m.id)}>
              <td>{date(m.created_at)}</td><td>{t(`int.${m.direction}`)}</td><td className="mono">{m.partner}</td><td className="mono">{m.msg_type}</td>
              <td className="mono small">{m.business_ref ?? ""}</td><td><span className={`chip ${tone(m.status)}`}>{m.status}{m.http_status ? ` · ${m.http_status}` : ""}</span></td>
              <td className="n">{m.attempts}</td><td className="n">{m.duration_ms ?? ""}</td><td className="mono small" dir="ltr">{m.correlation_id.slice(0, 13)}…</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {open && (
        <div className="panel stack" role="region" aria-label={t("int.type")}>
          <div className="row-between"><b className="mono">#{open.id} {open.partner} {open.msg_type}</b><button className="btn ghost" onClick={() => setOpen(null)}>{t("int.close")}</button></div>
          <div className="small mono" dir="ltr">{t("int.corr")}: {open.correlation_id}{open.idempotency_key && ` · Idempotency-Key: ${open.idempotency_key}`}</div>
          {open.last_error && <div className="note bad">{t("int.error")}: {open.last_error}</div>}
          {canRetry && open.status === "DEAD_LETTER" && <div className="ctrl"><button className="btn primary" onClick={() => retry(open.id)}>{t("int.retry")}</button></div>}
          <div className="grid2">
            <div><div className="eyebrow">{t("int.request")}</div><pre className="code" dir="ltr">{pretty(open.request)}</pre></div>
            <div><div className="eyebrow">{t("int.response")}</div><pre className="code" dir="ltr">{pretty(open.response)}</pre></div>
          </div>
        </div>
      )}
      {match.data && (
        <div className="panel">
          <div className="eyebrow">{t("int.moad")}</div>
          <p>{t("int.matched", { matched: match.data.matched, total: match.data.total })}</p>
          {match.data.exceptions.length > 0 && <div className="tbl"><table>
            <thead><tr><th>{t("int.employee")}</th><th>{t("int.status")}</th></tr></thead>
            <tbody>{match.data.exceptions.map((e: any) => <tr key={e.employee_no}><td><span className="mono">{e.employee_no}</span> · {e.full_name_ar}</td><td>{t(`moad.${e.result}`)}</td></tr>)}</tbody>
          </table></div>}
        </div>
      )}
    </section>
  );
}

function pretty(s: string | null) {
  if (!s) return "—";
  if (s.trim().startsWith("{") || s.trim().startsWith("[")) { try { return JSON.stringify(JSON.parse(s), null, 2); } catch { /* fall through */ } }
  return s.replace(/></g, ">\n<");
}

import React, { useState } from "react";
import { get, post } from "../api";
import { useI18n } from "../i18n";
import { ErrorNote, Field, Loading, StatusChip, useAsync } from "../components/common";
import { PaymentOrderActions, ReasonText } from "./Treasury";

const STATUS_STEP: Record<string, string> = { DRAFT: "SPENDING_UNIT", SUBMITTED: "MINISTRY", AWAITING_VISA: "VISA", AWAITING_RTO: "RTO", AWAITING_HQ: "HQ", AUTHORISED: "PAYMENT" };
const NEGATIVE = ["reject", "refuse_visa"];

function Route({ doc }: { doc: any }) {
  const { t, date, lang } = useI18n();
  const steps = ["SPENDING_UNIT", "MINISTRY", ...(doc.visa_required ? ["VISA"] : []), "RTO", "HQ", "PAYMENT"];
  const rejectedAt = doc.status === "REJECTED" ? [...doc.approvals].reverse().find((a: any) => ["REJECTED", "VISA_REFUSED"].includes(a.decision))?.step : null;
  const current = rejectedAt ?? STATUS_STEP[doc.status];
  const idx = steps.indexOf(current);
  return (
    <ol className="route" aria-label={t("doc.workflow")}>
      {steps.map((s, i) => {
        const last = [...doc.approvals].reverse().find((a: any) => a.step === s);
        const state = rejectedAt && s === rejectedAt ? "bad" : doc.status === "AUTHORISED" ? "done" : i < idx ? "done" : i === idx ? "current" : "todo";
        return (
          <li key={s} className={`route-step ${state}`}>
            <span className="dot" aria-hidden>{state === "done" ? "✓" : state === "bad" ? "✕" : i + 1}</span>
            <b>{t(`step.${s}`)}</b>
            {last && <small>{t(`decision.${last.decision}`)} · {lang === "ar" ? last.full_name_ar : last.full_name_en}<br />{date(last.created_at)}</small>}
            {s === "PAYMENT" && doc.paymentOrder && <small className="mono">{doc.paymentOrder.ref}</small>}
          </li>
        );
      })}
    </ol>
  );
}

function Actions({ doc, onDone }: { doc: any; onDone: (msg: string) => void }) {
  const { t, money } = useI18n();
  const [mode, setMode] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const run = async (action: string) => {
    setBusy(true); setError(null);
    try {
      if (action === "submit") await post(`/api/documents/${doc.id}/submit`, { version: doc.version });
      else if (action === "amend") await post(`/api/documents/${doc.id}/amend`, { amount: Number(amount), reason, version: doc.version });
      else await post(`/api/documents/${doc.id}/actions/${action}`, { reason: reason || undefined, version: doc.version });
      setMode(null); setReason(""); setAmount("");
      onDone(t("doc.done", { action: t(`action.${action}`) }));
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  if (!doc.actions.length) return <p className="muted">{t("doc.no_actions")}</p>;
  return (
    <div className="actions">
      <div className="ctrl">
        {doc.actions.map((a: string) => (
          <button key={a} className={`btn ${NEGATIVE.includes(a) ? "danger" : a === "amend" ? "" : "primary"}`} disabled={busy}
            onClick={() => (NEGATIVE.includes(a) || a === "amend" ? setMode(a) : run(a))}>{t(`action.${a}`)}</button>
        ))}
      </div>
      {mode && (
        <div className="form inset">
          {mode === "amend" && <Field label={t("field.new_amount")} hint={money(doc.amount)}><input type="number" min="1" value={amount} onChange={e => setAmount(e.target.value)} dir="ltr" /></Field>}
          <Field label={t("field.reason")} hint={t("doc.reason_hint")}><textarea rows={2} value={reason} onChange={e => setReason(e.target.value)} /></Field>
          <div className="ctrl">
            <button className={`btn ${mode === "amend" ? "primary" : "danger"}`} disabled={busy} onClick={() => run(mode)}>{t("action.confirm")}</button>
            <button className="btn ghost" onClick={() => { setMode(null); setError(null); }}>{t("common.cancel")}</button>
          </div>
        </div>
      )}
      <ErrorNote error={error} />
    </div>
  );
}

export function DocumentDetail({ id, role }: { id: number; role: string }) {
  const { t, money, date, name, lang } = useI18n();
  const doc = useAsync(() => get(`/api/documents/${id}`), [id]);
  const trail = useAsync(() => get<any[]>(`/api/audit?entity=document&entityId=${id}`), [id]);
  const [flash, setFlash] = useState("");
  if (doc.loading && !doc.data) return <Loading />;
  if (doc.error) return <ErrorNote error={doc.error} />;
  const d = doc.data;
  const done = (msg: string) => { setFlash(msg); doc.reload(); trail.reload(); };

  return (
    <section className="view">
      <a href="#/documents" className="back">← {t("common.back")}</a>
      <div className="doc-head">
        <div>
          <div className="eyebrow mono">{d.ref}</div>
          <h1>{d.description}</h1>
          <StatusChip status={d.status} />
        </div>
        <div className="amount"><b>{money(d.amount)}</b><small>{d.visa_required ? t("doc.visa_required") : t("doc.visa_not_required")}</small></div>
      </div>
      {flash && <div className="note ok" role="status">{flash}</div>}

      <div className="panel"><div className="eyebrow">{t("doc.workflow")}</div><Route doc={d} /></div>

      <div className="grid2">
        <div className="panel">
          <dl className="facts">
            <dt>{t("field.unit")}</dt><dd>{name(d.orgs[d.spending_unit_id])}</dd>
            <dt>{t("field.ministry")}</dt><dd>{name(d.orgs[d.ministry_id])}</dd>
            <dt>{t("field.rto")}</dt><dd>{name(d.orgs[d.rto_id])}</dd>
            <dt>{t("field.line")}</dt><dd><span className="mono">{d.line.id}</span> · {name(d.line)}</dd>
            <dt>{t(d.status === "DRAFT" || d.status === "REJECTED" ? "field.available" : "field.available_after")}</dt><dd>{money(d.availability.available)}</dd>
            <dt>{t("field.supplier")}</dt><dd>{d.supplier_name}</dd>
            <dt>{t("field.iban")}</dt><dd className="mono" dir="ltr">{d.supplier_iban}</dd>
          </dl>
        </div>
        <div className="panel">
          <div className="eyebrow">{t("doc.actions")}</div>
          <Actions doc={d} onDone={done} />
          {d.checks && (
            <>
              <div className="eyebrow" style={{ marginTop: 16 }}>{t("doc.checks")}</div>
              <ul className="checks">
                {d.checks.map((c: any) => <li key={c.key} className={c.ok ? "ok" : "bad"}><span>{c.ok ? "✓" : "✕"}</span>{t(c.key)}<small>{t(c.ok ? "check.ok" : "check.fail")}</small></li>)}
              </ul>
            </>
          )}
          {d.paymentOrders?.length > 0 && (
            <div className="po stack">
              <div className="eyebrow">{d.paymentOrders.length > 1 ? t("pay.history") : t("doc.payment_order")}</div>
              {d.paymentOrders.map((po: any) => (
                <div key={po.id}>
                  <b className="mono">{po.ref}</b> · {money(po.amount)} <StatusChip status={po.status} />
                  <div className="muted">{t("doc.debit_account")}: <span className="mono">{po.debit_account}</span>{po.cbs_reason && <> · <ReasonText code={po.cbs_reason} /></>}</div>
                  {po.id === d.paymentOrder.id && role === "TREASURY_HQ" && <PaymentOrderActions po={po} onDone={() => { doc.reload(); trail.reload(); }} />}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="panel">
        <div className="eyebrow">{t("doc.history")}</div>
        <div className="tbl"><table>
          <tbody>{d.approvals.map((a: any, i: number) => (
            <tr key={i}><td>{date(a.created_at)}</td><td>{t(`step.${a.step}`)}</td><td>{t(`decision.${a.decision}`)}</td>
              <td>{lang === "ar" ? a.full_name_ar : a.full_name_en}</td><td className="n">{money(a.amount)}</td><td>{a.reason ?? ""}</td></tr>
          ))}</tbody>
        </table></div>
      </div>

      <div className="panel">
        <div className="eyebrow">{t("doc.audit")}</div>
        {trail.data && <div className="tbl"><table>
          <thead><tr><th>{t("audit.when")}</th><th>{t("audit.who")}</th><th>{t("audit.what")}</th><th>Hash</th></tr></thead>
          <tbody>{trail.data.map(e => <tr key={e.id}><td>{date(e.ts)}</td><td className="mono">{e.actor}</td><td className="mono">{e.action}</td><td className="mono small">{e.hash.slice(0, 16)}…</td></tr>)}</tbody>
        </table></div>}
      </div>
    </section>
  );
}

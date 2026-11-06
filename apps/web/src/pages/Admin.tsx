import React, { useState } from "react";
import { get, post } from "../api";
import { useI18n } from "../i18n";
import { ErrorNote, Field, Loading, useAsync } from "../components/common";
import { WorkflowCard } from "./Governance";

export function Dashboard() {
  const { t, pct, money } = useI18n();
  const { data, error, loading } = useAsync(() => get<any[]>("/api/indicators"), []);
  return (
    <section className="view">
      <h1>{t("ind.title")}</h1>
      <p className="muted">{t("ind.subtitle")}</p>
      <ErrorNote error={error} />
      {loading ? <Loading /> : (
        <div className="ind-grid">
          {data!.map(i => (
            <div key={i.id} className={`ind panel ${i.status}`}>
              <div className="eyebrow">{i.id}</div>
              <h3>{t(i.key)}</h3>
              {i.status === "live" && i.unit === "boolean" ? (
                <>
                  <div className={`ind-value ${i.value ? "ok" : "bad"}`}>{t(i.value ? "ind.yes" : "ind.no")}</div>
                  <small className="muted">{t("ind.portal")}: {t(i.detail?.portal ? "ind.yes" : "ind.no")}</small>
                  <small className="muted">{t("ind.helpdesk_on_time", { n: i.numerator, d: i.denominator })}</small>
                </>
              ) : i.status === "live" && i.unit === "tco2e" ? (
                <>
                  <div className="ind-value">{(i.value ?? 0).toLocaleString(undefined, { maximumFractionDigits: 3 })} <small>tCO₂e</small></div>
                  <small className="muted">{t("ind.ghg_basis", { n: i.detail?.transactions ?? 0 })}</small>
                  <small className="muted">{t("ind.estimate")}</small>
                </>
              ) : i.status === "live" ? (
                <>
                  <div className="ind-value">{pct(i.value)}</div>
                  <div className="meter"><span style={{ width: `${Math.min(100, (i.value ?? 0) * 100)}%` }} />{i.target && <i style={{ insetInlineStart: `${i.target * 100}%` }} title={t("ind.target")} />}</div>
                  <small className="muted">{i.measure === "count" ? t("ind.count_of", { n: i.numerator, d: i.denominator }) : `${money(i.numerator)} ${t("ind.of")} ${money(i.denominator)}`}</small>
                  {i.target && <small className="muted">{t("ind.target")}: {pct(i.target)}</small>}
                </>
              ) : <small className="muted">{t("ind.planned")}</small>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function AuditPage() {
  const { t, date } = useI18n();
  const list = useAsync(() => get<any[]>("/api/audit"), []);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<any>(null);
  const verify = () => get("/api/audit/verify").then(setResult).catch(setError);
  return (
    <section className="view">
      <h1>{t("audit.title")}</h1>
      <div className="ctrl"><button className="btn primary" onClick={verify}>{t("audit.verify")}</button></div>
      {result && <div className={`note ${result.valid ? "ok" : "bad"}`} role="status">{result.valid ? t("audit.valid", { n: result.entries }) : t("audit.broken", { id: result.brokenAt })}</div>}
      <ErrorNote error={error || list.error} />
      {list.loading ? <Loading /> : (
        <div className="tbl"><table>
          <thead><tr><th>#</th><th>{t("audit.when")}</th><th>{t("audit.who")}</th><th>{t("audit.what")}</th><th>{t("audit.entity")}</th><th>Hash</th></tr></thead>
          <tbody>{list.data!.map(e => <tr key={e.id}><td>{e.id}</td><td>{date(e.ts)}</td><td className="mono">{e.actor}</td><td className="mono">{e.action}</td><td className="mono">{e.entity} {e.entity_id}</td><td className="mono small">{e.hash.slice(0, 16)}…</td></tr>)}</tbody>
        </table></div>
      )}
    </section>
  );
}

export function RulesPage({ canEdit }: { canEdit: boolean }) {
  const { t } = useI18n();
  const data = useAsync(() => get("/api/rules"), []);
  const [f, setF] = useState({ key: "VISA_THRESHOLD", scope: "", field: "amount", value: "", effectiveFrom: new Date().toISOString().slice(0, 10) });
  const [error, setError] = useState<any>(null);
  const FIELD: Record<string, string> = { VISA_THRESHOLD: "amount", CASH_LIMIT_MONTHLY: "amount", TSA_DEBIT_ACCOUNT: "account", REJECTION_REASON_MIN: "chars", REC_DEADLINE_DAYS: "days", HELPDESK_SLA_DAYS: "days",
    FX_RATE: "sypPerUnit", REVENUE_SHARING: "governorateShare", INCOME_TAX: "json", VIREMENT_LIMITS: "json" };
  const SYRIA = ["FX_RATE", "REVENUE_SHARING", "INCOME_TAX", "VIREMENT_LIMITS", "REDENOMINATION"];
  const current = (key: string, scope: string) => (data.data?.rules ?? []).filter((r: any) => r.key === key && (r.scope ?? "") === scope && !r.effective_to).slice(-1)[0]?.value;
  const pickKey = (key: string) => setF({ ...f, key, value: FIELD[key] === "json" ? JSON.stringify(current(key, f.scope) ?? {}, null, 2) : "" });
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null);
    const fld = FIELD[f.key];
    try {
      let value: any;
      if (fld === "json") { try { value = JSON.parse(f.value); } catch { throw { code: "rules.invalid_json" }; } }
      else value = { [fld]: fld === "account" ? f.value : Number(f.value) };
      await post("/api/rules", { key: f.key, scope: f.scope || null, value, effectiveFrom: f.effectiveFrom });
      data.reload();
    } catch (err) { setError(err); }
  };
  const show = (v: any) => Object.entries(v).map(([k, x]) => `${k}: ${typeof x === "number" ? x.toLocaleString() : typeof x === "object" ? JSON.stringify(x) : x}`).join(", ");
  return (
    <section className="view">
      <h1>{t("rules.title")}</h1>
      <p className="muted">{t("rules.subtitle")}</p>
      {data.loading ? <Loading /> : (
        <div className="tbl"><table>
          <thead><tr><th>{t("rules.key")}</th><th>{t("rules.scope")}</th><th>{t("rules.value")}</th><th>{t("rules.from")}</th><th>{t("rules.to")}</th><th>{t("audit.who")}</th></tr></thead>
          <tbody>{data.data.rules.map((r: any) => <tr key={r.id}><td className="mono">{r.key}{SYRIA.includes(r.key) && <> <span className="chip syria">{t("sy.badge")}</span></>}</td><td>{r.scope ?? t("rules.all")}</td><td className="mono small">{show(r.value)}</td><td>{r.effective_from}</td><td>{r.effective_to ?? "—"}</td><td className="mono">{r.created_by}</td></tr>)}</tbody>
        </table></div>
      )}
      {canEdit && (
        <form className="form panel" onSubmit={save}>
          <div className="eyebrow">{t("rules.add")}</div>
          <div className="row">
            <Field label={t("rules.key")}><select value={f.key} onChange={e => pickKey(e.target.value)}>{Object.keys(FIELD).map(k => <option key={k}>{k}</option>)}</select></Field>
            <Field label={t("rules.scope")}><input value={f.scope} onChange={e => setF({ ...f, scope: e.target.value })} placeholder={t("rules.all")} dir="ltr" /></Field>
            {FIELD[f.key] !== "json" && <Field label={`${t("rules.value")} (${FIELD[f.key]})`}><input value={f.value} onChange={e => setF({ ...f, value: e.target.value })} required dir="ltr" /></Field>}
            <Field label={t("rules.from")}><input type="date" value={f.effectiveFrom} onChange={e => setF({ ...f, effectiveFrom: e.target.value })} required /></Field>
          </div>
          {FIELD[f.key] === "json" && <Field label={t("rules.value_json")} hint={t("rules.json_hint")}><textarea rows={8} className="mono" dir="ltr" value={f.value} onChange={e => setF({ ...f, value: e.target.value })} required /></Field>}
          <ErrorNote error={error} />
          <div className="ctrl"><button className="btn primary">{t("common.save")}</button></div>
        </form>
      )}
      <WorkflowCard canEdit={canEdit} onSaved={data.reload} />
    </section>
  );
}

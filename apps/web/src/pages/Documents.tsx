import React, { useState } from "react";
import { get, post } from "../api";
import { useI18n } from "../i18n";
import { ErrorNote, Field, Loading, StatusChip, go, useAsync } from "../components/common";

export function DocumentList({ scope }: { scope: "inbox" | "all" }) {
  const { t, money, date, name } = useI18n();
  const { data, error, loading } = useAsync(() => get<any[]>(`/api/documents?scope=${scope}`), [scope]);
  return (
    <section className="view">
      <h1>{t(scope === "inbox" ? "nav.inbox" : "nav.requests")}</h1>
      <ErrorNote error={error} />
      {loading ? <Loading /> : !data?.length ? <p className="muted">{t("common.none")}</p> : (
        <div className="tbl">
          <table>
            <thead><tr><th>{t("field.ref")}</th><th>{t("field.unit")}</th><th>{t("field.supplier")}</th><th className="n">{t("field.amount")}</th><th>{t("field.status")}</th><th>{t("field.updated")}</th></tr></thead>
            <tbody>
              {data.map(d => (
                <tr key={d.id} className="clickable" onClick={() => go(`/documents/${d.id}`)}>
                  <td className="mono"><a href={`#/documents/${d.id}`}>{d.ref}</a></td>
                  <td>{name(d, "unit_")}</td>
                  <td>{d.supplier_name}</td>
                  <td className="n">{money(d.amount)}</td>
                  <td><StatusChip status={d.status} /></td>
                  <td>{date(d.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function NewDocument() {
  const { t, money, name } = useI18n();
  const lines = useAsync(() => get<any[]>("/api/budget-lines"), []);
  const [f, setF] = useState({ budgetLineId: "", supplierName: "", supplierIban: "", description: "", amount: "" });
  const [error, setError] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const line = lines.data?.find(l => l.id === f.budgetLineId);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await post("/api/documents", { ...f, amount: Number(f.amount) });
      go(`/documents/${r.id}`);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <section className="view narrow">
      <h1>{t("doc.new_title")}</h1>
      <form className="form panel" onSubmit={save}>
        <Field label={t("field.line")}>
          <select value={f.budgetLineId} onChange={set("budgetLineId")} required>
            <option value="" />
            {lines.data?.map(l => <option key={l.id} value={l.id}>{l.id} · {name(l)}</option>)}
          </select>
        </Field>
        {line && (
          <div className="kpis">
            <div><b>{money(line.allotment)}</b><span>{t("field.allotment")}</span></div>
            <div><b>{money(line.reserved)}</b><span>{t("field.reserved")}</span></div>
            <div><b>{money(line.available)}</b><span>{t("field.available")}</span></div>
          </div>
        )}
        <Field label={t("field.supplier")}><input value={f.supplierName} onChange={set("supplierName")} required /></Field>
        <Field label={t("field.iban")}><input value={f.supplierIban} onChange={set("supplierIban")} required dir="ltr" className="mono" /></Field>
        <Field label={t("field.description")}><textarea value={f.description} onChange={set("description")} required rows={2} /></Field>
        <Field label={t("field.amount")}><input type="number" min="1" step="1" value={f.amount} onChange={set("amount")} required dir="ltr" /></Field>
        <ErrorNote error={error} />
        <div className="ctrl"><button className="btn primary" disabled={busy}>{t("doc.create")}</button></div>
      </form>
    </section>
  );
}

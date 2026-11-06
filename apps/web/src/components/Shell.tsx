import React, { useEffect, useState } from "react";
import { get, post } from "../api";
import { useI18n } from "../i18n";
import { Lang } from "../i18n/messages";
import { onOutboxChange, outbox, syncOutbox } from "../offline";
import { Brand } from "./Brand";

function Outbox() {
  const { t } = useI18n();
  const [n, setN] = useState(outbox().length);
  useEffect(() => onOutboxChange(() => setN(outbox().length)), []);
  if (!n) return null;
  return <button className="btn outbox" onClick={() => syncOutbox()} title={t("offline.sync_now")}>⇅ {t("offline.waiting", { n })}</button>;
}

export interface Me { id: number; username: string; role: string; full_name_en: string; full_name_ar: string; org_en: string; org_ar: string; org_fr: string }

function Notifications() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<any[]>([]);
  const load = () => get("/api/notifications").then(setItems).catch(() => undefined);
  useEffect(() => { load(); const h = setInterval(load, 15000); return () => clearInterval(h); }, []);
  const unread = items.filter(n => !n.read).length;
  const openDoc = async (n: any) => {
    await post(`/api/notifications/${n.id}/read`).catch(() => undefined);
    setOpen(false); load();
    if (n.document_id) window.location.hash = `/documents/${n.document_id}`;
  };
  return (
    <div className="notif">
      <button className="btn ghost" aria-expanded={open} onClick={() => setOpen(!open)} aria-label={t("notif.title")}>
        🔔{unread > 0 && <span className="badge">{unread}</span>}
      </button>
      {open && (
        <div className="notif-panel" role="dialog" aria-label={t("notif.title")}>
          <div className="eyebrow">{t("notif.title")}</div>
          {items.length === 0 && <p className="muted">{t("notif.empty")}</p>}
          {items.map(n => (
            <button key={n.id} className={`notif-item ${n.read ? "" : "unread"}`} onClick={() => openDoc(n)}>
              {t(`notif.${n.key}`, n.params)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Shell({ me, route, onLogout, children }: { me: Me; route: string; onLogout: () => void; children: React.ReactNode }) {
  const { t, lang, setLang, name } = useI18n();
  const links: [string, string, boolean][] = [
    ["/inbox", "nav.inbox", ["SPENDING_UNIT", "MINISTRY_APPROVER", "FIN_CONTROLLER", "REGIONAL_TREASURY", "TREASURY_HQ", "ADMIN", "AUDITOR"].includes(me.role)],
    ["/documents", "nav.requests", ["SPENDING_UNIT", "MINISTRY_APPROVER", "FIN_CONTROLLER", "REGIONAL_TREASURY", "TREASURY_HQ", "ADMIN", "AUDITOR"].includes(me.role)],
    ["/documents/new", "nav.new", me.role === "SPENDING_UNIT"],
    ["/payments", "nav.payments", ["TREASURY_HQ", "REGIONAL_TREASURY", "ADMIN", "AUDITOR"].includes(me.role)],
    ["/reconciliation", "nav.reconciliation", ["TREASURY_HQ", "REGIONAL_TREASURY", "ADMIN", "AUDITOR"].includes(me.role)],
    ["/integration", "nav.integration", ["TREASURY_HQ", "ADMIN", "AUDITOR"].includes(me.role)],
    ["/receipts", "nav.receipts", ["REVENUE_OFFICER", "TREASURY_HQ", "ADMIN", "AUDITOR"].includes(me.role)],
    ["/payroll", "nav.payroll", ["HR_OFFICER", "TREASURY_HQ", "ADMIN", "AUDITOR"].includes(me.role)],
    ["/helpdesk", "nav.helpdesk", ["HELPDESK", "ADMIN", "AUDITOR"].includes(me.role)],
    ["/reports", "nav.reports", !["HELPDESK", "REVENUE_OFFICER", "HR_OFFICER"].includes(me.role)],
    ["/dashboard", "nav.dashboard", true],
    ["/audit", "nav.audit", ["AUDITOR", "ADMIN"].includes(me.role)],
    ["/delegations", "nav.delegations", ["MINISTRY_APPROVER", "FIN_CONTROLLER", "REGIONAL_TREASURY", "TREASURY_HQ", "ADMIN", "AUDITOR"].includes(me.role)],
    ["/users", "nav.users", ["ADMIN", "AUDITOR"].includes(me.role)],
    ["/rules", "nav.rules", ["ADMIN", "AUDITOR"].includes(me.role)],
  ];
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener("online", on); window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);
  return (
    <div className="app">
      <a className="skip" href="#main">{t("a11y.skip")}</a>
      <header className="top">
        <div className="wrap bar">
          <a className="brand" href="#/inbox" aria-label={`${t("app.name")} – ${t("app.edition")}`}>
            <Brand sub={t("app.edition")} />
          </a>
          <nav className="nav" aria-label="main">
            {links.filter(l => l[2]).map(([href, key]) => (
              <a key={href} href={`#${href}`} aria-current={route === href || (href === "/documents" && route.startsWith("/documents/") && route !== "/documents/new") ? "page" : undefined}>{t(key)}</a>
            ))}
          </nav>
          <div className="tools">
            <div className="langs" role="group" aria-label="Language">
              {(["ar", "en", "fr"] as Lang[]).map(l => (
                <button key={l} lang={l} aria-pressed={lang === l} onClick={() => setLang(l)}>{t(`lang.${l}`)}</button>
              ))}
            </div>
            <Outbox />
            <Notifications />
            <div className="who">
              <b>{lang === "ar" ? me.full_name_ar : me.full_name_en}</b>
              <small>{t(`role.${me.role}`)} · {name(me, "org_")}</small>
            </div>
            <a className="btn ghost" href="#/password">{t("nav.password")}</a>
            <button className="btn ghost" onClick={onLogout}>{t("nav.logout")}</button>
          </div>
        </div>
      </header>
      {!online && <div className="offline-banner" role="status">{t("offline.banner")}</div>}
      <main id="main" className="wrap main" tabIndex={-1}>{children}</main>
      <footer className="wrap foot"><img src="logo-mark.png" alt="" width={18} height={17} /> <span dir="ltr">ZenithCore FMIS 4.0</span> · Millenium Instrumentation Ltd · <span className="chip quiet">{t("app.sample")}</span></footer>
    </div>
  );
}

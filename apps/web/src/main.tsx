import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { get, session } from "./api";
import { I18nProvider } from "./i18n";
import { Shell, Me } from "./components/Shell";
import { Loading } from "./components/common";
import { Login } from "./pages/Login";
import { DocumentList, NewDocument } from "./pages/Documents";
import { DocumentDetail } from "./pages/DocumentDetail";
import { AuditPage, Dashboard, RulesPage } from "./pages/Admin";
import { IntegrationPage, PaymentsPage, ReconciliationPage } from "./pages/Treasury";

function useRoute() {
  const read = () => window.location.hash.replace(/^#/, "") || "/inbox";
  const [route, setRoute] = useState(read());
  useEffect(() => {
    const h = () => setRoute(read());
    window.addEventListener("hashchange", h);
    return () => window.removeEventListener("hashchange", h);
  }, []);
  return route;
}

function App() {
  const route = useRoute();
  const [me, setMe] = useState<Me | null>(null);
  const [checking, setChecking] = useState(true);

  const loadMe = () => {
    if (!session.token) { setMe(null); setChecking(false); return; }
    get<Me>("/api/me").then(setMe).catch(() => setMe(null)).finally(() => setChecking(false));
  };
  useEffect(() => {
    loadMe();
    const out = () => setMe(null);
    window.addEventListener("zc:logout", out);
    return () => window.removeEventListener("zc:logout", out);
  }, []);

  if (checking) return <Loading />;
  if (!me) return <Login onLogin={loadMe} />;

  const logout = () => { session.token = null; setMe(null); window.location.hash = "/inbox"; };
  const docMatch = /^\/documents\/(\d+)$/.exec(route);
  let page: React.ReactNode;
  if (route === "/inbox") page = <DocumentList scope="inbox" />;
  else if (route === "/documents") page = <DocumentList scope="all" />;
  else if (route === "/documents/new") page = <NewDocument />;
  else if (docMatch) page = <DocumentDetail id={Number(docMatch[1])} role={me.role} />;
  else if (route === "/dashboard") page = <Dashboard />;
  else if (route === "/audit") page = <AuditPage />;
  else if (route === "/rules") page = <RulesPage canEdit={me.role === "ADMIN"} />;
  else if (route === "/payments") page = <PaymentsPage />;
  else if (route === "/reconciliation") page = <ReconciliationPage canEdit={["TREASURY_HQ", "ADMIN"].includes(me.role)} />;
  else if (route === "/integration") page = <IntegrationPage canRetry={["TREASURY_HQ", "ADMIN"].includes(me.role)} />;
  else page = <DocumentList scope="inbox" />;

  return <Shell me={me} route={route} onLogout={logout}>{page}</Shell>;
}

createRoot(document.getElementById("root")!).render(<I18nProvider><App /></I18nProvider>);

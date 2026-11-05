import React, { useEffect, useState } from "react";
import { get, post, session } from "../api";
import { useI18n } from "../i18n";
import { Lang } from "../i18n/messages";
import { ErrorNote, Field } from "../components/common";

export function Login({ onLogin }: { onLogin: () => void }) {
  const { t, lang, setLang, name } = useI18n();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [demo, setDemo] = useState<any[]>([]);
  useEffect(() => { get("/api/demo-users").then(setDemo).catch(() => setDemo([])); }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await post("/api/auth/login", { username, password });
      session.token = r.token;
      onLogin();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <div className="login">
      <div className="login-card panel">
        <div className="login-head">
          <img src="logo.png" alt="" width={56} height={56} />
          <div><h1>{t("app.name")}</h1><p className="muted">{t("app.edition")}</p></div>
        </div>
        <div className="langs" role="group" aria-label="Language">
          {(["ar", "en", "fr"] as Lang[]).map(l => <button key={l} lang={l} aria-pressed={lang === l} onClick={() => setLang(l)}>{t(`lang.${l}`)}</button>)}
        </div>
        <form onSubmit={submit} className="form">
          <h2>{t("login.title")}</h2>
          <Field label={t("login.username")}><input value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" required dir="ltr" /></Field>
          <Field label={t("login.password")}><input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" required dir="ltr" /></Field>
          <ErrorNote error={error} />
          <button className="btn primary" disabled={busy}>{t("login.submit")}</button>
        </form>
      </div>
      {demo.length > 0 && (
        <div className="panel demo-users">
          <div className="eyebrow">{t("login.demo")}</div>
          <p className="muted">{t("login.demo_hint")}</p>
          <div className="demo-grid">
            {demo.map(u => (
              <button key={u.username} className="demo-user" onClick={() => setUsername(u.username)}>
                <b dir="ltr">{u.username}</b>
                <span>{t(`role.${u.role}`)}</span>
                <small>{name(u, "org_")}</small>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

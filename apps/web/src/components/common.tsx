import React, { useCallback, useEffect, useState } from "react";
import { ApiError } from "../api";
import { useI18n } from "../i18n";

export function useAsync<T>(fn: () => Promise<T>, deps: any[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(() => {
    setLoading(true);
    fn().then(d => { setData(d); setError(null); }).catch(setError).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { reload(); }, [reload]);
  return { data, error, loading, reload, setData };
}

export function ErrorNote({ error }: { error: any }) {
  const { t } = useI18n();
  if (!error) return null;
  const e = error as ApiError;
  const key = `error.${e.code}`;
  const msg = t(key, e.details ?? {});
  return <div className="note bad" role="alert">{msg === key ? t("error.generic", { id: e.correlationId ?? "—" }) : msg}</div>;
}

const TONE: Record<string, string> = { DRAFT: "quiet", AUTHORISED: "ok", REJECTED: "bad", SETTLED: "ok", RETURNED: "bad", SEND_FAILED: "bad" };
export function StatusChip({ status }: { status: string }) {
  const { t } = useI18n();
  return <span className={`chip ${TONE[status] ?? "warn"}`}>{t(`status.${status}`)}</span>;
}

export function Loading() {
  const { t } = useI18n();
  return <p className="muted">{t("common.loading")}</p>;
}

export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export const go = (path: string) => { window.location.hash = path; };

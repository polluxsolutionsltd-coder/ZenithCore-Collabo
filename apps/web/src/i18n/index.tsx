import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { Lang, MESSAGES } from "./messages";

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage may be unavailable */ } },
};

const LOCALE: Record<Lang, string> = { ar: "ar-SY-u-nu-latn", en: "en-GB", fr: "fr-FR" };

interface I18n {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: string, params?: Record<string, any>) => string;
  money: (n: number | null | undefined) => string;
  num: (n: number | null | undefined, digits?: number) => string;
  pct: (n: number | null | undefined) => string;
  date: (d: string | Date) => string;
  /** Pick the name in the current language from an object with name_en/name_ar/name_fr (or a custom prefix). */
  name: (o: any, prefix?: string) => string;
}

const Ctx = createContext<I18n>(null as any);

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const initial = (store.get("zc.lang") as Lang) || "ar";
  const [lang, setLangState] = useState<Lang>(MESSAGES[initial] ? initial : "ar");

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
    store.set("zc.lang", lang);
  }, [lang]);

  const value = useMemo<I18n>(() => {
    const nf = new Intl.NumberFormat(LOCALE[lang], { maximumFractionDigits: 0 });
    const df = new Intl.DateTimeFormat(LOCALE[lang], { dateStyle: "medium", timeStyle: "short" });
    const t = (key: string, params: Record<string, any> = {}) => {
      const s = MESSAGES[lang][key] ?? MESSAGES.en[key] ?? key;
      return s.replace(/\{(\w+)\}/g, (_, k) => (params[k] === undefined ? "" : typeof params[k] === "number" ? nf.format(params[k]) : String(params[k])));
    };
    return {
      lang,
      setLang: setLangState,
      t,
      money: n => (n === null || n === undefined ? "—" : `${nf.format(n)} ${t("common.syp")}`),
      num: (n, digits = 0) => (n === null || n === undefined ? "—" : new Intl.NumberFormat(LOCALE[lang], { maximumFractionDigits: digits }).format(n)),
      pct: n => (n === null || n === undefined ? "—" : new Intl.NumberFormat(LOCALE[lang], { style: "percent", maximumFractionDigits: 1 }).format(n)),
      date: d => df.format(typeof d === "string" ? new Date(d) : d),
      name: (o, prefix = "name_") => (o ? o[`${prefix}${lang}`] ?? o[`${prefix}en`] ?? "" : ""),
    };
  }, [lang]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useI18n = () => useContext(Ctx);

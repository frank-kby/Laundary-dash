import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { en, type MessageKey } from './en';
import { rw } from './rw';

export type Lang = 'en' | 'rw';
const dictionaries: Record<Lang, Partial<Record<MessageKey, string>>> = { en, rw };
const STORAGE_KEY = 'ld.lang'; // UI preference only — nothing sensitive is kept in browser storage

export type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

interface I18nValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: T;
  money: (n: number) => string;
  dateTime: (iso: string) => string;
  date: (iso: string) => string;
  slotLabel: (start: string, end: string) => string;
}

const Ctx = createContext<I18nValue | null>(null);

function initialLang(): Lang {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    if (s === 'en' || s === 'rw') return s;
  } catch {
    /* storage unavailable */
  }
  return navigator.language?.toLowerCase().startsWith('rw') ? 'rw' : 'en';
}

const TZ = 'Africa/Kigali'; // business time zone: all times shown as Kigali time

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* ignore */
    }
  }, []);
  const value = useMemo<I18nValue>(() => {
    const locale = lang === 'rw' ? 'rw-RW' : 'en-GB';
    const t: T = (key, vars) => {
      let s = dictionaries[lang][key] ?? en[key] ?? key;
      if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
      return s;
    };
    const safe = (opts: Intl.DateTimeFormatOptions) => {
      try {
        return new Intl.DateTimeFormat(locale, { timeZone: TZ, ...opts });
      } catch {
        return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, ...opts });
      }
    };
    const dt = safe({ weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const d = safe({ day: 'numeric', month: 'short', year: 'numeric' });
    const day = safe({ weekday: 'short', day: 'numeric', month: 'short' });
    const hm = safe({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    return {
      lang,
      setLang,
      t,
      money: (n) => `${new Intl.NumberFormat('en-US').format(Math.round(n))} RWF`,
      dateTime: (iso) => dt.format(new Date(iso)),
      date: (iso) => d.format(new Date(iso)),
      slotLabel: (s, e) => `${day.format(new Date(s))}, ${hm.format(new Date(s))}–${hm.format(new Date(e))}`,
    };
  }, [lang, setLang]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n() {
  const v = useContext(Ctx);
  if (!v) throw new Error('I18nProvider missing');
  return v;
}

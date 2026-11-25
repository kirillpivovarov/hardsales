import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from './api';

interface Locale {
  code: string;
  name: string;
  active: boolean;
  messages: Record<string, string>;
}

const russian: Locale = { code: 'ru', name: 'Русский', active: true, messages: {} };
type Translate = (source: string, replacements?: Record<string, string | number>) => string;
const I18nContext = createContext<{
  locale: string;
  locales: Locale[];
  setLocale: (value: string) => void;
  reloadLocales: () => void;
  t: Translate;
}>({ locale: 'ru', locales: [russian], setLocale: () => {}, reloadLocales: () => {}, t: source => source });

export const useI18n = () => useContext(I18nContext);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locales, setLocales] = useState<Locale[]>([russian]);
  const [preference, setPreference] = useState(() => localStorage.getItem('hwforai.locale') || 'ru');
  const reloadLocales = useCallback(() => {
    void api<Locale[]>('/locales').then(items => {
      setLocales(items.filter(item => item.active));
    }).catch(() => {});
  }, []);
  useEffect(reloadLocales, [reloadLocales]);
  const current = locales.find(item => item.code === preference) ?? locales.find(item => item.code === 'ru') ?? russian;
  useEffect(() => { document.documentElement.lang = current.code; }, [current.code]);
  const setLocale = useCallback((value: string) => {
    localStorage.setItem('hwforai.locale', value);
    setPreference(value);
  }, []);
  const t: Translate = useCallback((source, replacements) => {
    const translation = Object.hasOwn(current.messages, source) ? current.messages[source] : source;
    return translation.replace(/\{(\w+)\}/g, (match, key: string) => String(replacements?.[key] ?? match));
  }, [current]);
  const context = useMemo(() => ({ locale: current.code, locales, setLocale, reloadLocales, t }), [current.code, locales, setLocale, reloadLocales, t]);
  return <I18nContext.Provider value={context}>{children}</I18nContext.Provider>;
}

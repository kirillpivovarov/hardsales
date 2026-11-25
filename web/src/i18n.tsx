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
const previousExchangeLabels: Record<string, string> = {
  'Участник не проверен': 'не проверен',
  'Документы проверены': 'проверен документами',
  'Сделка подтверждена': 'проверен сделкой',
  'Рейтинг участника': 'Рейтинг по делам',
  'Рейтинг объявления · {score}/100': 'Рейтинг · {score}/100',
  'Условия согласованы': 'Договорились',
  'Сделка не состоялась': 'Сорвалось',
  'Сделка исполнена': 'Исполнено',
  'Полномочия подтверждены по корпоративной почте': 'подтверждён компанией по почте',
  'Полномочия подтверждены': 'принципал подтверждён',
  'Корпоративный адрес подтверждён': 'почта компании подтверждена',
  'Вознаграждение подтверждено принципалом': 'открытые агентские, подтверждено принципалом',
  'Размер вознаграждения указан': 'открытые агентские',
  'Ответы об актуальности': 'Дисциплина подтверждений',
  'Скорость ответа на совпадения': 'Скорость ответа на совпадение',
  'Срок работы на площадке': 'Давность на площадке',
};
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
    const previous = current.code !== 'ru' && Object.hasOwn(previousExchangeLabels, source) ? previousExchangeLabels[source] : undefined;
    const translation = Object.hasOwn(current.messages, source) ? current.messages[source]
      : previous && Object.hasOwn(current.messages, previous) ? current.messages[previous] : source;
    return translation.replace(/\{(\w+)\}/g, (match, key: string) => String(replacements?.[key] ?? match));
  }, [current]);
  const context = useMemo(() => ({ locale: current.code, locales, setLocale, reloadLocales, t }), [current.code, locales, setLocale, reloadLocales, t]);
  return <I18nContext.Provider value={context}>{children}</I18nContext.Provider>;
}

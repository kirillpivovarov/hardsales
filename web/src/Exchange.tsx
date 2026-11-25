import { createContext, useContext, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from './api';
import { useI18n } from './i18n';
import { Button, Field, Icon, Notice, Spinner } from './ui';
import type { RepresentationActionData } from './Representation';

type Settings = Record<string, boolean | number | string | string[]>;
const ExchangeContext = createContext({ features: {} as Settings, reload: () => {} });
export const useExchange = () => useContext(ExchangeContext);

export function ExchangeProvider({ children }: { children: ReactNode }) {
  const [features, setFeatures] = useState<Settings>({});
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    function refresh() {
      void api<Settings>('/platform/features', { signal: controller.signal }).then(items => {
        if (!controller.signal.aborted) {
          setFeatures(previous => JSON.stringify(previous) === JSON.stringify(items) ? previous : items);
        }
      }).catch(() => {});
    }
    refresh();
    const timer = window.setInterval(refresh, 60_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [version]);
  return <ExchangeContext.Provider value={{ features, reload: () => setVersion(value => value + 1) }}>{children}</ExchangeContext.Provider>;
}

interface Notification {
  id: string; title: string; body: string; createdAt: string; readAt: string | null;
  actions: { label: string; token?: string; href?: string }[];
}

export function NotificationLink({ revision }: { revision: number }) {
  const { t } = useI18n();
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    function refresh() {
      void api<{ unread: number }>('/notifications?unread=true&limit=1', { signal: controller.signal })
        .then(value => setUnread(value.unread)).catch(() => {});
    }
    refresh();
    const timer = window.setInterval(refresh, 60_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [revision]);
  return <Link to="/notifications" className="button button-secondary exchange-notification-link"
    aria-label={unread ? t('Уведомления, непрочитанных: {count}', { count: unread }) : t('Уведомления')}>
    <Icon name="bell" size={17} />
    {unread > 0 && <span className="exchange-count" aria-hidden="true">{unread > 99 ? '99+' : unread}</span>}
  </Link>;
}

export function NotificationsPage({ onRead }: { onRead: () => void }) {
  const { t, locale } = useI18n();
  const [page, setPage] = useState(1);
  const [version, setVersion] = useState(0);
  const [result, setResult] = useState<{ items: Notification[]; total: number; unread: number }>();
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void api<typeof result>('/notifications?page=' + page + '&limit=20', { signal: controller.signal })
      .then(setResult).catch((err: Error) => { if (!controller.signal.aborted) setError(err.message); });
    return () => controller.abort();
  }, [page, version]);
  async function mark(id?: string) {
    try {
      await api(id ? '/notifications/' + id + '/read' : '/notifications/read-all', { method: id ? 'PATCH' : 'POST' });
      setVersion(value => value + 1);
      onRead();
    } catch (err) { setError((err as Error).message); }
  }
  return <section className="container workflow-page exchange-page">
    <h1>{t('Уведомления')}</h1>
    {error && <Notice tone="error">{t(error)}</Notice>}
    {!result && !error && <Spinner />}
    {Boolean(result?.unread) && <Button variant="secondary" onClick={() => void mark()}>{t('Прочитать все')}</Button>}
    {result?.total === 0 && <Notice>{t('Уведомлений пока нет.')}</Notice>}
    <div className="workflow-stack">
      {result?.items.map(item => <article className="panel workflow-section" key={item.id}>
        <h2>{t(item.title)}</h2>
        <p>{t(item.body)}</p>
        <time className="muted" dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString(locale)}</time>
        <div className="admin-actions">
          {item.actions.flatMap((action, index) => {
            const path = action.token ? '/a/' + encodeURIComponent(action.token) : action.href;
            return path && /^\/(?![\\/])/.test(path) ? [<Link key={index} to={path} className="button button-secondary"
              onClick={() => void mark(item.id)}>{t(action.label)}</Link>] : [];
          })}
          {!item.readAt && <Button variant="ghost" onClick={() => void mark(item.id)}>{t('Прочитано')}</Button>}
        </div>
      </article>)}
    </div>
    {(page > 1 || Boolean(result && result.total > page * 20)) && <nav className="admin-actions" aria-label={t('Страницы уведомлений')}>
      <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>{t('Назад')}</Button>
      <span>{page}</span>
      <Button variant="secondary" disabled={!result || result.total <= page * 20} onClick={() => setPage(value => value + 1)}>{t('Далее')}</Button>
    </nav>}
  </section>;
}

const settingNames: Record<string, string> = {
  timezone: 'Часовой пояс площадки', rules_version: 'Версия правил', registration_mode: 'Режим регистрации',
  feature_invites: 'Приглашения, анкета и правила', feature_actuality: 'Подтверждение актуальности',
  feature_disclosure_journal: 'Журнал раскрытий', feature_representation: 'Прямые стороны и агенты',
  feature_matching: 'Совпадения объявлений', feature_trust_rating: 'Рейтинг и проверка',
  feature_catalog_sync: 'Синхронизация справочника', disclosure_min_level: 'Уровень для раскрытия',
  low_rating_threshold: 'Порог низкого рейтинга', catalog_sync_vendors: 'Идентификаторы производителей PCI',
};

export function ExchangeSettings() {
  const { t } = useI18n();
  const { reload } = useExchange();
  const [values, setValues] = useState<{ key: string; value: Settings[string] }[]>();
  const [busy, setBusy] = useState<string>();
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { void api<typeof values>('/admin/settings').then(setValues).catch(err => setError(err.message)); }, []);
  async function save(event: FormEvent<HTMLFormElement>, key: string, current: Settings[string]) {
    event.preventDefault();
    const field = new FormData(event.currentTarget).get('value');
    const value = typeof current === 'boolean' ? field === 'on' : typeof current === 'number' ? Number(field)
      : Array.isArray(current) ? String(field ?? '').trim().split(/[,\s]+/).filter(Boolean) : String(field ?? '');
    setBusy(key); setError(''); setMessage('');
    try {
      const row = await api<{ key: string; value: Settings[string] }>('/admin/settings/' + key, { method: 'PUT', body: { value } });
      setValues(list => list?.map(item => item.key === key ? row : item));
      reload();
      setMessage(t('Изменения сохранены.'));
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(undefined); }
  }
  return <div className="workflow-stack">
    <h2>{t('Настройки биржи')}</h2>
    {error && <Notice tone="error">{t(error)}</Notice>}
    {message && <Notice tone="success">{message}</Notice>}
    {!values && !error && <Spinner />}
    {values?.map(row => <form key={row.key} className="exchange-setting" onSubmit={event => void save(event, row.key, row.value)}>
      <Field label={t(settingNames[row.key] ?? row.key)}>
        {typeof row.value === 'boolean' ? <input type="checkbox" name="value" defaultChecked={row.value} /> :
          row.key === 'registration_mode' ? <select name="value" defaultValue={String(row.value)}>
            <option value="OPEN">{t('Открытая регистрация')}</option><option value="INVITE">{t('Только по приглашению')}</option>
          </select> : <input type={typeof row.value === 'number' ? 'number' : 'text'} name="value"
            defaultValue={Array.isArray(row.value) ? row.value.join(', ') : row.value} required />}
      </Field>
      <Button type="submit" variant="secondary" disabled={busy === row.key}>{t('Сохранить')}</Button>
    </form>)}
  </div>;
}

export function ExchangeJobRuns() {
  const { t, locale } = useI18n();
  const [records, setRecords] = useState<{ id: string; job: string; slot: string; status: string; startedAt: string }[]>();
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [job, setJob] = useState('');
  const [total, setTotal] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void api<{ items: NonNullable<typeof records>; total: number }>('/admin/jobs?' + new URLSearchParams({
      page: String(page), limit: '25', ...(job ? { job } : {}),
    }), { signal: controller.signal }).then(result => { setRecords(result.items); setTotal(result.total); })
      .catch((err: Error) => { if (!controller.signal.aborted) setError(err.message); });
    return () => controller.abort();
  }, [job, page]);
  return <div className="workflow-stack">
    <h2>{t('Фоновые задачи')}</h2>
    <form className="exchange-setting" onSubmit={event => {
      event.preventDefault();
      setPage(1); setJob(String(new FormData(event.currentTarget).get('job') ?? '').trim());
    }}>
      <Field label={t('Имя задачи')}><input name="job" maxLength={80} /></Field><Button type="submit">{t('Найти')}</Button>
    </form>
    {error && <Notice tone="error">{t(error)}</Notice>}
    {!records && !error && <Spinner />}
    <ul className="exchange-runs">{records?.map(item => <li key={item.id}>
      <strong>{item.job}</strong> <span>{item.slot}</span> <span>{item.status}</span>
      <time dateTime={item.startedAt}>{new Date(item.startedAt).toLocaleString(locale)}</time>
    </li>)}</ul>
    <div className="admin-actions">
      <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>{t('Назад')}</Button>
      <Button variant="secondary" disabled={total <= page * 25} onClick={() => setPage(value => value + 1)}>{t('Далее')}</Button>
    </div>
  </div>;
}

type ActionDescription = RepresentationActionData & {
  title?: string;
  listing?: { title?: string };
  fields?: { priceMode?: string; price?: number | null; quantity?: number; minLot?: number };
};
export function ActionPage({ renderForm }: { renderForm: (
  action: ActionDescription, onSubmit: (body: Record<string, unknown>) => Promise<void>, pending: boolean
) => ReactNode }) {
  const { token } = useParams();
  const { t } = useI18n();
  const [action, setAction] = useState<ActionDescription>();
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [dealId, setDealId] = useState<string>();
  const [error, setError] = useState('');
  const path = '/actions/' + encodeURIComponent(token ?? '');
  useEffect(() => {
    const controller = new AbortController();
    setError(''); setDone(false); setAction(undefined); setDealId(undefined);
    void api<ActionDescription>(path, { signal: controller.signal }).then(setAction)
      .catch((err: Error) => { if (!controller.signal.aborted) setError(err.message); });
    return () => controller.abort();
  }, [path]);
  async function submit(body: Record<string, unknown>) {
    if (pending) return;
    setPending(true); setError('');
    try {
      const data = await api<{ dealId?: string }>(path, { method: 'POST', body });
      setDealId(data?.dealId);
      setDone(true);
    }
    catch (err) { setError((err as Error).message); }
    finally { setPending(false); }
  }
  return <section className="container workflow-page exchange-page">
    <h1>{t(action?.title ?? 'Подтверждение действия')}</h1>
    {action?.listing?.title && <p>{action.listing.title}</p>}
    {error && <Notice tone="error">{t(error)}</Notice>}
    {done ? <Notice tone="success">{t('Ответ сохранён.')}</Notice> : action ? renderForm(action, submit, pending) : !error && <Spinner />}
    {dealId && <p><Link className="button button-secondary" to={`/deals/${encodeURIComponent(dealId)}?action=agree`}>{t('Открыть сделку')}</Link></p>}
    <Link to="/catalog" className="back-link">{t('К каталогу')}</Link>
  </section>;
}

import { createContext, useContext, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from './api';
import { useI18n } from './i18n';
import { Button, Field, Icon, Notice, Spinner } from './ui';
import type { RepresentationActionData } from './Representation';
import type { ListingOwnerFields } from './StaffListing';
import { TelegramDemoActions, type TelegramActionFields } from './Telegram';
import { ThirdPartyLetterEditor, type ThirdPartyLetter } from './Consent';
import { StaffDialog } from './StaffDialog';

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

export function NotificationLink({ unread }: { unread: number }) {
  const { t } = useI18n();
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
  feature_telegram: 'Уведомления в Telegram',
  disclosure_requires_verified_telegram: 'Требовать подтверждения Telegram перед раскрытием',
  feature_disputes: 'Споры по раскрытиям',
  feature_lot_groups: 'Дубли лотов', lot_price_tolerance: 'Допуск цены одинаковых лотов, доля',
  near_miss_max_failures: 'Допустимое число расхождений при ручном сведении',
  near_miss_price_over: 'Допуск сверх бюджета при ручном сведении, доля',
  feature_catalog_sync: 'Синхронизация справочника', disclosure_min_level: 'Уровень для раскрытия',
  low_rating_threshold: 'Порог низкого рейтинга', catalog_sync_vendors: 'Идентификаторы производителей PCI',
  model_required_categories: 'Категории с обязательной моделью',
  pd_policy_version: 'Версия политики обработки данных',
  staff_digest_hour: 'Час отправки сводки для модераторов',
  staff_instant_kinds: 'Срочные письма сотрудникам',
};
const staffNoticeLabels: Record<string, string> = {
  'onboarding.submitted': 'Новые анкеты', 'verification.document_uploaded': 'Загруженные документы',
  'deal.executed': 'Исполненные сделки', 'deal.amount_mismatch': 'Расхождения в условиях сделки',
  'listing.pending_review': 'Объявления на премодерации', 'dispute.opened': 'Открытые споры',
  'dispute.reopened': 'Заявления о пересмотре спора',
};
const dedicatedSettings = new Set(['ops_alerts', 'pilot_period', 'stop_rule', 'pilot_targets', 'pilot_excluded_users']);

export function ExchangeSettings() {
  const { t } = useI18n();
  const { reload } = useExchange();
  const [values, setValues] = useState<{ key: string; value: Settings[string] }[]>();
  const [busy, setBusy] = useState<string>();
  const [feedback, setFeedback] = useState<{ key: string; text: string; tone: 'error' | 'success' }>();
  const [loadError, setLoadError] = useState('');
  useEffect(() => { void api<typeof values>('/admin/settings').then(setValues).catch(err => setLoadError(err.message)); }, []);
  async function save(event: FormEvent<HTMLFormElement>, key: string, current: Settings[string]) {
    event.preventDefault();
    if (busy) return;
    const submitted = new FormData(event.currentTarget);
    const field = submitted.get('value');
    const value = key === 'staff_instant_kinds' ? submitted.getAll('noticeKind').map(String)
      : typeof current === 'boolean' ? field === 'on' : typeof current === 'number' ? Number(field)
      : Array.isArray(current) ? String(field ?? '').trim().split(/[,\s]+/).filter(Boolean) : String(field ?? '');
    setBusy(key); setFeedback(undefined);
    try {
      const row = await api<{ key: string; value: Settings[string] }>('/admin/settings/' + key, { method: 'PUT', body: { value } });
      setValues(list => list?.map(item => item.key === key ? row : item));
      reload();
      setFeedback({ key, text: 'Изменения сохранены.', tone: 'success' });
    } catch (err) { setFeedback({ key, text: (err as Error).message, tone: 'error' }); }
    finally { setBusy(undefined); }
  }
  return <div className="workflow-stack">
    <h2>{t('Настройки биржи')}</h2>
    {loadError && <Notice tone="error">{t(loadError)}</Notice>}
    {!values && !loadError && <Spinner />}
    {values?.filter(row => !dedicatedSettings.has(row.key)).map(row => row.key === 'third_party_letter' ?
      <ThirdPartyLetterEditor key={row.key} value={row.value as unknown as ThirdPartyLetter} onSaved={value => {
        setValues(list => list?.map(item => item.key === row.key ? { key: item.key, value: value as unknown as Settings[string] } : item));
      }} /> : <div key={row.key} className="workflow-stack">
      <form className="exchange-setting" aria-busy={busy === row.key} onSubmit={event => void save(event, row.key, row.value)}>
      {row.key === 'staff_instant_kinds' && Array.isArray(row.value) ? (
        <fieldset className="exchange-notice-kinds">
          <legend>{t(settingNames.staff_instant_kinds)}</legend>
          {Object.entries(staffNoticeLabels).map(([key, label]) => <label key={key} className="workflow-checkbox">
            <input type="checkbox" name="noticeKind" value={key} defaultChecked={(row.value as string[]).includes(key)} />
            {t(label)}
          </label>)}
        </fieldset>
      ) : <Field label={t(settingNames[row.key] ?? row.key)}>
        {typeof row.value === 'boolean' ? <input type="checkbox" name="value" defaultChecked={row.value} /> :
          row.key === 'registration_mode' ? <select name="value" defaultValue={String(row.value)}>
            <option value="OPEN">{t('Открытая регистрация')}</option><option value="INVITE">{t('Только по приглашению')}</option>
          </select> : <input type={typeof row.value === 'number' ? 'number' : 'text'} name="value"
            step={row.key === 'lot_price_tolerance' || row.key === 'near_miss_price_over' ? 'any' : undefined}
            min={row.key === 'staff_digest_hour' ? 0 : undefined} max={row.key === 'staff_digest_hour' ? 23 : undefined}
            defaultValue={Array.isArray(row.value) ? row.value.join(', ') : row.value} required />}
      </Field>}
        <Button type="submit" variant="secondary" disabled={Boolean(busy)}>{t('Сохранить')}</Button>
      </form>
      {feedback?.key === row.key && <Notice tone={feedback.tone}>{t(feedback.text)}</Notice>}
    </div>)}
  </div>;
}

const jobStatuses: Record<string, string> = { RUNNING: 'Выполняется', DONE: 'Выполнена', FAILED: 'Ошибка', SKIPPED: 'Пропущена' };
type JobOption = { name: string; title: string; canRun: boolean; requiresConfirmation: boolean };
export function ExchangeJobRuns({ administrator = false }: { administrator?: boolean }) {
  const { t, locale } = useI18n();
  const [records, setRecords] = useState<{ id: string; job: string; slot: string; status: string; startedAt: string; manual?: boolean; manualBy?: string }[]>();
  const [options, setOptions] = useState<JobOption[]>([]);
  const [confirm, setConfirm] = useState<{ task: JobOption; trigger: HTMLElement }>();
  const [busy, setBusy] = useState<string>();
  const [result, setResult] = useState('');
  useEffect(() => { void api<{ items: JobOption[] }>('/admin/jobs/available').then(response => setOptions(response.items))
    .catch((cause: Error) => setError(cause.message)); }, []);
  async function run(task: JobOption, confirmation = false) {
    setBusy(task.name); setError(''); setResult('');
    try {
      const response = await api<{ status: string }>('/admin/jobs/' + encodeURIComponent(task.name) + '/run', {
        method: 'POST', body: { confirm: confirmation },
      });
      setResult(jobStatuses[response.status] ?? 'Результат неизвестен');
      setRevision(value => value + 1);
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(undefined); setConfirm(undefined); }
  }
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [job, setJob] = useState('');
  const [total, setTotal] = useState(0);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void api<{ items: NonNullable<typeof records>; total: number }>('/admin/jobs?' + new URLSearchParams({
      page: String(page), limit: '25', ...(job ? { job } : {}),
    }), { signal: controller.signal }).then(result => { setRecords(result.items); setTotal(result.total); })
      .catch((err: Error) => { if (!controller.signal.aborted) setError(err.message); });
    return () => controller.abort();
  }, [job, page, revision]);
  return <div className="workflow-stack">
    <h2>{t('Фоновые задачи')}</h2>
    {administrator && <TelegramDemoActions onFinished={() => setRevision(value => value + 1)} />}
    <details className="ops-panel"><summary>{t('Ручной запуск')}</summary>
      <ul className="ops-job-list">{options.filter(item => item.canRun).map(item => <li key={item.name}>
        <strong>{t(item.title)}</strong>
        <Button variant="secondary" disabled={Boolean(busy)} aria-label={t('Запустить сейчас') + ' · ' + t(item.title)}
          onClick={event => item.requiresConfirmation ? setConfirm({ task: item, trigger: event.currentTarget }) : void run(item)}>
          {t('Запустить сейчас')}
        </Button>
      </li>)}</ul>
    </details>
    <Field label={t('Задача в журнале')}><select value={job} onChange={event => {
      setPage(1); setJob(event.currentTarget.value);
    }}><option value="">{t('Все задачи')}</option>
      {options.map(item => <option key={item.name} value={item.name}>{t(item.title)}</option>)}</select></Field>
    {error && <Notice tone="error">{t(error)}</Notice>}
    {result && <Notice>{t(result)}</Notice>}
    {!records && !error && <Spinner />}
    <ul className="ops-job-list">{records?.map(item => <li key={item.id}>
      <strong>{t(options.find(option => option.name === item.job)?.title ?? 'Служебная задача')}</strong>
      <span>{t(jobStatuses[item.status] ?? 'Неизвестный статус')}</span>
      {item.manual && <span>{t('Вручную')}{item.manualBy ? ' · ' + item.manualBy : ''}</span>}
      <time dateTime={item.startedAt}>{new Date(item.startedAt).toLocaleString(locale)}</time>
    </li>)}</ul>
    {confirm && <StaffDialog title={t(confirm.task.title)} returnFocus={confirm.trigger} closeDisabled={Boolean(busy)} onClose={() => setConfirm(undefined)}>
      <p>{t('Участники получат вопрос или напоминание сейчас.')}</p>
      <div className="admin-actions"><Button disabled={Boolean(busy)} onClick={() => void run(confirm.task, true)}>{t('Подтвердить отправку')}</Button></div>
    </StaffDialog>}
    <div className="admin-actions">
      <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>{t('Назад')}</Button>
      <Button variant="secondary" disabled={total <= page * 25} onClick={() => setPage(value => value + 1)}>{t('Далее')}</Button>
    </div>
  </div>;
}

type ActionDescription = RepresentationActionData & {
  title?: string;
  listing?: { title?: string };
  fields?: TelegramActionFields & ListingOwnerFields & { priceMode?: string; minLot?: number };
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
  const [chatId, setChatId] = useState<string>();
  const [error, setError] = useState('');
  const path = '/actions/' + encodeURIComponent(token ?? '');
  useEffect(() => {
    const controller = new AbortController();
    setError(''); setDone(false); setAction(undefined); setDealId(undefined); setChatId(undefined);
    void api<ActionDescription>(path, { signal: controller.signal }).then(setAction)
      .catch((err: Error) => { if (!controller.signal.aborted) setError(err.message); });
    return () => controller.abort();
  }, [path]);
  async function submit(body: Record<string, unknown>) {
    if (pending) return;
    setPending(true); setError('');
    try {
      const data = await api<{ dealId?: string; chatId?: string }>(path, { method: 'POST', body });
      setDealId(data?.dealId);
      setChatId(data?.chatId);
      setDone(true);
    }
    catch (err) { setError((err as Error).message); }
    finally { setPending(false); }
  }
  return <section className="container workflow-page exchange-page">
    <h1>{t(action?.title ?? 'Подтверждение действия')}</h1>
    {action?.listing?.title && <p>{action.listing.title}</p>}
    {error && <Notice tone="error">{t(error)}</Notice>}
    {done ? <Notice tone="success">{t(action?.purpose === 'email.optout' ? 'Площадка больше не будет писать на этот адрес' : 'Ответ сохранён.')}</Notice>
      : action ? renderForm(action, submit, pending) : !error && <Spinner />}
    {dealId && <p><Link className="button button-secondary" to={`/deals/${encodeURIComponent(dealId)}?action=agree`}>{t('Открыть сделку')}</Link></p>}
    {chatId && <p><Link className="button button-secondary" to={`/chats/${encodeURIComponent(chatId)}`}>{t('Открыть чат')}</Link></p>}
    <Link to="/catalog" className="back-link">{t('К каталогу')}</Link>
  </section>;
}

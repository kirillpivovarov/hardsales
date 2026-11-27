import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from './api';
import { useI18n } from './i18n';
import { StaffDialog } from './StaffDialog';
import { Button, Field, Notice, Spinner } from './ui';
import './pilot-operations.css';

type Outcome = { text: string; error?: boolean };
type Check = { id: string; ok: boolean; text: string; manual?: boolean };
type Readiness = { rows: Check[]; firstActualityAt: string; demo: boolean };
type Preview = { checks: Check[]; changes: { key: string; before: unknown; after: unknown }[];
  firstActualityAt: string; fxRates: Record<string, string | null> };
const currencies = ['RUB', 'USD', 'EUR', 'CNY', 'KZT', 'AED'];
const settings: Record<string, string> = {
  registration_mode: 'Регистрация', feature_invites: 'Приглашения', feature_disclosure_journal: 'Защита контактов и журнал',
  feature_representation: 'Представительство', feature_matching: 'Совпадения', feature_trust_rating: 'Рейтинг',
  feature_listing_premoderation: 'Проверка объявлений по сигналам', feature_actuality: 'Актуальность объявлений',
  feature_telegram: 'Уведомления в Telegram', disclosure_min_level: 'Минимальный уровень для раскрытия',
  disclosure_requires_verified_telegram: 'Подтверждение Telegram для раскрытия', low_rating_threshold: 'Порог низкого рейтинга',
  pilot_period: 'Период пробы', stop_rule: 'Стоп-правило', price_corridors: 'Ценовые ориентиры',
};
const formatValue = (value: unknown) => {
  if (value === true) return 'Включено';
  if (value === false) return 'Выключено';
  if (value === 'INVITE') return 'По приглашениям';
  if (value === 'OPEN') return 'Открытая';
  if (value && typeof value === 'object' && 'from' in value && 'to' in value) return `${value.from} — ${value.to}`;
  if (value && typeof value === 'object' && 'date' in value && 'minLiveMatches' in value) return `${value.date}, порог ${value.minLiveMatches}`;
  return String(value ?? 'Не задано');
};

function CheckList({ rows }: { rows: Check[] }) {
  const { t } = useI18n();
  return <ul className="ops-checklist">{rows.map(row => <li key={row.id}>
    <span className={row.ok ? 'ops-pass' : 'ops-pending'}>{t(row.ok ? 'Готово' : 'Требуется проверка')}</span>
    <span>{t(row.text)}</span>
  </li>)}</ul>;
}

export function PilotOperations({ onApplied }: { onApplied: () => void }) {
  const { t, locale } = useI18n();
  const [preview, setPreview] = useState<Preview>();
  const [rates, setRates] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState<Readiness>();
  const [feedback, setFeedback] = useState<Outcome>();
  const [confirm, setConfirm] = useState<HTMLElement>();
  function reload() {
    void api<Preview>('/admin/presets/trial').then(result => {
      setPreview(result);
      setRates(Object.fromEntries(currencies.map(currency => [currency, result.fxRates[currency] ?? ''])));
      setError('');
    }).catch((cause: Error) => setError(cause.message));
    void api<Readiness>('/admin/readiness').then(setReady).catch((cause: Error) => setError(cause.message));
  }
  useEffect(reload, []);
  async function apply() {
    setBusy(true);
    setFeedback(undefined);
    try {
      await api('/admin/presets/trial', { method: 'POST', body: { fxRates: rates } });
      setConfirm(undefined);
      setFeedback({ text: 'Пресет «Проба» применён.' });
      reload();
      onApplied();
    } catch (cause) {
      setConfirm(undefined);
      setFeedback({ text: (cause as Error).message, error: true });
    } finally { setBusy(false); }
  }
  const validRates = currencies.every(currency => /^\d{1,10}(\.\d{1,8})?$/.test(rates[currency] ?? '') && Number(rates[currency]) > 0);
  return <div className="workflow-stack">
    <details className="ops-panel">
      <summary>{t('Пресет «Проба»')}</summary>
      {error && <Notice tone="error">{error}</Notice>}
      {!preview && !error && <Spinner />}
      {preview && <form className="workflow-stack" onSubmit={event => { event.preventDefault(); setConfirm(event.currentTarget.querySelector('button')!); }}>
        <CheckList rows={preview.checks.map(row => row.id === 'rates' ? { ...row, ok: validRates } : row)} />
        <div className="ops-rates">{currencies.map(currency => <Field key={currency} label={t('Курс {currency} в USD', { currency })}>
          <input name={currency} inputMode="decimal" required value={rates[currency] ?? ''}
            onChange={event => setRates({ ...rates, [currency]: event.currentTarget.value.replace(',', '.') })} />
        </Field>)}</div>
        <p>{t('Первый вопрос об актуальности')}{' '}
          <time dateTime={preview.firstActualityAt}>{new Date(preview.firstActualityAt).toLocaleString(locale)}</time>.
          {' '}{t('Запланируйте первые приглашения с учётом трёх суток на подготовку.')}</p>
        {preview.changes.length > 0 && <div className="ops-before-after" aria-label={t('Сравнение настроек')}>
          {preview.changes.filter(item => !item.key.startsWith('fx.')).map(item => <div key={item.key}>
            <strong>{t(settings[item.key] ?? 'Настройка пробы')}</strong>
            <span>{t('Было')}{' '}{t(formatValue(item.before))}</span><span>{t('Станет')}{' '}{t(formatValue(item.after))}</span>
          </div>)}
        </div>}
        <div className="admin-actions"><Button type="submit" disabled={busy || !validRates ||
          preview.checks.some(check => check.id !== 'rates' && !check.ok)}>{t('Применить пресет')}</Button></div>
        {feedback && <Notice tone={feedback.error ? 'error' : 'success'}>{t(feedback.text)}</Notice>}
      </form>}
    </details>
    <TestMail onFinished={reload} />
    <RulesSchedule />
    <details className="ops-panel">
      <summary>{t('Готовность к приглашениям')}</summary>
      {!ready && !error && <Spinner />}
      {ready && <><CheckList rows={ready.rows} /><ManualChecks state={ready} onChange={setReady} /></>}
    </details>
    {confirm && <StaffDialog title={t('Применить пресет «Проба»')} onClose={() => setConfirm(undefined)}
      closeDisabled={busy} returnFocus={confirm}>
      <p>{t('Настройки биржи изменятся, а служебные уведомления будут поставлены в очередь.')}</p>
      <div className="admin-actions"><Button disabled={busy} onClick={() => void apply()}>{t('Применить')}</Button></div>
    </StaffDialog>}
  </div>;
}

function TestMail({ onFinished }: { onFinished: () => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Outcome>();
  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setFeedback(undefined);
    try {
      const result = await api<{ ok: boolean; error?: string }>('/admin/mail/test', {
        method: 'POST', body: { to: new FormData(event.currentTarget).get('email') },
      });
      setFeedback({ text: result.error ?? 'Тестовое письмо передано почтовому серверу.', error: !result.ok });
      onFinished();
    } catch (cause) { setFeedback({ text: (cause as Error).message, error: true }); }
    finally { setBusy(false); }
  }
  return <details className="ops-panel"><summary>{t('Тестовое письмо')}</summary>
    <form className="exchange-setting" onSubmit={event => void send(event)}>
      <Field label={t('Адрес получателя')}><input name="email" type="email" maxLength={254} required /></Field>
      <Button type="submit" disabled={busy}>{t('Отправить тестовое письмо')}</Button>
    </form>
    {feedback && <Notice tone={feedback.error ? 'error' : 'success'}>{t(feedback.text)}</Notice>}
  </details>;
}

function RulesSchedule() {
  const { t, locale } = useI18n();
  const [state, setState] = useState<{ current: string; pending?: { version: string; effectiveAt: string } }>();
  const [feedback, setFeedback] = useState<Outcome>();
  const [busy, setBusy] = useState(false);
  useEffect(() => { void api<NonNullable<typeof state>>('/admin/rules/schedule').then(setState)
    .catch((cause: Error) => setFeedback({ text: cause.message, error: true })); }, []);
  async function schedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    try {
      const pending = await api<{ version: string; effectiveAt: string }>('/admin/rules/schedule', {
        method: 'POST', body: { version: data.get('version'), effectiveAt: new Date(String(data.get('time'))).toISOString() },
      });
      setState(current => current ? { ...current, pending } : current);
      setFeedback({ text: 'Публикация запланирована. Участники получат уведомление.' });
    } catch (cause) { setFeedback({ text: (cause as Error).message, error: true }); }
    finally { setBusy(false); }
  }
  return <details className="ops-panel"><summary>{t('Новая версия правил')}</summary>
    <p>{t('Обновите заготовку в разделе «Страницы». Участники получат уведомление минимум за семь дней.')}{' '}
      <Link to="/admin?section=content">{t('Открыть страницы')}</Link></p>
    {state && <p>{t('Действующая версия')}{' '}{state.current}</p>}
    {state?.pending ? <p>{t('Запланирована версия')}{' '}{state.pending.version}{' · '}
      <time dateTime={state.pending.effectiveAt}>{new Date(state.pending.effectiveAt).toLocaleString(locale)}</time></p> :
      <form className="exchange-setting" onSubmit={event => void schedule(event)}>
        <Field label={t('Версия правил')}><input name="version" maxLength={32} required /></Field>
        <Field label={t('Дата и время вступления в силу')}><input name="time" type="datetime-local" required /></Field>
        <Button type="submit" disabled={busy || !state}>{t('Запланировать')}</Button>
      </form>}
    {feedback && <Notice tone={feedback.error ? 'error' : 'success'}>{t(feedback.text)}</Notice>}
  </details>;
}

function ManualChecks({ state, onChange }: { state: Readiness; onChange: (value: Readiness) => void }) {
  const { t } = useI18n();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const attestations = { mailboxes: 'Письмо проверено в трёх почтовых сервисах', invitations: 'Время приглашений запланировано',
    monitor: 'Оба адреса добавлены во внешний мониторинг', email: 'Участники предупреждены об уведомлениях по почте' };
  async function attest(key: string, checked: boolean) {
    setBusy(true); setError('');
    try { onChange(await api<Readiness>('/admin/readiness/' + key, { method: 'PUT', body: { checked } })); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  return <div className="workflow-stack">{Object.entries(attestations).map(([key, label]) => <div key={key} className="admin-actions">
    <span>{t(label)}</span>
    <Button variant="secondary" disabled={busy} onClick={() => void attest(key, true)}>{t('Подтвердить')}</Button>
    <Button variant="ghost" disabled={busy} onClick={() => void attest(key, false)}>{t('Снять отметку')}</Button>
  </div>)}
    {state.demo && <p>{t('Это локальный стенд. Часть внешних проверок выполняется перед рабочим запуском.')}</p>}
    {error && <Notice tone="error">{error}</Notice>}
  </div>;
}

export function InvitationReadiness() {
  const { t } = useI18n();
  const [data, setData] = useState<Readiness>();
  useEffect(() => { void api<Readiness>('/admin/readiness').then(setData).catch(() => undefined); }, []);
  return data && !data.demo && data.rows.some(row => !row.ok) ? <Notice>
    {t('Перед приглашением участников проверьте готовность площадки.')}{' '}
    <Link to="/admin?section=exchange&part=settings">{t('Настройки биржи')}</Link>
  </Notice> : null;
}

type DeliverySource = 'deliveries' | 'outbox';
type Delivery = { id: string; kind: string; recipient: string; channel: 'EMAIL' | 'TELEGRAM';
  status: string; attempts: number; createdAt: string; lastAttemptAt?: string; nextAttemptAt: string; error?: string };
type MailQueue = { items: Delivery[]; total: number; limit: number; summary: Record<string, number>; kinds: string[] };
const deliveryStatuses: Record<string, string> = { SENT: 'Отправлено', PENDING: 'В очереди', FAILED: 'Ошибка', SKIPPED: 'Пропущено' };
const notificationKinds: Record<string, string> = {
  'chat.message': 'Сообщение в чате', 'chat.digest': 'Сообщения в чате', 'staff.digest': 'Сводка оператору',
  'match.new': 'Совпадение', 'match.batch': 'Сводка по совпадениям', 'actuality.ask': 'Вопрос об актуальности',
  'actuality.remind': 'Напоминание об актуальности', 'actuality.status_summary': 'Скрытия и архив',
  'actuality.announced': 'Начало проверки актуальности', 'representation.confirm_mail': 'Подтверждение принципала',
  'company_email.confirm': 'Подтверждение адреса компании', 'company.letter': 'Письмо компании',
  'privacy.deleted': 'Удаление данных', 'rules.scheduled': 'Изменение правил',
};
function displayKind(kind: string) {
  if (notificationKinds[kind]) return notificationKinds[kind];
  if (kind.startsWith('deal.')) return 'Сделка';
  if (kind.startsWith('disclosure.')) return 'Раскрытие контактов';
  if (kind.startsWith('verification.')) return 'Проверка документов';
  if (kind.startsWith('dispute.')) return 'Спор';
  if (kind.startsWith('lot.')) return 'Проверка лота';
  return 'Служебное уведомление';
}

export function MailQueuePanel() {
  const { t, locale } = useI18n();
  const [source, setSource] = useState<DeliverySource>('deliveries');
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [lastChange, setLastChange] = useState(0);
  const [data, setData] = useState<MailQueue>();
  const [feedback, setFeedback] = useState<Outcome>();
  const [busy, setBusy] = useState<string>();
  useEffect(() => {
    const request = new AbortController();
    void api<MailQueue>('/admin/mail-queue?' + new URLSearchParams({ source, page: String(page), limit: '20' }) + query,
      { signal: request.signal }).then(setData).catch((cause: Error) => {
      if (!request.signal.aborted) setFeedback({ text: cause.message, error: true });
    });
    return () => request.abort();
  }, [source, page, query, lastChange]);
  function switchSource(next: DeliverySource) {
    if (next === source) return;
    setSource(next); setData(undefined); setQuery(''); setPage(1); setFeedback(undefined);
  }
  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const filter = new URLSearchParams();
    for (const [key, value] of new FormData(event.currentTarget)) if (value) filter.set(key, String(value));
    setPage(1); setQuery(filter.size ? '&' + filter : '');
  }
  async function retry(id: string) {
    setBusy(id); setFeedback(undefined);
    try {
      await api('/admin/mail-queue/' + source + '/' + id + '/retry', { method: 'POST' });
      setLastChange(current => current + 1);
      setFeedback({ text: 'Отправление возвращено в очередь.' });
    } catch (cause) { setFeedback({ text: (cause as Error).message, error: true }); }
    finally { setBusy(undefined); }
  }
  const localTime = (value?: string) => value ? new Date(value).toLocaleString(locale) : t('Нет данных');
  return <section className="workflow-stack">
    <h2>{t('Письма и доставки')}</h2>
    <div className="admin-actions" aria-label={t('Очереди отправки')}>
      <Button variant={source === 'deliveries' ? 'secondary' : 'ghost'} aria-pressed={source === 'deliveries'}
        onClick={() => switchSource('deliveries')}>{t('Уведомления участникам')}</Button>
      <Button variant={source === 'outbox' ? 'secondary' : 'ghost'} aria-pressed={source === 'outbox'}
        onClick={() => switchSource('outbox')}>{t('Письма компаниям')}</Button>
    </div>
    {data && <p>{t('За 24 часа')}{' · '}{Object.entries(deliveryStatuses).map(([key, label]) =>
      t(label) + ' ' + (data.summary[key] ?? 0)).join(' · ')}</p>}
    <form key={source} className="ops-mail-filters" onSubmit={search}>
      <Field label={t('Статус')}><select name="status"><option value="">{t('Любой')}</option>
        {Object.entries(deliveryStatuses).map(([value, label]) => <option value={value} key={value}>{t(label)}</option>)}</select></Field>
      <Field label={t('Вид уведомления')}><select name="kind"><option value="">{t('Любой')}</option>
        {data?.kinds.map(kind => <option value={kind} key={kind}>{t(displayKind(kind))}</option>)}</select></Field>
      <Field label={t('Дата с')}><input name="from" type="date" /></Field>
      <Field label={t('Дата по')}><input name="to" type="date" /></Field>
      <Button type="submit">{t('Применить фильтры')}</Button>
    </form>
    {feedback && <Notice tone={feedback.error ? 'error' : 'success'}>{t(feedback.text)}</Notice>}
    {!data && !feedback?.error && <Spinner />}
    {data?.items.length === 0 && <p>{t('В этой очереди ничего не найдено.')}</p>}
    <ul className="ops-mail-list">{data?.items.map(row => <li key={row.id}>
      <strong>{t(displayKind(row.kind))}</strong><span>{row.recipient}</span>
      <span>{row.channel === 'EMAIL' ? t('Почта') : 'Telegram'}</span>
      <span>{t(deliveryStatuses[row.status] ?? 'Неизвестный статус')}</span>
      <dl className="ops-mail-details">
        <div><dt>{t('Поставлено в очередь')}</dt><dd>{localTime(row.createdAt)}</dd></div>
        <div><dt>{t('Попыток')}</dt><dd>{row.attempts}</dd></div>
        {row.lastAttemptAt && <div><dt>{t('Последняя попытка')}</dt><dd>{localTime(row.lastAttemptAt)}</dd></div>}
        {row.status === 'PENDING' && <div><dt>{t('Следующая попытка')}</dt><dd>{localTime(row.nextAttemptAt)}</dd></div>}
        {row.error && <div><dt>{t(row.status === 'SKIPPED' ? 'Причина' : 'Ошибка')}</dt><dd>{row.error}</dd></div>}
      </dl>
      {row.status === 'FAILED' && <Button variant="secondary" disabled={Boolean(busy)} onClick={() => void retry(row.id)}>{t('Повторить')}</Button>}
    </li>)}</ul>
    <div className="admin-actions">
      <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>{t('Назад')}</Button>
      <Button variant="secondary" disabled={!data || data.total <= page * data.limit} onClick={() => setPage(value => value + 1)}>{t('Далее')}</Button>
    </div>
  </section>;
}

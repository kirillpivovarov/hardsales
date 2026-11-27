import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from './api';
import { useI18n } from './i18n';
import { StaffDialog } from './StaffDialog';
import { Button, Field, Notice, Spinner } from './ui';

export type TelegramState = {
  enabled: boolean; linked: boolean; username: string | null; botUsername: string | null;
  linkedAt: string | null; disabledReason: string | null; profileUsername: string | null; verified: boolean;
};

type AdminState = {
  enabled: boolean; tokenConfigured: boolean; demoMode: boolean; mode: 'webhook' | 'polling'; botUsername: string | null;
  webhook: { url: string | null; pendingUpdateCount: number; lastErrorMessage: string | null; lastErrorDate: number | null } | null;
  lastError: string | null; linkedUsers: number; deliveries24h: { SENT: number; FAILED: number; SKIPPED: number; PENDING: number };
};
const deliveryStates = { SENT: 'Отправлено', FAILED: 'Ошибка', SKIPPED: 'Пропущено', PENDING: 'Ожидают отправки' } as const;
const validLink = /^https:\/\/t\.me\/[A-Za-z][A-Za-z0-9_]{4,63}\?start=[A-Za-z0-9_-]{43}$/;

function useTelegramStatus(path: string, enabled = true, profileUsername?: string | null) {
  const [state, setState] = useState<TelegramState>();
  const [error, setError] = useState('');
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void api<TelegramState>(path, { signal: controller.signal }).then(setState).catch((cause: Error) => {
      if (!controller.signal.aborted) setError(cause.message);
    });
    return () => controller.abort();
  }, [path, enabled, profileUsername]);
  async function refresh() {
    setError('');
    try {
      const result = await api<TelegramState>(path);
      setState(result);
      return result;
    }
    catch (cause) { setError((cause as Error).message); }
  }
  return { state, error, setError, refresh };
}

export function TelegramVerificationLabel({ verified }: { verified?: boolean }) {
  const { t } = useI18n();
  return <small className={verified ? 'telegram-verified' : 'muted'}>{verified
    ? t('Подтверждён через бота')
    : t('Не подтверждён: площадка не проверяла, что это аккаунт собеседника')}</small>;
}

export function TelegramProfile({ profileUsername, onUsernameChange }: {
  profileUsername?: string | null;
  onUsernameChange?: (username: string) => void;
} = {}) {
  const { t, locale } = useI18n();
  const heading = useId();
  const { state, error, setError, refresh } = useTelegramStatus('/me/telegram', true, profileUsername);
  const [link, setLink] = useState<{ url: string; expiresAt: string }>();
  const [pending, setPending] = useState(false);
  const [unbinding, setUnbinding] = useState(false);
  const handle = (profileUsername ?? state?.profileUsername)?.replace(/^@/, '');
  const verified = Boolean(state?.verified && state.profileUsername?.toLowerCase() === handle?.toLowerCase());
  if (!state || (!state.enabled && !state.linked && !handle)) return null;
  async function connect() {
    const popup = window.open('', '_blank');
    if (popup) popup.opener = null;
    setPending(true); setError(''); setLink(undefined);
    try {
      const result = await api<NonNullable<typeof link>>('/me/telegram/link', { method: 'POST' });
      if (!validLink.test(result.url)) throw new Error('Ссылка Telegram недоступна.');
      setLink(result);
      if (popup) popup.location.href = result.url;
    } catch (cause) { popup?.close(); setError((cause as Error).message); }
    finally { setPending(false); }
  }
  async function unlink() {
    setPending(true); setError('');
    try {
      await api('/me/telegram', { method: 'DELETE' });
      setLink(undefined); setUnbinding(false);
      await refresh();
    } catch (cause) { setError((cause as Error).message); }
    finally { setPending(false); }
  }
  async function check() {
    const result = await refresh();
    if (result?.profileUsername && result.profileUsername !== profileUsername) onUsernameChange?.(result.profileUsername);
  }
  return <section className="workflow-span workflow-stack" aria-labelledby={heading}>
    <h2 id={heading}>{t('Telegram для уведомлений')}</h2>
    {handle && <p role="status" className={verified ? 'telegram-verified' : 'muted'}>{verified
      ? t('Telegram @{name}: подтверждён', { name: handle })
      : t('Telegram @{name}: не подтверждён', { name: handle })}</p>}
    {state.linked && <>
      <p>{state.username && state.linkedAt ? t('Подключён @{name} с {date}', {
        name: state.username, date: new Date(state.linkedAt).toLocaleDateString(locale),
      }) : t('Telegram подключён.')}</p>
    </>}
    {!state.linked && state.enabled && <>
      {state.disabledReason === 'BOT_BLOCKED' && <Notice>{t('Telegram отключён из-за блокировки бота. Разблокируйте его и подключите снова.')}</Notice>}
      {state.disabledReason === 'CHAT_NOT_FOUND' && <Notice>{t('Чат бота недоступен. Подключите Telegram снова.')}</Notice>}
      <p>{t('Вопрос «Актуально?» и уведомления будут приходить в Telegram с кнопками ответа. Если Telegram не доставит сообщение за 30 минут, придёт резервное письмо.')}</p>
    </>}
    {(state.enabled || state.linked) && <div className="admin-actions">
      {state.enabled && !verified && <Button variant="secondary" disabled={pending} onClick={() => void connect()}>
        {t(state.linked ? 'Подтвердить через бота' : 'Подключить Telegram')}
      </Button>}
      {state.enabled && !verified && <Button variant="ghost" disabled={pending} onClick={() => void check()}>
        {t(state.linked ? 'Проверить подтверждение' : 'Проверить подключение')}
      </Button>}
      {state.linked && <Button variant="secondary" onClick={() => setUnbinding(true)}>{t('Отвязать Telegram')}</Button>}
    </div>}
    {link && <p>{t('Ссылка действует 15 минут.')}{' '}
      <a className="text-link" href={link.url} target="_blank" rel="noopener noreferrer">{t('Открыть Telegram')}</a></p>}
    {error && !unbinding && <Notice tone="error">{t(error)}</Notice>}
    {unbinding && <StaffDialog title={t('Отвязать Telegram')} onClose={() => setUnbinding(false)} closeDisabled={pending}>
      <p>{t('Уведомления продолжат приходить на почту, если она включена в профиле.')}</p>
      {error && <Notice tone="error">{t(error)}</Notice>}
      <div className="admin-actions"><Button variant="danger" disabled={pending} onClick={() => void unlink()}>{t('Отвязать')}</Button></div>
    </StaffDialog>}
  </section>;
}

export function TelegramHint({ enabled = true }: { enabled?: boolean }) {
  const { t } = useI18n();
  const { state } = useTelegramStatus('/me/telegram', enabled);
  if (!enabled || !state?.enabled || state.linked) return null;
  return <p className="workflow-muted-line">{t('Отвечайте на «Актуально?» одной кнопкой в Telegram.')}{' '}
    <Link className="text-link" to="/account">{t('Подключить')}</Link></p>;
}

export function TelegramAdmin() {
  const { t, locale } = useI18n();
  const [state, setState] = useState<AdminState>();
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    void api<AdminState>('/admin/telegram', { signal: controller.signal }).then(setState).catch((cause: Error) => {
      if (!controller.signal.aborted) setError(cause.message);
    });
    return () => controller.abort();
  }, [revision]);
  return <section className="workflow-stack exchange-page">
    <div className="admin-actions"><h2>Telegram</h2><Button variant="secondary" onClick={() => setRevision(value => value + 1)}>{t('Обновить')}</Button></div>
    {error && <Notice tone="error">{t(error)}</Notice>}
    {!state && !error && <Spinner />}
    {state && <>
      <dl className="exchange-record panel">
        <div><dt>{t('Канал уведомлений')}</dt><dd>{t(state.enabled ? 'Включён' : 'Выключен')}</dd></div>
        <div><dt>{t('Токен бота')}</dt><dd>{t(state.tokenConfigured ? 'Задан' : 'Ожидает настройки владельцем')}</dd></div>
        <div><dt>{t('Режим')}</dt><dd>{state.mode}</dd></div>
        {state.botUsername && <div><dt>{t('Имя бота')}</dt><dd>@{state.botUsername}</dd></div>}
        <div><dt>{t('Подключено участников')}</dt><dd>{state.linkedUsers}</dd></div>
      </dl>
      <h3>{t('Доставки за 24 часа')}</h3>
      <ul className="exchange-record panel">
        {Object.entries(state.deliveries24h).map(([key, count]) => <li key={key}>
          {t(deliveryStates[key as keyof typeof deliveryStates])} · {count}</li>)}
      </ul>
      {state.lastError && <Notice tone="error">{t(state.lastError)}</Notice>}
      {state.webhook && <dl className="exchange-record panel">
        <div><dt>{t('Адрес вебхука')}</dt><dd>{state.webhook.url ?? t('Вебхук не подтверждён')}</dd></div>
        <div><dt>{t('Обновления в очереди Telegram')}</dt><dd>{state.webhook.pendingUpdateCount}</dd></div>
        {state.webhook.lastErrorMessage && <div><dt>{t('Последняя ошибка Telegram')}</dt><dd>{state.webhook.lastErrorMessage}</dd></div>}
        {state.webhook.lastErrorDate && <div><dt>{t('Дата ошибки')}</dt><dd>{new Date(state.webhook.lastErrorDate * 1000).toLocaleString(locale)}</dd></div>}
      </dl>}
      <Link className="text-link" to="/admin?section=exchange&part=settings">{t('Настройки биржи')}</Link>
    </>}
  </section>;
}

export function TelegramUserControl({ userId }: { userId: string }) {
  const { t } = useI18n();
  const path = `/admin/telegram/users/${encodeURIComponent(userId)}`;
  const { state, error, setError, refresh } = useTelegramStatus(path);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  if (!state?.linked) return null;
  async function unlink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); event.stopPropagation();
    const reason = new FormData(event.currentTarget).get('reason');
    setPending(true); setError('');
    try {
      await api(`${path}/unlink`, { method: 'POST', body: { reason } });
      await refresh(); setOpen(false);
    } catch (cause) { setError((cause as Error).message); }
    finally { setPending(false); }
  }
  return <div className="admin-actions">
    <span>{state.username ? '@' + state.username : t('Telegram подключён.')}</span>
    <Button variant="secondary" onClick={() => setOpen(true)}>{t('Отвязать Telegram')}</Button>
    {open && <StaffDialog title={t('Отвязать Telegram')} onClose={() => setOpen(false)} closeDisabled={pending}>
      <form className="workflow-stack" onSubmit={event => void unlink(event)}>
        <Field label={t('Причина')}><textarea name="reason" minLength={3} maxLength={500} rows={3} required /></Field>
        {error && <Notice tone="error">{t(error)}</Notice>}
        <div className="admin-actions"><Button type="submit" variant="danger" disabled={pending}>{t('Отвязать')}</Button></div>
      </form>
    </StaffDialog>}
  </div>;
}

export function TelegramDemoActions({ onFinished }: { onFinished: () => void }) {
  const { t } = useI18n();
  const [demo, setDemo] = useState(false);
  const [confirm, setConfirm] = useState<'ask' | 'remind'>();
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void api<AdminState>('/admin/telegram', { signal: controller.signal }).then(status => setDemo(status.demoMode)).catch(() => {});
    return () => controller.abort();
  }, []);
  if (!demo) return null;
  async function run() {
    if (!confirm) return;
    setPending(true); setError(''); setResult('');
    try {
      const response = await api<{ status: string; asked?: number; reminded?: number }>(`/admin/actuality/${confirm}-now`, { method: 'POST' });
      setResult(response.status !== 'DONE' ? t(response.status === 'FAILED' ? 'Не удалось выполнить задачу' : 'Задача пропущена')
        : t(confirm === 'ask' ? 'Вопрос отправлен для {count} объявлений.' : 'Напоминание отправлено для {count} объявлений.',
          { count: response.asked ?? response.reminded ?? 0 }));
      setConfirm(undefined); onFinished();
    } catch (cause) { setError((cause as Error).message); }
    finally { setPending(false); }
  }
  return <div className="workflow-stack">
    <div className="admin-actions">
      <Button variant="secondary" onClick={() => setConfirm('ask')}>{t('Отправить вопрос «Актуально?» сейчас')}</Button>
      <Button variant="secondary" onClick={() => setConfirm('remind')}>{t('Отправить напоминание сейчас')}</Button>
    </div>
    {result && <Notice>{result}</Notice>}
    {confirm && <StaffDialog title={t(confirm === 'ask' ? 'Отправить вопрос «Актуально?» сейчас' : 'Отправить напоминание сейчас')}
      onClose={() => setConfirm(undefined)} closeDisabled={pending}>
      <p>{t('Участники с подходящими объявлениями получат уведомление.')}</p>
      {error && <Notice tone="error">{t(error)}</Notice>}
      <div className="admin-actions"><Button disabled={pending} onClick={() => void run()}>{t('Отправить')}</Button></div>
    </StaffDialog>}
  </div>;
}

export type TelegramActionFields = { reasons?: readonly string[]; rules?: readonly string[]; hasFee?: boolean };
export function TelegramActionForm({ purpose, fields, pending, onSubmit }: {
  purpose: string; fields?: TelegramActionFields; pending: boolean; onSubmit: (value: Record<string, unknown>) => Promise<unknown>;
}) {
  const { t } = useI18n();
  const [agreed, setAgreed] = useState(false);
  const [answer, setAnswer] = useState('YES');
  const [decision, setDecision] = useState(false);
  const act = (value: Record<string, unknown>) => void onSubmit(value);
  if (purpose === 'chat.reveal') return <div className="workflow-stack">
    <ul>{fields?.rules?.map(rule => <li key={rule}>{t(rule)}</li>)}</ul>
    <label className="checkbox-label"><input type="checkbox" checked={agreed} onChange={event => setAgreed(event.target.checked)} />
      {t('Понимаю правила раскрытия')}</label>
    <div className="admin-actions"><Button disabled={pending || !agreed} onClick={() => act({ action: 'ACCEPT', rulesAccepted: true })}>
      {t('Принять обмен')}</Button><Button variant="secondary" disabled={pending} onClick={() => act({ action: 'DECLINE' })}>{t('Отклонить')}</Button></div>
  </div>;
  if (purpose === 'principal.answer') return <form className="workflow-stack" onSubmit={event => {
    event.preventDefault(); act({ answer, value: new FormData(event.currentTarget).get('value') ?? undefined });
  }}>
    <Field label={t('Ответ')}><select value={answer} onChange={event => setAnswer(event.target.value)}>
      <option value="YES">{t('Да')}</option><option value="NO">{t('Нет')}</option>
      {fields?.hasFee && <option value="OTHER">{t('Другая цифра')}</option>}
    </select></Field>
    {answer === 'OTHER' && <Field label={t('Другая цифра')}><input name="value" maxLength={120} required /></Field>}
    <div><Button type="submit" disabled={pending}>{t('Ответить')}</Button></div>
  </form>;
  if (purpose === 'match.decline' || purpose === 'deal.status') {
    const deal = purpose === 'deal.status';
    return <div className="workflow-stack">
      {deal && !decision && <div className="admin-actions">
        <Button disabled={pending} onClick={() => act({ status: 'NEGOTIATING' })}>{t('Идут переговоры')}</Button>
        <Button variant="secondary" disabled={pending} onClick={() => setDecision(true)}>{t('Сорвалось')}</Button>
      </div>}
      {(!deal || decision) && <form className="workflow-stack" onSubmit={event => {
        event.preventDefault(); act({ reason: new FormData(event.currentTarget).get('reason'), ...(deal && { status: 'FAILED' }) });
      }}><Field label={t('Причина')}><select name="reason" defaultValue="" required>
        <option value="" disabled>{t('Выберите причину')}</option>
        {fields?.reasons?.map(reason => <option key={reason} value={reason}>{t(reason)}</option>)}
      </select></Field><div className="admin-actions"><Button type="submit" disabled={pending}>{t('Подтвердить')}</Button></div></form>}
    </div>;
  }
  return <Button disabled={pending} onClick={() => act({})}>{t(purpose === 'match.chat' ? 'Написать' : 'Уже знакомы')}</Button>;
}

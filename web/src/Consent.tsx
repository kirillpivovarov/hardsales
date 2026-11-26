import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, type User } from './api';
import { useI18n } from './i18n';
import { StaffDialog } from './StaffDialog';
import { Button, Field, Notice, Spinner } from './ui';
import './privacy.css';

type RequestKind = 'EXPORT' | 'DELETE';
type RequestStatus = 'NEW' | 'DONE' | 'REJECTED';
type DataRequest = {
  id: string; number: string; kind: RequestKind; status: RequestStatus; requestedAt: string;
  handledAt?: string; exportAvailable: boolean; exportExpiresAt?: string; rejectionReason?: string;
};
type AdminRequest = DataRequest & { userId: string; nickname: string; comment?: string; handlerNote?: string };
export type ThirdPartyLetter = { approved: boolean; subject: string; body: string; approvedAt: string | null };
const kindNames = { EXPORT: 'Выгрузка', DELETE: 'Удаление' };
const statusNames = { NEW: 'На рассмотрении', DONE: 'Выполнен', REJECTED: 'Отклонён' };
const formatDate = (value: string, locale: string) => new Date(value).toLocaleString(locale, {
  dateStyle: 'medium', timeStyle: 'short',
});
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Не удалось выполнить запрос';

export function ConsentChoices({ accepted, onAccept, initialEmail = false }: {
  accepted: boolean; onAccept: (checked: boolean) => void; initialEmail?: boolean;
}) {
  const { t } = useI18n();
  return <div className="workflow-stack workflow-span">
    <div className="privacy-choice">
      <input id="personal-data-consent" type="checkbox" name="pdConsent" checked={accepted}
        onChange={event => onAccept(event.target.checked)} required />
      <div>
        <label htmlFor="personal-data-consent">{t('Я даю согласие на обработку персональных данных на условиях политики')}</label>
        {' · '}<Link className="text-link" to="/info/pd_policy" target="_blank" rel="noopener">
          {t('Политика обработки персональных данных')}
        </Link>
      </div>
    </div>
    <label className="privacy-choice">
      <input type="checkbox" name="infoEmailConsent" defaultChecked={initialEmail} />
      <span>{t('Согласен получать информационные письма площадки')}</span>
    </label>
  </div>;
}

export function ConsentPage({ user, onUser, onLogout }: { user: User; onUser: (user: User) => void; onLogout: () => Promise<void> }) {
  const { t } = useI18n();
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function accept(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accepted || busy || !user.pdPolicyVersion) return;
    const input = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      const result = await api<{ user: User }>('/auth/consent', { method: 'POST', body: {
        pdPolicyVersion: user.pdPolicyVersion, infoEmailConsent: input.has('infoEmailConsent'),
      } });
      onUser(result.user);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return <div className="container workflow-page workflow-stack">
    <section className="panel workflow-section workflow-stack">
      <h1>{t('Политика обработки персональных данных')}</h1>
      <p>{t('Политика обработки персональных данных обновилась (версия {version}).', { version: user.pdPolicyVersion ?? '' })}</p>
      <form className="workflow-stack" onSubmit={event => void accept(event)}>
        <ConsentChoices accepted={accepted} onAccept={setAccepted} initialEmail={user.infoEmailConsent} />
        {error && <Notice tone="error">{t(error)}</Notice>}
        <div className="exchange-actions">
          <Button type="submit" disabled={!accepted || busy || !user.pdPolicyVersion}>{t('Принять')}</Button>
          <Button variant="secondary" disabled={busy} onClick={() => void onLogout().catch(cause => setError(errorMessage(cause)))}>{t('Выйти')}</Button>
        </div>
      </form>
    </section>
    <AccountPrivacy user={user} onUser={onUser} preferences={false} />
  </div>;
}

export function AccountPrivacy({ user, onUser, preferences = true }: {
  user: User; onUser: (user: User) => void; preferences?: boolean;
}) {
  const { t, locale } = useI18n();
  const [rows, setRows] = useState<DataRequest[]>();
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [action, setAction] = useState<'delete' | 'withdraw'>();
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState('');

  useEffect(() => {
    const abort = new AbortController();
    void api<{ items: DataRequest[] }>('/me/data-requests', { signal: abort.signal })
      .then(data => setRows(data.items))
      .catch(cause => { if (!abort.signal.aborted) setError(errorMessage(cause)); });
    return () => abort.abort();
  }, [revision]);

  async function request(kind: RequestKind, comment?: string) {
    if (busy) return;
    setBusy(true);
    setNotice('');
    setDialogError('');
    setError('');
    try {
      await api('/me/data-requests', { method: 'POST', body: { kind, comment } });
      setNotice('Запрос принят.');
      setAction(undefined);
      setRevision(value => value + 1);
    } catch (cause) {
      (kind === 'DELETE' ? setDialogError : setError)(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function changeEmails(value: boolean) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const updated = await api<{ user: User }>('/auth/profile', { method: 'PATCH', body: { infoEmailConsent: value } });
      onUser(updated.user);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const deleting = rows?.some(row => row.kind === 'DELETE' && row.status === 'NEW');

  return <section id="personal-data" className="panel workflow-section workflow-stack">
    <h2>{t('Персональные данные')}</h2>
    {preferences && <>
      {user.pdConsentAt && user.pdConsentVersion && <p>{t('Согласие дано {date}, версия {version}', {
        date: formatDate(user.pdConsentAt, locale), version: user.pdConsentVersion,
      })}</p>}
      <label className="privacy-choice">
        <input type="checkbox" checked={Boolean(user.infoEmailConsent)} disabled={busy}
          onChange={event => void changeEmails(event.target.checked)} />
        <span>{t('Информационные письма')}</span>
      </label>
    </>}
    <div className="exchange-actions">
      <Button variant="secondary" disabled={busy || rows?.some(row => row.kind === 'EXPORT' && row.status === 'NEW')}
        onClick={() => void request('EXPORT')}>{t('Выгрузить мои данные')}</Button>
      <Button variant="secondary" disabled={busy || deleting} onClick={() => { setDialogError(''); setAction('delete'); }}>{t('Удалить мои данные')}</Button>
      <Button variant="ghost" disabled={busy || deleting} onClick={() => { setDialogError(''); setAction('withdraw'); }}>{t('Отозвать согласие')}</Button>
    </div>
    {error && <Notice tone="error">{t(error)}</Notice>}
    {notice && <Notice tone="success">{t(notice)}</Notice>}
    {!rows && !error && <Spinner />}
    {Boolean(rows?.length) && <ul className="exchange-records">
      {rows?.map(row => <li key={row.id} className="exchange-record">
        <strong>№{row.number} · {t(kindNames[row.kind])} · {t(statusNames[row.status])}</strong>
        <span className="muted">{formatDate(row.requestedAt, locale)}</span>
        {row.rejectionReason && <p>{row.rejectionReason}</p>}
        {row.exportAvailable && <a className="button button-secondary" href={`/api/v1/me/data-requests/${row.id}/export`} download>{t('Скачать')}</a>}
        {row.exportAvailable && row.exportExpiresAt && <small>{t('Доступно до {date}', { date: formatDate(row.exportExpiresAt, locale) })}</small>}
      </li>)}
    </ul>}
    {action && <StaffDialog title={t(action === 'withdraw' ? 'Отозвать согласие' : 'Запросить удаление данных')}
      onClose={() => setAction(undefined)} closeDisabled={busy}>
      <form className="workflow-stack" onSubmit={event => {
        event.preventDefault();
        const comment = String(new FormData(event.currentTarget).get('comment') ?? '').trim();
        void request('DELETE', comment || undefined);
      }}>
        <p>{t('Администратор получит запрос на удаление профиля. После обработки вход будет недоступен.')}</p>
        <Field label={t('Комментарий')}><textarea name="comment" maxLength={1000} rows={3} /></Field>
        {dialogError && <Notice tone="error">{t(dialogError)}</Notice>}
        <Button type="submit" variant="danger" disabled={busy}>{t('Подтвердить запрос')}</Button>
      </form>
    </StaffDialog>}
  </section>;
}

export function DataRequestsPanel() {
  const { t, locale } = useI18n();
  const [status, setStatus] = useState<RequestStatus>('NEW');
  const [page, setPage] = useState(1);
  const [records, setRecords] = useState<{ items: AdminRequest[]; total: number; limit: number }>();
  const [revision, setRevision] = useState(0);
  const [action, setAction] = useState<{ id: string; type: 'export' | 'delete' | 'reject'; number: string }>();
  const [error, setError] = useState('');
  const [dialogError, setDialogError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const abort = new AbortController();
    setError('');
    void api<NonNullable<typeof records>>(`/admin/data-requests?status=${status}&page=${page}`, { signal: abort.signal })
      .then(setRecords)
      .catch(cause => { if (!abort.signal.aborted) setError(errorMessage(cause)); });
    return () => abort.abort();
  }, [status, page, revision]);

  async function manage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!action || busy) return;
    const input = new FormData(event.currentTarget);
    setBusy(true);
    setDialogError('');
    setNotice('');
    try {
      const result = await api<{ retained?: string[] }>(`/admin/data-requests/${action.id}/${action.type}`, {
        method: 'POST', body: action.type === 'delete' ? { confirm: true }
          : action.type === 'reject' ? { note: input.get('note') } : undefined,
      });
      setNotice(result.retained ? 'Сохранены записи: ' + result.retained.join(' · ') : 'Запрос обработан.');
      setAction(undefined);
      setRevision(value => value + 1);
    } catch (cause) {
      setDialogError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  function open(row: AdminRequest, type: 'export' | 'delete' | 'reject') {
    setDialogError('');
    setAction({ id: row.id, type, number: row.number });
  }

  return <section className="workflow-stack">
    <h2>{t('Запросы по данным')}</h2>
    <Field label={t('Статус запроса')}>
      <select aria-label={t('Статус запроса')} value={status} onChange={event => { setStatus(event.target.value as RequestStatus); setPage(1); }}>
        {Object.entries(statusNames).map(([key, label]) => <option key={key} value={key}>{t(label)}</option>)}
      </select>
    </Field>
    {error && <Notice tone="error">{t(error)}</Notice>}
    {notice && <Notice tone="success">{t(notice)}</Notice>}
    {!records && !error && <Spinner />}
    {records?.items.length === 0 && <Notice>{t('Запросов с таким статусом нет.')}</Notice>}
    <ul className="exchange-records">
      {records?.items.map(row => <li className="exchange-record" key={row.id}>
        <strong>№{row.number} · {t(kindNames[row.kind])} · {row.nickname}</strong>
        <span className="muted">{formatDate(row.requestedAt, locale)} · {t(statusNames[row.status])}</span>
        {row.comment && <p>{row.comment}</p>}
        {row.handlerNote && <p>{row.handlerNote}</p>}
        <div className="exchange-actions">
          <Link className="button button-secondary" to={`/admin?section=exchange&part=user-consents&userId=${row.userId}`}>{t('История согласий')}</Link>
          {row.status === 'NEW' && <>
            <Button variant={row.kind === 'DELETE' ? 'danger' : 'secondary'} onClick={() => open(row, row.kind === 'DELETE' ? 'delete' : 'export')}>
              {t(row.kind === 'DELETE' ? 'Удалить данные' : 'Сформировать')}
            </Button>
            <Button variant="ghost" onClick={() => open(row, 'reject')}>{t('Отклонить')}</Button>
          </>}
        </div>
      </li>)}
    </ul>
    {records && records.total > records.limit && <div className="exchange-actions">
      <Button variant="secondary" disabled={page === 1} onClick={() => setPage(value => value - 1)}>{t('Назад')}</Button>
      <span>{page}</span>
      <Button variant="secondary" disabled={page * records.limit >= records.total} onClick={() => setPage(value => value + 1)}>{t('Далее')}</Button>
    </div>}
    {action && <StaffDialog title={t('Обработать запрос №{number}', { number: action.number })} closeDisabled={busy}
      onClose={() => setAction(undefined)}>
      <form className="workflow-stack" onSubmit={event => void manage(event)}>
        {action.type === 'reject' && <Field label={t('Причина отказа')}><textarea name="note" minLength={3} maxLength={1000} required /></Field>}
        {action.type === 'delete' && <Notice>{t('Профиль будет обезличен. Документы сделок и записи раскрытий сохранятся.')}</Notice>}
        {action.type === 'export' && <p>{t('Участник сможет скачать файл из профиля в течение 7 дней.')}</p>}
        {dialogError && <Notice tone="error">{t(dialogError)}</Notice>}
        <Button type="submit" variant={action.type === 'delete' ? 'danger' : 'primary'} disabled={busy}>{t('Подтвердить')}</Button>
      </form>
    </StaffDialog>}
  </section>;
}

export function UserConsents({ userId }: { userId: string }) {
  const { t, locale } = useI18n();
  const [rows, setRows] = useState<{ id: string; kind: string; granted: boolean; policyVersion: string;
    givenAt: string; ip: string | null; userAgent: string | null; source: string }[]>();
  const [error, setError] = useState('');
  const sources: Record<string, string> = {
    REGISTRATION: 'Регистрация', LOGIN: 'Вход и принятие новой версии', PROFILE: 'Профиль', MIGRATION: 'Демонстрационные данные',
  };

  useEffect(() => {
    const abort = new AbortController();
    setRows(undefined);
    setError('');
    void api<{ items: NonNullable<typeof rows> }>(`/admin/users/${encodeURIComponent(userId)}/consents`, { signal: abort.signal })
      .then(data => setRows(data.items))
      .catch(cause => { if (!abort.signal.aborted) setError(errorMessage(cause)); });
    return () => abort.abort();
  }, [userId]);

  return <section className="workflow-stack">
    <h2>{t('История согласий')}</h2>
    {error && <Notice tone="error">{t(error)}</Notice>}
    {!rows && !error && <Spinner />}
    {rows?.length === 0 && <Notice>{t('Согласий пока нет.')}</Notice>}
    <ul className="exchange-records">
      {rows?.map(row => <li className="exchange-record" key={row.id}>
        <strong>{t(row.kind === 'PD_PROCESSING' ? 'Обработка персональных данных' : 'Информационные письма')} · {t(row.granted ? 'Согласие' : 'Отказ')}</strong>
        <p>{t('Версия {version}', { version: row.policyVersion })} · {formatDate(row.givenAt, locale)} · {t(sources[row.source] ?? row.source)}</p>
        {row.ip && <small>{row.ip}</small>}
        {row.userAgent && <small className="privacy-break">{row.userAgent}</small>}
      </li>)}
    </ul>
  </section>;
}

export function ThirdPartyLetterEditor({ value, onSaved }: { value: ThirdPartyLetter; onSaved: (value: ThirdPartyLetter) => void }) {
  const { t, locale } = useI18n();
  const [subject, setSubject] = useState(value.subject);
  const [body, setBody] = useState(value.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const changed = subject.trim() !== value.subject || body.trim() !== value.body;
  const [suppressed, setSuppressed] = useState<number>();
  const examples: Record<string, string> = {
    link: '/a/пробная-ссылка', policyUrl: '/info/pd_policy', optOutUrl: '/a/пробная-ссылка-отказа',
    agentNickname: 'Участник', agentCompany: 'Пример компании', fee: 'Вознаграждение по договорённости', expiresDays: '14',
  };

  useEffect(() => {
    const abort = new AbortController();
    void api<{ count: number }>('/admin/email-suppressions/count', { signal: abort.signal })
      .then(result => setSuppressed(result.count)).catch(() => {});
    return () => abort.abort();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const button = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const approved = button?.value === 'approve';
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api<{ value: ThirdPartyLetter }>('/admin/settings/third_party_letter', {
        method: 'PUT', body: { value: { approved, subject, body } },
      });
      onSaved(result.value);
      setSubject(result.value.subject);
      setBody(result.value.body);
      setNotice(result.value.approved ? 'Текст утверждён.' : 'Текст сохранён как черновик.');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return <section className="panel workflow-section workflow-stack">
    <h3>{t('Письмо представителю компании')}</h3>
    <p>{value.approved && value.approvedAt
      ? t('Утверждено {date}', { date: formatDate(value.approvedAt, locale) })
      : t('Отправка писем доступна после утверждения текста.')}</p>
    {suppressed !== undefined && <small>{t('Адресов с отказом от писем: {count}', { count: suppressed })}</small>}
    <form className="workflow-stack" onSubmit={event => void submit(event)}>
      <Field label={t('Тема письма')}><input value={subject} onChange={event => setSubject(event.target.value)} minLength={5} maxLength={150} required /></Field>
      <Field label={t('Текст письма')} hint={t('Включите {link}, {policyUrl} и {optOutUrl}.')}>
        <textarea value={body} onChange={event => setBody(event.target.value)} minLength={50} maxLength={3000} rows={7} required />
      </Field>
      <details><summary>{t('Предпросмотр')}</summary>
        <p className="privacy-preview">{body.replace(/\{([^{}]+)\}/g, (whole, key: string) => examples[key] ?? whole)}</p>
      </details>
      <div className="exchange-actions">
        <Button type="submit" variant="secondary" disabled={busy}>{t('Сохранить черновик')}</Button>
        <Button type="submit" value="approve" disabled={busy || (changed && Boolean(value.body)) || (value.approved && !changed)}>
          {t('Утвердить текст')}
        </Button>
      </div>
      {changed && value.approved && <Notice>{t('После сохранения новой редакции нужно снова утвердить текст.')}</Notice>}
      {error && <Notice tone="error">{t(error)}</Notice>}
      {notice && <Notice tone="success">{t(notice)}</Notice>}
    </form>
  </section>;
}

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from './api';
import { useI18n } from './i18n';
import { StaffDialog } from './StaffDialog';
import { Button, Field, Notice } from './ui';

type InviteStatus = 'OPEN' | 'USED' | 'REVOKED' | 'EXPIRED';
type Invite = {
  id: string;
  code: string;
  note: string;
  presetRole: 'BUYER' | 'SELLER' | null;
  status: InviteStatus;
  expiresAt: string;
  usedBy: { id: string; username: string; displayName: string } | null;
};
type InvitePage = { items: Invite[]; total: number; page: number; limit: number };
type OnboardingRecord = {
  answers: Record<string, string>;
  questions: { id: string; text: string }[];
  submittedAt: string | null;
  representationMode: 'DIRECT' | 'AGENT' | 'BOTH';
  rulesAcceptedVersion: string | null;
};

const statusLabels: Record<InviteStatus, string> = {
  OPEN: 'Свободен', USED: 'Использован', REVOKED: 'Отозван', EXPIRED: 'Истёк',
};
const modeLabels = { DIRECT: 'Прямая сторона', AGENT: 'Агент', BOTH: 'Прямая сторона и агент' };
const errorMessage = (cause: unknown, fallback: string) => cause instanceof Error ? cause.message : fallback;

export function InvitesPanel() {
  const { t, locale } = useI18n();
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<InvitePage>();
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [revoking, setRevoking] = useState<Invite>();
  const revokeTrigger = useRef<HTMLButtonElement>(null);
  const revokeFallback = useRef<HTMLElement>(null);
  const revokeFocusOverride = useRef<HTMLElement>(null);
  const searchField = useRef<HTMLInputElement>(null);
  const [revokeError, setRevokeError] = useState('');
  const [rowFeedback, setRowFeedback] = useState<{ id: string; text: string; tone: 'success' | 'error' }>();

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ page: String(page), limit: '20' });
    if (status) query.set('status', status);
    if (search) query.set('q', search);
    setLoading(true);
    void api<InvitePage>('/admin/invites?' + query, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      const lastPage = Math.max(1, Math.ceil(result.total / result.limit));
      if (page > lastPage) setPage(lastPage);
      else setData(result);
    })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(errorMessage(cause, 'Не удалось загрузить приглашения.'));
      }).finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [page, revision, search, status]);

  const dates = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' });

  function applySearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError('');
    setNotice('');
    setRowFeedback(undefined);
    setPage(1);
    setSearch(String(form.get('q') ?? '').trim());
    setStatus(String(form.get('status') ?? ''));
    setRevision((current) => current + 1);
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const element = event.currentTarget;
    const form = new FormData(element);
    setBusy(true);
    setError('');
    setNotice('');
    setRowFeedback(undefined);
    try {
      const { items } = await api<{ items: Invite[] }>('/admin/invites', {
        method: 'POST',
        body: {
          count: Number(form.get('count')),
          note: String(form.get('note') ?? '').trim(),
          presetRole: form.get('presetRole') || null,
          expiresInDays: Number(form.get('expiresInDays')),
        },
      });
      element.reset();
      setNotice(t('Создано приглашений: {count}', { count: items.length }));
      setPage(1);
      setRevision((current) => current + 1);
    } catch (cause) {
      setError(errorMessage(cause, 'Не удалось создать приглашения.'));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!revoking || busy) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setRevokeError('');
    try {
      await api('/admin/invites/' + revoking.id + '/revoke', {
        method: 'PATCH', body: { reason: String(form.get('reason') ?? '').trim() },
      });
      revokeFocusOverride.current = revokeFallback.current;
      setRevoking(undefined);
      if (status === 'OPEN') {
        setNotice(t('Приглашение отозвано.'));
      } else {
        setRowFeedback({ id: revoking.id, text: t('Приглашение отозвано.'), tone: 'success' });
      }
      setRevision((current) => current + 1);
    } catch (cause) {
      setRevokeError(errorMessage(cause, 'Не удалось отозвать приглашение.'));
    } finally {
      setBusy(false);
    }
  }

  async function copy(invite: Invite, link: boolean) {
    setNotice('');
    setError('');
    try {
      const value = link ? new URL('/register?invite=' + encodeURIComponent(invite.code), window.location.origin).href : invite.code;
      await navigator.clipboard.writeText(value);
      setRowFeedback({ id: invite.id, text: t(link ? 'Ссылка скопирована.' : 'Код скопирован.'), tone: 'success' });
    } catch {
      setRowFeedback({ id: invite.id, text: t('Копирование недоступно. Выделите и скопируйте код в таблице.'), tone: 'error' });
    }
  }

  return (
    <div className="workflow-stack onboarding-invites">
      <section className="panel workflow-section workflow-stack" aria-labelledby="new-invites">
        <h2 id="new-invites">{t('Создать приглашения')}</h2>
        <form className="form-grid workflow-form" onSubmit={create} aria-busy={busy}>
          <Field label={t('Количество')}><input name="count" type="number" min={1} max={50} defaultValue={1} required /></Field>
          <Field label={t('Срок действия, дней')}><input name="expiresInDays" type="number" min={1} max={90} defaultValue={30} required /></Field>
          <Field label={t('Роль')}><select name="presetRole">
            <option value="">{t('Любая')}</option><option value="BUYER">{t('Покупатель')}</option><option value="SELLER">{t('Продавец')}</option>
          </select></Field>
          <Field label={t('Заметка')}><input name="note" maxLength={200} /></Field>
          <div className="workflow-span"><Button type="submit" disabled={busy}>{t('Создать приглашения')}</Button></div>
        </form>
      </section>

      {(error || notice) && <Notice tone={error ? 'error' : 'success'}>{t(error || notice)}</Notice>}
      {revoking && (
        <StaffDialog title={t('Отозвать приглашение {code}', { code: revoking.code })}
          onClose={() => setRevoking(undefined)} closeDisabled={busy}
          returnFocus={revokeTrigger.current} returnFocusOverride={revokeFocusOverride}>
          <form className="workflow-stack" onSubmit={revoke} aria-busy={busy}>
            <Field label={t('Причина отзыва')}><textarea name="reason" minLength={3} maxLength={500} rows={3} required /></Field>
            {revokeError && <Notice tone="error">{t(revokeError)}</Notice>}
            <div className="onboarding-notice">
              <Button type="submit" variant="danger" disabled={busy}>{t('Отозвать приглашение')}</Button>
              <Button type="button" variant="secondary" disabled={busy} onClick={() => setRevoking(undefined)}>{t('Отмена')}</Button>
            </div>
          </form>
        </StaffDialog>
      )}

      <section className="panel workflow-section workflow-stack" aria-labelledby="invite-list">
        <h2 id="invite-list">{t('Приглашения')}</h2>
        <form className="form-grid workflow-form" onSubmit={applySearch}>
          <Field label={t('Поиск по приглашениям')}><input ref={searchField} type="search" name="q" maxLength={120} /></Field>
          <Field label={t('Статус')}><select name="status">
            <option value="">{t('Все статусы')}</option>
            {Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
          </select></Field>
          <div className="workflow-span"><Button variant="secondary" type="submit">{t('Найти')}</Button></div>
        </form>
        {loading && <p role="status">{t('Загружаем приглашения…')}</p>}
        {!loading && !data?.items.length && <p>{t('Приглашения не найдены.')}</p>}
        {!!data?.items.length && (
          <div className="admin-table-scroll" tabIndex={0} role="region" aria-label={t('Таблица приглашений')}>
            <table className="admin-table">
              <thead><tr>{['Код', 'Заметка', 'Роль', 'Действует до', 'Статус', 'Действия'].map((label) =>
                <th key={label} scope="col">{t(label)}</th>)}</tr></thead>
              <tbody>{data.items.map((invite) => (
                <tr key={invite.id}>
                  <td data-label={t('Код')}><code>{invite.code}</code></td>
                  <td data-label={t('Заметка')}>{invite.note || '—'}</td>
                  <td data-label={t('Роль')}>{t(invite.presetRole === 'BUYER' ? 'Покупатель' : invite.presetRole === 'SELLER' ? 'Продавец' : 'Любая')}</td>
                  <td data-label={t('Действует до')}><time dateTime={invite.expiresAt}>{dates.format(new Date(invite.expiresAt))}</time></td>
                  <td data-label={t('Статус')}>{t(statusLabels[invite.status])}{invite.usedBy && ' · ' + invite.usedBy.displayName}</td>
                  <td><div className="onboarding-notice">
                    <Button type="button" variant="ghost" onClick={() => void copy(invite, false)}>{t('Копировать код')}</Button>
                    {invite.status === 'OPEN' && <>
                      <Button type="button" variant="ghost" onClick={() => void copy(invite, true)}>{t('Копировать ссылку')}</Button>
                      <Button type="button" variant="ghost" aria-haspopup="dialog" onClick={event => {
                        revokeTrigger.current = event.currentTarget;
                        revokeFallback.current = status === 'OPEN' ? searchField.current : event.currentTarget.parentElement?.querySelector('button') ?? null;
                        revokeFocusOverride.current = null;
                        setError(''); setNotice(''); setRowFeedback(undefined); setRevokeError(''); setRevoking(invite);
                      }}>
                        {t('Отозвать')}
                      </Button>
                    </>}
                  </div>{rowFeedback?.id === invite.id && <Notice tone={rowFeedback.tone}>{rowFeedback.text}</Notice>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        {!!data && data.total > data.limit && (
          <nav className="onboarding-notice" aria-label={t('Страницы приглашений')}>
            <Button type="button" variant="secondary" disabled={loading || page === 1} onClick={() => setPage(page - 1)}>{t('Назад')}</Button>
            <span>{t('Страница {page}', { page })}</span>
            <Button type="button" variant="secondary" disabled={loading || page * data.limit >= data.total} onClick={() => setPage(page + 1)}>{t('Далее')}</Button>
          </nav>
        )}
      </section>
    </div>
  );
}

export function UserOnboardingAnswers({ userId }: { userId: string }) {
  const { t, locale } = useI18n();
  const [record, setRecord] = useState<OnboardingRecord>();
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setRecord(undefined);
    setError('');
    void api<OnboardingRecord>('/admin/users/' + userId + '/onboarding', { signal: controller.signal })
      .then(setRecord).catch((cause) => {
        if (!controller.signal.aborted) setError(errorMessage(cause, 'Не удалось загрузить анкету.'));
      });
    return () => controller.abort();
  }, [userId]);
  if (error) return <Notice tone="error">{t(error)}</Notice>;
  if (!record) return <p role="status">{t('Загружаем анкету…')}</p>;
  const answers = record.questions.filter(({ id }) => record.answers[id]?.trim());
  return (
    <div className="workflow-stack">
      <p>{t(modeLabels[record.representationMode])}
        {record.rulesAcceptedVersion && ' · ' + t('Правила версии {version} приняты', { version: record.rulesAcceptedVersion })}
      </p>
      {record.submittedAt && <time dateTime={record.submittedAt}>
        {new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(record.submittedAt))}
      </time>}
      {answers.length ? <dl className="onboarding-invite-answers">{answers.map(({ id, text }) => (
        <div key={id}><dt>{t(text)}</dt><dd>{record.answers[id]}</dd></div>
      ))}</dl> : <p>{t('В анкете пока нет ответов.')}</p>}
    </div>
  );
}

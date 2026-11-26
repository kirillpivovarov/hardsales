import { useSearchParams } from 'react-router-dom';
import { useI18n } from './i18n';
import { useTrustData } from './Trust';
import { Button, Field, Notice, Spinner } from './ui';

type ContactBlock = {
  id: string;
  userId: string;
  displayName: string;
  peerId: string | null;
  surface: string;
  chatId: string | null;
  listingId: string | null;
  kinds: string[];
  body: string;
  createdAt: string;
  weekCount: number;
};

const kinds: Record<string, string> = {
  PHONE: 'Телефон', EMAIL: 'Почта', TELEGRAM: 'Telegram', MESSENGER: 'Мессенджер', LINK: 'Ссылка', SPLIT: 'Разбито на сообщения',
};
const surfaces: Record<string, string> = { CHAT: 'Чат', LISTING: 'Объявление', PROFILE: 'Профиль', REVIEW: 'Отзыв', REPORT: 'Жалоба' };

export function ContactBlocksAdmin() {
  const { t, locale } = useI18n();
  const [search, setSearch] = useSearchParams();
  const filters = new URLSearchParams();
  for (const key of ['userId', 'from', 'to', 'page']) {
    const value = search.get(key);
    if (value) filters.set(key, value);
  }
  const query = filters.toString();
  const { data, loading, error } = useTrustData<{ items: ContactBlock[]; total: number; page: number; limit: number }>(
    '/admin/contact-blocks?' + query,
  );
  const dates = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  function changePage(page: number) {
    setSearch(current => {
      const updated = new URLSearchParams(current);
      updated.set('page', String(page));
      return updated;
    });
  }

  return <section className="exchange-page">
    <h2>{t('Попытки обхода')}</h2>
    <p className="muted">{t('Журнал попыток передать контакты до взаимного согласия. Исходный текст доступен администратору.')}</p>
    <form className="form-grid" key={filters.get('userId') ?? ''} onSubmit={event => {
      event.preventDefault();
      const values = new FormData(event.currentTarget);
      setSearch(current => {
        const updated = new URLSearchParams(current);
        for (const key of ['userId', 'from', 'to']) {
          const value = String(values.get(key) ?? '').trim();
          if (value) updated.set(key, value);
          else updated.delete(key);
        }
        updated.delete('page');
        return updated;
      });
    }}>
      <Field label={t('ID участника')}><input name="userId" defaultValue={filters.get('userId') ?? ''} maxLength={36} /></Field>
      <Field label={t('Начало периода')}><input name="from" type="date" defaultValue={filters.get('from') ?? ''} /></Field>
      <Field label={t('Конец периода')}><input name="to" type="date" defaultValue={filters.get('to') ?? ''} /></Field>
      <div className="admin-actions"><Button type="submit" variant="secondary">{t('Найти')}</Button></div>
    </form>
    {loading && <Spinner />}
    {error && <Notice tone="error">{t(error)}</Notice>}
    {data?.items.length === 0 && <Notice>{t('Попыток обхода не найдено.')}</Notice>}
    {!!data?.items.length && <ul className="exchange-records">{data.items.map(row => <li className="panel exchange-record" key={row.id}>
      <strong>{row.displayName}</strong>
      <p className="muted">{row.userId} · {dates.format(new Date(row.createdAt))} · {t(surfaces[row.surface] ?? row.surface)}</p>
      <p>{row.kinds.map(kind => t(kinds[kind] ?? kind)).join(', ')} · {t('За 7 дней: {count}', { count: row.weekCount })}</p>
      {row.chatId && <p className="muted">{t('Чат {id}', { id: row.chatId })}</p>}
      {row.listingId && <p className="muted">{t('Объявление {id}', { id: row.listingId })}</p>}
      <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{row.body}</p>
    </li>)}</ul>}
    {data && (data.page > 1 || data.total > data.limit) && <nav className="exchange-actions" aria-label={t('Страницы журнала попыток')}>
      <Button variant="secondary" disabled={data.page <= 1} onClick={() => changePage(data.page - 1)}>{t('Назад')}</Button>
      <span>{t('Страница {page}', { page: data.page })}</span>
      <Button variant="secondary" disabled={data.page * data.limit >= data.total} onClick={() => changePage(data.page + 1)}>{t('Далее')}</Button>
    </nav>}
  </section>;
}
